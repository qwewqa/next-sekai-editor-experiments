import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkAccess, NXSP_CAPS } from '../../../src/local/nxsp/read'
import { ZipReader } from '../../../src/zip/reader'
import { rawZip } from '../../zip/rawZip'

// A STORE `chunks.bin` is read in windows: each chunk's bytes must be the file's at its place,
// whatever order the chunks are asked in, and a copy of its own, never a view of the window
// (stored as it is, a view would store the whole window).

test('chunks read through windows are the file’s bytes at their places, each a copy', async () => {
    const size = 5 * 1024 * 1024 + 123
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = (i * 2654435761) >>> 24
    const file = new Blob([
        rawZip([
            { name: 'a.txt', data: new Uint8Array([1, 2, 3]) },
            { name: 'history/chunks.bin', data, method: 0 },
        ]),
    ])
    const reader = await ZipReader.open(file)
    const entry = reader.get('history/chunks.bin')
    assert.ok(entry)

    // In file order, out of order, across a window’s end, larger than a window, and the last.
    const places: [number, number][] = []
    for (let at = 0; at + 70_000 <= size; at += 70_000) places.push([at, 70_000])
    places.push(
        [2 * 1024 * 1024 - 10, 20],
        [10, 5],
        [4 * 1024 * 1024 + 7, 1024],
        [100, 3 * 1024 * 1024],
        [size - 1, 1],
        [3 * 1024 * 1024, 0],
    )
    const index = new Map(places.map(([offset, length], i) => [`c${i}`, { offset, length }]))
    const chunks = chunkAccess(reader, entry, index, NXSP_CAPS)
    for (const [key, { offset, length }] of [...index].reverse().concat([...index])) {
        const bytes = await chunks.stored(key)
        assert.deepEqual(bytes, data.slice(offset, offset + length), key)
        assert.equal(bytes.buffer.byteLength, length, `${key} is a copy`)
    }
})
