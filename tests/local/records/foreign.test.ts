import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateChunk } from '../../../src/local/chunkVerify'
import { hashKey } from '../../../src/local/db'
import { NewerRecordsError, type ForeignBatch } from '../../../src/local/foreign'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { keyText } from '../../../src/local/kv/keys'
import { canonicalBytes } from '../../../src/local/records/canonical'
import { toRecords } from '../../../src/local/records/records'
import { isChunkRowIntact, unpackHashes, type ChunkRow } from '../../../src/local/records/rows'
import { encodeSnapshot, type EncodedSnapshot } from '../../../src/local/records/snapshot'
import { openLocalData } from '../../../src/local/testing/db'
import { createWorld, type World } from '../../../src/local/testing/world'
import { openPage, rows, type Page } from '../flush/harness'
import { goldenChart, mediaHash, stateOf } from './charts'

// A foreign root's media `refs` come from its header chunk, and a root above v1 is
// "Needs a newer version", not damage.

const batchOf = (snapshot: EncodedSnapshot, withHeader = true, media?: string[]): ForeignBatch => ({
    roots: [snapshot.root.hash],
    nodes: [
        ...snapshot.nodes.map((node) => ({ hash: node.hash, bytes: node.bytes })),
        { hash: snapshot.root.hash, bytes: snapshot.root.bytes, ...(media ? { media } : {}) },
    ],
    chunks: [...(withHeader ? [snapshot.header] : []), ...snapshot.chunks].map((chunk) => ({
        hash: chunk.hash,
        stored: deflateChunk(chunk.bytes),
    })),
    media: [],
})

const importForeign = (page: Page, batch: ForeignBatch) =>
    page.tab.run(() => page.handlers.importForeign(batch))

const rootMedia = (world: World, snapshot: EncodedSnapshot) => {
    const row = rows(world, 'nodes').get(keyText(hashKey(snapshot.root.hash)))
    assert.ok(row)
    return unpackHashes(row.refs as Uint8Array)
        .slice(1 + snapshot.root.kinds.length)
        .map(toHex)
}

const goldenMedia = [mediaHash('cover'), mediaHash('preview'), mediaHash('bgm')]

test("a foreign root's media refs are its header's, whatever the caller passes", async () => {
    const world = createWorld({ seed: 11 })
    const page = await openPage(world, world.tab('a'))
    const snapshot = encodeSnapshot(toRecords(stateOf(goldenChart())))
    // The caller names other media: refused, nothing written.
    await assert.rejects(importForeign(page, batchOf(snapshot, true, [goldenMedia[0]!])))
    assert.equal(rows(world, 'nodes').size, 0)
    // The caller names none: they come from the header.
    assert.equal((await importForeign(page, batchOf(snapshot))).kind, 'stored')
    assert.deepEqual(rootMedia(world, snapshot), goldenMedia)
})

test('a root whose header is already stored takes its media from the stored header', async () => {
    const world = createWorld({ seed: 12 })
    const page = await openPage(world, world.tab('a'))
    const first = encodeSnapshot(toRecords(stateOf(goldenChart())))
    assert.equal((await importForeign(page, batchOf(first))).kind, 'stored')
    // Another slide: the same header, sent without it.
    const edited = goldenChart()
    edited.chart.slides.push([{ ...edited.chart.slides[0]![0]!, beat: 7 }])
    const third = encodeSnapshot(toRecords(stateOf(edited)))
    assert.equal(toHex(third.header.hash), toHex(first.header.hash))
    assert.equal((await importForeign(page, batchOf(third, false))).kind, 'stored')
    assert.deepEqual(rootMedia(world, third), goldenMedia)
})

test('a stored header whose CRC fails counts as missing, and the copy sent heals it', async () => {
    const world = createWorld({ seed: 13 })
    const tab = world.tab('a')
    const page = await openPage(world, tab)
    const first = encodeSnapshot(toRecords(stateOf(goldenChart())))
    assert.equal((await importForeign(page, batchOf(first))).kind, 'stored')
    const db = await openLocalData(tab)
    const key = hashKey(first.header.hash)
    await tab.run(() =>
        db.transaction(['chunks'], 'readwrite', async (tx) => {
            const row = (await tx.get('chunks', key)) as ChunkRow
            const bytes = row.bytes.map((byte, i) => (i === 2 ? byte ^ 4 : byte))
            await tx.put('chunks', { ...row, bytes }, key)
        }),
    )
    const edited = goldenChart()
    edited.chart.slides.push([{ ...edited.chart.slides[0]![0]!, beat: 7 }])
    const next = encodeSnapshot(toRecords(stateOf(edited)))
    const missing = await importForeign(page, batchOf(next, false))
    assert.deepEqual(missing, { kind: 'missing', hashes: [toHex(first.header.hash)] })
    assert.equal(rows(world, 'nodes').get(keyText(hashKey(next.root.hash))), undefined)
    assert.equal((await importForeign(page, batchOf(next))).kind, 'stored')
    assert.deepEqual(rootMedia(world, next), goldenMedia)
    const healed = rows(world, 'chunks').get(keyText(key)) as unknown as ChunkRow
    assert.ok(isChunkRowIntact(first.header.hash, healed))
})

test('a foreign root above v1 is a newer version, not damage', async () => {
    const world = createWorld({ seed: 14 })
    const page = await openPage(world, world.tab('a'))
    const snapshot = encodeSnapshot(toRecords(stateOf(goldenChart())))
    const json = [2, ...snapshot.root.json.slice(1)]
    const bytes = canonicalBytes(json)
    const batch = batchOf(snapshot)
    batch.roots = [hash16Sync(bytes)]
    batch.nodes = [...batch.nodes.slice(0, -1), { hash: hash16Sync(bytes), bytes }]
    await assert.rejects(importForeign(page, batch), (error: Error) => {
        assert.ok(error instanceof NewerRecordsError || error.name === 'NewerRecordsError')
        return true
    })
    assert.equal(rows(world, 'nodes').size, 0)
})
