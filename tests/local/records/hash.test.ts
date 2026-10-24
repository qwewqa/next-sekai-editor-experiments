import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
    equalBytes,
    fromHex16,
    hash16,
    hash16Sync,
    isHash16Hex,
    sha256,
    sha256Sync,
    SYNC_HASH_LIMIT,
    toHex,
} from '../../../src/local/hash'

const nodeSha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

test('the synchronous SHA-256 matches the FIPS 180-4 examples', () => {
    const text = (value: string) => toHex(sha256Sync(new TextEncoder().encode(value)))
    assert.equal(text(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(
        text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
})

test('the synchronous SHA-256 matches crypto.subtle and Node at every padding boundary', async () => {
    let seed = 1
    const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff
    for (const length of [
        ...Array.from({ length: 200 }, (_, i) => i),
        511,
        512,
        1023,
        1024,
        4097,
    ]) {
        const data = Uint8Array.from({ length }, random)
        const expected = nodeSha256(data)
        assert.equal(toHex(sha256Sync(data)), expected, `length ${length}`)
        assert.equal(toHex(await sha256(data)), expected, `length ${length}`)
    }
})

test('hash16 is the first 16 bytes, compact, on both sides of the synchronous limit', async () => {
    for (const length of [0, SYNC_HASH_LIMIT - 1, SYNC_HASH_LIMIT, 5000]) {
        const data = new Uint8Array(length).fill(7)
        const hash = await hash16(data)
        assert.equal(hash.length, 16)
        // Never a view into the 32-byte digest.
        assert.equal(hash.buffer.byteLength, 16)
        assert.equal(toHex(hash), nodeSha256(data).slice(0, 32))
        assert.deepEqual(hash, hash16Sync(data))
    }
})

test('hex is 32 lowercase characters both ways', () => {
    const hash = hash16Sync(new Uint8Array([1, 2, 3]))
    assert.ok(isHash16Hex(toHex(hash)))
    assert.ok(equalBytes(fromHex16(toHex(hash)), hash))
    for (const bad of ['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 1])
        assert.equal(isHash16Hex(bad), false, String(bad))
    assert.throws(() => fromHex16('F'.repeat(32)), TypeError)
})
