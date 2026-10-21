import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
    CHUNK_CAP,
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
import { canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
import { toRecords } from '../../../src/local/records/records'
import { checkRecord } from '../../../src/local/records/schema'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { useDay } from '../../helpers/useDay'
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
    assert.equal(damage.length, 10)
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
    assert.throws(() => chunkRowOf(forged, useDay(0)), ChunkVerifyError)
    // A view into a larger buffer is stored as exactly its bytes.
    const stored = deflateChunk(chunk.bytes)
    const padded = new Uint8Array(stored.length + 8)
    padded.set(stored, 4)
    const view = padded.subarray(4, 4 + stored.length)
    const row = chunkRowOf(
        await verifyChunk({ hash: chunk.hash, stored: view, canonical: chunk.bytes }),
        useDay(0),
    )
    assert.equal(row.bytes.buffer.byteLength, stored.length)
})

test('a verified chunk holds its own copy: the caller’s buffer changing after the call changes nothing', async () => {
    const [chunk] = encodeSnapshot(toRecords(stateOf(goldenChart()))).chunks
    assert.ok(chunk)
    for (const canonical of [chunk.bytes, undefined]) {
        const stored = deflateChunk(chunk.bytes)
        const hash = chunk.hash.slice()
        const pending = verifyChunk(canonical ? { hash, stored, canonical } : { hash, stored })
        // Overwritten while the hash is awaited.
        stored.fill(0)
        hash.fill(0)
        const verified = await pending
        const row = chunkRowOf(verified, useDay(0))
        assert.deepEqual(inflateStrict(row.bytes), chunk.bytes)
        assert.deepEqual(verified.hash, chunk.hash)
    }
})

test('outside bytes inflate at most to the chunk reader cap', async () => {
    const big = new Uint8Array(CHUNK_CAP + 1).fill(0x20)
    const stored = deflateChunk(big)
    const hash = hash16Sync(big)
    await assert.rejects(verifyChunk({ hash, stored }), DeflateError)
    await assert.rejects(verifyChunk({ hash, stored, maxSize: Infinity }), DeflateError)
})

test('an integer spelled otherwise is other bytes: it reads under its own hash, never the canonical one', async () => {
    const spelled = new TextEncoder().encode('[[1.0,"F",-0,1e0]]')
    const value = JSON.parse(new TextDecoder().decode(spelled)) as RecordValue
    const canonical = canonicalBytes(value)
    assert.equal(new TextDecoder().decode(canonical), '[[1,"F",0,1]]')
    await assert.rejects(
        verifyChunk({ hash: hash16Sync(canonical), stored: deflateChunk(spelled) }),
        ChunkVerifyError,
    )
    const own = await verifyChunk({ hash: hash16Sync(spelled), stored: deflateChunk(spelled) })
    assert.equal(own.size, spelled.length)
    for (const folder of value as RecordValue[]) checkRecord('folder', folder)
})
