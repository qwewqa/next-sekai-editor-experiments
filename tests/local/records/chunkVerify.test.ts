import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
    chunkRowOf,
    ChunkVerifyError,
    deflateChunk,
    DeflateError,
    inflateStrict,
    isVerifiedChunk,
    setDeflateHookForTests,
    verifyChunk,
    type VerifiedChunk,
} from '../../../src/local/chunkVerify'
import { hash16Sync } from '../../../src/local/hash'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { goldenChart, stateOf } from './charts'

const vectors = join(import.meta.dirname, '..', '..', 'fixtures', 'deflate-v1')
const read = (name: string) => new Uint8Array(readFileSync(join(vectors, name)))

test('the deflate-v1 vectors: valid streams inflate, damaged ones are refused', async () => {
    const { inflatesTo, valid, damage } = JSON.parse(
        readFileSync(join(vectors, 'vectors.json'), 'utf8'),
    ) as { inflatesTo: string; valid: string[]; damage: string[] }
    const canonical = read(inflatesTo)
    const hash = hash16Sync(canonical)
    for (const name of valid) {
        assert.deepEqual(inflateStrict(read(name)), canonical, name)
        const verified = await verifyChunk({ hash, stored: read(name) })
        assert.equal(verified.size, canonical.length)
    }
    assert.equal(damage.length, 4)
    for (const name of damage) {
        assert.throws(() => inflateStrict(read(name)), DeflateError, name)
        await assert.rejects(verifyChunk({ hash, stored: read(name) }), DeflateError, name)
    }
})

test('deflated chunks are verified against the canonical bytes, not re-hashed', async () => {
    for (const chunk of encodeSnapshot(toRecords(stateOf(goldenChart()))).chunks) {
        const stored = deflateChunk(chunk.bytes)
        // Deflated bytes aren't pinned; inflating them is.
        assert.deepEqual(inflateStrict(stored), chunk.bytes)
        const verified = await verifyChunk({ hash: chunk.hash, stored, canonical: chunk.bytes })
        assert.ok(isVerifiedChunk(verified))
        assert.equal(verified.size, chunk.bytes.length)
    }
})

test('verify on write: a deflate output corrupted by the test hook fails, and nothing is made', async () => {
    const [chunk] = encodeSnapshot(toRecords(stateOf(goldenChart()))).chunks
    assert.ok(chunk)
    const other = deflateChunk(new TextEncoder().encode('[]'))
    const corruptions: ((stored: Uint8Array) => Uint8Array)[] = [
        (stored) => stored.map((byte, i) => (i === stored.length >> 1 ? byte ^ 0x10 : byte)),
        (stored) => stored.slice(0, -1),
        (stored) => Uint8Array.from([...stored, 0]),
        () => other,
    ]
    try {
        for (const corrupt of corruptions) {
            setDeflateHookForTests(corrupt)
            const stored = deflateChunk(chunk.bytes)
            await assert.rejects(
                verifyChunk({ hash: chunk.hash, stored, canonical: chunk.bytes }),
                (error) => error instanceof DeflateError || error instanceof ChunkVerifyError,
            )
        }
    } finally {
        setDeflateHookForTests(undefined)
    }
})

test('outside bytes must hash to the chunk’s hash', async () => {
    const [a, b] = encodeSnapshot(toRecords(stateOf(goldenChart()))).chunks
    assert.ok(a && b)
    await assert.rejects(
        verifyChunk({ hash: b.hash, stored: deflateChunk(a.bytes) }),
        ChunkVerifyError,
    )
    await assert.rejects(
        verifyChunk({ hash: a.hash, stored: deflateChunk(a.bytes), maxSize: a.bytes.length - 1 }),
        DeflateError,
    )
})

test('only verifyChunk makes a VerifiedChunk, and its row is a compact copy', async () => {
    const [chunk] = encodeSnapshot(toRecords(stateOf(goldenChart()))).chunks
    assert.ok(chunk)
    const forged = { hash: chunk.hash, stored: deflateChunk(chunk.bytes), size: 1 } as VerifiedChunk
    assert.equal(isVerifiedChunk(forged), false)
    assert.throws(() => chunkRowOf(forged, 0), ChunkVerifyError)
    // A view into a larger buffer is stored as exactly its bytes.
    const stored = deflateChunk(chunk.bytes)
    const padded = new Uint8Array(stored.length + 8)
    padded.set(stored, 4)
    const view = padded.subarray(4, 4 + stored.length)
    const row = chunkRowOf(
        await verifyChunk({ hash: chunk.hash, stored: view, canonical: chunk.bytes }),
        0,
    )
    assert.equal(row.bytes.buffer.byteLength, stored.length)
})
