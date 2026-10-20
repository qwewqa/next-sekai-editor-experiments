import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { equalJson, type JsonValue } from '../../../src/history/operations'
import { deflateChunk } from '../../../src/local/chunkVerify'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { readNxsp } from '../../../src/local/nxsp/read'
import { canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
import { jsonOf, setJson, unzip, zipItems, type Item, type Loose } from './craft'

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
            // The patch number and the app version of a save (§1.6.11.4, §1.6.11.5).
            [
                'patch-missing',
                craft((items) => {
                    const p = jsonOf(items, 'project.json')
                    delete p.patch
                    setJson(items, 'project.json', p)
                }),
                'project.json: patch',
            ],
            [
                'patch-newer',
                craft((items) => {
                    setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), patch: 1 })
                }),
                'project.json: patch',
            ],
            [
                'appversion-missing',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    delete m.entries.find((e: Loose) => e.kind === 'save').appVersion
                    setJson(items, 'history/manifest.json', m)
                }),
                'appVersion',
            ],
            [
                'appversion-on-edit',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    m.entries.find((e: Loose) => e.kind === 'edit').appVersion = '0.6.0'
                    setJson(items, 'history/manifest.json', m)
                }),
                'appVersion',
            ],
            // A hash with a trailing newline is no hash (fullmatch, not match).
            [
                'sha256-newline',
                craft((items) => {
                    const p = jsonOf(items, 'project.json')
                    p.bgm.sha256 = `${p.bgm.sha256}
`
                    setJson(items, 'project.json', p)
                }),
                'bgm.sha256',
            ],
            [
                'x-not-object',
                craft((items) => {
                    const m = jsonOf(items, 'history/manifest.json')
                    m.undoStack.slots[0].step.x = [1]
                    setJson(items, 'history/manifest.json', m)
                }),
                'x: not an object',
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

test('the Python reader checks shared graph closure in stored-edge work', { skip: !hasUv }, () => {
    const script = `
import runpy, sys
m = runpy.run_path(sys.argv[1])
class Edges(list):
    visits = 0
    def __iter__(self):
        for value in super().__iter__():
            Edges.visits += 1
            yield value
repeat = 80
header, body = "a" * 32, "b" * 32
key = lambda value: m["hash16"](m["js_json"](value).encode("utf-8"))
leaf = ["bpms", 0, Edges([body] * repeat)]
leaf_key = key(leaf)
top = ["bpms", 1, [leaf_key] * repeat]
top_key = key(top)
root = [1, header, [["bpms", top_key]], 0]
root_key = key(root)
manifest = dict(version=2, entries=[], roots={root_key: root}, nodes={leaf_key: leaf, top_key: top},
                chunks=[[header, 0, 1], [body, 1, 1]],
                undoStack=dict(base=0, index=0, slots=[dict(snapshot=root_key, step=dict(kind="init", operation={"id":"future.fixture", "version":1, "data":{}, "fallback":{"locale":"en", "text":"Graph fixture"}}))]))
Edges.visits = 0
history, issues = m["combine_parts"]([], manifest, 0, 2)
assert history is not None and not issues, issues
assert Edges.visits < repeat * 6, Edges.visits
`
    const result = spawnSync(
        'uv',
        ['run', 'python', '-I', '-c', script, join(repo, 'tools', 'nxsp_check.py')],
        { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})

test(
    'both checker modes accept opaque operation variants while structural carriers stay strict',
    { skip: !hasUv },
    async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nxsp-opaque-'))
        const base = {
            id: 'nse.note.add',
            version: 1,
            data: { created: 1 },
            fallback: { locale: 'fr', text: 'Description future' },
        }
        const variants: JsonValue[] = [
            {
                ...base,
                id: 'future.tool',
                data: { ['__proto__']: { kept: true }, newEnum: 'future' },
            },
            { ...base, version: 2 },
            { ...base, futureEnvelope: { nested: [1, 'kept'] } },
            { ...base, data: { created: 1, newField: 'future' } },
            { ...base, data: { created: 'future-enum' } },
            {
                malformedKnown: { still: 'bounded JSON' },
                fallback: { text: 'Readable fallback', locale: 'ja' },
            },
            null,
        ]
        try {
            for (const [index, operation] of variants.entries()) {
                const bytes = await craft((items) => {
                    const manifest = jsonOf(items, 'history/manifest.json')
                    manifest.entries[1].step.operation = operation
                    setJson(items, 'history/manifest.json', manifest)
                })
                const file = join(dir, `opaque-${index}.nxsp`)
                writeFileSync(file, bytes)
                const strict = check(file)
                assert.equal(strict.status, 0, strict.output)
                const reader = check('--read', file)
                assert.equal(reader.status, 0, reader.output)
                assert.match(reader.output, /"open": "full"/)
                const opened = await readNxsp(new Blob([bytes]))
                assert(opened.kind === 'nxsp' && opened.history)
                const entry = opened.history.entries[1]!
                assert(entry.kind === 'edit')
                assert(equalJson(entry.step.operation, operation))
            }
            const bad = await craft((items) => {
                const manifest = jsonOf(items, 'history/manifest.json')
                manifest.entries[1].step.kind = 'future-mechanics'
                setJson(items, 'history/manifest.json', manifest)
            })
            const file = join(dir, 'bad-carrier.nxsp')
            writeFileSync(file, bad)
            assert.notEqual(check(file).status, 0)
            const reader = check('--read', file)
            assert.match(reader.output, /"open": "partial"/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    },
)

test(
    'the checker accepts x on every carrier and any content inside it',
    { skip: !hasUv },
    async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nxsp-x-'))
        try {
            const bytes = await craft((items) => {
                const m = jsonOf(items, 'history/manifest.json')
                const x = { future: [1, { deep: true }], text: 'ü' }
                m.x = x
                m.undoStack.x = x
                m.undoStack.slots[0].x = x
                m.undoStack.slots[0].step.x = x
                for (const entry of m.entries) {
                    entry.x = x
                    if (entry.step) entry.step.x = x
                }
                setJson(items, 'history/manifest.json', m)
            })
            const path = join(dir, 'x.nxsp')
            writeFileSync(path, bytes)
            const strict = check(path)
            assert.equal(strict.status, 0, strict.output)
            const reader = check('--read', path)
            assert.match(reader.output, /"open": "full"/)
            assert.equal(((await readNxsp(new Blob([bytes]))) as { open: string }).open, 'full')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    },
)

test(
    'the checker never crashes on a path or a number: any Unicode name, huge integer literals',
    { skip: !hasUv },
    async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nxsp-robust-'))
        try {
            const good = await craft(() => undefined)
            // A name outside every Windows code page, and one with a character the console lacks.
            const odd = join(dir, 'バス-ファイル-é-☃.nxsp')
            writeFileSync(odd, good)
            for (const args of [[odd], ['--read', odd]]) {
                const result = check(...args)
                assert.equal(result.status, 0, result.output)
                assert.doesNotMatch(result.output, /Error/)
            }
            // Integer literals of 400 digits, and of more than Python's 4,300-digit string limit.
            for (const digits of [400, 5000]) {
                const huge = await craft((items) => {
                    const entry = items.find((i) => i.name === 'project.json')
                    assert.ok(entry)
                    const text = new TextDecoder().decode(entry.data)
                    entry.data = encoder.encode(
                        text.replace('"rating":12', `"rating":${'9'.repeat(digits)}`),
                    )
                })
                const path = join(dir, `huge-${digits}.nxsp`)
                writeFileSync(path, huge)
                const strict = check(path)
                assert.equal(strict.status, 1)
                assert.doesNotMatch(strict.output, /Error/)
                const reader = check('--read', path)
                assert.equal(reader.status, 0, reader.output)
                assert.match(reader.output, /"invalid-key", "metadata\.rating"/)
                assert.doesNotMatch(reader.output, /"error"/)
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    },
)
