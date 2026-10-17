import type { State } from '../state'
import type { Store } from '../state/store'
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
import type { KindName } from './records/schema'
import { headerMedia } from './records/snapshot'
import { splitKind } from './records/split'

// The main thread's half of a flush (Part 1 §1.6.2, §1.6.4): records for the changed windows only,
// through the identity memo. Records are encoded once per entity (per-slide note arrays, event
// and time-scale entities, BPMs) and chunks are matched by their members' identity, so
// serializing costs in proportion to the edit. A chunk sent but not hashed yet is held as a
// pending promise and never sent twice. The memo is only a hint: the worker's closure check
// decides what is stored (§1.6.6).

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

    add(text: string, kind: KindName | 'header') {
        this.texts.push(text)
        this.kinds.push(kind)
        return this.texts.length - 1
    }

    header(text: string) {
        let id = this.headers.get(text)
        if (id === undefined) this.headers.set(text, (id = this.add(text, 'header')))
        return id
    }

    get size() {
        let size = 0
        for (const text of this.texts) size += text.length
        return size
    }
}

/** A chunk the memo knows by its members: hashed and stored, or pending in a batch. */
export type ChunkMemo = {
    readonly members: readonly object[]
    hash?: Uint8Array
    /** The epoch at which it was last known stored (§1.6.6). */
    epoch?: number
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

/**
 * The identity memo and the extraction. One per tab: a worker restart resets it (§1.6.5), and
 * a closure check that finds windows missing forgets only those (§1.6.6).
 */
export class Extractor {
    /** The last extraction's records, so a record is encoded once while its entity lives on. */
    private records = new Map<object, RecordMemo>()
    private next = new Map<object, RecordMemo>()
    private chunks = new WeakMap<object, ChunkMemo[]>()
    /** Records encoded since the last reset: a test's measure of the memo's work. */
    encoded = 0

    /** Forgets everything, after a worker restart. */
    reset() {
        this.records = new Map()
        this.next = new Map()
        this.chunks = new WeakMap()
    }

    private record(entity: object, key: number, encode: () => Rec): Item {
        let memo = this.next.get(entity) ?? this.records.get(entity)
        if (!memo) {
            memo = { text: canonical(encode()), key }
            this.encoded++
        }
        this.next.set(entity, memo)
        return { entity, key: memo.key, text: memo.text }
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

    /** A batch was stored: its chunks' hashes, and the epoch its transaction read. */
    settle(batch: ChunkBatch, hashes: readonly Uint8Array[], epoch: number) {
        for (const memo of batch.introduced) {
            const pending = memo.pending
            if (!pending) continue
            const hash = hashes[pending.id]
            if (!hash) throw new Error('A stored batch is missing a chunk hash')
            memo.hash = hash
            memo.epoch = epoch
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

    /** Marks reused chunks as checked at an epoch: the worker found them stored. */
    confirm(memos: Iterable<ChunkMemo>, epoch: number) {
        for (const memo of memos) if (memo.hash) memo.epoch = epoch
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
     * A state's snapshot plan, as a job that yields between slices of work. The records memo
     * then holds only this state's entities.
     */
    *plan(state: State, batch: ChunkBatch): Generator<void, SnapshotPlan> {
        this.next = new Map()
        const header = headerRecord(state, {
            bgmOffset: state.bgm.offset,
            levelInfo: state.levelInfo,
            ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
        })
        const headerId = batch.header(canonical(header))
        const kinds: { kind: KindName; chunks: PlannedChunk[] }[] = []
        let noteCount = 0
        const ordered = yield* this.orderGen(state.store)
        for (const [kind, items] of ordered) {
            if (kind === 'slides')
                for (const item of items) noteCount += (item.entity as unknown[]).length
            yield
            const parts = splitKind(kind, items as unknown as KeyedRecord[]) as unknown as Item[][]
            const chunks: PlannedChunk[] = []
            for (const [i, part] of parts.entries()) {
                chunks.push(this.chunk(part, kind, batch))
                if (i % 16 === 15) yield
            }
            if (chunks.length) kinds.push({ kind, chunks })
        }
        this.records = this.next
        return {
            header: headerId,
            kinds,
            noteCount,
            media: headerMedia(header).map(toHex),
        }
    }

    /** Each kind's items in the v1 order (§1.6.11.1), as `orderStore` gives them. */
    private *orderGen(store: Store): Generator<void, [KindName, Item[]][]> {
        const { grid, slides, globalEventRanges, stageEventRanges } = store
        const slideItems: Item[] = []
        let n = 0
        for (const notes of slides.note.values()) {
            const first = notes[0]
            if (!first) continue
            slideItems.push(this.record(notes, first.beat, () => slideRecord(notes)))
            if (++n % 256 === 0) yield
        }
        slideItems.sort((a, b) => a.key - b.key || compareText(a.text, b.text))

        const events = <T extends { beat: number }>(
            entities: readonly T[],
            track: (entity: T) => number,
            encode: (entity: T) => Rec,
        ): Item[] =>
            entities
                .map((entity, index) => ({
                    item: this.record(entity, entity.beat, () => encode(entity)),
                    track: track(entity),
                    index,
                }))
                .sort((a, b) => a.item.key - b.item.key || a.track - b.track || a.index - b.index)
                .map(({ item }) => item)

        const kinds: [KindName, Item[]][] = [['slides', slideItems]]
        kinds.push(['bpms', events(entitiesOf(grid.bpm), () => 0, bpmRecord)])
        yield
        kinds.push([
            'timeScales',
            events(entitiesOf(grid.timeScale), (e) => e.groupId, timeScaleRecord),
        ])
        yield
        kinds.push([
            'cameraEvents',
            events(
                inChainOrder(
                    grid.cameraEventJoint,
                    grid.cameraEventConnection,
                    globalEventRanges.cameraEventJoint
                        ? [globalEventRanges.cameraEventJoint.min]
                        : [],
                ),
                () => 0,
                cameraEventRecord,
            ),
        ])
        yield
        kinds.push([
            'stageMaskEvents',
            events(
                inChainOrder(
                    grid.stageMaskEventJoint,
                    grid.stageMaskEventConnection,
                    stageHeads(stageEventRanges.stageMaskEventJoint),
                ),
                (e) => e.stageId,
                stageMaskEventRecord,
            ),
        ])
        yield
        kinds.push([
            'stagePivotEvents',
            events(
                inChainOrder(
                    grid.stagePivotEventJoint,
                    grid.stagePivotEventConnection,
                    stageHeads(stageEventRanges.stagePivotEventJoint),
                ),
                (e) => e.stageId,
                stagePivotEventRecord,
            ),
        ])
        yield
        kinds.push([
            'stageStyleEvents',
            events(
                inChainOrder(
                    grid.stageStyleEventJoint,
                    grid.stageStyleEventConnection,
                    stageHeads(stageEventRanges.stageStyleEventJoint),
                ),
                (e) => e.stageId,
                stageStyleEventRecord,
            ),
        ])
        yield
        kinds.push([
            'stageTransformEvents',
            events(
                inChainOrder(
                    grid.stageTransformEventJoint,
                    grid.stageTransformEventConnection,
                    stageHeads(stageEventRanges.stageTransformEventJoint),
                ),
                (e) => e.stageId,
                stageTransformEventRecord,
            ),
        ])
        return kinds
    }
}

/** Runs a job in one go: on hide and before a switch (§1.6.4). */
export const runToEnd = <T>(job: Generator<void, T>): T => {
    for (;;) {
        const step = job.next()
        if (step.done) return step.value
    }
}

/** The about-8 ms slices a whole-chart extraction runs in (§1.6.4). */
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
 */
export const runSliced = <T>(
    job: Generator<void, T>,
    {
        onSlice,
        now = () => performance.now(),
    }: { onSlice?: (ms: number) => void; now?: () => number } = {},
): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const idle = (globalThis as IdleScope).requestIdleCallback
        const slice = (deadline?: IdleDeadline) => {
            const start = now()
            // Leave a margin under the slice: the last step may run past the check.
            const budget = Math.min(SLICE_MS - 2, deadline ? deadline.timeRemaining() : SLICE_MS)
            try {
                for (;;) {
                    const step = job.next()
                    if (step.done) {
                        onSlice?.(now() - start)
                        resolve(step.value)
                        return
                    }
                    if (now() - start >= Math.max(budget, 1)) break
                }
            } catch (error) {
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
