import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../../src/local/hash'
import { toRecords, type KeyedRecord } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { groupChunks, splitKind } from '../../../src/local/records/split'
import { createSlideId } from '../../../src/state/entities/slides'
import { addNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { edgeChart, goldenChart, note, stateOf } from './charts'

const keyed = (keys: number[]): KeyedRecord[] => keys.map((key, i) => ({ key, record: [key, i] }))
const sizes = (chunks: unknown[][]) => chunks.map((chunk) => chunk.length)

test('a window splits at 4 beats, then 1 beat, then into runs of 24', () => {
    // At most 24 in a window: one chunk per window.
    assert.deepEqual(sizes(splitKind('slides', keyed([0, 1, 15.9, 16, 40]))), [3, 1, 1])
    // 30 in a window, over two 4-beat parts.
    const window = [...Array(15).fill(0), ...Array(15).fill(4.5)] as number[]
    assert.deepEqual(sizes(splitKind('slides', keyed(window))), [15, 15])
    // 30 in one 4-beat part, over two 1-beat parts.
    const part = [...Array(15).fill(8), ...Array(15).fill(9.5)] as number[]
    assert.deepEqual(sizes(splitKind('slides', keyed(part))), [15, 15])
    // 30 in one beat: runs of 24 in order.
    const beat = Array.from({ length: 30 }, (_, i) => 12 + i / 64)
    const runs = splitKind('slides', keyed(beat))
    assert.deepEqual(sizes(runs), [24, 6])
    assert.deepEqual(
        runs.flat().map(({ record }) => record[1]),
        beat.map((_, i) => i),
    )
    // 25 at one beat: the window, its part and the beat each split.
    const mixed = [...Array(25).fill(0), 5] as number[]
    assert.deepEqual(sizes(splitKind('slides', keyed(mixed))), [24, 1, 1])
})

test('a kind other than slides with at most 64 records is one chunk', () => {
    const keys = Array.from({ length: 64 }, (_, i) => i * 0.25)
    assert.deepEqual(sizes(splitKind('bpms', keyed(keys))), [64])
    assert.deepEqual(sizes(splitKind('slides', keyed(keys))), [16, 16, 16, 16])
    assert.ok(splitKind('cameraEvents', keyed([...keys, 16])).length > 1)
})

test('the kind node groups chunks 16 at a time', () => {
    assert.deepEqual(groupChunks([1, 2, 3]), [[1, 2, 3]])
    assert.deepEqual(sizes(groupChunks(Array.from({ length: 33 }, (_, i) => i))), [16, 16, 1])
})

test('a note added to a window of 49 slides rewrites one chunk', () => {
    const fixture = goldenChart()
    // 49 slides in window 4 (beats 64–80), as dense as coconut's average.
    for (let i = 0; i < 49; i++) fixture.chart.slides.push([note(64 + i * 0.3, { left: i % 10 })])
    const before = stateOf(fixture)
    const transaction = createTransaction(before)
    addNote(transaction, createSlideId(), note(70.1, { left: 4 }))
    const after = transaction.commit([])
    const hashes = (state: typeof before) =>
        new Set(encodeSnapshot(toRecords(state)).chunks.map((chunk) => toHex(chunk.hash)))
    const old = hashes(before)
    const added = [...hashes(after)].filter((hash) => !old.has(hash))
    assert.equal(added.length, 1)
    assert.equal(old.size, hashes(after).size)
})

test('the edge chart has the 4-beat, 1-beat and run splits and a depth-1 slides node', () => {
    const snapshot = encodeSnapshot(toRecords(stateOf(edgeChart())))
    const slides = snapshot.chunks.filter((chunk) => chunk.kind === 'slides')
    const beats = (chunk: (typeof slides)[number]) =>
        chunk.json.map((slide) => ((slide as unknown[][])[0] as number[])[2] as number)
    const windowOf = (w: number) =>
        slides.filter((chunk) => Math.floor(beats(chunk)[0]! / 16) === w)
    assert.deepEqual(
        windowOf(2).map((chunk) => chunk.json.length),
        [15, 15],
    )
    assert.deepEqual(
        windowOf(3).map((chunk) => chunk.json.length),
        [15, 15],
    )
    assert.deepEqual(
        windowOf(4).map((chunk) => chunk.json.length),
        [24, 6],
    )
    assert.ok(slides.length > 16)
    assert.deepEqual(
        snapshot.nodes.filter((node) => node.kind === 'slides').map((node) => node.depth),
        [0, 0, 1],
    )
})
