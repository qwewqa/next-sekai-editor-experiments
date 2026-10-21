import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateChunk, inflateStrict, verifyChunk } from '../../../src/local/chunkVerify'
import { hashKey } from '../../../src/local/db'
import type { KvTx } from '../../../src/local/kv/types'
import { putChunk } from '../../../src/local/putChunk'
import { toRecords } from '../../../src/local/records/records'
import { chunkCrc32, isChunkRowIntact, type ChunkRow } from '../../../src/local/records/rows'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { openLocalData } from '../../../src/local/testing/db'
import { createWorld } from '../../../src/local/testing/world'
import { useDay } from '../../helpers/useDay'
import { goldenChart, stateOf } from './charts'

// `putChunk` (§1.6.11.2): an intact row stays with its first `day`; a row whose CRC fails is
// replaced by the verified bytes.

const setup = async () => {
    const world = createWorld({ seed: 7 })
    const tab = world.tab('a')
    const db = await openLocalData(tab)
    const write = <T>(fn: (tx: KvTx) => Promise<T>) =>
        tab.run(() => db.transaction(['chunks'], 'readwrite', fn))
    const [a, b] = encodeSnapshot(toRecords(stateOf(goldenChart()))).chunks
    assert.ok(a && b)
    const verify = (chunk: typeof a) =>
        verifyChunk({ hash: chunk.hash, stored: deflateChunk(chunk.bytes), canonical: chunk.bytes })
    return { write, a, b, verify }
}

const rowOf = (tx: KvTx, hash: Uint8Array) => tx.get('chunks', hashKey(hash)) as Promise<ChunkRow>

test('an intact row is kept with its first day', async () => {
    const { write, a, verify } = await setup()
    const chunk = await verify(a)
    const added = await write((tx) => putChunk(tx, chunk, useDay(5)))
    assert.equal(added?.day, 5)
    const again = await write(async (tx) => [
        await putChunk(tx, chunk, useDay(9)),
        await rowOf(tx, a.hash),
    ])
    assert.equal(again[0], undefined)
    assert.equal((again[1] as ChunkRow).day, 5)
})

test('a row whose CRC fails is replaced by the verified bytes, keeping its day', async () => {
    const { write, a, b, verify } = await setup()
    const chunk = await verify(a)
    await write((tx) => putChunk(tx, chunk, useDay(5)))
    const damaged: ((row: ChunkRow) => unknown)[] = [
        // Bit rot in the stored bytes.
        (row) => ({ ...row, bytes: row.bytes.map((byte, i) => (i === 3 ? byte ^ 1 : byte)) }),
        // Another chunk's intact row under this key.
        (row) => {
            const bytes = deflateChunk(b.bytes)
            return { ...row, bytes, crc32: chunkCrc32(b.hash, bytes) }
        },
        // Not a row at all: the given day is used.
        () => 'garbage',
    ]
    for (const [i, damage] of damaged.entries()) {
        await write(async (tx) => {
            await tx.put('chunks', damage(await rowOf(tx, a.hash)), hashKey(a.hash))
        })
        const [result, row] = await write(async (tx) => [
            await putChunk(tx, chunk, useDay(9)),
            await rowOf(tx, a.hash),
        ])
        assert.equal(result, undefined)
        const healed = row as ChunkRow
        assert.ok(isChunkRowIntact(a.hash, healed), `${i}`)
        assert.deepEqual(inflateStrict(healed.bytes), a.bytes)
        assert.equal(healed.day, i === 2 ? 9 : 5)
        if (i === 2)
            await write(async (tx) => tx.put('chunks', { ...healed, day: 5 }, hashKey(a.hash)))
    }
})
