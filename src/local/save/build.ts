import { centralDirectoryOf } from '../../platform/fingerprint'
import type { BgmMeta } from '../../state/bgm'
import type { LevelInfo, MediaRef } from '../../state/levelInfo'
import { inflateStrict } from '../chunkVerify'
import { fromHex16, toHex } from '../hash'
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
import { PlanError, type PinnedSource, type WritePlan } from '../nxsp/plan'
import { placedCompleteFrom, type DeviceForm, type RevisionForm } from '../nxsp/project'
import { stateFromRecords } from '../records/records'
import { decodeSnapshot } from '../records/snapshot'
import { replay, ReplayError, type ReplayEntry, type ReplaySlot } from '../timeline'
import { assertAppend, plannedParts, plannedProject, sourceParts } from './assert'
import {
    isWhole,
    loadBodies,
    type Bodies,
    type PendingRecords,
    type SaveStore,
    type SourceKeys,
} from './bodies'
import { CUT_STORES, readCut, type ChainCut, type EntryRow } from './cut'
import { markDamaged } from './mark'
import { planMediaItem, type HeldMedia, type MediaKind } from './media'
import {
    carries,
    chainRows,
    checkReadable,
    cutStack,
    isLater,
    ModelError,
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

/** An entry this tab hasn't flushed yet, after the stored ones of the saved session. */
export type PendingRow = {
    seq: number
    time: number
    kind: string
    label: string
    /** Its state's root, as hex. */
    snapshot: string
    noteCount: number
    dirty: boolean
    stack?: { keep: number; push: { snapshot: string; label: string }[]; index: number }
}

/** This tab's unflushed part of the saved session: its rows, its live stack and their records. */
export type PendingInput = {
    entries: PendingRow[]
    /** The live undo stack, absolute numbers in the session's numbering. */
    stack?: { base: number; slots: { snapshot: string; label: string }[]; index: number }
    records: PendingRecords
}

/** The head's level data and header, from the page's live state (else decoded from storage). */
export type HeadInput = {
    level: unknown
    editor: { defaultGuideColors?: readonly number[] }
    summary: { noteCount: number; durationMs: number }
    levelInfo: LevelInfo
    bgm?: BgmMeta
    levelVersion: number
}

export type SaveOptions = {
    /** History included: the binding's option, or the Save dialog's tick for a new file. */
    history: boolean
    /** The head's BGM included: `options.bgm`, false only by the user's untick (§1.6.11.6). */
    bgm: boolean
    /** `revision.fileName`: the name this write uses. */
    fileName?: string
    /** This write's `save` entry, created before the build: its time and label. */
    save: { time: number; label: string }
    context: { now: number; newId: () => string; device: DeviceForm; appVersion: string }
    /** The saved session: the chain's head unless given (Save to File… gives its own). */
    sessionId?: string
    pending?: PendingInput
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

export type SaveRefusal = { refused: SaveRefusalReason; message?: string }

/** The identity unit a write that binds commits after it (§1.3.2, §1.6.11.6). */
export type SaveIdentity = {
    docId: string
    revision: { id: string; n: number; ancestors: string[] }
    /** As written, placed; absent without history. */
    completeFrom?: string
    /** The cut's counts; the caller adds the `save` entry's `sessionId`, `seq` and `startedAt`. */
    entry?: { count: number; notKept: number }
}

export type SavePlan = {
    plan: WritePlan
    revisionId: string
    project: Record<string, unknown>
    /** For the post-build check: chunks taken from storage. */
    storageChunks: PlannedChunk[]
    /** "Some earlier steps were not kept." (§1.6.11.6): exactly when the write doesn't carry its base. */
    someStepsNotKept: boolean
    /** Media written as metadata only (the "without its …" lines), in BGM, cover, preview order. */
    without: MediaKind[]
    identity: SaveIdentity
    /** The `save` entry the file ends with. */
    saveEntry: EntryForm
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

const refuse = (refused: SaveRefusalReason, message?: string): SaveRefusal => ({
    refused,
    ...(message === undefined ? {} : { message }),
})

export const isRefusal = (value: unknown): value is SaveRefusal =>
    isObject(value) && typeof value.refused === 'string'

const slotOf = (slot: { snapshot: string; label: string }): ReplaySlot => ({
    snapshot: fromHex16(slot.snapshot),
    label: slot.label,
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
        const last = rows.at(-1)?.entry
        return (
            last && { base: 0, slots: [{ snapshot: last.snapshot, label: last.label }], index: 0 }
        )
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

const pendingSnapshots = (row: PendingRow) => [
    row.snapshot,
    ...(row.stack?.push.map((slot) => slot.snapshot) ?? []),
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
    const cut = await store.read(CUT_STORES, (tx) => readCut(tx, chainId, savedSession))
    if (!cut) return refuse('noChain')
    const { chain } = cut
    let rows: ChainRow[]
    try {
        checkReadable(cut)
        rows = chainRows(cut, target.kind === 'new' ? target.sessionId : undefined)
    } catch (error) {
        if (error instanceof ModelError) return refuse(error.reason)
        throw error
    }
    if (cut.sessions.some((session) => session.importPending)) return refuse('importing')
    const pending = options.pending

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
    const appending = target.kind === 'append' && options.history
    const cutEntry = chain.file?.entry
    let sourceKeys: SourceKeys | undefined
    if (appending && source) {
        if (!source.manifest || !cutEntry) return refuse('notAtBase')
        try {
            sourceKeys = keysOf(source)
        } catch {
            return refuse('damagedSource')
        }
    }

    // The rows this write adds: after the cut for an append, the whole chronology otherwise.
    const own = appending && cutEntry ? rows.filter((row) => isLater(row, cutEntry)) : rows
    const stack = writeStack(cut, rows, pending)
    if (!stack) return refuse('unreadableHead')
    const head = toHex((stack.slots[stack.index - stack.base] as ReplaySlot).snapshot)

    // Bodies: every root the rows, their pushes, the stack and the head need, verified.
    const wanted = new Set<string>([head, ...stack.slots.map((slot) => toHex(slot.snapshot))])
    if (options.history) {
        for (const { entry } of own)
            if (entry.kept) for (const hex of rowSnapshots(entry)) wanted.add(hex)
        for (const row of pending?.entries ?? [])
            for (const hex of pendingSnapshots(row)) wanted.add(hex)
    }
    let bodies: Bodies
    try {
        bodies = await loadBodies(store, wanted, {
            ...(pending ? { pending: pending.records } : {}),
            ...(sourceKeys ? { source: sourceKeys } : {}),
        })
    } catch (error) {
        if (error instanceof ModelError) return refuse(error.reason)
        throw error
    }
    let headInput = options.head
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

    // Damage in storage: stored rows whose state isn't whole become `kept: false`, marked
    // before the plan is final (§1.6.11.6).
    const needsMark = (entry: EntryRow) =>
        options.history &&
        entry.kept &&
        rowSnapshots(entry).some((hex) => !bodies.complete.has(hex))
    const markRows = own.filter(({ entry }) => needsMark(entry)).map(({ entry }) => entry)
    const markedKeys = new Set(markRows.map((entry) => `${entry.sessionId}:${entry.seq}`))
    const isMarked = (entry: EntryRow) => markedKeys.has(`${entry.sessionId}:${entry.seq}`)

    // The media rule.
    const media: BuildInput['media'] = {}
    const without: MediaKind[] = []
    const damagedMedia: string[] = []
    const items: [MediaKind, MediaRef | undefined][] = [
        ['bgm', options.bgm ? headInput.bgm : undefined],
        ['cover', headInput.levelInfo.cover],
        ['preview', headInput.levelInfo.preview],
    ]
    for (const [kind, ref] of items) {
        if (!ref) continue
        const item = await planMediaItem(store, kind, ref, {
            ...(options.media?.find((held) => held.hash === ref.hash)
                ? { held: options.media.find((held) => held.hash === ref.hash) }
                : {}),
            ...(source ? { source } : {}),
        })
        media[kind] = item.input satisfies MediaInput
        if (item.without) without.push(kind)
        if (item.damaged) damagedMedia.push(ref.hash)
    }

    const damaged = [...new Set([...bodies.bad, ...damagedMedia])]
    let markStored = true
    if (markRows.length || damaged.length)
        markStored = await markDamaged(store, chainId, markRows, damaged)

    // `completeFrom`, the carry test and the line (§1.6.11.6).
    const baseHadHistory = !!(chain.revision && cutEntry)
    const notKept = (row: ChainRow) => !row.entry.kept || isMarked(row.entry)
    const carried = !appending && baseHadHistory && !!cutEntry && carries(rows, cutEntry, notKept)
    let completeFrom: string | undefined
    if (appending && source) completeFrom = placedCompleteFrom(sourceRevision(source))
    else if (carried && target.kind !== 'new' && chain.revision)
        completeFrom = chain.file?.completeFrom ?? chain.revision.id
    const someStepsNotKept = options.history && !appending && baseHadHistory && !carried

    // The revision.
    const revisionId = options.context.newId()
    const fresh = target.kind === 'new'
    const parent = fresh ? null : (chain.revision?.id ?? null)
    const ancestors =
        fresh || !chain.revision
            ? []
            : [chain.revision.id, ...chain.revision.ancestors].slice(0, ANCESTOR_LIMIT)
    const n = fresh ? 1 : (chain.revision?.n ?? 0) + 1

    const saveEntry: EntryForm = {
        kind: 'save',
        time: options.save.time,
        label: options.save.label,
        snapshot: head,
        noteCount: headInput.summary.noteCount,
        revisionId,
        device: options.context.device,
    }

    let history: HistoryInput | undefined
    if (options.history) {
        const entries: EntryForm[] = []
        for (const { entry } of own)
            entries.push({
                kind: entry.kind as EntryForm['kind'],
                time: entry.time,
                label: entry.label,
                snapshot: toHex(entry.snapshot),
                noteCount: entry.noteCount,
                ...(entry.dirty ? { dirty: true as const } : {}),
                ...(!entry.kept || isMarked(entry) ? { kept: false as const } : {}),
                ...(entry.revisionId === undefined ? {} : { revisionId: entry.revisionId }),
                ...(entry.device ? { device: entry.device } : {}),
                ...(entry.stack
                    ? {
                          stack: {
                              keep: entry.stack.keep,
                              push: entry.stack.push.map((slot) => ({
                                  snapshot: toHex(slot.snapshot),
                                  label: slot.label,
                              })),
                              index: entry.stack.index,
                          },
                      }
                    : {}),
                ...(entry.x ? { x: entry.x } : {}),
            })
        for (const row of pending?.entries ?? [])
            entries.push({
                kind: row.kind as EntryForm['kind'],
                time: row.time,
                label: row.label,
                snapshot: row.snapshot,
                noteCount: row.noteCount,
                ...(row.dirty ? { dirty: true as const } : {}),
                ...(pendingSnapshots(row).some((hex) => !bodies.complete.has(hex))
                    ? { kept: false as const }
                    : {}),
                ...(row.stack ? { stack: row.stack } : {}),
            })
        entries.push(saveEntry)

        // The undo stack: cut at slots the file doesn't hold, numbered by replay of the file.
        const cutSlots = cutStack(stack, (slot) => bodies.complete.has(toHex(slot.snapshot)))
        const replayed: ReplayEntry[] = []
        let seq = 0
        const toReplay = (form: EntryForm) =>
            replayed.push({
                seq: seq++,
                kind: form.kind,
                label: form.label,
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
        const offset = renumbering(replayed, cutSlots.index)
        let base = cutSlots.base - offset
        let slots = cutSlots.slots
        if (base < 0) {
            slots = slots.slice(-base)
            base = 0
        }
        if (offset)
            for (const form of entries) if (form.stack) form.stack = withShift(form.stack, offset)

        history = {
            ...(appending && source ? { append: source.token } : {}),
            entries,
            roots: bodies.roots,
            nodes: bodies.nodes,
            chunks: bodies.chunks,
            undoStack: {
                base,
                slots: slots.map((slot) => ({ snapshot: toHex(slot.snapshot), label: slot.label })),
                index: cutSlots.index - offset,
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
            device: options.context.device,
            appVersion: options.context.appVersion,
        },
        id: docId,
        lineageId: chain.lineageId,
        ...(chain.name === undefined ? {} : { name: chain.name }),
        ...(chain.exportName === undefined ? {} : { exportName: chain.exportName }),
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
        media,
        ...(chain.extra ? { extra: chain.extra } : {}),
        ...(history ? { history } : {}),
    }

    let plan: WritePlan
    let project: Record<string, unknown>
    let storageChunks: PlannedChunk[]
    try {
        const result = planNxsp(input, sources)
        plan = hooks.plan ? hooks.plan(result.plan) : result.plan
        project = result.project
        storageChunks = result.storageChunks
        if (appending && source) assertAppend(plan, source)
    } catch (error) {
        if (error instanceof PlanError) {
            console.error('A save plan failed', error)
            return refuse('plan', error.message)
        }
        throw error
    }

    // The binding's counts: the file's rows, and those whose state it doesn't hold.
    let entry: SaveIdentity['entry']
    if (history) {
        const parts = plannedParts(plan, appending ? source : undefined)
        const roots = new Set(parts.flatMap((part) => Object.keys(part.roots)))
        let count = 0
        let lacking = 0
        for (const part of parts)
            for (const form of part.entries) {
                count++
                if (!roots.has(form.snapshot)) lacking++
            }
        entry = { count, notKept: lacking }
    }
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
        someStepsNotKept,
        without,
        identity: {
            docId,
            revision: { id: revisionId, n, ancestors },
            ...(writtenFrom === undefined ? {} : { completeFrom: writtenFrom }),
            ...(entry ? { entry } : {}),
        },
        saveEntry,
        damaged,
        marked: markRows.length,
        markStored,
    }
}
