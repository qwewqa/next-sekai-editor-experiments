import type { Chart } from '../../chart'
import { parseLevelDataChart } from '../../chart/parse/levelData'
import { validateChart } from '../../chart/validate'
import { parseAutoSave } from '../../history/autoSave/parse'
import { LevelDataReport } from '../../levelData/report'
import { getLevelDataRevision, getRevisionWarning } from '../../levelData/revision'
import type { JournalFound, JournalStore, LockService } from '../../platform/types'
import { createState } from '../../state'
import { sha256, toHex } from '../hash'
import {
    replayJournal,
    replayJournals,
    type JournalOutcome,
    type JournalWorker,
} from '../journal/replay'
import { JOURNAL_TOTAL_LIMIT, type JournalStorage } from '../journal/store'
import { hasWebLocks, sessionLock } from '../locks'
import { displayName, namePartsOf } from '../names'
import { stateBatch } from '../stateBatch'
import type { StorageStatus } from '../worker/core'
import { addLoadEvent, type LoadEvent, type ShownName } from './events'
import { AUTO_SAVE_KEY, LEGACY_RECOVERY_KEY, writeLegacyRecovery, writesLegacySlot } from './legacy'
import type { MigrationBatch, MigrationResult } from './migrationWrite'
import { RecoverySteps } from './recovery'

// The web's recovery steps (Part 0 §0.9.8; Part 1 §1.6.9, §1.6.4 #7, §1.8), in order: the canary,
// the journals, then the old auto save. Each reads storage as the step before left it.

/** What the steps need of the storage worker. */
export type RecoveryWorker = JournalWorker & {
    readMetaIds: () => Promise<{ dbInstanceId?: string; deviceId?: string }>
    /** Whether `meta.migratedHashes` holds a slot's hash: read before the slot is parsed. */
    migratedBefore: (hash: string) => Promise<boolean>
    migrateAutoSave: (batch: MigrationBatch) => Promise<MigrationResult>
}

export type RecoveryContext = {
    worker: RecoveryWorker
    status: StorageStatus
    locks: LockService
    journal: JournalStore
    /** localStorage, and the editor's key prefix. */
    storage: () => JournalStorage | undefined
    prefix: string
    appVersion: string
    /** Safe mode writes nothing in localStorage but settings (§1.4.2). */
    safe: boolean
    /** The label of a `recovered` entry, and of the migrated session's `init` entry. */
    labels: { recovered: (dropped: number) => string; migrated: string }
    /** The session whose lock this tab already holds: its own reload's (§1.4.2). */
    own?: string
    now?: () => number
    newId?: () => string
    /** What the steps found, in order. */
    outcomes: JournalOutcome[]
    /** The journal step's time, for the timing spec. */
    journalMs?: number
    /** The session the migration made, which this load continues (§1.8), and its name. */
    migrated?: { sessionId: string; name: ShownName }
    /** Journals offered in Local Data: earlier visits' (storage unavailable), or what replay left. */
    keptForLocalData: JournalFound[]
    /** This tab's own journal, unreplayed or left by replay: its reload goes on from it. */
    ownJournal?: JournalFound
    /** What replay did with this tab's own journal, when it had one. */
    ownOutcome?: JournalOutcome
    /**
     * This tab's own journal is still there after replay (it failed, or a newer build wrote it):
     * its session is never appended to, so the reload continues it in a new one (§1.6.4 step 2).
     */
    ownLeft?: boolean
    /** "Unsaved work from an earlier visit is in Local Data." was raised at this load. */
    saidInLocalData?: boolean
    events: (event: LoadEvent) => void
}

const read = (context: RecoveryContext, key: string) => {
    try {
        return context.storage()?.getItem(context.prefix + key) ?? undefined
    } catch {
        return
    }
}

const write = (context: RecoveryContext, key: string, text: string) => {
    try {
        context.storage()?.setItem(context.prefix + key, text)
    } catch {
        // Left for the next load.
    }
}

const parseJson = (text: string | undefined): unknown => {
    try {
        return text === undefined ? undefined : (JSON.parse(text) as unknown)
    } catch {
        return
    }
}

/**
 * Step 1, the canary (§1.6.9), against storage as found: localStorage's `canary` and the
 * database's `dbInstanceId` disagree only when the browser cleared this site's IndexedDB (a
 * database made at this open has a new id). Only localStorage cleared: the canary is written
 * again and `deviceId` comes back from `meta`. Safe mode writes neither.
 */
export const canaryStep = async (context: RecoveryContext) => {
    if (context.status.mode === 'memory') return
    // A read that fails says nothing either way: the next load checks again.
    const ids = await context.worker.readMetaIds().catch(() => undefined)
    if (!ids) return
    const canary = parseJson(read(context, 'canary'))
    // No `meta` where a database once had one: cleared as well.
    if (!ids.dbInstanceId) {
        if (typeof canary === 'string') context.events({ kind: 'storageCleared' })
        return
    }
    if (typeof canary === 'string' && canary !== ids.dbInstanceId)
        context.events({ kind: 'storageCleared' })
    if (context.safe) return
    if (canary !== ids.dbInstanceId) write(context, 'canary', JSON.stringify(ids.dbInstanceId))
    if (ids.deviceId && typeof parseJson(read(context, 'deviceId')) !== 'string')
        write(context, 'deviceId', JSON.stringify(ids.deviceId))
}

const shown = (outcome: JournalOutcome & { names: unknown; startedAt: number }) => ({
    name: displayName(outcome.names as Parameters<typeof displayName>[0]),
    at: outcome.startedAt,
})

/**
 * Step 2, the journals (§1.6.4 #7): each pending journal applied to its session, kept as a
 * recovery session, or its bytes moved into the `recovered` store. While storage is unavailable
 * none is replayed: this tab's own is its reload's to continue from, and an earlier visit's waits
 * in Local Data, never loaded automatically (§1.6.7).
 */
export const journalsStep = async (context: RecoveryContext) => {
    if (context.status.mode !== 'stored') {
        let size = 0
        for (const found of await context.journal.read()) {
            if (found.sessionId === context.own) {
                context.ownJournal = found
                continue
            }
            // A live tab's journal is that tab's. Without Web Locks (an insecure origin) no tab
            // can be told apart, so every other journal is offered (§1.6.7).
            const free =
                !hasWebLocks() ||
                (await context.locks
                    .request(sessionLock(found.sessionId), { ifAvailable: true }, (held) =>
                        Promise.resolve(held),
                    )
                    // A refused request can't tell: left alone, as a live tab's.
                    .catch(() => false))
            if (!free) continue
            context.keptForLocalData.push(found)
            size += found.from.length + found.text.length
        }
        if (context.keptForLocalData.length) unsavedInLocalData(context)
        // Kept until opened, downloaded or discarded: say so before they crowd out today's.
        if (size >= JOURNAL_TOTAL_LIMIT / 2) context.events({ kind: 'journalsFull' })
        return
    }
    const start = performance.now()
    const outcomes = await replayJournals(
        {
            store: context.journal,
            locks: context.locks,
            worker: context.worker,
            appVersion: context.appVersion,
            label: context.labels.recovered,
            ...(context.now ? { now: context.now } : {}),
        },
        context.own === undefined ? {} : { own: context.own },
    )
    context.outcomes.push(...outcomes)
    context.journalMs = performance.now() - start
    // What replay left (a failed apply, a newer build's) is offered in Local Data too, with
    // Download, and Open when it reads (§1.4.14); a live tab's stays that tab's.
    const left = await context.journal.read()
    const live = new Set(
        outcomes.filter((each) => each.kind === 'live').map((each) => each.sessionId),
    )
    for (const found of left) if (!live.has(found.sessionId)) context.keptForLocalData.push(found)
    if (context.own !== undefined) {
        context.ownOutcome = outcomes.find((outcome) => outcome.sessionId === context.own)
        const own = left.find((found) => found.sessionId === context.own)
        context.ownLeft = own !== undefined
        if (own) context.ownJournal = own
    }
    let later = false
    let failed = false
    for (const outcome of outcomes) {
        if (!('result' in outcome)) {
            // Written by a newer build, before its apply was tried.
            if (outcome.kind === 'later') later = true
            if (outcome.kind === 'failed') {
                console.error('A journal could not be replayed', outcome.error)
                failed = true
            }
            continue
        }
        const { result } = outcome
        if (result.kind === 'later') later = true
        // This tab's own reload says nothing: it continues where it was.
        else if (result.kind === 'applied' && outcome.sessionId !== context.own)
            context.events(
                result.created
                    ? { kind: 'unsavedRecovered', sessionId: outcome.sessionId }
                    : {
                          kind: 'journalRecovered',
                          name: shown(outcome),
                          sessionId: outcome.sessionId,
                      },
            )
        else if (result.kind === 'recovery')
            context.events({
                kind: 'journalKept',
                name: shown(outcome),
                sessionId: result.sessionId,
            })
    }
    if (later) context.events({ kind: 'journalLater' })
    // Left in place for the next load, which tries again (§1.4.3: never silent).
    if (failed) context.events({ kind: 'journalFailed' })
}

/** "Unsaved work from an earlier visit is in Local Data.", once per load. */
const unsavedInLocalData = (context: RecoveryContext) => {
    if (context.saidInLocalData) return
    context.saidInLocalData = true
    context.events({ kind: 'unsavedInLocalData' })
}

/** The old slot's chart, or undefined when this build can't read all of it (§1.8 step 4). */
export const parseAutoSaveSlot = (
    text: string,
): { chart: Chart; offset: number; filename?: string; olderRevision: boolean } | undefined => {
    try {
        const parsed = parseAutoSave(JSON.parse(text))
        const report = new LevelDataReport()
        const { entities } = parsed.levelData
        const chart = parseLevelDataChart(entities, parsed.defaultGuideColors, undefined, report)
        // Content this build didn't read: never migrated, so never lost (§0.10.5 invariant 5).
        if (!report.isEmpty) return
        validateChart(chart)
        return {
            chart,
            offset: parsed.levelData.bgmOffset,
            ...(parsed.filename ? { filename: parsed.filename } : {}),
            // Opened today with a warning when the revision change can matter (D18).
            olderRevision: getRevisionWarning(getLevelDataRevision(entities), chart) === 'older',
        }
    } catch {
        return
    }
}

/** The migration's batch, or undefined when this build can't make one of the slot. */
const migrationBatch = (context: RecoveryContext, text: string, hash: string) => {
    const slot = parseAutoSaveSlot(text)
    if (!slot) return
    try {
        const newId = context.newId ?? (() => crypto.randomUUID())
        const state = createState(slot.chart, slot.offset)
        const batch: MigrationBatch = {
            ...stateBatch(state),
            hash,
            ids: { chainId: newId(), docId: newId(), lineageId: newId(), sessionId: newId() },
            ...(slot.filename ? { sourceName: slot.filename } : {}),
            label: context.labels.migrated,
            appVersion: context.appVersion,
            wall: (context.now ?? Date.now)(),
        }
        const parts = namePartsOf(slot.filename ? { sourceName: slot.filename } : {}, state)
        return { batch, name: displayName(parts), olderRevision: slot.olderRevision }
    } catch (error) {
        // Read but not storable: a bug, kept in Local Data rather than blocking every load.
        console.error('The old auto save could not be prepared', error)
        return
    }
}

/**
 * Step 3, the old auto save (§1.8), on every load: a slot this build reads becomes a session,
 * deduplicated by `meta.migratedHashes`; its value is copied into the legacy recovery slot
 * first, and the key is deleted after the transaction commits, only if its value is unchanged
 * since it was read. A failed transaction leaves the key, with its load notice. Without
 * IndexedDB the key stays, offered in Local Data; an unreadable slot stays too, and says so.
 */
export const migrationStep = async (context: RecoveryContext) => {
    const text = read(context, AUTO_SAVE_KEY)
    if (text === undefined) return
    if (context.status.mode !== 'stored') {
        unsavedInLocalData(context)
        return
    }
    const hash = toHex(await sha256(new TextEncoder().encode(text)))
    let result: MigrationResult
    // A slot migrated before (an old tab's write-back, a key a kill left) isn't parsed again.
    // A failed read only costs the parse: the transaction's own check still finds a duplicate.
    const before = await context.worker.migratedBefore(hash).catch(() => false)
    if (before) result = { kind: 'duplicate' }
    else {
        const made = migrationBatch(context, text, hash)
        if (!made) {
            context.events({ kind: 'migrationFailed', unreadable: true })
            return
        }
        try {
            result = await context.worker.migrateAutoSave(made.batch)
        } catch (error) {
            console.error('The old auto save could not be migrated', error)
            context.events({ kind: 'migrationFailed' })
            return
        }
        if (result.kind === 'migrated') {
            // Its line waits for the open, which knows whether it's the session that opened.
            context.migrated = {
                sessionId: result.sessionId,
                name: { name: made.name, at: made.batch.wall },
            }
            if (made.olderRevision)
                context.events({ kind: 'migratedRevision', sessionId: result.sessionId })
        }
    }
    // The insurance copy first, from the first load (round 10), unless one is there already.
    const legacy = !writesLegacySlot(context.appVersion)
        ? true
        : result.kind === 'duplicate' && read(context, LEGACY_RECOVERY_KEY) !== undefined
          ? true
          : writeLegacyRecovery(text, context.storage() ?? undefined, context.prefix)
    // An old tab's newer write survives, and the next load migrates it.
    if (legacy && read(context, AUTO_SAVE_KEY) === text)
        try {
            context.storage()?.removeItem(context.prefix + AUTO_SAVE_KEY)
        } catch {
            // Left: its hash is migrated, so the next load only deletes it.
        }
}

export type { JournalOutcome }

/** The web's recovery order; the apps replace and add steps through its insertion points. */
export const recoverySteps = new RecoverySteps<RecoveryContext>([
    { name: 'canary', run: canaryStep },
    { name: 'journals', run: journalsStep },
    { name: 'legacyMigration', run: migrationStep },
])

/** Runs the recovery order; safe mode skips the journals and the migration (§1.4.2). */
export const runRecovery = (context: RecoveryContext) =>
    recoverySteps.run(context, (name) => context.safe && name !== 'canary')

/** Replays one session's pending journal under the lock the caller holds (between loads). */
export const replaySessionJournal = async (context: RecoveryContext, sessionId: string) => {
    const found = (await context.journal.read()).find((each) => each.sessionId === sessionId)
    if (!found || context.status.mode !== 'stored') return
    const outcome = await replayJournal(
        found,
        {
            store: context.journal,
            locks: context.locks,
            worker: context.worker,
            appVersion: context.appVersion,
            label: context.labels.recovered,
        },
        { held: true },
    )
    context.outcomes.push(outcome)
    return outcome
}

/** Adds a load event: for the UI's pill and Local Data's "At this load:". */
export const reportLoadEvent = addLoadEvent
