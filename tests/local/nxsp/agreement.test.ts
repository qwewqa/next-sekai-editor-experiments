import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { deflateChunk } from '../../../src/local/chunkVerify'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { executePlan, planNxsp, readNxsp } from '../../../src/local/nxsp'
import { canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
import { rawZip, type RawEntry } from '../../zip/rawZip'
import { fresh } from './chain'
import { jsonOf, setJson, unzip, zipItems, type Item, type Loose } from './craft'
import { entry } from './helpers'

// The reader and the independent checker agree (§1.6.11.9): every crafted probe is read by
// `readNxsp` and by the checker's reader mode, and both must open it the same way (`full`, or
// `partial` with the same reasons, `unreadable` or `not-project`). Every probe the checker passes
// as a writer's file must also open fully. Python runs through `uv` with `-I`; without `uv` the
// test is skipped (CI installs it).

const repo = join(import.meta.dirname, '..', '..', '..')
const golden = join(import.meta.dirname, 'golden-v1')
const hasUv = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0
const encoder = new TextEncoder()

const checker = (...args: string[]) =>
    spawnSync('uv', ['run', 'python', '-I', join(repo, 'tools', 'nxsp_check.py'), ...args], {
        encoding: 'utf8',
        maxBuffer: 1 << 26,
    })

const goldenItems = async (name = 'write-2.nxsp') =>
    unzip(new Blob([readFileSync(join(golden, name))]))

/** A probe from write-2, changed, zipped with the writer's pins. */
const probe = async (change: (items: Item[]) => void, name?: string) => {
    const { items, modified } = await goldenItems(name)
    change(items)
    return new Uint8Array(await (await zipItems(items, modified)).arrayBuffer())
}

const changeJson = (name: string, change: (value: Loose) => void) => (items: Item[]) => {
    const value = jsonOf(items, name)
    change(value)
    setJson(items, name, value)
}

const project = (change: (value: Loose) => void) => changeJson('project.json', change)
const manifest = (change: (value: Loose) => void) => changeJson('history/manifest.json', change)

const textOf = (items: Item[], name: string) => {
    const item = items.find((i) => i.name === name)
    assert.ok(item, name)
    return { item, text: new TextDecoder().decode(item.data) }
}

const hashOf = (value: RecordValue) => toHex(hash16Sync(canonicalBytes(value)))

/**
 * Replaces one chunk the head reaches (its header, or a kind's first chunk) with a changed copy,
 * re-hashing the node and root, so only the intended change remains.
 */
const changeHeadChunk =
    (kind: 'header' | string, change: (value: RecordValue[]) => RecordValue[]) =>
    (items: Item[]) => {
        const m = jsonOf(items, 'history/manifest.json')
        const chunks = items.find((i) => i.name === 'history/chunks.bin')
        assert.ok(chunks)
        const head = m.undoStack.slots[m.undoStack.index - m.undoStack.base].snapshot as string
        const root = m.roots[head] as RecordValue[]
        const read = (hash: string) => {
            const [, offset, length] =
                (m.chunks as [string, number, number][]).find(([h]) => h === hash) ?? []
            assert.ok(offset !== undefined && length !== undefined, hash)
            return JSON.parse(
                inflateRawSync(chunks.data.subarray(offset, offset + length)).toString(),
            ) as RecordValue[]
        }
        const add = (value: RecordValue[]) => {
            const bytes = canonicalBytes(value)
            const hash = toHex(hash16Sync(bytes))
            const stored = deflateChunk(bytes)
            m.chunks.push([hash, chunks.data.length, stored.length])
            chunks.data = new Uint8Array([...chunks.data, ...stored])
            return hash
        }
        let newRoot: RecordValue[]
        if (kind === 'header')
            newRoot = [root[0], add(change(read(root[1] as string))), root[2], root[3]]
        else {
            const kinds = root[2] as [string, string][]
            const at = kinds.findIndex(([name]) => name === kind)
            const [, top] = kinds[at] ?? []
            assert.ok(top, kind)
            const node = m.nodes[top] as [string, number, string[]]
            assert.equal(node[1], 0)
            const first = node[2][0] as string
            const newNode: RecordValue[] = [
                node[0],
                0,
                [add(change(read(first))), ...node[2].slice(1)],
            ]
            const nodeHash = hashOf(newNode)
            m.nodes[nodeHash] = newNode
            newRoot = [
                root[0],
                root[1],
                kinds.map((pair, i) => (i === at ? [pair[0], nodeHash] : pair)),
                root[3],
            ]
        }
        const newHead = hashOf(newRoot)
        m.roots[newHead] = newRoot
        const swap = (h: string) => (h === head ? newHead : h)
        for (const e of m.entries) e.snapshot = swap(e.snapshot)
        for (const s of m.undoStack.slots) s.snapshot = swap(s.snapshot)
        delete m.roots[head]
        setJson(items, 'history/manifest.json', m)
    }

/** The items as raw entries, zipped as an OS tool would: DEFLATE throughout, data descriptors, no UTF-8 flag. */
const rezip = (items: Item[], extra: RawEntry[] = []) =>
    rawZip([
        ...items.map((item) => ({
            name: encoder.encode(item.name),
            data: item.data,
            method: 8 as const,
            flags: 0x0008,
        })),
        ...extra,
    ])

/** A file with segments, written by the builder: a chain of 1,100 entries. */
const segmentedFile = async () => {
    // The shared chain's states, its head last, so the summary and media are the head's.
    const { input, store, hashes } = fresh()
    const entries = Array.from({ length: 1099 }, (_, i) =>
        entry(i ? 'edit' : 'init', 1000 + i, `Step ${i}`, hashes[i % 3] as string),
    )
    const head = hashes[2] as string
    entries.push(
        entry('save', 9000, 'Saved', head, {
            revisionId: 'r001-0000-4000-8000-000000000000',
            device: input.context.device,
        }),
    )
    const plan = planNxsp({
        ...input,
        history: {
            entries,
            roots: store.roots,
            nodes: store.nodes,
            chunks: store.chunks,
            undoStack: { base: 0, slots: [{ snapshot: head, label: 'Saved' }], index: 0 },
        },
    }).plan
    return executePlan(plan, new Map())
}

const probes = async (): Promise<Record<string, Uint8Array>> => {
    const filler = {
        kind: 'edit',
        time: 1,
        label: 'x',
        snapshot: '0'.repeat(32),
        noteCount: 0,
        kept: false,
    }
    const segmented = await segmentedFile()
    const fromSegmented = async (change: (items: Item[]) => Item[] | void, store = false) => {
        const { items, modified } = await unzip(segmented)
        const next = change(items) ?? items
        if (store)
            for (const item of next)
                if (item.name.startsWith('history/segments/')) item.method = 'store'
        return new Uint8Array(await (await zipItems(next, modified)).arrayBuffer())
    }
    return {
        // The review's probes.
        noop: await probe(() => undefined),
        'version-true': await probe(project((p) => (p.version = true))),
        'manifest-version-true': await probe(manifest((m) => (m.version = true))),
        'ancestor-empty': await probe(project((p) => p.revision.ancestors.push(''))),
        'root-float': await probe((items) => {
            const { item, text } = textOf(items, 'history/manifest.json')
            const key = Object.keys(JSON.parse(text).roots)[0] as string
            item.data = encoder.encode(text.replace(`"${key}":[1,`, `"${key}":[1.0,`))
        }),
        'device-in-edit': await probe(
            manifest(
                (m) =>
                    (m.entries.find((e: Loose) => e.kind === 'edit').device = {
                        id: 'x',
                        label: 'y',
                    }),
            ),
        ),
        big: await probe((items) => {
            const m = jsonOf(items, 'history/manifest.json')
            const last = m.entries.pop()
            for (let i = 0; i < 200_000; i++) m.entries.push(filler)
            m.entries.push(last)
            setJson(items, 'history/manifest.json', m)
            project((p) => (p.history.entries = m.entries.length))(items)
        }),
        // Agreement on types and ids.
        'parent-empty': await probe(project((p) => (p.revision.parent = ''))),
        'version-float': await probe(project((p) => (p.version = 1.0))),
        'levelversion-true': await probe(project((p) => (p.levelVersion = true))),
        'entries-true': await probe(project((p) => (p.history.entries = true))),
        'bgm-size-true': await probe(project((p) => (p.bgm.size = true))),
        'time-float': await probe(manifest((m) => (m.entries[0].time = 1.5))),
        'time-negative': await probe(manifest((m) => (m.entries[0].time = -1))),
        'kind-unknown': await probe(
            manifest((m) =>
                Object.assign(m.entries[0], {
                    kind: 'merge',
                    stack: { keep: 0, push: [], index: 0 },
                }),
            ),
        ),
        'stack-on-edit': await probe(
            manifest((m) => (m.entries[0].stack = { keep: 0, push: [], index: 0 })),
        ),
        'two-values-bool': await probe((items) => {
            const m = jsonOf(items, 'history/manifest.json')
            const [key, root] = Object.entries(m.roots)[0] as [string, RecordValue[]]
            const segment = {
                entries: [],
                roots: { [key]: [true, ...root.slice(1)] },
                nodes: {},
                chunks: [],
            }
            items.splice(2, 0, {
                name: 'history/segments/1.json',
                data: encoder.encode(JSON.stringify(segment)),
                method: 'deflate',
            })
            project((p) => (p.history.segments = ['history/segments/1.json']))(items)
        }),
        // A BPM of 0: the duration is 0 (IEEE division, then not finite), never a crash.
        'bpm-zero': await probe((items) => {
            changeHeadChunk('bpms', (bpms) =>
                bpms.map((bpm) => [(bpm as RecordValue[])[0] as number, 0, 4]),
            )(items)
            project((p) => (p.summary.durationMs = 0))(items)
        }),
        // Files a writer doesn't make.
        rezipped: await (async () => {
            const { items } = await goldenItems()
            const bgm = items.find((i) => i.name.startsWith('bgm/'))
            assert.ok(bgm)
            bgm.name = 'bgm/バス.mp3'
            project((p) => (p.bgm.file = bgm.name.normalize('NFD')))(items)
            return rezip(items, [
                { name: '__MACOSX/', data: new Uint8Array(0), method: 0 },
                { name: '__MACOSX/._project.json', data: encoder.encode('x'), method: 8 },
                { name: 'Thumbs.db', data: encoder.encode('x'), method: 8 },
            ])
        })(),
        segmented: await fromSegmented(() => undefined),
        'segment-stored': await fromSegmented(() => undefined, true),
        'unknown-entry': await probe((items) =>
            items.push({ name: 'notes.txt', data: encoder.encode('x'), method: 'deflate' }),
        ),
        'unknown-key': await probe(manifest((m) => (m.entries[0].zz = 1))),
        'extra-position': await probe(changeHeadChunk('header', (header) => [...header, 0, 1])),
        'newer-level': await probe(project((p) => (p.levelVersion = 2))),
        'newer-minor': await probe(project((p) => (p.minor = 1))),
        'newer-major': await probe((items) => {
            project((p) => (p.version = 2))(items)
            items.push({ name: 'video/a.mp4', data: encoder.encode('x'), method: 'store' })
        }),
        parts: await probe(project((p) => (p.parts = { video: 'video/a.mp4' }))),
        'parts-array': await probe(project((p) => (p.parts = []))),
        'edited-metadata': await probe(
            project((p) => (p.metadata = { ...p.metadata, title: 'Edited' })),
        ),
        'bad-media': await probe(project((p) => (p.bgm.sha256 = '0'.repeat(64)))),
        duplicate: await (async () => {
            const { items } = await goldenItems()
            return rawZip(
                [...items, items[1] as Item].map((item) => ({
                    name: item.name,
                    data: item.data,
                    method: item.method === 'store' ? 0 : 8,
                })),
            )
        })(),
        'no-project': await probe((items) => items.splice(0, 1)),
        'not-nxsp': await probe(project((p) => (p.format = 'other'))),
        'pointer-outside': await probe(project((p) => (p.level = 'history/manifest.json'))),
        'chunks-tiling': await probe(manifest((m) => (m.chunks[0][1] += 1))),
        // A chunk no open check reads, damaged: the reader opens fully, the writer checks fail.
        'cold-chunk': await probe((items) => {
            const m = jsonOf(items, 'history/manifest.json')
            const chunks = items.find((i) => i.name === 'history/chunks.bin')
            assert.ok(chunks)
            const stored = deflateChunk(encoder.encode('[1]'))
            const hash = '0'.repeat(32)
            m.chunks.push([hash, chunks.data.length, stored.length])
            chunks.data = new Uint8Array([...chunks.data, ...stored])
            setJson(items, 'history/manifest.json', m)
        }),
        'not-zip': encoder.encode('not a zip'),
        // Two ignored entries whose real ranges overlap: the first's local header claims an extra field.
        overlap: await (async () => {
            const { items } = await goldenItems()
            const entries: RawEntry[] = [
                ...items.map((item) => ({
                    name: item.name,
                    data: item.data,
                    method: item.method === 'store' ? (0 as const) : (8 as const),
                })),
                { name: '__MACOSX/a', data: encoder.encode('aaaa'), method: 0 },
                { name: '__MACOSX/b', data: encoder.encode('bbbb'), method: 0 },
            ]
            const zip = rawZip(entries)
            const v = new DataView(zip.buffer)
            let p = v.getUint32(zip.length - 22 + 16, true)
            for (let i = 0; i < entries.length - 2; i++) p += 46 + v.getUint16(p + 28, true)
            v.setUint16(v.getUint32(p + 42, true) + 28, 8, true)
            return zip
        })(),
    }
}

type Opened = { kind: string; open: string | null; reasons: string[] }

const openedBy = async (bytes: Uint8Array): Promise<Opened> => {
    const read = await readNxsp(bytes)
    return {
        kind: read.kind,
        open: read.kind === 'nxsp' ? read.open : null,
        reasons:
            read.kind === 'not-project'
                ? []
                : [...new Set(read.report.map((r) => r.reason))].sort(),
    }
}

test('the reader and the checker open every probe alike', { skip: !hasUv }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nxsp-agree-'))
    try {
        const all = await probes()
        const paths: string[] = []
        for (const [name, bytes] of Object.entries(all)) {
            const path = join(dir, `${name}.nxsp`)
            writeFileSync(path, bytes)
            paths.push(path)
        }
        const read = checker('--read', ...paths)
        assert.equal(read.status, 0, `${read.stdout}${read.stderr}`)
        const lines = read.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Loose)
        const strict = checker(...paths).stdout
        for (const [i, [name, bytes]] of Object.entries(all).entries()) {
            const js = await openedBy(bytes)
            const line = lines[i] ?? {}
            const py: Opened = {
                kind: line.kind,
                open: line.open,
                reasons: [
                    ...new Set((line.report as [string, string][]).map(([reason]) => reason)),
                ].sort(),
            }
            assert.deepEqual(py, js, `${name}: ${JSON.stringify(line.report)}`)
            // Never the dangerous direction: a file the checker passes always opens fully.
            if (strict.includes(`ok ${paths[i] ?? ''}`))
                assert.deepEqual([js.kind, js.open], ['nxsp', 'full'], name)
        }
        // The probes cover each outcome.
        const outcomes = new Set(lines.map((line) => `${line.kind} ${line.open}`))
        for (const outcome of ['nxsp full', 'nxsp partial', 'unreadable null', 'not-project null'])
            assert.ok(outcomes.has(outcome), outcome)
        // A conforming file a writer doesn't make passes the writer checks too.
        for (const name of [
            'noop',
            'root-float',
            'big',
            'segmented',
            'segment-stored',
            'bpm-zero',
            'version-float',
        ])
            assert.match(strict, new RegExp(`ok .*${name}\\.nxsp`), name)
        for (const name of [
            'version-true',
            'manifest-version-true',
            'ancestor-empty',
            'parent-empty',
            'time-float',
            'cold-chunk',
            'two-values-bool',
        ])
            assert.match(strict, new RegExp(`FAIL .*${name}\\.nxsp`), name)
        assert.doesNotMatch(strict, /Error:/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
