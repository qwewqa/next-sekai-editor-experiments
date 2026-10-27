import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReadHistory } from '../../../src/local/nxsp'
import { distinctRootChunks, inFileOrder } from '../../../src/local/nxsp/manifest'
import { chunkAccess, NXSP_CAPS } from '../../../src/local/nxsp/read'
import { planImport } from '../../../src/local/open/plan'
import { ZipReader } from '../../../src/zip/reader'
import { rawZip } from '../../zip/rawZip'

// A long-edited file: many states, each reaching a header and three chunks, spread over a
// `chunks.bin` of several windows in no relation to the undo stack's order. The windows
// are for reads in file order, so the import's batches and the head's read go in it.

const ROOTS = 600
const CHUNK = 1500
const COUNT = ROOTS * 4
const SIZE = COUNT * CHUNK

const build = () => {
    const roots = new Map<string, unknown[]>()
    const nodes = new Map<string, unknown[]>()
    const index = new Map<string, { offset: number; length: number }>()
    const place = (name: string, n: number) =>
        index.set(name, { offset: ((n * 2399) % COUNT) * CHUNK, length: CHUNK })
    const slots: { snapshot: string }[] = []
    for (let i = 0; i < ROOTS; i++) {
        const root = `r${i}`
        place(`h${i}`, i * 4)
        for (let k = 1; k < 4; k++) place(`c${i}.${k}`, i * 4 + k)
        nodes.set(`n${i}`, [0, 0, [1, 2, 3].map((k) => `c${i}.${k}`)])
        roots.set(root, [0, `h${i}`, [['x', `n${i}`]]])
        slots.push({ snapshot: root })
    }
    const history = {
        roots,
        nodes,
        index,
        undoStack: { base: 0, slots, index: ROOTS - 1 },
        entries: [],
        head: `r${ROOTS - 1}`,
    } as unknown as ReadHistory
    return history
}

const access = async (history: ReadHistory, t: test.TestContext) => {
    const data = new Uint8Array(SIZE).map((_, i) => (i * 40503) >>> 8)
    const file = new Blob([rawZip([{ name: 'history/chunks.bin', data, method: 0 }])])
    const reader = await ZipReader.open(file)
    const entry = reader.get('history/chunks.bin')
    assert.ok(entry)
    const read = { bytes: 0 }
    const slice = Blob.prototype.slice
    t.mock.method(Blob.prototype, 'slice', function (this: Blob, start?: number, end?: number) {
        if (this !== file) read.bytes += (end ?? this.size) - (start ?? 0)
        return slice.call(this, start, end)
    })
    return { chunks: chunkAccess(reader, entry, history.index, NXSP_CAPS), read }
}

test("the import's batches keep their chunks and read each in file order", async (t) => {
    const history = build()
    const plain = [...distinctRootChunks(history, history.roots.keys())]
    const batches = planImport(history, new Set(), true).filter((b) => b.kind === 'chunks')
    assert.deepEqual(batches.flatMap((b) => b.hashes).sort(), [...plain].sort())
    for (const batch of batches) {
        const offsets = batch.hashes.map((h) => history.index.get(h)?.offset ?? 0)
        assert.deepEqual(
            offsets,
            [...offsets].sort((a, b) => a - b),
        )
    }
    const { chunks, read } = await access(history, t)
    for (const batch of batches) for (const hash of batch.hashes) await chunks.stored(hash)
    assert.ok(read.bytes <= 3 * SIZE, `the import read ${read.bytes} bytes of ${SIZE}`)
})

test('inFileOrder sorts by offset and puts unknown chunks last', () => {
    const index = new Map([
        ['a', { offset: 30 }],
        ['b', { offset: 10 }],
        ['c', { offset: 20 }],
    ])
    assert.deepEqual(inFileOrder(index, ['a', 'zz', 'c', 'b']), ['b', 'c', 'a', 'zz'])
})
