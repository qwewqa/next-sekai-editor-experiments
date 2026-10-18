import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { deflateChunk } from '../../../src/local/chunkVerify'
import {
    currentSummary,
    placedCompleteFrom,
    readNxsp,
    type NxspRead,
} from '../../../src/local/nxsp'
import { readProject } from '../../../src/local/nxsp/project'
import { rawZip, type RawEntry } from '../../zip/rawZip'
import {
    crafted,
    freshFile,
    jsonOf,
    overHistoryCap,
    readCrafted,
    reasonsOf,
    setJson,
    unzip,
    type Item,
    type Loose,
} from './craft'

const encoder = new TextEncoder()

const nxsp = (read: NxspRead) => {
    assert.equal(read.kind, 'nxsp', JSON.stringify(read))
    return read as Extract<NxspRead, { kind: 'nxsp' }>
}

const hasReason = (read: NxspRead, reason: string, path?: string) =>
    reasonsOf(read).some(
        (line) =>
            line === (path === undefined ? line : `${reason} ${path}`) && line.startsWith(reason),
    )

/** The items as raw entries, for faults the writer can't make. */
const rawOf = (items: readonly Item[]): RawEntry[] =>
    items.map((item) => ({
        name: item.name,
        data: item.data,
        method: item.method === 'store' ? 0 : 8,
    }))

const rawFile = async (change: (entries: RawEntry[]) => RawEntry[] | void) => {
    const { items } = await unzip(await freshFile())
    const entries = rawOf(items)
    return new Blob([rawZip(change(entries) ?? entries)])
}

test('a good file opens fully', async () => {
    const read = nxsp(await readNxsp(await freshFile()))
    assert.deepEqual(read.report, [])
    assert.equal(read.open, 'full')
    assert.ok(read.history)
})

test('bytes and a Blob read alike', async () => {
    const file = await freshFile()
    const a = nxsp(await readNxsp(new Uint8Array(await file.arrayBuffer())))
    assert.equal(a.open, 'full')
})

test('not a project: no project.json, or another format', async () => {
    assert.equal(
        (await readNxsp(new Blob([rawZip([{ name: 'a.txt', data: encoder.encode('x') }])]))).kind,
        'not-project',
    )
    const other = await readCrafted((items) => {
        setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), format: 'other' })
    })
    assert.equal(other.kind, 'not-project')
    const garbage = await readNxsp(encoder.encode('not a zip at all'))
    assert.equal(garbage.kind, 'unreadable')
})

// Ambiguity and damage (§1.6.11.4)

test('two entries with the same name are damage: the file opens without its history', async () => {
    const file = await rawFile((entries) => {
        const chunks = entries.find((e) => e.name === 'history/chunks.bin')
        assert.ok(chunks)
        entries.push({ ...chunks })
    })
    const read = nxsp(await readNxsp(file))
    assert.ok(hasReason(read, 'damaged', 'history/chunks.bin'))
    assert.equal(read.history, undefined)
    assert.equal(read.open, 'partial')
})

test('two names equal after NFC are duplicates', async () => {
    const file = await rawFile((entries) => {
        entries.push({ name: 'assets/xé', data: encoder.encode('a'), method: 0 })
        entries.push({ name: 'assets/xé', data: encoder.encode('b'), method: 0 })
    })
    assert.ok(hasReason(await readNxsp(file), 'damaged', 'assets/xé'))
})

test('a duplicate level.json opens nothing', async () => {
    const file = await rawFile((entries) => {
        const level = entries.find((e) => e.name === 'level.json')
        assert.ok(level)
        entries.push({ ...level })
    })
    assert.equal((await readNxsp(file)).kind, 'unreadable')
})

test('a local header that disagrees with its central record is damage', async () => {
    const file = await rawFile((entries) => {
        const manifest = entries.find((e) => e.name === 'history/manifest.json')
        assert.ok(manifest)
        manifest.central = { method: 0 }
    })
    const read = nxsp(await readNxsp(file))
    assert.equal(read.history, undefined)
    assert.ok(reasonsOf(read).some((line) => line.startsWith('damaged')))
})

test('overlapping data ranges are damage', async () => {
    const file = await (async () => {
        const { items } = await unzip(await freshFile())
        const entries = rawOf(items)
        entries.push({ name: 'assets/a', data: encoder.encode('aaaa'), method: 0 })
        entries.push({ name: 'assets/b', data: encoder.encode('bbbb'), method: 0 })
        const zip = rawZip(entries)
        const v = new DataView(zip.buffer)
        const end = zip.length - 22
        let p = v.getUint32(end + 16, true)
        const records: { pos: number; offset: number }[] = []
        for (let i = 0; i < entries.length; i++) {
            records.push({ pos: p, offset: v.getUint32(p + 42, true) })
            p += 46 + v.getUint16(p + 28, true)
        }
        const last = records.at(-1)
        const before = records.at(-2)
        assert.ok(last && before)
        v.setUint32(last.pos + 42, before.offset, true)
        return new Blob([zip])
    })()
    const read = nxsp(await readNxsp(file))
    assert.ok(
        reasonsOf(read).some((line) => line.startsWith('damaged assets/')),
        reasonsOf(read).join(),
    )
    assert.equal(read.history, undefined)
})

test('real ranges are checked for every entry, ignored ones too', async () => {
    const { items } = await unzip(await freshFile())
    const entries = rawOf(items)
    entries.push({ name: '__MACOSX/a', data: encoder.encode('aaaa'), method: 0 })
    entries.push({ name: '__MACOSX/b', data: encoder.encode('bbbb'), method: 0 })
    const zip = rawZip(entries)
    const v = new DataView(zip.buffer)
    // `a`'s local header claims an extra field its data then overlaps `b`'s header with.
    let p = v.getUint32(zip.length - 22 + 16, true)
    for (let i = 0; i < entries.length - 2; i++) p += 46 + v.getUint16(p + 28, true)
    v.setUint16(v.getUint32(p + 42, true) + 28, 8, true)
    const read = nxsp(await readNxsp(new Blob([zip])))
    assert.deepEqual(reasonsOf(read), ['damaged __MACOSX/a', 'damaged __MACOSX/b'])
    assert.equal(read.history, undefined)
})

test('inflating past the declared size is damage', async () => {
    const file = await rawFile((entries) => {
        const manifest = entries.find((e) => e.name === 'history/manifest.json')
        assert.ok(manifest)
        // Declares fewer bytes than its stream holds, in both headers.
        manifest.stored = deflateRawSync(manifest.data)
        manifest.data = manifest.data.subarray(0, manifest.data.length - 10)
    })
    const read = nxsp(await readNxsp(file))
    assert.ok(hasReason(read, 'damaged', 'history/manifest.json'))
    assert.equal(read.history, undefined)
})

test('a STORE entry whose stored and declared sizes differ is damage', async () => {
    const file = await rawFile((entries) => {
        const chunks = entries.find((e) => e.name === 'history/chunks.bin')
        assert.ok(chunks)
        chunks.stored = new Uint8Array([...chunks.data, 0, 0])
    })
    const read = nxsp(await readNxsp(file))
    assert.ok(
        reasonsOf(read).some((line) => line.startsWith('damaged history/chunks.bin')),
        reasonsOf(read).join(),
    )
})

test('a DEFLATE entry stored past 2 × size + 1024 is refused before it is read', async () => {
    const file = await rawFile((entries) => {
        const manifest = entries.find((e) => e.name === 'history/manifest.json')
        assert.ok(manifest)
        manifest.stored = new Uint8Array(manifest.data.length * 2 + 2048)
    })
    assert.ok(hasReason(await readNxsp(file), 'damaged', 'history/manifest.json'))
})

test('every reader cap: past it is damage', async () => {
    const file = await freshFile()
    const sizes = Object.fromEntries((await unzip(file)).items.map((i) => [i.name, i.data.length]))
    const level = sizes['level.json'] ?? 0
    const manifest = sizes['history/manifest.json'] ?? 0
    const chunks = sizes['history/chunks.bin'] ?? 0

    assert.equal((await readNxsp(file, { project: 10 })).kind, 'unreadable')
    assert.equal((await readNxsp(file, { level: level - 1 })).kind, 'unreadable')
    const m = nxsp(await readNxsp(file, { manifest: manifest - 1 }))
    assert.ok(hasReason(m, 'damaged', 'history/manifest.json'))
    assert.equal(m.history, undefined)
    const c = nxsp(await readNxsp(file, { chunksBin: chunks - 1 }))
    assert.ok(hasReason(c, 'damaged', 'history/chunks.bin'))
    const k = nxsp(await readNxsp(file, { chunk: 8 }))
    assert.ok(reasonsOf(k).some((line) => line.startsWith('history-unreadable')))
    const media = nxsp(await readNxsp(file, { media: 4 }))
    assert.ok(reasonsOf(media).some((line) => line.startsWith('damaged bgm/')))
})

test('JSON nested deeper than 64 is damage', async () => {
    const deep = (n: number): unknown => (n ? [deep(n - 1)] : 0)
    const read = await readCrafted((items) => {
        setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), zz: deep(64) })
    })
    assert.equal(read.kind, 'unreadable')
    const ok = await readCrafted((items) => {
        setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), zz: deep(62) })
    })
    assert.equal(nxsp(ok).open, 'full')
})

test('more than 4,096 segments is damage', async () => {
    const read = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            project.history.segments = Array.from({ length: 4097 }, (_, i) => `history/s${i}`)
            setJson(items, 'project.json', project)
        }),
    )
    assert.ok(hasReason(read, 'damaged', 'history.segments'))
    assert.equal(read.history, undefined)
})

test('the manifest and segments over 512 MB together is damage: no history', async () => {
    const read = nxsp(await readNxsp(new Blob([await overHistoryCap(await freshFile())])))
    assert.ok(hasReason(read, 'damaged', 'history'), reasonsOf(read).join())
    assert.equal(read.history, undefined)
    assert.ok(read.level)
    // The same check at real sizes, with a smaller cap.
    const small = nxsp(await readNxsp(await freshFile(), { history: 100 }))
    assert.deepEqual(reasonsOf(small), ['damaged history'])
})

test('more than 65,535 entries opens nothing', async () => {
    const entries: RawEntry[] = Array.from({ length: 65536 }, (_, i) => ({
        name: `x${i}`,
        data: new Uint8Array(0),
        method: 0,
    }))
    assert.equal(
        (await readNxsp(new Blob([rawZip(entries, { zip64End: true })]))).kind,
        'unreadable',
    )
})

test('two pointers naming one entry, or a pointer outside its prefix, are damage', async () => {
    const aliased = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            project.history.chunks = project.history.manifest
            setJson(items, 'project.json', project)
        }),
    )
    assert.ok(hasReason(aliased, 'damaged', 'history.chunks'))
    const outside = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            const bgm = items.find((i) => i.name.startsWith('bgm/'))
            assert.ok(bgm)
            bgm.name = 'assets/song.mp3'
            project.bgm.file = 'assets/song.mp3'
            setJson(items, 'project.json', project)
        }),
    )
    assert.ok(hasReason(outside, 'damaged', 'bgm.file'))
})

test('parts that is not an object is damage; a key in parts is unknown', async () => {
    const bad = nxsp(
        await readCrafted((items) => {
            setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), parts: [] })
        }),
    )
    assert.ok(hasReason(bad, 'damaged', 'parts'))
    const key = nxsp(
        await readCrafted((items) => {
            setJson(items, 'project.json', {
                ...jsonOf(items, 'project.json'),
                parts: { video: 'video/a.mp4' },
            })
        }),
    )
    assert.ok(hasReason(key, 'unknown-key', 'parts.video'))
    assert.equal(key.extra.parts, undefined)
    assert.ok(key.history, 'a partial open for unknown content still reads the history')
    const empty = nxsp(
        await readCrafted((items) => {
            setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), parts: {} })
        }),
    )
    assert.equal(empty.open, 'full')
})

// Unknown content (§1.6.11.8)

test('an unknown entry makes the open partial; ignored entries do not', async () => {
    const unknown = nxsp(
        await readCrafted((items) => {
            items.push({ name: 'video/clip.mp4', data: encoder.encode('v'), method: 'store' })
        }),
    )
    assert.deepEqual(reasonsOf(unknown), ['unknown-entry video/clip.mp4'])
    const media = nxsp(
        await readCrafted((items) => {
            items.push({ name: 'history/media/1.png', data: encoder.encode('v'), method: 'store' })
        }),
    )
    assert.deepEqual(reasonsOf(media), ['unknown-entry history/media/1.png'])
    const ignored = nxsp(
        await readCrafted((items) => {
            for (const name of [
                '__MACOSX/._level.json',
                'Thumbs.db',
                'bgm/.DS_Store',
                'desktop.ini',
                'cache/waveform.bin',
                'assets/._cover.png',
            ])
                items.push({ name, data: encoder.encode('x'), method: 'store' })
        }),
    )
    assert.equal(ignored.open, 'full')
})

test('unknown top-level and metadata keys are kept as extra; anywhere else they make the open partial', async () => {
    const kept = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            project.zzNew = { a: 1 }
            project.metadata.zzMeta2 = 'x'
            project.revision.zzIgnored = 1
            project.summary.zzIgnored = 1
            setJson(items, 'project.json', project)
        }),
    )
    assert.equal(kept.open, 'full')
    assert.deepEqual(kept.extra, {
        zzTop: { kept: true },
        zzNew: { a: 1 },
        metadata: { zzMeta: 1, zzMeta2: 'x' },
    })

    for (const [where, set] of [
        ['bgm.zz', (p: Loose) => (p.bgm.zz = 1)],
        ['history.media', (p: Loose) => (p.history.media = [])],
        ['editor.zz', (p: Loose) => (p.editor.zz = 1)],
        ['metadata.cover.zz', (p: Loose) => (p.metadata.cover.zz = 1)],
        ['metadata.preview.zz', (p: Loose) => (p.metadata.preview.zz = 1)],
        ['metadata.tags[0].zz', (p: Loose) => (p.metadata.tags[0].zz = 1)],
    ] as const) {
        const read = nxsp(
            await readCrafted((items) => {
                const project = jsonOf(items, 'project.json')
                set(project)
                setJson(items, 'project.json', project)
            }),
        )
        assert.ok(hasReason(read, 'unknown-key', where), `${where}: ${reasonsOf(read).join()}`)
    }
})

test('a key named __proto__ is kept in extra like any other', async () => {
    const read = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            const text = JSON.stringify(project)
                .replace('{', '{"__proto__":{"a":1},')
                .replace('"metadata":{', '"metadata":{"__proto__":2,')
            const item = items.find((i) => i.name === 'project.json')
            assert.ok(item)
            item.data = encoder.encode(text)
        }),
    )
    assert.equal(read.open, 'full')
    assert.ok(Object.hasOwn(read.extra, '__proto__'))
    assert.ok(Object.hasOwn(read.extra.metadata ?? {}, '__proto__'))
    const written = JSON.stringify(read.extra)
    assert.match(written, /"__proto__":\{"a":1\}/)
    assert.match(written, /"__proto__":2/)
})

test('a bgm with file and hash, or without file and with sha256, is a schema violation', async () => {
    const both = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            project.bgm.hash = project.bgm.sha256.slice(0, 32)
            setJson(items, 'project.json', project)
        }),
    )
    assert.ok(hasReason(both, 'unknown-key', 'bgm.hash'))
    const meta = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            project.metadata.preview.sha256 = '0'.repeat(64)
            setJson(items, 'project.json', project)
        }),
    )
    assert.ok(hasReason(meta, 'unknown-key', 'metadata.preview.sha256'))
})

test('an unknown key in level.json makes the open partial', async () => {
    const read = nxsp(
        await readCrafted((items) => {
            setJson(items, 'level.json', { ...jsonOf(items, 'level.json'), zz: 1 })
        }),
    )
    assert.deepEqual(reasonsOf(read), ['unknown-key level.json.zz'])
})

test('versions: a newer major reads the level only; a newer minor skips the history; a newer levelVersion is partial', async () => {
    const major = nxsp(
        await readCrafted((items) => {
            setJson(items, 'project.json', {
                ...jsonOf(items, 'project.json'),
                version: 2,
                zzWhatever: 1,
            })
            items.push({ name: 'new/thing', data: encoder.encode('x'), method: 'store' })
        }),
    )
    assert.deepEqual(reasonsOf(major), ['newer-version version'])
    assert.equal(major.project, undefined)
    assert.ok(major.level)

    const minor = nxsp(
        await readCrafted((items) => {
            setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), minor: 1 })
        }),
    )
    assert.deepEqual(reasonsOf(minor), ['newer-minor minor'])
    assert.equal(minor.history, undefined)

    const absent = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            delete project.minor
            setJson(items, 'project.json', project)
        }),
    )
    assert.equal(absent.open, 'full')
    assert.equal(absent.project?.minor, 0)

    const level = nxsp(
        await readCrafted((items) => {
            setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), levelVersion: 2 })
        }),
    )
    assert.deepEqual(reasonsOf(level), ['newer-level levelVersion'])
    assert.ok(level.history)
})

// History (§1.6.11.5)

const changeManifest = (change: (manifest: Loose) => void) =>
    readCrafted((items) => {
        const manifest = jsonOf(items, 'history/manifest.json')
        change(manifest)
        setJson(items, 'history/manifest.json', manifest)
    })

test('a newer manifest version, root v or entry kind: newer history, not read', async () => {
    const version = nxsp(await changeManifest((m) => (m.version = 2)))
    assert.deepEqual(reasonsOf(version), ['newer-history manifest.version'])
    assert.equal(version.history, undefined)

    const kind = nxsp(await changeManifest((m) => (m.entries[0].kind = 'merge')))
    assert.ok(hasReason(kind, 'newer-history', 'manifest.entries[0].kind'))

    const rootV = nxsp(
        await changeManifest((m) => {
            const key = Object.keys(m.roots)[0] as string
            m.roots[key][0] = 2
        }),
    )
    assert.ok(
        reasonsOf(rootV).some((line) => line.startsWith('newer-history roots.')),
        reasonsOf(rootV).join(),
    )
})

test('an unknown entry kind is newer only, whatever fields it carries', async () => {
    const read = nxsp(
        await changeManifest((m) => {
            m.entries[0].kind = 'merge'
            m.entries[0].revisionId = 'r'
            m.entries[0].device = { id: 'd', label: 'D' }
            m.entries[0].stack = { keep: 0, push: [], index: 0 }
        }),
    )
    assert.deepEqual(reasonsOf(read), ['newer-history manifest.entries[0].kind'])
})

test('a field another entry kind has is an unknown key', async () => {
    const read = nxsp(
        await changeManifest((m) => {
            m.entries[1].revisionId = 'r'
            m.entries[1].device = { id: 'd', label: 'D' }
            m.entries[1].stack = { keep: 0, push: [], index: 0 }
        }),
    )
    assert.deepEqual(reasonsOf(read), [
        'unknown-key manifest.entries[1].revisionId',
        'unknown-key manifest.entries[1].device',
        'unknown-key manifest.entries[1].stack',
    ])
    assert.equal(read.history, undefined)
})

test('an entry’s time is a safe integer of at least 0', async () => {
    for (const time of [1.5, -1, 2 ** 53, '1']) {
        const read = nxsp(await changeManifest((m) => (m.entries[0].time = time)))
        assert.deepEqual(
            reasonsOf(read),
            ['history-unreadable manifest.entries[0].time'],
            `${time}`,
        )
    }
    const zero = nxsp(await changeManifest((m) => (m.entries[0].time = 0)))
    assert.equal(zero.open, 'full')
})

test('a part with 200,000 entries opens: no argument-list overflow', async () => {
    const filler = { kind: 'edit', time: 1, label: 'x', snapshot: '0'.repeat(32), noteCount: 0 }
    const read = nxsp(
        await readCrafted((items) => {
            const manifest = jsonOf(items, 'history/manifest.json')
            const last = manifest.entries.pop()
            for (let i = 0; i < 200_000; i++) manifest.entries.push({ ...filler, kept: false })
            manifest.entries.push(last)
            setJson(items, 'history/manifest.json', manifest)
            const project = jsonOf(items, 'project.json')
            project.history.entries = manifest.entries.length
            setJson(items, 'project.json', project)
        }),
    )
    assert.equal(read.open, 'full', reasonsOf(read).join())
    assert.equal(read.history?.entries.length, 200_000 + 4)
})

test('issues are capped: the first 20, then how many more', async () => {
    const read = nxsp(
        await changeManifest((m) => {
            for (let i = 0; i < 1000; i++) m.entries.push({ ...m.entries[0], time: -1 })
        }),
    )
    assert.equal(read.report.length, 21)
    assert.deepEqual(read.report.at(-1), {
        reason: 'history-unreadable',
        path: 'manifest',
        detail: 'and 980 more',
    })
})

test('an unknown key anywhere in the manifest makes the open partial', async () => {
    for (const [path, change] of [
        ['manifest.zz', (m: Loose) => (m.zz = 1)],
        ['manifest.entries[0].zz', (m: Loose) => (m.entries[0].zz = 1)],
        ['manifest.entries[3].device.zz', (m: Loose) => (m.entries[3].device.zz = 1)],
        ['manifest.undoStack.zz', (m: Loose) => (m.undoStack.zz = 1)],
        ['manifest.undoStack.slots[0].zz', (m: Loose) => (m.undoStack.slots[0].zz = 1)],
    ] as const) {
        const read = nxsp(await changeManifest(change))
        assert.ok(hasReason(read, 'unknown-key', path), `${path}: ${reasonsOf(read).join()}`)
        assert.equal(read.history, undefined)
    }
    // Inside `x`, anything goes.
    const x = nxsp(
        await changeManifest((m) => (m.entries[0].x = { anything: [1, { deep: true }] })),
    )
    assert.equal(x.open, 'full')
    assert.deepEqual(x.history?.entries[0]?.x, { anything: [1, { deep: true }] })
    const notObject = nxsp(await changeManifest((m) => (m.entries[0].x = [1])))
    assert.ok(hasReason(notObject, 'history-unreadable', 'manifest.entries[0].x'))
})

test('a root or node under a wrong hash is unreadable history', async () => {
    const root = nxsp(
        await changeManifest((m) => {
            const key = Object.keys(m.roots)[0] as string
            m.roots[key][3] += 1
        }),
    )
    assert.ok(reasonsOf(root).some((line) => line.startsWith('history-unreadable roots.')))
    assert.equal(root.history, undefined)
    const node = nxsp(
        await changeManifest((m) => {
            const key = Object.keys(m.nodes)[0] as string
            m.nodes[key][2].reverse()
            m.nodes[key][2].push(m.nodes[key][2][0])
        }),
    )
    assert.ok(reasonsOf(node).some((line) => line.startsWith('history-unreadable nodes.')))
})

test('history.entries not matching the parts is unreadable history', async () => {
    const read = nxsp(
        await readCrafted((items) => {
            const project = jsonOf(items, 'project.json')
            project.history.entries += 1
            setJson(items, 'project.json', project)
        }),
    )
    assert.ok(hasReason(read, 'history-unreadable', 'history.entries'))
})

test('an index that does not tile chunks.bin, or a chunk under a wrong hash, is unreadable history', async () => {
    const gap = nxsp(await changeManifest((m) => (m.chunks[1][1] += 1)))
    assert.ok(reasonsOf(gap).some((line) => line.startsWith('history-unreadable chunks.')))
    const short = nxsp(
        await readCrafted((items) => {
            const chunks = items.find((i) => i.name === 'history/chunks.bin')
            assert.ok(chunks)
            chunks.data = new Uint8Array([...chunks.data, 0])
        }),
    )
    assert.ok(hasReason(short, 'history-unreadable', 'chunks'))
    // Swap two chunks' bytes, keeping the index's lengths: the head's chunks no longer hash.
    const swapped = nxsp(
        await readCrafted((items) => {
            const manifest = jsonOf(items, 'history/manifest.json')
            const chunks = items.find((i) => i.name === 'history/chunks.bin')
            assert.ok(chunks)
            const [first] = manifest.chunks as [string, number, number][]
            assert.ok(first)
            const bytes = chunks.data.slice()
            const replacement = deflateChunk(encoder.encode('[]'))
            bytes.set(replacement.subarray(0, Math.min(replacement.length, first[2])), first[1])
            chunks.data = bytes
        }),
    )
    assert.ok(
        reasonsOf(swapped).some((line) => line.startsWith('history-unreadable')),
        reasonsOf(swapped).join(),
    )
})

test('a dangling reference, a stack index out of range, or a key with two values: unreadable history', async () => {
    const dangling = nxsp(await changeManifest((m) => (m.entries[1].snapshot = '0'.repeat(32))))
    assert.ok(hasReason(dangling, 'history-unreadable', 'entries[1]'))
    const notKept = nxsp(
        await changeManifest((m) => {
            m.entries[1].snapshot = '0'.repeat(32)
            m.entries[1].kept = false
        }),
    )
    assert.equal(notKept.open, 'full')
    const stack = nxsp(await changeManifest((m) => (m.undoStack.index = 3)))
    assert.ok(hasReason(stack, 'history-unreadable', 'undoStack.index'))
    const below = nxsp(await changeManifest((m) => (m.undoStack.base = 3)))
    assert.ok(hasReason(below, 'history-unreadable', 'undoStack.index'))
})

test('a kept: false row whose root the file holds is accepted', async () => {
    const read = nxsp(await changeManifest((m) => (m.entries[0].kept = false)))
    assert.equal(read.open, 'full')
    assert.equal(read.history?.entries[0]?.kept, false)
})

test('media failing its size or SHA-256, or missing, is unreadable media', async () => {
    const changed = nxsp(
        await readCrafted((items) => {
            const bgm = items.find((i) => i.name.startsWith('bgm/'))
            assert.ok(bgm)
            bgm.data = bgm.data.map((b) => b ^ 1)
        }),
    )
    assert.deepEqual(
        changed.report.map(({ reason, media }) => [reason, media]),
        [['media-unreadable', 'bgm']],
    )
    assert.ok(changed.history, 'the rest still opens')
    const missing = nxsp(
        await readCrafted((items) => items.filter((i) => !i.name.startsWith('assets/cover.'))),
    )
    assert.deepEqual(
        missing.report.map(({ reason, media }) => [reason, media]),
        [['media-unreadable', 'cover']],
    )
})

test('an OS re-zip opens fully: DEFLATE everywhere, data descriptors, no UTF-8 flag, NFD pointers', async () => {
    const { items } = await unzip(await freshFile())
    const project = jsonOf(items, 'project.json')
    const bgm = items.find((i) => i.name.startsWith('bgm/'))
    assert.ok(bgm)
    // A Japanese entry name written without bit 11, and its pointer in NFD.
    const name = 'bgm/バス.mp3'
    bgm.name = name
    project.bgm.file = name.normalize('NFD')
    setJson(items, 'project.json', project)
    const entries: RawEntry[] = items.map((item) => ({
        name: encoder.encode(item.name),
        data: item.data,
        method: 8,
        flags: 0x0008,
    }))
    entries.push({
        name: '__MACOSX/._project.json',
        data: encoder.encode('x'),
        method: 8,
        flags: 8,
    })
    const read = nxsp(await readNxsp(new Blob([rawZip(entries)])))
    assert.deepEqual(read.report, [])
    assert.ok(read.history)
    assert.ok(read.media.bgm)
    // chunks.bin deflated: chunks still read.
    const head = read.history.headRecords
    assert.ok(head.kinds.length > 0)
})

test('the summary is used only for its revision, and completeFrom placed', () => {
    const base = {
        format: 'nxsp',
        version: 1,
        minor: 0,
        levelVersion: 1,
        appVersion: '0.6.0',
        id: 'd',
        lineageId: 'l',
        level: 'level.json',
        editor: {},
    }
    const revision = {
        id: 'b',
        parent: 'a',
        n: 2,
        savedAt: '2026-10-16T05:41:07Z',
        device: { id: 'x', label: 'y' },
        ancestors: ['a'],
    }
    const stale = readProject({
        ...base,
        revision,
        summary: { noteCount: 1, durationMs: 2, revisionId: 'a' },
    })
    assert.equal(currentSummary(stale.project), undefined)
    const fresh = readProject({
        ...base,
        revision,
        summary: { noteCount: 1, durationMs: 2, revisionId: 'b' },
    })
    assert.deepEqual(currentSummary(fresh.project), {
        noteCount: 1,
        durationMs: 2,
        revisionId: 'b',
    })
    assert.equal(
        placedCompleteFrom(
            readProject({ ...base, revision: { ...revision, completeFrom: 'a' } }).project.revision,
        ),
        'a',
    )
    assert.equal(
        placedCompleteFrom(
            readProject({ ...base, revision: { ...revision, completeFrom: 'z' } }).project.revision,
        ),
        'b',
    )
    assert.equal(
        placedCompleteFrom(
            readProject({ ...base, revision: { ...revision, completeFrom: 5 } }).project.revision,
        ),
        'b',
    )
    assert.equal(placedCompleteFrom(readProject({ ...base, revision }).project.revision), 'b')
    assert.deepEqual(
        readProject({ ...base, revision: { ...revision, completeFrom: 5 } }).issues,
        [],
    )
})

test('a crafted file that only reorders entries still opens fully', async () => {
    const file = await crafted((items) => [...items].reverse())
    assert.equal(nxsp(await readNxsp(file)).open, 'full')
})
