import assert from 'node:assert/strict'
import test from 'node:test'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { type ReadHistory } from '../../../src/local/nxsp'
import {
    combineParts,
    distinctRootChunks,
    type ManifestForm,
} from '../../../src/local/nxsp/manifest'
import { planImport } from '../../../src/local/open/plan'
import { canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
import { decodeSnapshot } from '../../../src/local/records/snapshot'
import { jsonOf, readCrafted, setJson } from './craft'

const hash = (json: RecordValue[]) => toHex(hash16Sync(canonicalBytes(json)))
const header = 'a'.repeat(32)
const body = 'b'.repeat(32)
const graph = (repeat: number): ManifestForm => {
    const leaf: RecordValue[] = ['bpms', 0, Array<string>(repeat).fill(body)]
    const top: RecordValue[] = ['bpms', 1, Array<string>(repeat).fill(hash(leaf))]
    const root: RecordValue[] = [1, header, [['bpms', hash(top)]], 0]
    return {
        version: 1,
        entries: [],
        roots: { [hash(root)]: root },
        nodes: { [hash(leaf)]: leaf, [hash(top)]: top },
        chunks: [
            [header, 0, 1],
            [body, 1, 1],
        ],
        undoStack: { base: 0, index: 0, slots: [{ snapshot: hash(root), label: '' }] },
    }
}

test('closure validation checks direct edges without expanding shared nodes', (t) => {
    const repeat = 80
    const manifest = graph(repeat)
    const has = t.mock.method(Map.prototype, 'has')
    const get = t.mock.method(Map.prototype, 'get')
    const result = combineParts([], manifest, { entries: 0, chunksSize: 2 })
    assert.deepEqual(result.issues, [])
    assert.ok(result.history)
    assert.ok(has.mock.callCount() + get.mock.callCount() < repeat * 5)
    has.mock.restore()
    get.mock.restore()
    const nodeGet = t.mock.method(result.history.nodes, 'get')
    assert.deepEqual(
        [...distinctRootChunks(result.history, Array<string>(repeat).fill(result.history.head))],
        [header, body],
    )
    assert.equal(nodeGet.mock.callCount(), 2)
    nodeGet.mock.resetCalls()
    const batches = planImport(result.history as ReadHistory, new Set())
    assert.deepEqual(
        batches.filter((b) => b.kind === 'chunks').flatMap((b) => b.hashes),
        [header, body],
    )
    assert.equal(nodeGet.mock.callCount(), 2)
})

test('decoding retains repeated chunks and same-beat record order', () => {
    const manifest = graph(2)
    const head = manifest.undoStack.slots[0]!.snapshot
    const records = [
        [0, 120, 4],
        [0, 180, 4],
    ]
    const decoded = decodeSnapshot(manifest.roots[head], {
        node: (key) => manifest.nodes[key],
        chunk: (key) =>
            key === header
                ? [1000, false, 0, [], [], [], [], ['', '', '', '', [], [], []]]
                : records,
    })
    assert.deepEqual(
        decoded.kinds[0]!.records.map((r) => r.record),
        [...records, ...records, ...records, ...records],
    )
})

for (const fault of [
    'missing chunk',
    'missing child',
    'wrong kind',
    'wrong depth',
    'valid',
] as const)
    test(`orphan nodes: ${fault}`, async () => {
        const read = await readCrafted((items) => {
            const manifest = jsonOf(items, 'history/manifest.json')
            const chunk = manifest.chunks[0][0] as string
            const leaf: RecordValue[] = [fault === 'wrong kind' ? 'slides' : 'bpms', 0, [chunk]]
            const middle: RecordValue[] = ['bpms', 1, [hash(leaf)]]
            manifest.nodes[hash(leaf)] = leaf
            manifest.nodes[hash(middle)] = middle
            const orphan: RecordValue[] =
                fault === 'missing chunk'
                    ? ['bpms', 0, ['c'.repeat(32)]]
                    : [
                          'bpms',
                          1,
                          [
                              fault === 'missing child'
                                  ? 'c'.repeat(32)
                                  : fault === 'wrong depth'
                                    ? hash(middle)
                                    : hash(leaf),
                          ],
                      ]
            manifest.nodes[hash(orphan)] = orphan
            setJson(items, 'history/manifest.json', manifest)
        })
        assert.equal(read.kind, 'nxsp')
        if (read.kind !== 'nxsp') return
        assert.equal(read.open, fault === 'valid' ? 'full' : 'partial')
        assert.equal(!!read.history, fault === 'valid')
    })

test('a compact shared graph outside the head opens without decoding its repeated records', async () => {
    const read = await readCrafted((items) => {
        const manifest = jsonOf(items, 'history/manifest.json')
        const head =
            manifest.undoStack.slots[manifest.undoStack.index - manifest.undoStack.base].snapshot
        const root = manifest.roots[head] as RecordValue[]
        const [kind, topHash] = (root[2] as [string, string][])[0]!
        const top = manifest.nodes[topHash] as RecordValue[]
        const originalLeaf =
            top[1] === 0 ? top : (manifest.nodes[(top[2] as string[])[0]!] as RecordValue[])
        const leaf: RecordValue[] = [
            kind,
            0,
            Array<string>(80).fill((originalLeaf[2] as string[])[0]!),
        ]
        const shared: RecordValue[] = [kind, 1, Array<string>(80).fill(hash(leaf))]
        const other: RecordValue[] = [1, root[1]!, [[kind, hash(shared)]], 0]
        manifest.nodes[hash(leaf)] = leaf
        manifest.nodes[hash(shared)] = shared
        manifest.roots[hash(other)] = other
        setJson(items, 'history/manifest.json', manifest)
    })
    assert.equal(read.kind, 'nxsp')
    if (read.kind !== 'nxsp') return
    assert.equal(read.open, 'full')
    assert.ok(read.history)
})
