import type { State } from '../state'
import type { NoteEntity } from '../state/entities/slides/note'
import type { Store } from '../state/store'
import type { KnownAt } from './flushWrite'
import { toHex } from './hash'
import { canonical, type RecordValue } from './records/canonical'
import {
    bpmRecord,
    cameraEventRecord,
    slideRecord,
    stageMaskEventRecord,
    stagePivotEventRecord,
    stageStyleEventRecord,
    stageTransformEventRecord,
    timeScaleRecord,
    type KeyedRecord,
} from './records/encode'
import { entitiesOf, inChainOrder, stageHeads } from './records/extract'
import { headerRecord } from './records/records'
import {
    checkHeader,
    checkRefs,
    headerIds,
    kindNames,
    kindRecords,
    type HeaderIds,
    type KindName,
} from './records/schema'
import { headerMedia } from './records/snapshot'
import { splitKind } from './records/split'

// The main thread's half of a flush: records for the changed windows only,
// through the identity memo. Records are encoded once per entity (per-slide note arrays, event
// and time-scale entities, BPMs) and chunks are matched by their members' identity, so
// serializing costs in proportion to the edit. A chunk sent but not hashed yet is held as a
// pending promise and never sent twice. The memo is only a hint: the worker's closure check
// decides what is stored.

type Rec = readonly RecordValue[]

/** A record's canonical text and window key, memoized per entity. */
type RecordMemo = { readonly text: string; readonly key: number }

/** An entity in the emission order with its record's text. */
type Item = { readonly entity: object; readonly key: number; readonly text: string }

/** One batch's new chunk texts; a chunk is never sent twice. */
export class ChunkBatch {
    readonly texts: string[] = []
    /** The kind each new chunk is of, for the worker's sizes and the inspector. */
    readonly kinds: (KindName | 'header')[] = []
    private readonly headers = new Map<string, number>()
    /** Memo entries this batch introduced, settled when it is acknowledged or fails. */
    readonly introduced: ChunkMemo[] = []
    /** The new text so far, in UTF-16 code units. */
    size = 0

    add(text: string, kind: KindName | 'header') {
        this.texts.push(text)
        this.kinds.push(kind)
        this.size += text.length
        return this.texts.length - 1
    }

    header(text: string) {
        let id = this.headers.get(text)
        if (id === undefined) this.headers.set(text, (id = this.add(text, 'header')))
        return id
    }
}

/** A chunk the memo knows by its members: hashed and stored, or pending in a batch. */
export type ChunkMemo = {
    readonly members: readonly object[]
    hash?: Uint8Array
    /** The database and epoch at which it was last known stored. */
    known?: KnownAt
    pending?: {
        readonly batch: ChunkBatch
        readonly id: number
        readonly promise: Promise<Uint8Array>
        resolve: (hash: Uint8Array) => void
        reject: (error: Error) => void
    }
}

/** A chunk of a snapshot plan: a stored hash, or a pending one (in this batch or an earlier one). */
export type PlannedChunk =
    | { readonly t: 'stored'; readonly memo: ChunkMemo; readonly hash: Uint8Array }
    | { readonly t: 'pending'; readonly memo: ChunkMemo }

export type SnapshotPlan = {
    readonly header: number
    readonly kinds: readonly { readonly kind: KindName; readonly chunks: PlannedChunk[] }[]
    readonly noteCount: number
    /** The media the header references, as hex: cover, preview and BGM, each once. */
    readonly media: readonly string[]
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** At most this many memo entries share a first member (different chunk boundaries). */
const SAME_FIRST_LIMIT = 4

/** Work between yields: records encoded, and chunks made. */
const RECORDS_PER_STEP = 64
const CHUNKS_PER_STEP = 4

/** What a kind's records come from: when all are the same objects, so are its records. */
type KindInputs = readonly unknown[]

type KindCache = {
    readonly inputs: KindInputs
    readonly items: Item[]
    /** Its entities' records, so a changed kind encodes only its changed entities. */
    readonly records: Map<object, RecordMemo>
}

/**
 * The identity memo and the extraction. One per tab: a worker restart resets it, and
 * a closure check that finds windows missing forgets only those. States are immutable
 * and share what an edit didn't touch, so an unchanged kind's maps are the same objects, and an
 * unchanged entity is the same object: neither is encoded again.
 */
export class Extractor {
    private kinds = new Map<KindName, KindCache>()
    private chunks = new WeakMap<object, ChunkMemo[]>()
    /** Records encoded since the last reset: a test's measure of the memo's work. */
    encoded = 0
    /**
     * Outside release builds, every snapshot is checked before it's sent for the group, stage
     * and folder ids its records name, so a bug fails here rather than storing a snapshot
     * this build can't read: new records as they're encoded, all of them when the ids change.
     */
    private readonly checking: boolean
    private ids: { key: string; ids: HeaderIds } | undefined

    constructor({ check = !isProduction() }: { check?: boolean } = {}) {
        this.checking = check
    }

    /** Forgets everything, after a worker restart. */
    reset() {
        this.kinds = new Map()
        this.chunks = new WeakMap()
    }

    /** The header's ids, checked; whether they changed since the last plan. */
    private headerIds(header: readonly RecordValue[]) {
        checkHeader(header)
        const ids = headerIds(header)
        const key = JSON.stringify(Object.values(ids).map((set) => [...set]))
        const changed = this.ids?.key !== key
        this.ids = { key, ids }
        return { ids, changed }
    }

    private chunk(members: readonly Item[], kind: KindName, batch: ChunkBatch): PlannedChunk {
        // splitKind never returns an empty chunk.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const first = members[0]!.entity
        const known = this.chunks.get(first)
        const memo = known?.find(
            (memo) =>
                memo.members.length === members.length &&
                memo.members.every((member, i) => member === members[i]?.entity),
        )
        if (memo?.hash) return { t: 'stored', memo, hash: memo.hash }
        if (memo) return { t: 'pending', memo }

        let text = '['
        for (let i = 0; i < members.length; i++) {
            if (i) text += ','
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            text += members[i]!.text
        }
        text += ']'
        const id = batch.add(text, kind)
        let resolve!: (hash: Uint8Array) => void
        let reject!: (error: Error) => void
        const promise = new Promise<Uint8Array>((res, rej) => {
            resolve = res
            reject = rej
        })
        // A batch that fails with no plan waiting on it rejects into the void.
        promise.catch(() => undefined)
        const created: ChunkMemo = {
            members: members.map(({ entity }) => entity),
            pending: { batch, id, promise, resolve, reject },
        }
        const list = known ?? []
        list.push(created)
        if (list.length > SAME_FIRST_LIMIT) list.shift()
        if (!known) this.chunks.set(first, list)
        batch.introduced.push(created)
        return { t: 'pending', memo: created }
    }

    /** A batch was stored: its chunks' hashes, and the database and epoch its transaction read. */
    settle(batch: ChunkBatch, hashes: readonly Uint8Array[], known: KnownAt) {
        for (const memo of batch.introduced) {
            const pending = memo.pending
            if (!pending) continue
            const hash = hashes[pending.id]
            if (!hash) throw new Error('A stored batch is missing a chunk hash')
            memo.hash = hash
            memo.known = known
            memo.pending = undefined
            pending.resolve(hash)
        }
    }

    /** A batch failed: its pending chunks are forgotten, so the next plan sends them again. */
    fail(batch: ChunkBatch, error: Error) {
        for (const memo of batch.introduced) {
            const pending = memo.pending
            if (pending?.batch !== batch) continue
            this.forget(memo)
            pending.reject(error)
        }
    }

    /** Marks reused chunks as checked in a database at an epoch: the worker found them stored. */
    confirm(memos: Iterable<ChunkMemo>, known: KnownAt) {
        for (const memo of memos) if (memo.hash) memo.known = known
    }

    /** Forgets the memo entries for hashes the closure check found missing. */
    forgetHashes(missing: ReadonlySet<string>, plans: readonly SnapshotPlan[]) {
        for (const plan of plans)
            for (const { chunks } of plan.kinds)
                for (const chunk of chunks)
                    if (chunk.t === 'stored' && missing.has(toHex(chunk.hash)))
                        this.forget(chunk.memo)
    }

    private forget(memo: ChunkMemo) {
        const first = memo.members[0]
        if (!first) return
        const list = this.chunks.get(first)
        const at = list?.indexOf(memo) ?? -1
        if (list && at >= 0) list.splice(at, 1)
    }

    /**
     * A state's snapshot plan, as a job that yields between slices of work. The memo then holds
     * this state's records.
     */
    *plan(state: State, batch: ChunkBatch): Generator<void, SnapshotPlan> {
        const header = headerRecord(state, {
            bgmOffset: state.bgm.offset,
            levelInfo: state.levelInfo,
            ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
        })
        const headerId = batch.header(canonical(header))
        const check = this.checking ? this.headerIds(header) : undefined
        const kinds: { kind: KindName; chunks: PlannedChunk[] }[] = []
        let noteCount = 0
        for (const kind of kindNames) {
            const items = yield* this.kindItems(kind, state.store, check?.ids)
            if (check?.changed)
                for (const item of items)
                    checkRefs(kindRecords[kind], JSON.parse(item.text), check.ids, kind)
            if (kind === 'slides')
                for (const item of items) noteCount += (item.entity as unknown[]).length
            const parts = splitKind(kind, items as unknown as KeyedRecord[]) as unknown as Item[][]
            yield
            const chunks: PlannedChunk[] = []
            for (const [i, part] of parts.entries()) {
                chunks.push(this.chunk(part, kind, batch))
                if (i % CHUNKS_PER_STEP === CHUNKS_PER_STEP - 1) yield
            }
            if (chunks.length) kinds.push({ kind, chunks })
        }
        return {
            header: headerId,
            kinds,
            noteCount,
            media: headerMedia(header).map(toHex),
        }
    }

    /** A kind's items in the v1 order, as `orderStore` gives them. */
    private *kindItems(kind: KindName, store: Store, ids?: HeaderIds): Generator<void, Item[]> {
        const source = kindSource(kind, store)
        const cached = this.kinds.get(kind)
        if (
            cached?.inputs.length === source.inputs.length &&
            cached.inputs.every((input, i) => input === source.inputs[i])
        )
            return cached.items
        const previous = cached?.records
        const records = new Map<object, RecordMemo>()
        const record = (entity: object, key: number, encode: () => Rec): Item => {
            let memo = previous?.get(entity) ?? records.get(entity)
            if (!memo) {
                const value = encode()
                if (ids) checkRefs(kindRecords[kind], value, ids, kind)
                memo = { text: canonical(value), key }
                this.encoded++
            }
            records.set(entity, memo)
            return { entity, key: memo.key, text: memo.text }
        }
        let items: Item[]
        if (source.kind === 'slides') {
            items = []
            let n = 0
            for (const notes of source.slides) {
                const first = notes[0]
                if (!first) continue
                items.push(record(notes, first.beat, () => slideRecord(notes)))
                if (++n % RECORDS_PER_STEP === 0) yield
            }
            items.sort((a, b) => a.key - b.key || compareText(a.text, b.text))
        } else {
            const placed: { item: Item; track: number; index: number }[] = []
            for (const [index, entity] of source.entities().entries()) {
                placed.push({
                    item: record(entity, entity.beat, () => source.encode(entity)),
                    track: source.track(entity),
                    index,
                })
                if (index % RECORDS_PER_STEP === RECORDS_PER_STEP - 1) yield
            }
            placed.sort((a, b) => a.item.key - b.item.key || a.track - b.track || a.index - b.index)
            items = placed.map(({ item }) => item)
        }
        this.kinds.set(kind, { inputs: source.inputs, items, records })
        return items
    }
}

type Beat = { beat: number }

// Vite sets it; Node tests have no import.meta.env.
const isProduction = () => (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true

type KindSource =
    | { kind: 'slides'; inputs: KindInputs; slides: Iterable<readonly NoteEntity[]> }
    | {
          kind: Exclude<KindName, 'slides'>
          inputs: KindInputs
          entities: () => Beat[]
          track: (entity: Beat) => number
          encode: (entity: Beat) => Rec
      }

const event = <T extends Beat>(
    kind: Exclude<KindName, 'slides'>,
    inputs: KindInputs,
    entities: () => T[],
    track: (entity: T) => number,
    encode: (entity: T) => Rec,
): KindSource => ({
    kind,
    inputs,
    entities,
    track: track as (entity: Beat) => number,
    encode: encode as (entity: Beat) => Rec,
})

/** Where a kind's records come from in a store, in `orderStore`'s order, and what decides them. */
const kindSource = (kind: KindName, store: Store): KindSource => {
    const { grid, slides, globalEventRanges, stageEventRanges } = store
    switch (kind) {
        case 'slides':
            return { kind, inputs: [slides.note], slides: slides.note.values() }
        case 'bpms':
            return event(
                kind,
                [grid.bpm],
                () => entitiesOf(grid.bpm),
                () => 0,
                bpmRecord,
            )
        case 'timeScales':
            return event(
                kind,
                [grid.timeScale],
                () => entitiesOf(grid.timeScale),
                (e) => e.groupId,
                timeScaleRecord,
            )
        case 'cameraEvents': {
            const range = globalEventRanges.cameraEventJoint
            return event(
                kind,
                [grid.cameraEventJoint, grid.cameraEventConnection, range],
                () =>
                    inChainOrder(
                        grid.cameraEventJoint,
                        grid.cameraEventConnection,
                        range ? [range.min] : [],
                    ),
                () => 0,
                cameraEventRecord,
            )
        }
        case 'stageMaskEvents': {
            const ranges = stageEventRanges.stageMaskEventJoint
            return event(
                kind,
                [grid.stageMaskEventJoint, grid.stageMaskEventConnection, ranges],
                () =>
                    inChainOrder(
                        grid.stageMaskEventJoint,
                        grid.stageMaskEventConnection,
                        stageHeads(ranges),
                    ),
                (e) => e.stageId,
                stageMaskEventRecord,
            )
        }
        case 'stagePivotEvents': {
            const ranges = stageEventRanges.stagePivotEventJoint
            return event(
                kind,
                [grid.stagePivotEventJoint, grid.stagePivotEventConnection, ranges],
                () =>
                    inChainOrder(
                        grid.stagePivotEventJoint,
                        grid.stagePivotEventConnection,
                        stageHeads(ranges),
                    ),
                (e) => e.stageId,
                stagePivotEventRecord,
            )
        }
        case 'stageStyleEvents': {
            const ranges = stageEventRanges.stageStyleEventJoint
            return event(
                kind,
                [grid.stageStyleEventJoint, grid.stageStyleEventConnection, ranges],
                () =>
                    inChainOrder(
                        grid.stageStyleEventJoint,
                        grid.stageStyleEventConnection,
                        stageHeads(ranges),
                    ),
                (e) => e.stageId,
                stageStyleEventRecord,
            )
        }
        case 'stageTransformEvents': {
            const ranges = stageEventRanges.stageTransformEventJoint
            return event(
                kind,
                [grid.stageTransformEventJoint, grid.stageTransformEventConnection, ranges],
                () =>
                    inChainOrder(
                        grid.stageTransformEventJoint,
                        grid.stageTransformEventConnection,
                        stageHeads(ranges),
                    ),
                (e) => e.stageId,
                stageTransformEventRecord,
            )
        }
    }
}

/** Runs a job in one go: on hide and before a switch. */
export const runToEnd = <T>(job: Generator<void, T>): T => {
    for (;;) {
        const step = job.next()
        if (step.done) return step.value
    }
}

/** The about-8 ms slices a whole-chart extraction runs in. */
export const SLICE_MS = 8

type IdleDeadline = { timeRemaining: () => number }
type IdleScope = {
    requestIdleCallback?: (
        fn: (deadline: IdleDeadline) => void,
        options?: { timeout: number },
    ) => number
}

/**
 * Runs a job in slices of about 8 ms: `requestIdleCallback` deadlines where there are any,
 * `setTimeout` slices otherwise (Safari has none). Each slice's length goes to `onSlice`.
 * `hurry` is handed a function that runs the rest at once, as a hide needs.
 */
export const runSliced = <T>(
    job: Generator<void, T>,
    {
        onSlice,
        hurry,
        now = () => performance.now(),
    }: {
        onSlice?: (ms: number) => void
        hurry?: (finish: () => void) => void
        now?: () => number
    } = {},
): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const idle = (globalThis as IdleScope).requestIdleCallback
        let settled = false
        hurry?.(() => {
            if (settled) return
            settled = true
            const start = now()
            try {
                const value = runToEnd(job)
                onSlice?.(now() - start)
                resolve(value)
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)))
            }
        })
        const slice = (deadline?: IdleDeadline) => {
            if (settled) return
            const start = now()
            // Half the slice, leaving room for the last step and a collection to run past it.
            const budget = Math.min(SLICE_MS / 2, deadline ? deadline.timeRemaining() : SLICE_MS)
            try {
                for (;;) {
                    const step = job.next()
                    if (step.done) {
                        settled = true
                        onSlice?.(now() - start)
                        resolve(step.value)
                        return
                    }
                    if (now() - start >= Math.max(budget, 1)) break
                }
            } catch (error) {
                settled = true
                reject(error instanceof Error ? error : new Error(String(error)))
                return
            }
            onSlice?.(now() - start)
            schedule()
        }
        const schedule = () => {
            if (idle) idle(slice, { timeout: 200 })
            else setTimeout(slice, 0)
        }
        schedule()
    })
