import { withSwitchRequest, type SwitchRequest } from '../../editor/switchRequest'
import type { JournalFound } from '../../platform/types'
import type { State } from '../../state'
import { createState } from '../../state'
import { storageKey } from '../../storage'
import { journalState } from '../journal/content'
import { readJournal } from '../journal/format'
import { hasWebLocks, sessionLock } from '../locks'
import type { DisplayName } from '../names'
import { mapRead, readValue, storedRead, type StoredRead } from '../storedRead'
import { previousSession } from './events'
import {
    AUTO_SAVE_KEY,
    AUTO_SAVE_UNREADABLE_KEY,
    LEGACY_RECOVERY_KEY,
    toRecoveryFile,
} from './legacy'
import { boundElsewhere, copyOfOf, holdShared, openStored, type OpenDeps } from './open'
import { journalledSession } from './resume'
import { parseAutoSaveSlot, replaySessionJournal, type RecoveryContext } from './steps'
import { claimSessionLock, MARKER_WAIT_MS } from './tab'

// What the UI acts on after startup (Part 1 §1.4.1, §1.4.14): Reopen after leaving a session,
// Restore as a Copy from a load notice, and Settings › Local Data › Recovery's rows with their
// Open, Download and Discard…. Page-only: it drives the open session and the storage worker.

export { previousSession }

let context: { open: OpenDeps; recovery: RecoveryContext } | undefined

/** Set by startup once the recovery order has run. */
export const setSessionContext = (open: OpenDeps, recovery: RecoveryContext) => {
    context = { open, recovery }
}

/** Notes the session a switch left: Reopen offers it while it's stored (§1.4.1). */
export const leftSession = (
    sessionId: string,
    name: DisplayName,
    at: number,
    stored: Promise<boolean>,
) => {
    const left = { sessionId, name: { name, at } }
    previousSession.value = left
    void stored.then((ok) => {
        // Not durably stored (Leave Anyway): there's nothing to reopen.
        if (!ok && previousSession.value === left) previousSession.value = undefined
    })
}

/** What opening a stored session in this tab did; when it didn't, why. */
export type OpenResult =
    | { opened: true }
    | {
          opened: false
          /** `none`: nothing to reopen, or startup hasn't run; `blank`: what's open stays. */
          why: 'none' | 'deleted' | 'missing' | 'later' | 'damaged' | 'blank'
      }

/**
 * Opens a stored session in this tab, replacing what's open: its pending journal applied first
 * under its lock (§1.6.4, between loads), then a continuation, or a fork when it isn't its
 * chain's latest session or is open in another tab.
 */
const openSession = async (
    asked: string,
    asCopy: boolean,
    request: SwitchRequest,
): Promise<OpenResult> => {
    let sessionId = asked
    if (!context) return { opened: false, why: 'none' }
    const captured = context
    const { open, recovery } = captured
    const flusher = open.flusher()
    const leaving = flusher?.session
    // Its own tab lets it go once its strict commit lands; the release itself comes a little
    // later, so the session this tab just left is waited for, as a reload waits (§1.6.6).
    await flusher?.outgoing
    if (!request.isCurrent() || context !== captured) return { opened: false, why: 'blank' }
    const own = leaving?.id === sessionId || previousSession.value?.sessionId === sessionId
    const lock = await claimSessionLock(open.locks, sessionId, own ? MARKER_WAIT_MS : 0)
    let opened = false
    try {
        // Its pending journal first (§1.6.4, between loads): a stale session is never opened
        // over it silently.
        const outcome = lock ? await replaySessionJournal(recovery, sessionId) : undefined
        const result = outcome && 'result' in outcome ? outcome.result : undefined
        if (outcome?.kind === 'later' || result?.kind === 'later')
            return { opened: false, why: 'later' }
        let recovered: { found: JournalFound; state: State; seq: number } | undefined
        if (outcome?.kind === 'failed') {
            const found = (await recovery.journal.read()).find(
                (each) => each.sessionId === sessionId,
            )
            const journalled = found && journalledSession(found)
            // It reads: the work starts from its state; it doesn't: nothing opens over it.
            if (!found || !journalled) return { opened: false, why: 'damaged' }
            recovered = { found, state: journalled.state, seq: journalled.seq }
        }
        // Kept as a recovery session (continued elsewhere since): that one holds the work.
        if (result?.kind === 'recovery') {
            lock?.release()
            sessionId = result.sessionId
        }
        const read = await open.worker.call('readSession', sessionId)
        if (read.kind !== 'open') return { opened: false, why: read.kind }
        // A journal a flush covered since goes, as the apply would have found it (§1.6.4 step 3).
        const lastSeq = typeof read.session.lastSeq === 'number' ? read.session.lastSeq : 0
        // That flush may have been relaxed: the key goes only after a strict commit.
        if (recovered && recovered.seq <= lastSeq) {
            if (await open.worker.call('syncStrict').catch(() => false))
                recovery.journal.remove(recovered.found)
            recovered = undefined
        }
        const held = result?.kind === 'recovery' ? undefined : lock
        const elsewhere =
            !held && hasWebLocks() && (await open.client.heldElsewhere(sessionLock(sessionId)))
        const fork =
            asCopy || elsewhere || !read.isHead || (await boundElsewhere(open, read)) !== 'no'
        const copyOf = copyOfOf(read)
        // The exclusive hold taken for the replay stands for the parent's shared one (§1.3.6).
        const parentLock = held ?? (await holdShared(open.locks, sessionId))
        const state = await openStored(
            open,
            read,
            fork || !parentLock
                ? { mode: 'fork', ...(parentLock ? { parentLock } : {}), copyOf }
                : { mode: 'continue', parentLock },
            {
                replace: true,
                request,
                canShow: () => context === captured,
                onTransferred: () => {
                    opened = true
                },
                onShown: (left) => {
                    if (left && flusher) open.onLeft?.(left, flusher.outgoing)
                },
                ...(recovered ? { recovered } : {}),
            },
        )
        if (!state) return { opened: false, why: 'blank' }
        opened = true
        // The session this replaced is offered by Reopen in turn (§1.4.1).
        return { opened: true }
    } finally {
        // Otherwise the opened session holds it (released twice is harmless).
        if (lock && !opened) lock.release()
    }
}

/** Reopen (§1.4.1): continues the session this tab left last, saying why when it can't. */
export const reopenSession = (supplied?: SwitchRequest): Promise<OpenResult> =>
    withSwitchRequest(supplied, async (request): Promise<OpenResult> => {
        const left = previousSession.value
        if (!left) return { opened: false, why: 'none' }
        const result = await openSession(left.sessionId, false, request)
        if (result.opened && request.isCurrent() && previousSession.value === left)
            previousSession.value = undefined
        return result
    })

export const reopen = async (request?: SwitchRequest) => (await reopenSession(request)).opened

export const restoreAsCopy = (sessionId: string, supplied?: SwitchRequest) =>
    withSwitchRequest(
        supplied,
        async (request) => (await openSession(sessionId, true, request)).opened,
    )

export const restoreSession = (sessionId: string, supplied?: SwitchRequest) =>
    withSwitchRequest(
        supplied,
        async (request) => (await openSession(sessionId, false, request)).opened,
    )

/** What opening a session in this tab needs, once startup has run. */
export const sessionContext = () => context

/**
 * Applies a session's pending journal under its lock (§1.6.4, between loads; r11-stage1 M3):
 * `held` when another tab holds the session, which owns its journal. Restore Session, Reopen,
 * Save to File… and Delete run it before acting on a session that isn't open.
 */
export const applyPendingJournal = async (sessionId: string) => {
    if (!context) return
    const { open, recovery } = context
    const lock = await claimSessionLock(open.locks, sessionId, 0)
    if (!lock) return 'held' as const
    try {
        return await replaySessionJournal(recovery, sessionId)
    } finally {
        lock.release()
    }
}

/** A row of Settings › Local Data › Recovery (§1.4.14). */
export type RecoveryItem =
    /** A journal of an earlier visit kept while storage is unavailable: Open and Download. */
    | {
          kind: 'journal'
          key: string
          text: string
          writtenAt?: number
          size: number
          /** Whether this build reads it, so Open can show it. */
          readable: boolean
      }
    /**
     * The old auto save, unreadable or kept without IndexedDB: Download and Discard…, and Open
     * when this build reads it (§1.8 step 5).
     */
    | { kind: 'autoSave'; key: string; text: string; size: number; readable: boolean }
    /** The legacy recovery slot: Download only. */
    | { kind: 'legacy'; key: string; text: string; size: number }
    /** Unreadable recovered work in the `recovered` store: Download and Discard…. */
    | { kind: 'recovered'; id: string; foundAt: number; size: number }

const local = () => {
    try {
        return localStorage
    } catch {
        return undefined
    }
}

/**
 * Every recovery row, as Local Data lists them. `unreadable` is true when the stored rows could
 * not be listed: an empty list then does not mean there is nothing to recover.
 */
export const recoveryItems = async (): Promise<{ items: RecoveryItem[]; unreadable: boolean }> => {
    let unreadable = false
    const items: RecoveryItem[] = []
    for (const found of context?.recovery.keptForLocalData ?? []) {
        const text = local()?.getItem(storageKey(found.from))
        if (text !== found.text) continue
        const reading = readJournal(text, found.sessionId)
        items.push({
            kind: 'journal',
            key: found.from,
            text,
            ...(reading.kind === 'journal' ? { writtenAt: reading.journal.writtenAt } : {}),
            size: new Blob([text]).size,
            readable: reading.kind === 'journal' && journalState(reading.journal).kind === 'state',
        })
    }
    for (const key of [AUTO_SAVE_KEY, AUTO_SAVE_UNREADABLE_KEY]) {
        const text = local()?.getItem(storageKey(key))
        if (text === null || text === undefined) continue
        items.push({
            kind: 'autoSave',
            key,
            text,
            size: new Blob([text]).size,
            readable: key === AUTO_SAVE_KEY && parseAutoSaveSlot(text) !== undefined,
        })
    }
    const legacy = local()?.getItem(storageKey(LEGACY_RECOVERY_KEY))
    if (legacy)
        items.push({
            kind: 'legacy',
            key: LEGACY_RECOVERY_KEY,
            text: legacy,
            size: new Blob([legacy]).size,
        })
    const worker = context?.open.worker
    if (worker && context?.recovery.status.mode !== 'memory') {
        const listed = await storedRead(worker, 'listRecovered', undefined)
        switch (listed.storedRead) {
            case 'value':
                for (const row of listed.storedValue)
                    items.push({
                        kind: 'recovered',
                        id: row.id,
                        foundAt: row.foundAt,
                        size: row.size,
                    })
                break
            case 'failed':
                // Shown as its own state, never as nothing to recover.
                unreadable = true
                break
        }
    }
    return { items, unreadable }
}

/** A recovery row as a file to download (`toRecoveryFile`); the UI hands it over. */
export const recoveryFile = async (
    item: RecoveryItem,
): Promise<StoredRead<ReturnType<typeof toRecoveryFile> | undefined>> => {
    if (item.kind !== 'recovered') return readValue(toRecoveryFile(item.text))
    const worker = context?.open.worker
    if (!worker) return readValue(undefined)
    // `undefined` is a row gone since it was listed; a failed read is its own answer.
    return mapRead(await storedRead(worker, 'readRecovered', item.id), (text) =>
        text === undefined ? undefined : toRecoveryFile(text),
    )
}

/**
 * Discard… after its confirm: removes the row, only while it still holds what was listed. A
 * journal goes only after it was opened and stored, downloaded or discarded (§1.6.7).
 */
export const discardRecoveryItem = async (item: RecoveryItem) => {
    if (item.kind === 'recovered') {
        await context?.open.worker.call('discardRecovered', item.id)
        return
    }
    const store = local()
    const key = storageKey(item.key)
    if (store?.getItem(key) === item.text) store.removeItem(key)
}

/**
 * Open on a journal kept while storage is unavailable (§1.6.7): its state in a new session in
 * this tab, whose own journal covers it from now on. The key stays until downloaded or discarded.
 */
export const openRecoveryJournal = (item: RecoveryItem & { kind: 'journal' }) => {
    const sessionId = item.key.slice('journal.'.length)
    const reading = readJournal(item.text, sessionId)
    if (reading.kind !== 'journal') return false
    const content = journalState(reading.journal)
    if (content.kind !== 'state' || !context) return false
    const { name, sourceName } = reading.journal.descriptor
    context.open.showState(content.state, {
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof sourceName === 'string' ? { sourceName } : {}),
    })
    return true
}

/**
 * Open on the old auto save kept in Local Data (§1.8 step 5): its chart in a new session in this
 * tab. The key stays until downloaded or discarded.
 */
export const openRecoveryAutoSave = (item: RecoveryItem & { kind: 'autoSave' }) => {
    const slot = item.key === AUTO_SAVE_KEY ? parseAutoSaveSlot(item.text) : undefined
    if (!slot || !context) return false
    context.open.showState(
        createState(slot.chart, slot.offset),
        slot.filename ? { sourceName: slot.filename } : {},
    )
    return true
}
