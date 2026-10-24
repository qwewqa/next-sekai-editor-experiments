import {
    captureEntryDescription,
    captureOperation,
    captureStep,
    type EntryDescription,
    type JsonValue,
    type UndoableStep,
} from '../../history/operations'
import { centralDirectoryOf } from '../../platform/fingerprint'
import type { BgmMeta } from '../../state/bgm'
import type { LevelInfo, MediaRef } from '../../state/levelInfo'
import { inflateStrict } from '../chunkVerify'
import { documentDevice, type DeviceSource } from '../deviceId'
import { equalBytes, fromHex16, toHex } from '../hash'
import {
    ANCESTOR_LIMIT,
    planNxsp,
    type BuildInput,
    type HistoryInput,
    type MediaInput,
    type PlannedChunk,
} from '../nxsp/build'
import { isObject } from '../nxsp/json'
import type { EntryForm } from '../nxsp/manifest'
import { PlanError, type PinnedSource, type PlanLimit, type WritePlan } from '../nxsp/plan'
import { placedCompleteFrom, type DeviceForm, type RevisionForm } from '../nxsp/project'
import { stateFromRecords } from '../records/records'
import { decodeSnapshot } from '../records/snapshot'
import { replay, ReplayError, type ReplayEntry, type ReplaySlot } from '../timeline'
import { assertAppend, plannedParts, plannedProject, sourceParts } from './assert'
import {
    isWhole,
    loadBodies,
    takeWhole,
    type Bodies,
    type PendingRecords,
    type SaveStore,
    type SourceKeys,
} from './bodies'
import {
    CUT_STORES,
    readCut,
    type ChainCut,
    type ChainRecord,
    type EntryRow,
    type StoredBinding,
} from './cut'
import { markDamaged } from './mark'
import { planMediaItem, type HeldMedia, type MediaKind } from './media'
import {
    bindingHasHistory,
    carryStatus,
    chainRows,
    checkReadable,
    cutStack,
    isLater,
    ModelError,
    ownRow,
    renumbering,
    type ChainRow,
    type WriteStack,
} from './model'
import { headInput as headOf } from './pending'

// The shared writer's history half (Part 1 §1.6.11.6): from a chain's consistent cut and the
// write's kind, it decides what the file holds (an append to the chain's own file at the base,
// or the chain's chronology from storage), verifies every body it takes, marks damage in storage
// before the plan is final, decides `completeFrom` with the carry test and whether the line shows,
// applies the media rule, and hands the format half (`planNxsp`) exactly what to lay out. For an
// append it then checks independently that the plan is one.

/**
 * What kind of write this is (§1.6.11.6's table):
 * - `append`: a write-back to the chain's own file at the base, or a save picker's return of it
 *   with its bytes read first; `source` is the pinned source's token.
 * - `replace`: keep-first (the conflict dialog's Replace; the kept copy is the caller's, committed
 *   before this write), writing `replaces`.
 * - `copy`: a new file keeping the `docId` and the chain's revision as parent: a download, Save as
 *   a Separate File, the not-found dialog's Save As…, the chain's own file picked without its bytes
 *   read, the first Save after a takeover, a write-back over a 0-byte file, and an unbound chain's
 *   first Save.
 * - `new`: a new `docId` with no parent: Save As…, and with `sessionId` Save to File… of that
 *   session, which binds nothing.
 */
export type SaveTarget =
    | { kind: 'append'; source: string }
    | { kind: 'replace'; replaces: string }
    | { kind: 'copy' }
    | { kind: 'new'; docId: string; sessionId?: string }

/**
 * An entry this tab hasn't flushed yet, after the stored ones of the saved session. Rows at or
 * below the session's last stored `seq` are already stored, and are taken from storage only.
 */
export type PendingRow = EntryDescription & {
    seq: number
    time: number
    /** Its state's root, as hex. */
    snapshot: string
    /** Absent when the root isn't at hand here; the writer takes it from the root it holds. */
    noteCount?: number
    dirty: boolean
    stack?: { keep: number; push: { snapshot: string; step: UndoableStep }[]; index: number }
    /** A `save` entry's revision, device and writer's app version. */
    revisionId?: string
    device?: { id: string; label: string }
    appVersion?: string
}

/** This tab's unflushed part of the saved session: its rows, its live stack and their records. */
export type PendingInput = {
    entries: PendingRow[]
    /** The live undo stack, absolute numbers in the session's numbering. */
    stack?: { base: number; slots: { snapshot: string; step: UndoableStep }[]; index: number }
    records: PendingRecords
    /** The saved session's `startedAt`, for when storage holds no row of it. */
    startedAt?: number
}

/** A chain entry by its key. */
export type RowKey = { sessionId: string; seq: number }

/**
 * The tab's binding while storage is paused or full (§1.3.2: it lives in memory until storing
 * resumes): used in place of the stored chain's identity and binding.
 */
export type IdentityInput = {
    docId: string
    revision?: { id: string; n: number; ancestors: string[] }
    file?: Pick<StoredBinding, 'entry' | 'completeFrom' | 'disk'>
    /** Rows earlier writes marked `kept: false` whose marks aren't stored yet. */
    marks?: RowKey[]
}

/** The head's level data and header, from the page's live state (else decoded from storage). */
export type HeadInput = {
    /** The head's root as hex: a head input for another state is ignored. */
    snapshot: string
    level: unknown
    editor: { defaultGuideColors?: readonly number[] }
    summary: { noteCount: number; durationMs: number }
    levelInfo: LevelInfo
    bgm?: BgmMeta
    levelVersion: number
}

export type SaveOptions = {
    /**
     * History included: true unless the Save dialog's tick for this write left it out. An append
     * source with history keeps it either way.
     */
    history: boolean
    /** The head's BGM included: true unless the Save dialog's tick for this write left it out. */
    bgm: boolean
    /** `revision.fileName`: the name this write uses. */
    fileName?: string
    /** This write's `save` entry, created before the build: its time and captured operation. */
    save: { time: number; operation: JsonValue }
    /** `device`: this install's; the write records the device of the chain's lineage (§1.3.3). */
    context: { now: number; newId: () => string; device: DeviceSource; appVersion: string }
    /** The saved session: the chain's head unless given (Save to File… gives its own). */
    sessionId?: string
    pending?: PendingInput
    /** The binding in memory, while storage is paused or full. */
    identity?: IdentityInput
    /**
     * The chain record as this tab holds it, for a chain storage holds nothing of (storing paused
     * or unavailable since its start; the Save core's seam): the write is planned from `pending`.
     */
    unstored?: ChainRecord
    head?: HeadInput
    /** Media this tab holds that storage may not (the head's BGM, cover and preview). */
    media?: HeldMedia[]
}

/** Why a write can't be planned: each is shown, never a corrupt or filtered file. */
export type SaveRefusalReason =
    | 'noChain'
    /** "Needs a newer version": a session, entry kind or root this build doesn't read. */
    | 'needsNewer'
    /** Two sessions share a start the parent links don't order. */
    | 'order'
    /** An open's background import of the chain hasn't finished: wait for it first. */
    | 'importing'
    /** The append source isn't the chain's file at the base. */
    | 'notAtBase'
    /** The chain's own file is damaged: the session unlinks, and the Save goes on as Save As…. */
    | 'damagedSource'
    /** The head's state can't be read: ""Coconut" could not be read completely." */
    | 'unreadableHead'
    /** A plan error: a bug, or a file past a reader cap. */
    | 'plan'

export type SaveRefusal = {
    refused: SaveRefusalReason
    message?: string
    /** With `plan`: the reader cap the file would pass, for the Save's message (else a bug). */
    limit?: PlanLimit
}

/** The identity unit a write that binds commits after it (§1.3.2, §1.6.11.6). */
export type SaveIdentity = {
    clearExport?: true
    docId: string
    revision: { id: string; n: number; ancestors: string[] }
    /** As written, placed; absent without history. */
    completeFrom?: string
    /** The cut's counts; the caller adds the `save` entry's `sessionId`, `seq` and `startedAt`. */
    entry?: { count: number; notKept: number; inexact?: true }
    /**
     * Every row written `kept: false` by a mark (this build's and `options.identity`'s): committed
     * with the binding, in its transaction, so a binding is never stored without them (D25).
     */
    marks: RowKey[]
}

export type SavePlan = {
    plan: WritePlan
    revisionId: string
    project: Record<string, unknown>
    /** For the post-build check: chunks taken from storage. */
    storageChunks: PlannedChunk[]
    /**
     * The line a write that doesn't carry its base gets (§1.6.11.6, I-18): "were not kept" for
     * steps known missing, "may not be included" when none is known missing, none otherwise.
     */
    stepsLine: 'none' | 'notKept' | 'mayNotBeIncluded'
    /** Media written as metadata only, in BGM, cover, preview order. */
    without: MediaKind[]
    /** Those of `without` this tab holds but that pass the 1 GB media cap: the "without its …" line. */
    tooLarge: MediaKind[]
    identity: SaveIdentity
    /** The `save` entry the file ends with; it always knows its count, the head's. */
    saveEntry: EntryForm & { noteCount: number; device: DeviceForm }
    /** Hashes found missing or bad in storage, marked damaged. */
    damaged: string[]
    /** Rows marked `kept: false` in storage by this build. */
    marked: number
    /** Whether the marks reached storage (storage paused or read-only: they didn't). */
    markStored: boolean
}

type Hooks = { plan?: (plan: WritePlan) => WritePlan }

let hooks: Hooks = {}

/** Test hooks: `plan` alters a plan before the append assertion. */
export const setSaveHooksForTests = (next: Hooks) => {
    hooks = next
}

const refuse = (refused: SaveRefusalReason, message?: string, limit?: PlanLimit): SaveRefusal => ({
    refused,
    ...(message === undefined ? {} : { message }),
    ...(limit === undefined ? {} : { limit }),
})

export const isRefusal = (value: unknown): value is SaveRefusal =>
    isObject(value) && typeof value.refused === 'string'

const slotOf = (slot: { snapshot: string; step: UndoableStep }): ReplaySlot => ({
    snapshot: fromHex16(slot.snapshot),
    step: captureStep(slot.step),
})

/** The saved session's stack: the live one, else the stored window, else replay of its rows. */
const writeStack = (
    cut: ChainCut,
    rows: readonly ChainRow[],
    pending?: PendingInput,
): WriteStack | undefined => {
    if (pending?.stack)
        return {
            base: pending.stack.base,
            slots: pending.stack.slots.map(slotOf),
            index: pending.stack.index,
        }
    if (cut.stack?.slots)
        return {
            base: cut.stack.window.base,
            slots: cut.stack.slots,
            index: cut.stack.window.index,
        }
    try {
        const replayed = replay(rows.map(({ entry }) => entry))
        return { base: 0, slots: [...replayed.slots], index: replayed.index }
    } catch (error) {
        if (!(error instanceof ReplayError)) throw error
        return
    }
}

/** The head's level data and header from its verified records. */
const headFromBodies = (bodies: Bodies, hex: string): HeadInput => {
    const decoder = new TextDecoder()
    const records = decodeSnapshot(bodies.roots.get(hex), {
        node: (key) => bodies.nodes.get(key),
        chunk: (key) => {
            const chunk = bodies.chunks.get(key)
            if (!chunk) throw new Error(`No chunk ${key}`)
            return JSON.parse(decoder.decode(inflateStrict(chunk.stored))) as unknown
        },
    })
    return headOf(stateFromRecords(records))
}

const rowSnapshots = (entry: { snapshot: Uint8Array; stack?: EntryRow['stack'] }) => [
    toHex(entry.snapshot),
    ...(entry.stack?.push.map((slot) => toHex(slot.snapshot)) ?? []),
]

/** The keys an append source's parts hold. */
const keysOf = (source: PinnedSource): SourceKeys => {
    const keys: SourceKeys = { roots: new Set(), nodes: new Set(), chunks: new Set() }
    for (const part of sourceParts(source)) {
        for (const key of Object.keys(part.roots)) keys.roots.add(key)
        for (const key of Object.keys(part.nodes)) keys.nodes.add(key)
        for (const [key] of part.chunks) keys.chunks.add(key)
    }
    return keys
}

const sourceRevision = (source: PinnedSource): RevisionForm | undefined => {
    const project = source.projectJson
    const revision = isObject(project) ? project.revision : undefined
    return isObject(revision) &&
        typeof revision.id === 'string' &&
        Array.isArray(revision.ancestors)
        ? (revision as RevisionForm)
        : undefined
}

const withShift = (stack: EntryForm['stack'], offset: number): EntryForm['stack'] =>
    stack && offset
        ? { keep: Math.max(0, stack.keep - offset), push: stack.push, index: stack.index - offset }
        : stack

const keyOf = (row: RowKey) => `${row.sessionId}:${row.seq}`

/** An entry form's `noteCount`, left out when it's unknown (never written as 0). */
const withCount = (noteCount: number | undefined) => (noteCount === undefined ? {} : { noteCount })

/** The chain as this write sees it: its stored identity and binding, or the tab's in memory. */
const chainOf = (stored: ChainRecord, identity: IdentityInput | undefined): ChainRecord => {
    if (!identity) return stored
    const { revision: _revision, file: _file, ...rest } = stored
    return {
        ...rest,
        docId: identity.docId,
        ...(identity.revision ? { revision: identity.revision } : {}),
        ...(identity.file ? { file: { ...identity.file } } : {}),
    }
}

/**
 * The chain's rows with this tab's unflushed ones of the saved session after its stored ones:
 * only rows above the session's last stored `seq`, so no row is taken twice.
 */
const withPending = (
    cut: ChainCut,
    rows: readonly ChainRow[],
    sessionId: string | undefined,
    pending: PendingInput | undefined,
    identity: IdentityInput | undefined,
): ChainRow[] => {
    if (!pending?.entries.length || sessionId === undefined) return [...rows]
    const stored = cut.entries.get(sessionId) ?? []
    const last = stored.reduce((max, entry) => Math.max(max, entry.seq), -Infinity)
    const entry = identity?.file?.entry
    const startedAt =
        cut.sessions.find((session) => session.id === sessionId)?.startedAt ??
        pending.startedAt ??
        (entry?.sessionId === sessionId ? entry.startedAt : Number.MAX_SAFE_INTEGER)
    const added: ChainRow[] = pending.entries
        .filter((row) => row.seq > last)
        .map((row) => ({
            startedAt,
            entry: {
                sessionId,
                seq: row.seq,
                time: row.time,
                ...captureEntryDescription(row),
                snapshot: fromHex16(row.snapshot),
                ...withCount(row.noteCount),
                dirty: row.dirty,
                kept: true,
                ...(row.revisionId === undefined ? {} : { revisionId: row.revisionId }),
                ...(row.device ? { device: row.device } : {}),
                ...(row.appVersion === undefined ? {} : { appVersion: row.appVersion }),
                ...(row.stack
                    ? {
                          stack: {
                              keep: row.stack.keep,
                              push: row.stack.push.map(slotOf),
                              index: row.stack.index,
                          },
                      }
                    : {}),
            },
        }))
    let at = rows.length
    while (at > 0 && rows[at - 1]?.entry.sessionId !== sessionId) at--
    if (!at) at = rows.length
    return [...rows.slice(0, at), ...added, ...rows.slice(at)]
}

/**
 * Plans a `.nxsp` write of a chain (§1.6.11.6). `sources` are the pinned sources' metadata
 * (`inspectNxsp`); only `append` reads them, besides the media rule's copies. Damage in storage is
 * marked before the plan is final; a refusal says why nothing can be planned.
 */
export const planSave = async (
    store: SaveStore,
    chainId: string,
    target: SaveTarget,
    options: SaveOptions,
    sources: readonly PinnedSource[] = [],
): Promise<SavePlan | SaveRefusal> => {
    const savedSession =
        target.kind === 'new' ? (target.sessionId ?? options.sessionId) : options.sessionId
    // The consistent cut: one read-only transaction.
    const stored = await store
        .read(CUT_STORES, (tx) => readCut(tx, chainId, savedSession))
        .catch(() => undefined)
    const cut: ChainCut | undefined =
        stored ??
        (options.unstored && options.pending
            ? {
                  chain: options.unstored,
                  sessions: [],
                  entries: new Map(),
                  unreadable: 0,
                  sessionId: savedSession,
              }
            : undefined)
    if (!cut) return refuse('noChain')
    const chain = chainOf(cut.chain, options.identity)
    const pending = options.pending
    let rows: ChainRow[]
    try {
        checkReadable(cut)
        rows = withPending(
            cut,
            chainRows(cut, target.kind === 'new' ? target.sessionId : undefined),
            cut.sessionId,
            pending,
            options.identity,
        )
    } catch (error) {
        if (error instanceof ModelError) return refuse(error.reason)
        throw error
    }
    if (cut.sessions.some((session) => session.importPending)) return refuse('importing')

    // The append source: the chain's own file at the base (its revision id and `<cd>`).
    let source: PinnedSource | undefined
    if (target.kind === 'append') {
        source = sources.find((each) => each.token === target.source)
        if (!source) throw new PlanError(`No source ${target.source}`)
        const revision = sourceRevision(source)
        const disk = chain.file?.disk
        const cd = centralDirectoryOf(source.fingerprint)
        if (
            !revision ||
            revision.id !== chain.revision?.id ||
            !disk ||
            cd === undefined ||
            cd !== centralDirectoryOf(disk.fingerprint)
        )
            return refuse('notAtBase')
    }
    // A file's history is never stripped (H-5): an append source with a manifest is appended to,
    // whatever option is passed. A source without history gains it when the option includes it:
    // its one version, its head, is a state of the chain's rows, which are written whole.
    const appending = !!source?.manifest
    const history = appending || options.history
    if (appending && !options.history)
        console.error('A write-back’s history option differs from its file’s; the file’s is kept', {
            chainId,
        })
    const cutEntry = chain.file?.entry
    let sourceKeys: SourceKeys | undefined
    if (appending && source) {
        if (!cutEntry) return refuse('notAtBase')
        try {
            sourceKeys = keysOf(source)
        } catch {
            return refuse('damagedSource')
        }
    }

    // The rows this write adds: after the cut for an append, the whole chronology otherwise.
    const own = appending && cutEntry ? rows.filter((row) => isLater(row, cutEntry)) : rows
    const stack = writeStack(cut, rows, pending)
    const headSlot = stack?.slots[stack.index - stack.base]
    if (history && (!stack || !headSlot)) return refuse('unreadableHead')
    const headSnapshot = headSlot?.snapshot ?? rows.at(-1)?.entry.snapshot
    if (!headSnapshot) return refuse('unreadableHead')
    const head = toHex(headSnapshot)

    // Rows flagged before this build: stored `kept: false`, or marked by an earlier write whose
    // binding is still in memory.
    const priorMarks = new Set((options.identity?.marks ?? []).map(keyOf))
    const flaggedBefore = (entry: EntryRow) => !entry.kept || priorMarks.has(keyOf(entry))

    // Bodies: every root the rows, their pushes, the stack and the head need, verified. Without
    // history only the head is written: the stack's other states are neither read nor marked.
    const wanted = new Set<string>([
        head,
        ...(history ? (stack?.slots.map((slot) => toHex(slot.snapshot)) ?? []) : []),
    ])
    if (history)
        for (const { entry } of own)
            if (!flaggedBefore(entry)) for (const hex of rowSnapshots(entry)) wanted.add(hex)
    const loadFrom = {
        ...(pending ? { pending: pending.records } : {}),
        ...(sourceKeys ? { source: sourceKeys } : {}),
    }
    let bodies: Bodies
    try {
        bodies = await loadBodies(store, wanted, loadFrom)
        // Flagged rows' states too, when storage still holds them whole (H-2); a miss is no damage.
        const flaggedStates = new Set<string>()
        if (history)
            for (const { entry } of own)
                if (flaggedBefore(entry))
                    for (const hex of rowSnapshots(entry))
                        if (!bodies.complete.has(hex)) flaggedStates.add(hex)
        if (flaggedStates.size)
            takeWhole(bodies, await loadBodies(store, flaggedStates, loadFrom), flaggedStates)
    } catch (error) {
        if (error instanceof ModelError) return refuse(error.reason)
        throw error
    }
    let headInput = options.head?.snapshot === head ? options.head : undefined
    if (!headInput) {
        // Decoded from storage: the head's own bodies, whatever the source holds.
        const headBodies = sourceKeys
            ? await loadBodies(store, [head], pending ? { pending: pending.records } : {})
            : bodies
        if (!isWhole(headBodies, head)) return refuse('unreadableHead')
        try {
            headInput = headFromBodies(headBodies, head)
        } catch {
            return refuse('unreadableHead')
        }
    } else if (!isWhole(bodies, head)) return refuse('unreadableHead')

    // Damage in storage: rows whose state isn't whole become `kept: false`, marked before the
    // plan is final (§1.6.11.6).
    const needsMark = (entry: EntryRow) =>
        history &&
        !flaggedBefore(entry) &&
        rowSnapshots(entry).some((hex) => !bodies.complete.has(hex))
    const markRows = own.filter(({ entry }) => needsMark(entry)).map(({ entry }) => entry)
    const markedKeys = new Set(markRows.map(keyOf))
    const flagged = (entry: EntryRow) => flaggedBefore(entry) || markedKeys.has(keyOf(entry))

    // The media rule.
    const media: BuildInput['media'] = {}
    const without: MediaKind[] = []
    const tooLarge: MediaKind[] = []
    const damagedMedia: string[] = []
    const items: [MediaKind, MediaRef | undefined][] = [
        ['bgm', options.bgm ? headInput.bgm : undefined],
        ['cover', headInput.levelInfo.cover],
        ['preview', headInput.levelInfo.preview],
    ]
    for (const [kind, ref] of items) {
        if (!ref) continue
        const held = options.media?.find((each) => each.hash === ref.hash)
        const item = await planMediaItem(store, kind, ref, {
            ...(held ? { held } : {}),
            ...(source ? { source } : {}),
        })
        media[kind] = item.input satisfies MediaInput
        if (item.without) without.push(kind)
        if (item.tooLarge) tooLarge.push(kind)
        if (item.damaged) damagedMedia.push(ref.hash)
    }

    const damaged = [...new Set([...bodies.bad, ...damagedMedia])]
    let markStored = true
    if (markRows.length || damaged.length)
        markStored = (await markDamaged(store, chainId, markRows, damaged)) !== undefined
    const marks = new Map<string, RowKey>()
    for (const { sessionId, seq } of [...(options.identity?.marks ?? []), ...markRows])
        marks.set(keyOf({ sessionId, seq }), { sessionId, seq })

    // `completeFrom`, the carry test (D25) and the line (§1.6.11.6).
    const baseHadHistory = !!chain.revision && bindingHasHistory(chain.file)
    const baseOf = chain.revision ? { revisionId: chain.revision.id } : undefined
    const sessionStored = (sessionId: string) =>
        cut.sessions.some((session) => session.id === sessionId)
    const carried =
        !appending &&
        !!baseOf &&
        !!cutEntry &&
        carryStatus(rows, cutEntry, baseOf, sessionStored, (row) => flagged(row.entry)) ===
            'carries'
    let completeFrom: string | undefined
    if (appending && source) completeFrom = placedCompleteFrom(sourceRevision(source))
    else if (carried && target.kind !== 'new' && chain.revision)
        completeFrom = chain.file?.completeFrom ?? chain.revision.id

    // The revision.
    const revisionId = options.context.newId()
    const fresh = target.kind === 'new'
    const parent = fresh ? null : (chain.revision?.id ?? null)
    const ancestors =
        fresh || !chain.revision
            ? []
            : [chain.revision.id, ...chain.revision.ancestors].slice(0, ANCESTOR_LIMIT)
    const n = fresh ? 1 : (chain.revision?.n ?? 0) + 1

    const device = documentDevice(options.context.device, chain.lineageId)
    const saveEntry: EntryForm & { noteCount: number; device: DeviceForm } = {
        kind: 'save',
        time: options.save.time,
        operation: captureOperation(options.save.operation),
        snapshot: head,
        noteCount: headInput.summary.noteCount,
        revisionId,
        device,
        appVersion: options.context.appVersion,
    }

    let historyInput: HistoryInput | undefined
    if (history) {
        if (!stack || !headSlot) return refuse('unreadableHead')
        // A row that doesn't say its note count takes its state's, from the root this write
        // verified (PF2-5): a count is never made up as 0. A row whose root no source holds has
        // an unknown count, and the entry is written without one.
        const countOf = (entry: EntryRow) => {
            if (entry.noteCount !== undefined) return entry.noteCount
            const count = bodies.roots.get(toHex(entry.snapshot))?.[3]
            return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
                ? count
                : undefined
        }
        const entries: EntryForm[] = []
        for (const { entry } of own)
            entries.push({
                ...captureEntryDescription(entry),
                time: entry.time,
                snapshot: toHex(entry.snapshot),
                ...withCount(countOf(entry)),
                ...(entry.dirty ? { dirty: true as const } : {}),
                ...(flagged(entry) ? { kept: false as const } : {}),
                ...(entry.revisionId === undefined ? {} : { revisionId: entry.revisionId }),
                ...(entry.device ? { device: entry.device } : {}),
                ...(entry.appVersion === undefined ? {} : { appVersion: entry.appVersion }),
                ...(entry.stack
                    ? {
                          stack: {
                              keep: entry.stack.keep,
                              push: entry.stack.push.map((slot) => ({
                                  snapshot: toHex(slot.snapshot),
                                  step: captureStep(slot.step),
                              })),
                              index: entry.stack.index,
                          },
                      }
                    : {}),
                ...(entry.x ? { x: entry.x } : {}),
            })
        entries.push(saveEntry)

        // The undo stack: cut at slots the file doesn't hold, numbered by replay of the file.
        const cutSlots = cutStack(stack, (slot) => bodies.complete.has(toHex(slot.snapshot)))
        const replayed: ReplayEntry[] = []
        let seq = 0
        const toReplay = (form: EntryForm) =>
            replayed.push({
                seq: seq++,
                ...captureEntryDescription(form),
                snapshot: fromHex16(form.snapshot),
                ...(form.stack
                    ? {
                          stack: {
                              keep: form.stack.keep,
                              push: form.stack.push.map(slotOf),
                              index: form.stack.index,
                          },
                      }
                    : {}),
            })
        if (appending && source)
            for (const part of sourceParts(source)) part.entries.forEach(toReplay)
        entries.forEach(toReplay)
        const renumbered = renumbering(replayed, cutSlots.index)
        const held = (slot: ReplaySlot) => bodies.complete.has(toHex(slot.snapshot))
        let undoStack: WriteStack
        if (renumbered) {
            const { offset, replayed: file } = renumbered
            let base = cutSlots.base - offset
            let slots = cutSlots.slots
            if (base < 0) {
                slots = slots.slice(-base)
                base = 0
            }
            const agrees = slots.every((slot, i) => {
                const own = file.slots[base + i]
                return !!own && equalBytes(own.snapshot, slot.snapshot)
            })
            if (agrees) {
                if (offset)
                    for (const form of entries)
                        if (form.stack) form.stack = withShift(form.stack, offset)
                undoStack = { base, slots, index: cutSlots.index - offset }
            } else {
                // Sessions removed from the chain's middle: replay of the file gives another
                // stack than the session's, and replay defines the stack (§1.3.9).
                console.warn('A Save’s undo stack is replay’s of its file', { chainId })
                undoStack = cutStack({ base: 0, slots: [...file.slots], index: file.index }, held)
            }
        } else {
            // Replay can't follow the chronology (a session removed from its middle): the stack
            // is cut to its head, so no slot claims a number replay doesn't give.
            console.warn(
                'A Save could not replay its chronology; its undo stack is the head only',
                {
                    chainId,
                },
            )
            undoStack = { base: 0, slots: [headSlot], index: 0 }
        }

        historyInput = {
            ...(appending && source ? { append: source.token } : {}),
            entries,
            roots: bodies.roots,
            nodes: bodies.nodes,
            chunks: bodies.chunks,
            undoStack: {
                base: undoStack.base,
                slots: undoStack.slots.map((slot) => ({
                    snapshot: toHex(slot.snapshot),
                    step: captureStep(slot.step),
                })),
                index: undoStack.index,
            },
        }
    }

    const docId = fresh ? target.docId : chain.docId
    const input: BuildInput = {
        context: {
            now: options.context.now,
            // The first id is the revision's, which the `save` entry already carries.
            newId: (() => {
                let first = true
                return () => {
                    if (first) {
                        first = false
                        return revisionId
                    }
                    return options.context.newId()
                }
            })(),
            device,
            appVersion: options.context.appVersion,
        },
        id: docId,
        lineageId: chain.lineageId,
        ...(fresh || chain.exportName === undefined ? {} : { exportName: chain.exportName }),
        revision: {
            parent,
            n,
            ancestors,
            ...(target.kind === 'replace' ? { replaces: target.replaces } : {}),
            ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
            ...(completeFrom === undefined ? {} : { completeFrom }),
        },
        levelVersion: headInput.levelVersion,
        level: headInput.level,
        editor: headInput.editor,
        summary: headInput.summary,
        levelInfo: headInput.levelInfo,
        headBgm: headInput.bgm?.hash ?? null,
        media,
        ...(chain.extra ? { extra: chain.extra } : {}),
        ...(historyInput ? { history: historyInput } : {}),
    }

    let plan: WritePlan
    let project: Record<string, unknown>
    let storageChunks: PlannedChunk[]
    try {
        const result = planNxsp(input, source ? [source] : [])
        plan = hooks.plan ? hooks.plan(result.plan) : result.plan
        project = result.project
        storageChunks = result.storageChunks
        if (appending && source) assertAppend(plan, source)
    } catch (error) {
        if (error instanceof PlanError) {
            console.error('A save plan failed', error)
            return refuse('plan', error.message, error.limit)
        }
        throw error
    }

    // The binding's counts: the file's rows, and those whose root it lacks. An append onto a
    // base whose own row is absent or replaced, or whose cut was inexact, leaves an inexact cut.
    let entry: SaveIdentity['entry']
    let roots = new Set<string>()
    if (historyInput) {
        const parts = plannedParts(plan, appending ? source : undefined)
        roots = new Set(parts.flatMap((part) => Object.keys(part.roots)))
        let count = 0
        let lacking = 0
        for (const part of parts)
            for (const form of part.entries) {
                count++
                if (!roots.has(form.snapshot)) lacking++
            }
        const own =
            appending && baseOf && cutEntry ? ownRow(rows, cutEntry, baseOf, sessionStored) : 'held'
        entry = {
            count,
            notKept: lacking,
            ...(appending && (cutEntry?.inexact || own === 'absent' || own === 'replaced')
                ? { inexact: true as const }
                : {}),
        }
    }
    // The line, by what is known (I-18): the plan's roots say which states the write lacks.
    let stepsLine: SavePlan['stepsLine'] = 'none'
    if (history && !appending && baseHadHistory && !carried && baseOf && cutEntry)
        stepsLine =
            carryStatus(
                rows,
                cutEntry,
                baseOf,
                sessionStored,
                (row) => flagged(row.entry),
                (row) => !roots.has(toHex(row.entry.snapshot)),
            ) === 'missing'
                ? 'notKept'
                : 'mayNotBeIncluded'
    const written = plannedProject(plan).revision
    const writtenFrom =
        isObject(written) && typeof written.completeFrom === 'string'
            ? written.completeFrom
            : undefined

    return {
        plan,
        revisionId,
        project,
        storageChunks,
        stepsLine,
        without,
        tooLarge,
        identity: {
            ...(fresh ? { clearExport: true as const } : {}),
            docId,
            revision: { id: revisionId, n, ancestors },
            ...(writtenFrom === undefined ? {} : { completeFrom: writtenFrom }),
            ...(entry ? { entry } : {}),
            marks: [...marks.values()],
        },
        saveEntry,
        damaged,
        marked: markRows.length,
        markStored,
    }
}
