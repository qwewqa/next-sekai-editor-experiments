import assert from 'node:assert/strict'
import test from 'node:test'
import { gzip } from 'pako'
import { LEVEL_FILE_MAX_BYTES } from '../../src/levelData/fileLimit'
import { inflateCapped, LevelFileTooLarge } from '../../src/levelData/gzip'

// A level file's gzip is inflated under the level file limit: a gzip bomb stops at the cap, and
// the refusal is its own error, never the not-JSON answer that falls through to the next format.

test('a gzip that inflates past the limit is refused as too large', () => {
    const bomb = gzip(new Uint8Array(LEVEL_FILE_MAX_BYTES + 1024 * 1024))
    assert.ok(bomb.length < 1024 * 1024)
    assert.throws(() => inflateCapped(bomb), LevelFileTooLarge)
})

test('a gzip within the limit inflates whole', () => {
    const text = new TextEncoder().encode('{"entities":[]}')
    assert.deepEqual(inflateCapped(gzip(text)), text)
    assert.deepEqual(inflateCapped(gzip(text), 15), text)
    assert.throws(() => inflateCapped(gzip(text), 14), LevelFileTooLarge)
})

test('a damaged gzip fails as itself, not as too large', () => {
    const bytes = gzip(new TextEncoder().encode('{"entities":[]}'))
    bytes.fill(0xff, 10, 14)
    assert.throws(
        () => inflateCapped(bytes.subarray(0, bytes.length - 6)),
        (error: unknown) => error instanceof Error && !(error instanceof LevelFileTooLarge),
    )
})
