import assert from 'node:assert/strict'
import test from 'node:test'
import { maxBeat } from '../../../src/chart/limits'
import type { NoteObject } from '../../../src/chart/note'
import {
    MARK_LIMIT,
    diffChanges,
    isMoved,
    summarizeChanges,
    touchesBeats,
    type ChangeSet,
} from '../../../src/local/changes/diff'
import { readCandidates, type PartSource } from '../../../src/local/changes/read'
import { stateCandidates, totalsOf } from '../../../src/local/changes/states'
import { toHex } from '../../../src/local/hash'
import type { RecordValue } from '../../../src/local/records/canonical'
import { noteObjectOf } from '../../../src/local/records/extract'
import { toRecords } from '../../../src/local/records/records'
import type { KindName } from '../../../src/local/records/schema'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import type { State } from '../../../src/state'
import { createState } from '../../../src/state'
import type { Entity } from '../../../src/state/entities'
import { createSlideId } from '../../../src/state/entities/slides'
import type { NoteEntity } from '../../../src/state/entities/slides/note'
import { addBpm, replaceBpm } from '../../../src/state/mutations/bpm'
import { addNote, removeNote, replaceNote } from '../../../src/state/mutations/slides/note'
import { flipVerticalWithReceipt } from '../../../src/state/operations/flipVertical'
import { createTransaction, type Transaction } from '../../../src/state/transaction'
import { edgeChart, goldenChart, note, stateOf } from '../records/charts'

// The change view's diff: the records two snapshots differ in, paired into
// objects added, removed and changed; by hash in the worker and by identity in the page, with
// the same answer.

type Rec = readonly RecordValue[]

/** Every part of the states' snapshots, as the worker's reads would give them. */
const memorySource = (...states: State[]): PartSource & { reads: string[] } => {
    const roots = new Map<string, { header: string; kinds: Map<KindName, string> }>()
    const nodes = new Map<string, { depth: 0 | 1; children: string[] }>()
    const chunks = new Map<string, Rec[]>()
    for (const state of states) {
        const encoded = encodeSnapshot(toRecords(state))
        roots.set(toHex(encoded.root.hash), {
            header: toHex(encoded.root.header),
            kinds: new Map(encoded.root.kinds.map(([kind, hash]) => [kind, toHex(hash)])),
        })
        for (const node of encoded.nodes)
            nodes.set(toHex(node.hash), { depth: node.depth, children: node.children.map(toHex) })
        for (const chunk of encoded.chunks) chunks.set(toHex(chunk.hash), [...chunk.json] as Rec[])
    }
    const reads: string[] = []
    return {
        reads,
        root: (hex) => Promise.resolve(roots.get(hex)),
        node: (hex) => Promise.resolve(nodes.get(hex)),
        chunk: (hex) => {
            reads.push(hex)
            return Promise.resolve(chunks.get(hex))
        },
    }
}

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

/** The worker's answer: narrowed by hash. */
const byHash = async (before: State, after: State, source = memorySource(before, after)) => {
    const input = await readCandidates(source, rootOf(before), rootOf(after))
    assert.ok(input)
    return diffChanges(input, totalsOf(after))
}

/** The page's answer: narrowed by identity. */
const byIdentity = (before: State, after: State) =>
    diffChanges(stateCandidates(before, after), totalsOf(after))

/** Both, checked equal. */
const diff = async (before: State, after: State): Promise<ChangeSet> => {
    const worker = await byHash(before, after)
    assert.deepEqual(byIdentity(before, after), worker, 'the page and the worker agree')
    return worker
}

const notesOf = (state: State) =>
    [...state.store.slides.note.values()].flat().sort((a, b) => a.beat - b.beat || a.left - b.left)

const edit = (state: State, change: (transaction: Transaction, notes: NoteEntity[]) => void) => {
    const transaction = createTransaction(state)
    change(transaction, notesOf(state))
    return transaction.commit([])
}

const replace = (t: Transaction, entity: NoteEntity, extra: Partial<NoteObject>) =>
    replaceNote(t, entity, { ...noteObjectOf(entity), ...extra })

/** The golden chart's header and BPM changes with these slides and no other events. */
const chart = (slides: NoteObject[][], bpms = goldenChart().chart.bpms) =>
    createState(
        {
            ...goldenChart().chart,
            slides,
            bpms,
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
        },
        0,
    )

const taps = (beats: number[], extra: Partial<NoteObject> = {}) =>
    chart(beats.map((beat) => [note(beat, extra)]))

const statuses = (set: ChangeSet) =>
    set.objects.map((object) => `${object.kind}:${object.status}@${object.beat}`)

test('equal states change nothing; a header edit is no object', async () => {
    const state = stateOf(goldenChart())
    const same = await diff(state, state)
    assert.deepEqual(same, {
        objects: [],
        counts: {
            slides: 0,
            bpms: 0,
            timeScales: 0,
            cameraEvents: 0,
            stageMaskEvents: 0,
            stagePivotEvents: 0,
            stageStyleEvents: 0,
            stageTransformEvents: 0,
        },
        header: false,
        layout: 'none',
    })
    const life = { ...state, initialLife: 500 }
    const header = await diff(state, life)
    assert.equal(header.header, true)
    assert.equal(header.layout, 'none')
})

test('an added and a removed note', async () => {
    const before = taps([0, 1, 2, 3])
    const added = edit(before, (t) => addNote(t, createSlideId(), note(1.5, { left: 2 })))
    assert.deepEqual(statuses(await diff(before, added)), ['slides:added@1.5'])
    const removed = edit(before, (t, notes) => removeNote(t, notes[2]!))
    assert.deepEqual(statuses(await diff(before, removed)), ['slides:removed@2'])
})

test('a property change is one note changed in place, with no ghost', async () => {
    const before = taps([0, 1, 2])
    const after = edit(before, (t, notes) => replace(t, notes[1]!, { isCritical: true }))
    const set = await diff(before, after)
    assert.deepEqual(statuses(set), ['slides:changed@1'])
    assert.equal(isMoved(set.objects[0]!), false)
})

test('a move pairs with the nearest within the bound; a far delete and add is not a move', async () => {
    const before = taps([0, 4, 8])
    const near = edit(before, (t, notes) => replace(t, notes[1]!, { beat: 5, left: 3 }))
    const moved = await diff(before, near)
    assert.deepEqual(statuses(moved), ['slides:changed@5'])
    assert.equal(isMoved(moved.objects[0]!), true)
    assert.equal(moved.objects[0]!.from?.[2], 4)

    const far = edit(before, (t, notes) => replace(t, notes[0]!, { beat: 40 }))
    assert.deepEqual(statuses(await diff(before, far)), ['slides:removed@0', 'slides:added@40'])
})

test('eight identical notes moved one lane pair each with its own', async () => {
    const before = taps([0, 1, 2, 3, 4, 5, 6, 7], { isCritical: true })
    const after = edit(before, (t, notes) => {
        for (const entity of notes) replace(t, entity, { left: entity.left + 1 })
    })
    const set = await diff(before, after)
    assert.equal(set.objects.length, 8)
    for (const object of set.objects) {
        assert.equal(object.status, 'changed')
        assert.equal(object.from?.[2], object.beat)
    }
})

test('a flip pairs notes by their mirror; a note the flip maps onto itself is unchanged', async () => {
    const before = createState(
        {
            ...goldenChart().chart,
            slides: [
                [note(0, { left: -4, size: 2, flickDirection: 'upLeft' })],
                [note(0, { left: 1, size: 2 })],
                [note(1, { left: -1, size: 2 })],
            ],
        },
        0,
    )
    const after = edit(before, (t, notes) => {
        for (const entity of notes) {
            const flick = { upLeft: 'upRight', upRight: 'upLeft' }[entity.flickDirection as string]
            replace(t, entity, {
                left: -(entity.left + entity.size),
                ...(flick ? { flickDirection: flick as NoteObject['flickDirection'] } : {}),
            })
        }
    })
    const set = await diff(before, after)
    const notes = set.objects.filter((object) => object.kind === 'slides')
    // The centred note at beat 1 flips onto itself.
    assert.equal(notes.length, 2)
    for (const object of notes) {
        assert.equal(object.status, 'changed')
        const from = object.from!
        assert.equal(object.left, -((from[8] as number) + (from[9] as number)))
    }
})

test('one tick added to a slide marks one note, and Edits Here finds only its beat', async () => {
    const before = createState(
        {
            ...goldenChart().chart,
            slides: [[note(0), note(4), note(8), note(16)]],
        },
        0,
    )
    const after = edit(before, (t, notes) =>
        addNote(t, notes[0]!.slideId, note(6, { isAttached: true }), notes[1]),
    )
    const set = await diff(before, after)
    assert.deepEqual(
        statuses(set).filter((s) => s.startsWith('slides')),
        ['slides:added@6'],
    )
    const input = await readCandidates(memorySource(before, after), rootOf(before), rootOf(after))
    const summary = summarizeChanges(input!)
    assert.deepEqual(summary.beats, [6])
    assert.equal(touchesBeats(summary.beats, 0, 4), false)
    assert.equal(touchesBeats(summary.beats, 5, 7), true)
})

test('a reordered stack or a changed slide connection marks only the notes and events it moved', async () => {
    const flip = (state: State, entities: Entity[]) =>
        flipVerticalWithReceipt(state, entities).state
    const bpmsOf = (state: State) => [...state.store.grid.bpm.values()].flatMap((b) => [...b])
    /** The changed objects' beats on both paths, and the beats Edits Here finds. */
    const beatsOf = async (before: State, after: State) => {
        const set = await diff(before, after)
        const beats = [...new Set(set.objects.map((object) => object.beat))].sort((a, b) => a - b)
        const input = await readCandidates(
            memorySource(before, after),
            rootOf(before),
            rootOf(after),
        )
        assert.deepEqual(summarizeChanges(input!).beats, beats, 'Edits Here finds the same beats')
        return { set, beats }
    }

    const stack = chart(
        [],
        [
            { beat: 0, bpm: 120, meter: 4 },
            { beat: 4, bpm: 180, meter: 4 },
            { beat: 4, bpm: 90, meter: 4 },
        ],
    )
    const swapped = edit(stack, (t) => {
        const [, fast, slow] = bpmsOf(stack)
        replaceBpm(t, fast!, { beat: 4, bpm: 90, meter: 4 })
        replaceBpm(t, slow!, { beat: 4, bpm: 180, meter: 4 })
    })
    const reordered = await beatsOf(stack, swapped)
    assert.deepEqual(reordered.beats, [4])
    assert.equal(reordered.set.counts.bpms, 2)
    for (const object of reordered.set.objects) {
        assert.equal(object.status, 'changed')
        assert.equal(isMoved(object), false)
    }
    // An edit to the first of the pair is that change alone, as before.
    const edited = edit(stack, (t) =>
        replaceBpm(t, bpmsOf(stack)[1]!, { beat: 4, bpm: 200, meter: 4 }),
    )
    assert.deepEqual(statuses(await diff(stack, edited)), ['bpms:changed@4'])

    // Two slides flipped: [A, A, B, A] at 4 becomes [A, B, A, A]; [C, D] at 0 and 8 reverse.
    const a = (beat: number) => note(beat, { left: -2 })
    const b = (beat: number) => note(beat, { left: 2 })
    const c = (beat: number) => note(beat, { left: -4 })
    const d = (beat: number) => note(beat, { left: 4 })
    const two = chart([
        [note(2), a(4), a(4), b(4), a(4), note(6)],
        [c(0), d(0), c(8), d(8)],
    ])
    const flipped = await beatsOf(two, flip(two, notesOf(two)))
    // The endpoints at 2 and 6 keep their neighbours.
    assert.deepEqual(flipped.beats, [0, 4, 8])
    assert.equal(flipped.set.counts.slides, 7)

    // A long slide flipped: only the stack moved; the notes at 99 and 101 keep theirs.
    const long = chart([
        Array.from({ length: 201 }, (_, beat) =>
            beat === 100 ? [a(100), a(100), b(100), a(100)] : [note(beat)],
        ).flat(),
    ])
    const longFlipped = await beatsOf(long, flip(long, notesOf(long)))
    assert.deepEqual(longFlipped.beats, [100])
    assert.equal(longFlipped.set.counts.slides, 3)

    // Two taps combined into a slide, and split again.
    const apart = chart([[note(2)], [note(4)]])
    const joined = chart([[note(2), note(4)]])
    for (const [before, after] of [
        [apart, joined],
        [joined, apart],
    ] as const) {
        const { set, beats } = await beatsOf(before, after)
        assert.deepEqual(beats, [2, 4])
        assert.equal(set.counts.slides, 2)
    }

    // Three runs of 24 BPM changes at 4 permuted: whole stored chunks change place.
    const runs = chart(
        [],
        [
            { beat: 0, bpm: 120, meter: 4 },
            { beat: 2, bpm: 100, meter: 4 },
            ...[180, 90, 120].flatMap((bpm) =>
                Array.from({ length: 24 }, () => ({ beat: 4, bpm, meter: 4 })),
            ),
            { beat: 6, bpm: 100, meter: 4 },
        ],
    )
    const permuted = flip(
        runs,
        bpmsOf(runs).filter((bpm) => bpm.beat > 0),
    )
    const input = await readCandidates(memorySource(runs, permuted), rootOf(runs), rootOf(permuted))
    assert.ok(input!.kinds.some((kind) => kind.before.length && kind.after.length))
    const runBeats = await beatsOf(runs, permuted)
    assert.deepEqual(runBeats.beats, [4])
    assert.equal(runBeats.set.counts.bpms, 48)
})

test('connection changes count toward the layout and keep their marks in the most layout', async () => {
    const beatsOf = async (before: State, after: State) => {
        const set = await diff(before, after)
        const beats = [...new Set(set.objects.map((object) => object.beat))].sort((a, b) => a - b)
        const input = await readCandidates(
            memorySource(before, after),
            rootOf(before),
            rootOf(after),
        )
        assert.deepEqual(summarizeChanges(input!).beats, beats, 'Edits Here finds the same beats')
        return { set, beats }
    }
    const every = (count: number) => Array.from({ length: count }, (_, beat) => beat)

    // 200 taps combined into one slide: 200 of 202 objects changed, and nothing else.
    const joined = await beatsOf(
        chart(every(200).map((beat) => [note(beat)])),
        chart([every(200).map((beat) => note(beat))]),
    )
    assert.equal(joined.set.layout, 'most')
    assert.equal(joined.set.counts.slides, 200)
    assert.ok(joined.set.objects.every((object) => object.status === 'changed'))
    assert.deepEqual(joined.beats, every(200))

    // 400 taps combined while the first 340 lose Slide Critical: the other 60 keep their marks.
    const critical = (beat: number) => note(beat, { connectorActiveIsCritical: beat < 340 })
    const mixed = await beatsOf(
        chart(every(400).map((beat) => [critical(beat)])),
        chart([every(400).map((beat) => note(beat))]),
    )
    assert.equal(mixed.set.layout, 'most')
    assert.deepEqual(mixed.beats, every(400))
    assert.deepEqual(
        mixed.set.objects.filter((object) => object.status === 'changed').map((o) => o.beat),
        every(400).slice(340),
    )
    assert.equal(mixed.set.counts.slides, 340 + 340 + 60)
})

test('a record past the chart limits makes the change unknown: nothing is built from it', async () => {
    const base = stateOf(goldenChart())
    const past = edit(base, (t) => addNote(t, createSlideId(), note(maxBeat + 1)))
    const bpmPast = edit(base, (t) => addBpm(t, { beat: maxBeat + 1, bpm: 90, meter: 4 }))
    const pairs: [State, State][] = [
        [past, base],
        [base, past],
        [bpmPast, base],
    ]
    for (const [before, after] of pairs)
        assert.equal(
            await readCandidates(memorySource(before, after), rootOf(before), rootOf(after)),
            undefined,
        )
    const within = edit(base, (t) => addNote(t, createSlideId(), note(maxBeat)))
    assert.ok(await readCandidates(memorySource(base, within), rootOf(base), rootOf(within)))
})

test('events: a BPM changed in place, a BPM added', async () => {
    const before = stateOf(goldenChart())
    const bpm = [...before.store.grid.bpm.values()].flatMap((bucket) => [...bucket])[1]!
    const changed = edit(before, (t) => replaceBpm(t, bpm, { beat: 8, bpm: 180, meter: 3 }))
    assert.deepEqual(statuses(await diff(before, changed)), ['bpms:changed@8'])
    const added = edit(before, (t) => addBpm(t, { beat: 12, bpm: 90, meter: 4 }))
    assert.deepEqual(statuses(await diff(before, added)), ['bpms:added@12'])
})

test('a 25th record in a full window re-splits chunks and is still one added note', async () => {
    const beats = Array.from({ length: 24 }, (_, i) => 32 + i * 0.5)
    const before = taps(beats)
    const after = edit(before, (t) => addNote(t, createSlideId(), note(40.25, { left: 3 })))
    const source = memorySource(before, after)
    const set = await byHash(before, after, source)
    assert.deepEqual(statuses(set), ['slides:added@40.25'])
    assert.deepEqual(byIdentity(before, after), set)
    // The split read several chunks a side.
    assert.ok(source.reads.length > 2)
})

test('a two-level kind reads only the leaf that changed', async () => {
    const before = stateOf(edgeChart())
    const target = notesOf(before).find((entity) => entity.beat === 21 * 16 + 1)!
    const after = edit(before, (t) => replace(t, target, { isCritical: true }))
    const source = memorySource(before, after)
    const set = await byHash(before, after, source)
    assert.deepEqual(statuses(set), [`slides:changed@${21 * 16 + 1}`])
    assert.equal(source.reads.length, 2)
})

test('a missing part makes the change unknown', async () => {
    const before = taps([0, 1])
    const after = edit(before, (t, notes) => removeNote(t, notes[0]!))
    const source = memorySource(before, after)
    const missing: PartSource = { ...source, chunk: () => Promise.resolve(undefined) }
    assert.equal(await readCandidates(missing, rootOf(before), rootOf(after)), undefined)
    assert.equal(await readCandidates(source, rootOf(before), 'f'.repeat(32)), undefined)
})

test('the layouts: small up to the limit, large past it, most from 80% of the objects', async () => {
    const count = 400
    const before = taps(Array.from({ length: count }, (_, i) => i * 0.25))
    const changeFirst = (n: number) =>
        edit(before, (t, notes) => {
            for (const entity of notes.slice(0, n)) replace(t, entity, { isCritical: true })
        })
    const small = await diff(before, changeFirst(MARK_LIMIT))
    assert.equal(small.layout, 'small')
    assert.equal(small.counts.slides, MARK_LIMIT)
    const large = await diff(before, changeFirst(MARK_LIMIT + 1))
    assert.equal(large.layout, 'large')
    assert.equal(large.objects.length, MARK_LIMIT + 1)
    // 330 of 402 objects (the chart keeps its two BPM changes).
    const most = await diff(before, changeFirst(330))
    assert.equal(most.layout, 'most')
    assert.equal(most.objects.length, 660)
    assert.equal(most.objects.filter((object) => object.status === 'added').length, 330)
    assert.equal(most.counts.slides, 660)
})

test('the page and the worker agree across the golden and edge charts', async () => {
    for (const fixture of [goldenChart(), edgeChart()]) {
        const before = stateOf(fixture)
        const after = edit(before, (t, notes) => {
            removeNote(t, notes[0]!)
            replace(t, notes[3]!, { left: notes[3]!.left + 0.5 })
            replace(t, notes.at(-1)!, { isCritical: !notes.at(-1)!.isCritical })
            addNote(t, createSlideId(), note(7.75, { left: -3 }))
        })
        const set = await diff(before, after)
        assert.ok(set.objects.length >= 4)
        // Unrelated states, as one read from storage and one in memory, give the same answer.
        assert.deepEqual(byIdentity(stateOf(fixture), after), set)
    }
})

test('dense candidate pairing is bounded even inside a mostly unchanged chart', () => {
    const before = createState(
        { ...edgeChart().chart, slides: Array.from({ length: 400 }, () => [note(4, { left: 1 })]) },
        0,
    )
    const after = createState(
        { ...edgeChart().chart, slides: Array.from({ length: 400 }, () => [note(5, { left: 2 })]) },
        0,
    )
    const set = diffChanges(stateCandidates(before, after), { notes: 100_000, events: 0 })
    assert.equal(set.layout, 'most')
    assert.equal(set.objects.length, 800)
    assert.equal(set.objects.filter((object) => object.status === 'removed').length, 400)
    assert.equal(set.objects.filter((object) => object.status === 'added').length, 400)
})

test('event footprints detect horizontal moves at the same beat', () => {
    for (const [kind, lane] of [
        ['cameraEvents', 1],
        ['stageMaskEvents', 2],
        ['stagePivotEvents', 2],
        ['stageStyleEvents', 2],
        ['stageTransformEvents', 3],
        ['timeScales', 2],
    ] as const) {
        const record = toRecords(stateOf(goldenChart())).kinds.find(
            (candidate) => candidate.kind === kind,
        )!.records[0]!.record
        const moved = [...record]
        moved[lane] = (record[lane] as number) + 15
        const set = diffChanges({
            header: false,
            kinds: [{ kind, before: [record], after: [moved] }],
        })
        assert.equal(set.objects.length, 1)
        assert.equal(isMoved(set.objects[0]!), true, kind)
        assert.equal(set.objects[0]!.left, moved[lane], kind)
    }
})
