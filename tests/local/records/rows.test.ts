import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkRowOf, deflateChunk, verifyChunk } from '../../../src/local/chunkVerify'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { canonicalBytes } from '../../../src/local/records/canonical'
import { markReachable, UnknownNodeError, type MarkRow } from '../../../src/local/records/mark'
import { toRecords } from '../../../src/local/records/records'
import {
    hashKey,
    isChunkRowIntact,
    nodeJsonFromRow,
    nodeRow,
    packHashes,
    rootJsonFromRow,
    rootRow,
    unpackHashes,
    type NodesRow,
} from '../../../src/local/records/rows'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { useDay } from '../../helpers/useDay'
import { edgeChart, goldenChart, mediaHash, stateOf } from './charts'

const hashOf = (json: Parameters<typeof canonicalBytes>[0]) =>
    toHex(hash16Sync(canonicalBytes(json)))

test('a root row’s JSON form, rebuilt from its refs and kinds, hashes to its key', () => {
    for (const fixture of [goldenChart(), edgeChart()]) {
        const snapshot = encodeSnapshot(toRecords(stateOf(fixture)))
        const row = rootRow(snapshot.root, useDay(3))
        assert.equal(hashOf(rootJsonFromRow(row)), toHex(snapshot.root.hash))
        assert.equal(row.size, snapshot.root.bytes.length)
        assert.equal(row.day, 3)
        // refs: the header, the kind nodes in kinds order, then the media.
        const refs = unpackHashes(row.refs).map(toHex)
        assert.equal(refs[0], toHex(snapshot.header.hash))
        assert.deepEqual(
            refs.slice(1, 1 + row.kinds.length),
            snapshot.root.kinds.map(([, hash]) => toHex(hash)),
        )
        for (const node of snapshot.nodes)
            assert.equal(hashOf(nodeJsonFromRow(nodeRow(node, useDay(0)))), toHex(node.hash))
    }
    const golden = rootRow(encodeSnapshot(toRecords(stateOf(goldenChart()))).root, useDay(0))
    assert.deepEqual(unpackHashes(golden.refs).slice(-3).map(toHex), [
        mediaHash('cover'),
        mediaHash('preview'),
        mediaHash('bgm'),
    ])
})

test('the root lists a media hash once when it serves twice', () => {
    const fixture = goldenChart()
    const info = fixture.extras.levelInfo!
    fixture.extras.levelInfo = { ...info, preview: { ...info.preview!, hash: info.cover!.hash } }
    const snapshot = encodeSnapshot(toRecords(stateOf(fixture)))
    assert.deepEqual(snapshot.root.media.map(toHex), [mediaHash('cover'), mediaHash('bgm')])
})

test('packed hashes and keys are compact 16-byte runs', () => {
    const hashes = [hash16Sync(new Uint8Array([1])), hash16Sync(new Uint8Array([2]))]
    const packed = packHashes(hashes)
    assert.equal(packed.byteLength, 32)
    assert.deepEqual(unpackHashes(packed), hashes)
    assert.equal(unpackHashes(packed)[1]!.buffer.byteLength, 16)
    const digest = new Uint8Array(32).fill(9)
    assert.equal(hashKey(digest.subarray(0, 16)).byteLength, 16)
    assert.throws(() => packHashes([digest]), TypeError)
})

/** A `nodes` store of the snapshots' rows, keyed by hex. */
const nodesStore = (snapshots: ReturnType<typeof encodeSnapshot>[]) => {
    const rows = new Map<string, NodesRow>()
    for (const snapshot of snapshots) {
        rows.set(toHex(snapshot.root.hash), rootRow(snapshot.root, useDay(0)))
        for (const node of snapshot.nodes) rows.set(toHex(node.hash), nodeRow(node, useDay(0)))
    }
    return rows
}

test('GC marking reaches everything through direct-children refs, two-level nodes included', async () => {
    const edge = encodeSnapshot(toRecords(stateOf(edgeChart())))
    const golden = encodeSnapshot(toRecords(stateOf(goldenChart())))
    assert.ok(edge.nodes.some((node) => node.depth === 1))
    const rows = nodesStore([edge, golden])
    const marked = await markReachable([edge.root.hash], (hash) => rows.get(toHex(hash)))
    const expected = new Set([
        toHex(edge.root.hash),
        toHex(edge.header.hash),
        ...edge.chunks.map((chunk) => toHex(chunk.hash)),
        ...edge.nodes.map((node) => toHex(node.hash)),
        ...edge.root.media.map(toHex),
    ])
    assert.deepEqual(marked, expected)
    // The golden snapshot shares nothing with the edge one, so none of its own parts are marked.
    assert.ok(!marked.has(toHex(golden.root.hash)))
    assert.ok(!marked.has(toHex(golden.header.hash)))
})

test('GC marking aborts on a nodes row it cannot read', async () => {
    const golden = encodeSnapshot(toRecords(stateOf(goldenChart())))
    const rows = new Map<string, MarkRow>(nodesStore([golden]))
    const node = golden.nodes[0]!
    rows.set(toHex(node.hash), { t: 'tree', refs: packHashes([]) })
    await assert.rejects(
        markReachable([golden.root.hash], (hash) => rows.get(toHex(hash))),
        UnknownNodeError,
    )
})

test('a chunk row moved under another key fails its CRC', async () => {
    const snapshot = encodeSnapshot(toRecords(stateOf(goldenChart())))
    const [a, b] = snapshot.chunks
    assert.ok(a && b)
    const verified = await verifyChunk({
        hash: a.hash,
        stored: deflateChunk(a.bytes),
        canonical: a.bytes,
    })
    const row = chunkRowOf(verified, useDay(5))
    assert.ok(isChunkRowIntact(a.hash, row))
    assert.equal(isChunkRowIntact(b.hash, row), false)
    assert.equal(row.size, a.bytes.length)
    assert.equal(row.day, 5)
    assert.equal(row.bytes.byteLength, row.bytes.buffer.byteLength)
})
