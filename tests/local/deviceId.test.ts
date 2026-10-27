import assert from 'node:assert/strict'
import test from 'node:test'
import { documentDeviceId, hmacSha256 } from '../../src/local/deviceId'
import { toHex } from '../../src/local/hash'

// A document's device id: HMAC-SHA-256 of its lineage under the install's deviceId.

const bytes = (text: string) => new TextEncoder().encode(text)

test("the HMAC is RFC 4231's, for a short key and one longer than a block", () => {
    assert.equal(
        toHex(hmacSha256(bytes('Jefe'), bytes('what do ya want for nothing?'))),
        '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
    assert.equal(
        toHex(
            hmacSha256(
                new Uint8Array(131).fill(0xaa),
                bytes('Test Using Larger Than Block-Size Key - Hash Key First'),
            ),
        ),
        '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    )
})

test('one install and lineage give one id; another lineage or install gives another', () => {
    const install = 'c3f00000-0000-4000-8000-000000000000'
    const id = documentDeviceId(install, 'lineage-a')
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(documentDeviceId(install, 'lineage-a'), id)
    assert.notEqual(documentDeviceId(install, 'lineage-b'), id)
    assert.notEqual(documentDeviceId('another-install', 'lineage-a'), id)
    assert.notEqual(id, install)
})

test("the id is pinned: the HMAC's first 16 bytes, with version 8 and variant 10", () => {
    // Computed apart from this code (Python's hmac); a rewrite that slices or sets bits differently
    // makes every own save read as another device's.
    assert.equal(
        documentDeviceId('c3f00000-0000-4000-8000-000000000000', 'lineage-a'),
        'ddbe03da-f8bc-8997-a041-499da3b5cc32',
    )
})
