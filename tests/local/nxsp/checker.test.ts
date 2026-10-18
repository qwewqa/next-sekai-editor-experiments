import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { deflateChunk } from '../../../src/local/chunkVerify'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
import { jsonOf, setJson, unzip, zipItems, type Item } from './craft'

// The independent checker (`tools/nxsp_check.py`, §1.6.11.9) over the builder golden's output and
// over crafted bad files, each failing for its reason. Python runs through `uv` with `-I`; without
// `uv` on the machine the test is skipped (CI installs it for the checker step).

const repo = join(import.meta.dirname, '..', '..', '..')
const golden = join(import.meta.dirname, 'golden-v1')
const hasUv = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0

const check = (...paths: string[]) => {
    const result = spawnSync(
        'uv',
        ['run', 'python', '-I', join(repo, 'tools', 'nxsp_check.py'), ...paths],
        {
            encoding: 'utf8',
        },
    )
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const encoder = new TextEncoder()

/** A crafted file from write-1, its JSON and chunks changed, zipped with the writer's pins. */
const craft = async (
    change: (items: Item[]) => void,
    name = 'write-1.nxsp',
    time?: (modified: { dosTime: number; dosDate: number }) => { dosTime: number; dosDate: number },
) => {
    const { items, modified } = await unzip(new Blob([readFileSync(join(golden, name))]))
    change(items)
    return new Uint8Array(
        await (await zipItems(items, time ? time(modified) : modified)).arrayBuffer(),
    )
}

const patch = (bytes: Uint8Array, find: number[], replace: number[], all = true) => {
    const out = bytes.slice()
    for (let i = 0; i + find.length <= out.length; i++) {
        if (find.every((b, j) => out[i + j] === b)) {
            out.set(replace, i)
            if (!all) break
        }
    }
    return out
}

/** Re-hashes a changed head header so only the intended fault remains: a new chunk, root and references. */
const changeHeadHeader = (items: Item[], change: (header: RecordValue[]) => RecordValue[]) => {
    const manifest = jsonOf(items, 'history/manifest.json')
    const chunksItem = items.find((i) => i.name === 'history/chunks.bin')
    assert.ok(chunksItem)
    const head = manifest.undoStack.slots[manifest.undoStack.index - manifest.undoStack.base]
        .snapshot as string
    const root = manifest.roots[head] as RecordValue[]
    const [, offset, length] =
        (manifest.chunks as [string, number, number][]).find(([h]) => h === root[1]) ?? []
    assert.ok(offset !== undefined && length !== undefined)
    const header = JSON.parse(
        inflateRawSync(chunksItem.data.subarray(offset, offset + length)).toString(),
    ) as RecordValue[]
    const bytes = canonicalBytes(change(header))
    const hash = toHex(hash16Sync(bytes))
    const stored = deflateChunk(bytes)
    manifest.chunks.push([hash, chunksItem.data.length, stored.length])
    chunksItem.data = new Uint8Array([...chunksItem.data, ...stored])
    const newRoot = [root[0], hash, root[2], root[3]] as RecordValue[]
    const newHead = toHex(hash16Sync(canonicalBytes(newRoot)))
    manifest.roots[newHead] = newRoot
    const swap = (h: string) => (h === head ? newHead : h)
    for (const e of manifest.entries) e.snapshot = swap(e.snapshot)
    for (const s of manifest.undoStack.slots) s.snapshot = swap(s.snapshot)
    delete manifest.roots[head]
    setJson(items, 'history/manifest.json', manifest)
}

test(
    'the checker passes the builder golden’s output and every conformance expected.nxsp',
    { skip: !hasUv },
    () => {
        const result = check(join(golden, 'write-1.nxsp'), join(golden, 'write-2.nxsp'))
        assert.equal(result.status, 0, result.output)
        const conformance = join(repo, 'tests', 'zip', 'plan-conformance-v1')
        const expected = readdirSync(conformance)
            .map((name) => join(conformance, name, 'expected.nxsp'))
            .filter((path) => existsSync(path))
        assert.ok(expected.length >= 6)
        const all = check(...expected)
        assert.equal(all.status, 0, all.output)
    },
)

test('the checker fails each crafted file for its reason', { skip: !hasUv }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nxsp-check-'))
    try {
        const good = readFileSync(join(golden, 'write-1.nxsp'))
        const cases: [string, Uint8Array | Promise<Uint8Array>, string][] = [
            // ZIP header pins.
            ['flags', patch(good, [0x14, 0x00, 0x00, 0x08], [0x14, 0x00, 0x08, 0x08]), 'flags'],
            [
                'comment',
                new Uint8Array([...good.subarray(0, good.length - 2), 3, 0, 0x61, 0x62, 0x63]),
                'end record',
            ],
            ['trailing', new Uint8Array([...good, 0]), 'end record'],
            [
                'time',
                craft(
                    () => undefined,
                    'write-1.nxsp',
                    (m) => ({ ...m, dosTime: m.dosTime + 1 }),
                ),
                'DOS time',
            ],
            [
                'unnamed',
                craft((items) =>
                    items.push({ name: 'zz', data: encoder.encode(''), method: 'store' }),
                ),
                'no pointer',
            ],
            // Order, methods and CRCs.
            ['order', craft((items) => items.push(...items.splice(2, 1))), 'entry order'],
            [
                'method',
                craft((items) => {
                    const chunks = items.find((i) => i.name === 'history/chunks.bin')
                    if (chunks) chunks.method = 'deflate'
                }),
                'method',
            ],
            // project.json and its pointers.
            [
                'sha256',
                craft((items) => {
                    const p = jsonOf(items, 'project.json')
                    p.bgm.sha256 = '0'.repeat(64)
                    setJson(items, 'project.json', p)
                }),
                'bgm.sha256',
            ],
            [
                'placed',
                craft((items) => {
                    const p = jsonOf(items, 'project.json')
                    p.revision.completeFrom = 'elsewhere'
                    setJson(items, 'project.json', p)
                }),
                'cannot be placed',
            ],
            [
                'parts',
                craft((items) => {
                    setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), parts: {} })
                }),
                'parts',
            ],
            [
                'summary',
                craft((items) => {
                    const p = jsonOf(items, 'project.json')
                    p.summary.noteCount += 1
                    setJson(items, 'project.json', p)
                }),
                'summary.noteCount',
            ],
            [
                'duration',
                craft((items) => {
                    const p = jsonOf(items, 'project.json')
                    p.summary.durationMs += 1
                    setJson(items, 'project.json', p)
                }),
                'summary.durationMs',
            ],
            [
                'entries',
                craft((items) => {
                    const p = jsonOf(items, 'project.json')
                    p.history.entries += 1
                    setJson(items, 'project.json', p)
                }),
                'history.entries',
            ],
            [
                'empty-string',
                craft((items) => {
                    const p = jsonOf(items, 'project.json')
                    p.metadata.title = ''
                    setJson(items, 'project.json', p)
                }),
                'metadata.title',
            ],
            // The history.
            [
                'root-hash',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    const key = Object.keys(m.roots)[0] as string
                    m.roots[key][3] += 1
                    setJson(items, 'history/manifest.json', m)
                }),
                'does not hash to its key',
            ],
            [
                'tiling',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    m.chunks[1][1] += 1
                    setJson(items, 'history/manifest.json', m)
                }),
                'does not tile',
            ],
            [
                'stack',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    m.undoStack.index = 9
                    setJson(items, 'history/manifest.json', m)
                }),
                'undoStack.index',
            ],
            [
                'last-save',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    m.entries.push({ ...m.entries[0] })
                    setJson(items, 'history/manifest.json', m)
                    const p = jsonOf(items, 'project.json')
                    p.history.entries += 1
                    setJson(items, 'project.json', p)
                }),
                'does not end with',
            ],
            [
                'dangling',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    m.entries[0].snapshot = '0'.repeat(32)
                    setJson(items, 'history/manifest.json', m)
                }),
                'missing',
            ],
            [
                'unknown-key',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    m.entries[0].zz = 1
                    setJson(items, 'history/manifest.json', m)
                }),
                'unknown keys',
            ],
            [
                'chunk-hash',
                craft((items) => {
                    const chunks = items.find((i) => i.name === 'history/chunks.bin')
                    const m = jsonOf(items, 'history/manifest.json')
                    if (!chunks) return
                    const [hash, offset, length] = m.chunks[0] as [string, number, number]
                    const other = deflateChunk(encoder.encode('[]'))
                    const bytes = new Uint8Array([
                        ...chunks.data.subarray(0, offset),
                        ...other,
                        ...chunks.data.subarray(offset + length),
                    ])
                    chunks.data = bytes
                    const delta = other.length - length
                    m.chunks = (m.chunks as [string, number, number][]).map(([h, o, l]) => [
                        h,
                        o > offset ? o + delta : o,
                        h === hash ? other.length : l,
                    ])
                    setJson(items, 'history/manifest.json', m)
                }),
                'does not hash to its name',
            ],
            // A record with an extra position, re-hashed so nothing else is wrong.
            [
                'extra-position',
                craft((items) => changeHeadHeader(items, (header) => [...header, 0])),
                'positions',
            ],
            [
                'bad-type',
                craft((items) => changeHeadHeader(items, (header) => [true, ...header.slice(1)])),
                'not a finite number',
            ],
        ]
        for (const [name, bytes, reason] of cases) {
            const path = join(dir, `${name}.nxsp`)
            writeFileSync(path, await bytes)
            const result = check(path)
            assert.equal(result.status, 1, `${name} passed: ${result.output}`)
            assert.ok(
                result.output.includes(reason),
                `${name}: expected “${reason}”, got ${result.output}`,
            )
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the checker verifies completeFrom against the file it names', { skip: !hasUv }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nxsp-check-'))
    try {
        // write-2 without one of write-1's rows, still claiming write-1's completeness.
        const thinner = await craft((items) => {
            const m = jsonOf(items, 'history/manifest.json')
            m.entries.splice(2, 1)
            setJson(items, 'history/manifest.json', m)
            const p = jsonOf(items, 'project.json')
            p.history.entries -= 1
            setJson(items, 'project.json', p)
        }, 'write-2.nxsp')
        const path = join(dir, 'thinner.nxsp')
        writeFileSync(path, thinner)
        assert.equal(check(path).status, 0, check(path).output)
        const both = check(join(golden, 'write-1.nxsp'), path)
        assert.equal(both.status, 1, both.output)
        assert.ok(both.output.includes('claims'), both.output)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test(
    'the checker rejects unresolved orphan references in strict and reader modes',
    { skip: !hasUv },
    async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nxsp-orphans-'))
        try {
            for (const fault of ['chunk', 'child', 'kind', 'depth']) {
                const bytes = await craft((items) => {
                    const manifest = jsonOf(items, 'history/manifest.json')
                    const put = (node: RecordValue[]) => {
                        const key = toHex(hash16Sync(canonicalBytes(node)))
                        manifest.nodes[key] = node
                        return key
                    }
                    const leaf = put([
                        fault === 'kind' ? 'slides' : 'bpms',
                        0,
                        [manifest.chunks[0][0]],
                    ])
                    const middle = put(['bpms', 1, [leaf]])
                    put(
                        fault === 'chunk'
                            ? ['bpms', 0, ['c'.repeat(32)]]
                            : [
                                  'bpms',
                                  1,
                                  [
                                      fault === 'child'
                                          ? 'c'.repeat(32)
                                          : fault === 'depth'
                                            ? middle
                                            : leaf,
                                  ],
                              ],
                    )
                    setJson(items, 'history/manifest.json', manifest)
                })
                const path = join(dir, `${fault}.nxsp`)
                writeFileSync(path, bytes)
                const strict = check(path)
                assert.notEqual(strict.status, 0)
                assert.match(strict.output, /nodes\./)
                const reader = check('--read', path)
                assert.equal(reader.status, 0, reader.output)
                assert.match(reader.output, /"open": "partial"/)
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    },
)
