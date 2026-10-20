import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { deflateChunk } from '../../../src/local/chunkVerify'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { executePlan, parseSavedAt, planNxsp, readNxsp } from '../../../src/local/nxsp'
import { canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
import { editStep, futureFixtureOperation, initialStep } from '../../helpers/historySteps'
import { rawZip, type RawEntry } from '../../zip/rawZip'
import { fresh } from './chain'
import { jsonOf, overHistoryCap, setJson, unzip, zipItems, type Item, type Loose } from './craft'
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
        const root = m.roots[head] as [number, string, [string, string][], number]
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
        if (kind === 'header') newRoot = [root[0], add(change(read(root[1]))), root[2], root[3]]
        else {
            const kinds = root[2]
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
        entry(
            i
                ? {
                      kind: 'edit',
                      step: editStep(
                          futureFixtureOperation('segmented-row', { index: i }, `Step ${i}`),
                      ),
                  }
                : {
                      kind: 'init',
                      operation: futureFixtureOperation(
                          'segmented-origin',
                          { index: i },
                          `Step ${i}`,
                      ),
                  },
            1000 + i,
            hashes[i % 3] as string,
        ),
    )
    const head = hashes[2] as string
    entries.push(
        entry(
            { kind: 'save', operation: futureFixtureOperation('segmented-save', {}, 'Saved') },
            9000,
            head,
            {
                revisionId: 'r001-0000-4000-8000-000000000000',
                device: input.context.device,
                appVersion: input.context.appVersion,
            },
        ),
    )
    const plan = planNxsp({
        ...input,
        history: {
            entries,
            roots: store.roots,
            nodes: store.nodes,
            chunks: store.chunks,
            undoStack: {
                base: 0,
                slots: [
                    { snapshot: head, step: initialStep(futureFixtureOperation('segmented-head')) },
                ],
                index: 0,
            },
        },
    }).plan
    return executePlan(plan, new Map())
}

const probes = async (): Promise<Record<string, Uint8Array>> => {
    const filler = {
        kind: 'edit',
        time: 1,
        step: editStep(futureFixtureOperation('entry-cap')),
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
        'newer-minor': await probe(project((p) => (p.minor = 2))),
        'newer-patch': await probe(project((p) => (p.patch = 1))),
        'newer-patch-entry': await probe((items) => {
            project((p) => (p.patch = 4))(items)
            items.push({ name: 'video/a.mp4', data: encoder.encode('x'), method: 'store' })
        }),
        'patch-string': await probe(project((p) => (p.patch = '1'))),
        'patch-negative': await probe(project((p) => (p.patch = -1))),
        // Plan §1.6.11.8: `x` is ignorable on every structural object, and carried unread.
        'x-everywhere': await probe(
            manifest((m) => {
                const x = { future: [1, { deep: true }] }
                m.x = x
                m.undoStack.x = x
                m.undoStack.slots[0].x = x
                m.undoStack.slots[0].step.x = x
                for (const e of m.entries) if (e.step) e.step.x = x
            }),
        ),
        'x-not-object': await probe(manifest((m) => (m.undoStack.slots[0].x = [1]))),
        // The operation byte limit holds on every carrier, not only a step's.
        'x-slot-oversize': await probe(
            manifest((m) => (m.undoStack.slots[0].x = { big: 'x'.repeat(300_000) })),
        ),
        'x-manifest-oversize': await probe(manifest((m) => (m.x = { big: 'x'.repeat(300_000) }))),
        'x-entry-oversize': await probe(
            manifest((m) => (m.entries[0].x = { big: 'x'.repeat(300_000) })),
        ),
        'x-undostack-oversize': await probe(
            manifest((m) => (m.undoStack.x = { big: 'x'.repeat(300_000) })),
        ),
        // Plan §1.6.11.8: a key no carrier knows, inside a slot or a step, is "unknown-key".
        'step-unknown-key': await probe(manifest((m) => (m.undoStack.slots[0].step.zz = 1))),
        'entry-step-unknown-key': await probe(
            manifest((m) => (m.entries.find((e: Loose) => e.step).step.zz = 1)),
        ),
        'slot-unknown-key': await probe(manifest((m) => (m.undoStack.slots[0].zz = 1))),
        'step-unknown-key-and-damage': await probe(
            manifest((m) => {
                m.undoStack.slots[0].step.zz = 1
                m.undoStack.slots[0].step.kind = 'nope'
            }),
        ),
        // The app version of a save: optional on read, a string, only on a save entry.
        'appversion-absent': await probe(
            manifest((m) => delete m.entries.find((e: Loose) => e.kind === 'save').appVersion),
        ),
        'appversion-number': await probe(
            manifest((m) => (m.entries.find((e: Loose) => e.kind === 'save').appVersion = 6)),
        ),
        'appversion-on-edit': await probe(manifest((m) => (m.entries[1].appVersion = '0.6.0'))),
        // Plan §1.6.11.4: names are UTF-8 as Rust's from_utf8_lossy reads them, which keeps U+FEFF.
        'bom-name': await (async () => {
            const { items } = await goldenItems()
            const bom = [0xef, 0xbb, 0xbf]
            return rawZip(
                items.map((item) => ({
                    name: item.name.startsWith('bgm/')
                        ? new Uint8Array([...bom, ...encoder.encode(item.name)])
                        : item.name,
                    data: item.data,
                    method: item.method === 'store' ? (0 as const) : (8 as const),
                })),
            )
        })(),
        // A hash is exactly 32 or 64 lowercase hex digits: no trailing newline.
        'sha256-newline': await probe(
            project(
                (p) =>
                    (p.bgm.sha256 = `${p.bgm.sha256}
`),
            ),
        ),
        'hash-newline': await probe(
            project(
                (p) =>
                    (p.metadata.preview = {
                        type: 'audio/mpeg',
                        hash: `${'a'.repeat(32)}
`,
                        size: 3,
                    }),
            ),
        ),
        // Huge integer literals read as JSON.parse reads them: a double, or Infinity.
        'huge-int-n': await probe((items) => {
            const { item, text } = textOf(items, 'project.json')
            item.data = encoder.encode(text.replace(/"n":\d+/, `"n":1${'0'.repeat(400)}`))
        }),
        'huge-int-rating': await probe((items) => {
            const { item, text } = textOf(items, 'project.json')
            item.data = encoder.encode(text.replace('"rating":12', `"rating":${'9'.repeat(5000)}`))
        }),
        'huge-int-level': await probe((items) => {
            const { item, text } = textOf(items, 'level.json')
            item.data = encoder.encode(
                text.replace(/"bgmOffset":[^,]+/, `"bgmOffset":${'7'.repeat(5000)}`),
            )
        }),
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
        'history-cap': await overHistoryCap(new Blob([readFileSync(join(golden, 'write-2.nxsp'))])),
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

/**
 * What the plan says each of these opens as (§1.6.11.4, §1.6.11.8), written out apart from either
 * reader: both readers can share a deviation, and agreeing with each other cannot catch it.
 */
const expectedByPlan: Record<string, Opened> = {
    noop: { kind: 'nxsp', open: 'full', reasons: [] },
    // A newer patch alone is a notice: the open is whole. With anything else unknown it is partial.
    'newer-patch': { kind: 'nxsp', open: 'full', reasons: ['newer-patch'] },
    'newer-patch-entry': {
        kind: 'nxsp',
        open: 'partial',
        reasons: ['newer-patch', 'unknown-entry'],
    },
    'patch-string': { kind: 'nxsp', open: 'partial', reasons: ['invalid-key'] },
    'patch-negative': { kind: 'nxsp', open: 'partial', reasons: ['invalid-key'] },
    // A newer minor skips the history; the file opens partial.
    'newer-minor': { kind: 'nxsp', open: 'partial', reasons: ['newer-minor'] },
    // `x` is ignorable anywhere; a non-object `x` is damaged history.
    'x-everywhere': { kind: 'nxsp', open: 'full', reasons: [] },
    'x-not-object': { kind: 'nxsp', open: 'partial', reasons: ['history-unreadable'] },
    'x-slot-oversize': { kind: 'nxsp', open: 'partial', reasons: ['history-unreadable'] },
    'x-manifest-oversize': { kind: 'nxsp', open: 'partial', reasons: ['history-unreadable'] },
    'x-entry-oversize': { kind: 'nxsp', open: 'partial', reasons: ['history-unreadable'] },
    'x-undostack-oversize': { kind: 'nxsp', open: 'partial', reasons: ['history-unreadable'] },
    // An unknown key in a slot or step is newer content: "Made by a newer version", not damage.
    'step-unknown-key': { kind: 'nxsp', open: 'partial', reasons: ['unknown-key'] },
    'entry-step-unknown-key': { kind: 'nxsp', open: 'partial', reasons: ['unknown-key'] },
    'slot-unknown-key': { kind: 'nxsp', open: 'partial', reasons: ['unknown-key'] },
    'step-unknown-key-and-damage': {
        kind: 'nxsp',
        open: 'partial',
        reasons: ['history-unreadable', 'unknown-key'],
    },
    // The app version of a save is optional, a string, and a save's alone.
    'appversion-absent': { kind: 'nxsp', open: 'full', reasons: [] },
    'appversion-number': { kind: 'nxsp', open: 'partial', reasons: ['history-unreadable'] },
    'appversion-on-edit': { kind: 'nxsp', open: 'partial', reasons: ['unknown-key'] },
    // A name keeps a leading U+FEFF: it is another entry than bgm/…, which is then missing.
    'bom-name': { kind: 'nxsp', open: 'partial', reasons: ['media-unreadable', 'unknown-entry'] },
    // A hash with a trailing newline is no hash.
    'sha256-newline': { kind: 'nxsp', open: 'partial', reasons: ['invalid-key', 'unknown-entry'] },
    'hash-newline': { kind: 'nxsp', open: 'partial', reasons: ['invalid-key', 'unknown-entry'] },
    // Past the double range a literal is Infinity: not a safe integer, not a finite number.
    'huge-int-n': { kind: 'nxsp', open: 'partial', reasons: ['invalid-key'] },
    'huge-int-rating': { kind: 'nxsp', open: 'partial', reasons: ['invalid-key'] },
    // level.json's numbers are the level parser's, not the reader's.
    'huge-int-level': { kind: 'nxsp', open: 'full', reasons: [] },
}

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
            const planned = expectedByPlan[name]
            if (planned) assert.deepEqual(js, planned, `${name} by the plan`)
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
        assert.match(
            strict,
            /FAIL .*history-cap\.nxsp: history: the manifest and segments are over their cap/,
        )
        assert.doesNotMatch(strict, /Error:/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test(
    'savedAt reads the same in the reader and the checker: RFC 3339 only, else absent',
    { skip: !hasUv },
    async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nxsp-saved-'))
        try {
            const cases: [unknown, number | null][] = [
                ['2026-10-16T05:41:07Z', Date.UTC(2026, 9, 16, 5, 41, 7)],
                ['2026-10-16T05:41:07.250Z', Date.UTC(2026, 9, 16, 5, 41, 7)],
                ['2026-10-16T14:41:07+09:00', Date.UTC(2026, 9, 16, 5, 41, 7)],
                ['2026-10-15T20:41:07-09:00', Date.UTC(2026, 9, 16, 5, 41, 7)],
                ['2024-02-29T00:00:00Z', Date.UTC(2024, 1, 29)],
                ['1970-01-01T00:00:00Z', 0],
                ['0000-01-01T00:00:00Z', -62_167_219_200_000],
                ['2026-10-16T05:41:07z', null],
                ['2026-10-16t05:41:07Z', null],
                ['2026-10-16 05:41:07Z', null],
                ['2026-10-16T05:41:07', null],
                ['2026-10-16T05:41Z', null],
                ['2026-10-16T05:41:07.Z', null],
                ['2026-10-16T05:41:07+0900', null],
                ['2026-10-16T05:41:60Z', null],
                ['2026-10-16T24:00:00Z', null],
                ['2026-10-16T05:60:00Z', null],
                ['2026-13-01T00:00:00Z', null],
                ['2026-00-10T00:00:00Z', null],
                ['2026-02-29T00:00:00Z', null],
                ['2026-04-31T00:00:00Z', null],
                ['1900-02-29T00:00:00Z', null],
                ['2026-10-16T05:41:07+24:00', null],
                ['2026-10-16T05:41:07+09:60', null],
                ['Oct 19 2026', null],
                ['٢٠٢٦-١٠-١٦T٠٥:٤١:٠٧Z', null],
                ['2026-10-16T05:41:07Z\n', null],
                [' 2026-10-16T05:41:07Z', null],
                ['', null],
                [1792126800000, null],
                [null, null],
                [true, null],
            ]
            const paths: string[] = []
            for (const [i, [savedAt]] of cases.entries()) {
                const path = join(dir, `${i}.nxsp`)
                writeFileSync(path, await probe(project((p) => (p.revision.savedAt = savedAt))))
                paths.push(path)
            }
            const read = checker('--read', ...paths)
            assert.equal(read.status, 0, `${read.stdout}${read.stderr}`)
            const lines = read.stdout
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as Loose)
            for (const [i, [savedAt, millis]] of cases.entries()) {
                const js = await readNxsp(new Uint8Array(readFileSync(paths[i] as string)))
                assert.equal(js.kind, 'nxsp')
                const label = JSON.stringify(savedAt)
                // Never a reason to open partial, on either side.
                assert.equal(js.kind === 'nxsp' ? js.open : '', 'full', label)
                assert.equal(lines[i]?.open, 'full', label)
                assert.equal(parseSavedAt(savedAt) ?? null, millis, label)
                // What the reader keeps of the revision is the same value, or nothing.
                const kept = js.kind === 'nxsp' ? js.project?.revision?.savedAt : undefined
                assert.equal(kept === undefined ? null : parseSavedAt(kept), millis, label)
                assert.equal(lines[i]?.savedAt ?? null, parseSavedAt(savedAt) ?? null, label)
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    },
)
