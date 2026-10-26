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
import { createSlideId } from '../../../src/state/entities/slides'
import type { NoteEntity } from '../../../src/state/entities/slides/note'
import { addBpm, replaceBpm } from '../../../src/state/mutations/bpm'
import { addNote, removeNote, replaceNote } from '../../../src/state/mutations/slides/note'
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

const taps = (beats: number[], extra: Partial<NoteObject> = {}) =>
    createState(
        {
            ...goldenChart().chart,
            slides: beats.map((beat) => [note(beat, extra)]),
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
        },
        0,
    )

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

test('a record past the chart limits makes the change unknown: nothing is built from it', async () => {
    const base = stateOf(goldenChart())
    const past = edit(base, (t) => addNote(t, createSlideId(), note(maxBeat + 1)))
    const bpmPast = edit(base, (t) => addBpm(t, { beat: maxBeat + 1, bpm: 90, meter: 4 }))
    for (const [before, after] of [
        [past, base],
        [base, past],
        [bpmPast, base],
    ])
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
