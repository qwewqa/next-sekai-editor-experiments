import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateChunk } from '../../../src/local/chunkVerify'
import { storeForeign, type ForeignBatch } from '../../../src/local/foreign'
import { toHex } from '../../../src/local/hash'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot, type EncodedSnapshot } from '../../../src/local/records/snapshot'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld } from '../../../src/local/testing/world'
import { edgeChart, recordsText, stateOf } from '../records/charts'
import { openPage, rows, storedRecords } from './harness'

// The closure check of foreign data (§1.6.4 step 4): nothing is written while a part is missing;
// the page sends the missing parts and it retries, at most twice.

const parts = (snapshot: EncodedSnapshot) => ({
    nodes: [
        ...snapshot.nodes.map((node) => ({ hash: node.hash, bytes: node.bytes })),
        {
            hash: snapshot.root.hash,
            bytes: snapshot.root.bytes,
            media: snapshot.root.media.map(toHex),
        },
    ],
    chunks: [snapshot.header, ...snapshot.chunks].map((chunk) => ({
        hash: chunk.hash,
        stored: deflateChunk(chunk.bytes),
    })),
})

test('foreign data missing parts is stored once the page sends them, and only then', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('a'))
    const state = stateOf(edgeChart())
    const snapshot = encodeSnapshot(toRecords(state))
    const all = parts(snapshot)
    // The first batch lacks a chunk and a kind node.
    const lostChunk = all.chunks[2]!
    const lostNode = all.nodes[0]!
    const first: ForeignBatch = {
        roots: [snapshot.root.hash],
        nodes: all.nodes.filter((node) => node !== lostNode),
        chunks: all.chunks.filter((chunk) => chunk !== lostChunk),
        media: [],
    }
    const asked: string[][] = []
    const results: string[] = []
    const stored = await storeForeign(
        async (batch) => {
            const result = await page.tab.run(() => page.handlers.importForeign(batch))
            results.push(result.kind)
            // Nothing is written while anything is missing.
            if (result.kind === 'missing') assert.equal(rows(world, 'nodes').size, 0)
            return result
        },
        first,
        async (missing) => {
            asked.push([...missing])
            return {
                nodes: all.nodes.filter((node) => missing.includes(toHex(node.hash))),
                chunks: all.chunks.filter((chunk) => missing.includes(toHex(chunk.hash))),
                media: [],
            }
        },
    )
    assert.equal(stored, true)
    // The lost node hides its own chunks, so the second round finds the lost chunk behind it.
    assert.ok(asked.flat().includes(toHex(lostNode.hash)))
    assert.ok(asked.flat().includes(toHex(lostChunk.hash)))
    assert.equal(results.at(-1), 'stored')
    assert.equal(
        recordsText(storedRecords(world, snapshot.root.hash)),
        recordsText(toRecords(state)),
    )
    assert.deepEqual(checkStored(world.memory), [])
})

test('foreign data still missing parts after two retries fails with nothing written', async () => {
    const world = createWorld({ seed: 2 })
    const page = await openPage(world, world.tab('a'))
    const snapshot = encodeSnapshot(toRecords(stateOf(edgeChart())))
    const all = parts(snapshot)
    let sends = 0
    const stored = await storeForeign(
        (batch) => {
            sends++
            return page.tab.run(() => page.handlers.importForeign(batch))
        },
        { roots: [snapshot.root.hash], nodes: all.nodes, chunks: all.chunks.slice(1), media: [] },
        async () => ({ nodes: [], chunks: [], media: [] }),
    )
    assert.equal(stored, false)
    assert.equal(sends, 3)
    assert.equal(rows(world, 'nodes').size, 0)
    assert.equal(rows(world, 'chunks').size, 0)
})

test('foreign bytes that don’t hash to their hash are refused before any write', async () => {
    const world = createWorld({ seed: 3 })
    const page = await openPage(world, world.tab('a'))
    const snapshot = encodeSnapshot(toRecords(stateOf(edgeChart())))
    const all = parts(snapshot)
    const bad = all.chunks[1]!
    const stored = bad.stored.slice()
    stored[stored.length - 1] = (stored.at(-1) ?? 0) ^ 0xff
    await assert.rejects(
        page.tab.run(() =>
            page.handlers.importForeign({
                roots: [snapshot.root.hash],
                nodes: all.nodes,
                chunks: all.chunks.map((chunk) => (chunk === bad ? { ...chunk, stored } : chunk)),
                media: [],
            }),
        ),
    )
    assert.equal(rows(world, 'chunks').size, 0)
})

test('a part already stored needn’t come again', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openPage(world, world.tab('a'))
    const snapshot = encodeSnapshot(toRecords(stateOf(edgeChart())))
    const all = parts(snapshot)
    const first = await page.tab.run(() =>
        page.handlers.importForeign({ roots: [snapshot.root.hash], ...all, media: [] }),
    )
    assert.equal(first.kind, 'stored')
    // The same root again with only its root node: everything else is in storage.
    const again = await page.tab.run(() =>
        page.handlers.importForeign({
            roots: [snapshot.root.hash],
            nodes: all.nodes.slice(-1),
            chunks: [],
            media: [],
        }),
    )
    assert.equal(again.kind, 'stored')
})
