import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import type { MediaForm, NxspRead } from '../../src/local/nxsp'
import { mediaRefOf, placedCompleteFrom, readNxsp } from '../../src/local/nxsp'
import { levelState, matchesHead } from '../../src/local/open/decide'
import { noteCountOf, stateFromRecords } from '../../src/local/records/records'
import { decodeSnapshot } from '../../src/local/records/snapshot'
import { nxspFolder } from '../fixtures-v1/folders'
import { crafted, jsonOf, setJson, unzip } from '../local/nxsp/craft'
import { rawZip, type RawEntry } from './rawZip'

// The v1 `.nxsp` fixtures (`tests/native/fixtures/nxsp-v1/`), read by the editor's
// reader as every later build must read them. Each test names the bug it catches: a later build
// that misreads a v1 file. The files are the v0.6.0 editor's own output; what is crafted here is
// made from `full.nxsp` at test time.

const root = nxspFolder
const names = readdirSync(root).filter((name) => name.endsWith('.nxsp'))
const bytesOf = (name: string) => new Uint8Array(readFileSync(join(root, name)))
const blobOf = (name: string) => new Blob([bytesOf(name)])

type Opened = Extract<NxspRead, { kind: 'nxsp' }>

const opened = async (file: Blob): Promise<Opened> => {
    const read = await readNxsp(file)
    assert.equal(read.kind, 'nxsp')
    return read as Opened
}

/** A fixture whose history and project the reader gave whole. */
const whole = async (name: string) => {
    const read = await opened(blobOf(name))
    assert.ok(read.project, name)
    assert.ok(read.history, name)
    return { read, project: read.project, history: read.history }
}

const level = (read: Opened) => read.level as { bgmOffset: number; entities: never[] }

type Fixture = Awaited<ReturnType<typeof whole>>

/** Whether the level payload and project metadata differ from the history head. */
const matches = ({ read, project, history }: Fixture) =>
    matchesHead(
        level(read).entities,
        level(read).bgmOffset,
        project,
        stateFromRecords(history.headRecords),
    )

const withHistory = names.filter((name) => name !== 'no-history.nxsp')

test('every fixture opens fully, and its head matches the level payload and project metadata', async () => {
    // Catches a later reader that opens a v1 file partial (an unbound copy of the user's own
    // file), or sees a change where there is none (a "Changed outside the editor" step on every open).
    assert.equal(names.length, 8)
    for (const name of names) {
        const read = await opened(blobOf(name))
        assert.equal(read.open, 'full', name)
        assert.deepEqual(read.report, [], name)
    }
    for (const name of withHistory) {
        const fixture = await whole(name)
        assert.equal(matches(fixture), true, name)
        assert.equal(fixture.history.entries.at(-1)?.kind, 'save', name)
    }
    // Without history, the level payload is the chart.
    const plain = await opened(blobOf('no-history.nxsp'))
    assert.equal(plain.history, undefined)
    assert.equal(plain.project?.history, undefined)
    parseLevelDataChart(level(plain).entities, plain.project?.editor.defaultGuideColors)
})

const form = (media: MediaForm | undefined) =>
    media === undefined ? 'absent' : media.file === undefined ? 'metadata' : 'file'

const formsOf = ({ project }: Fixture) => [
    form(project.bgm),
    form(project.metadata?.cover),
    form(project.metadata?.preview),
]

test("the media forms map to the head's records: sha256 with a file, hash without, absent when left out", async () => {
    // Catches a later reader that confuses the two hash forms (the full SHA-256 of a held file, the
    // 16-byte hash of one that is not held), or reads an absent `bgm` as a removed one.
    const expected: Record<string, string[]> = {
        'full.nxsp': ['file', 'file', 'file'],
        'kept-first.nxsp': ['file', 'file', 'file'],
        'carried.nxsp': ['file', 'file', 'file'],
        'not-carried.nxsp': ['file', 'file', 'file'],
        'media-not-held.nxsp': ['metadata', 'metadata', 'metadata'],
        'bgm-unticked.nxsp': ['absent', 'file', 'file'],
        'no-media.nxsp': ['absent', 'absent', 'absent'],
    }
    for (const [name, forms] of Object.entries(expected)) {
        const fixture = await whole(name)
        assert.deepEqual(formsOf(fixture), forms, name)
        const head = stateFromRecords(fixture.history.headRecords)
        const { bgm, metadata } = fixture.project
        for (const [media, recorded] of [
            [bgm, head.bgm.meta],
            [metadata?.cover, head.levelInfo.cover],
            [metadata?.preview, head.levelInfo.preview],
        ] as const) {
            if (!media) continue
            // A file names its media by `sha256` (the record's hash is its 16-byte prefix); a
            // media item the file does not hold, by `hash` alone.
            if (media.file !== undefined) {
                assert.match(media.sha256, /^[0-9a-f]{64}$/)
                assert.equal(mediaRefOf(media).hash, media.sha256.slice(0, 32))
            } else assert.match(media.hash, /^[0-9a-f]{32}$/)
            assert.equal(mediaRefOf(media).hash, recorded?.hash, name)
        }
        // The held media have their bytes in the file, and the reader checked them.
        assert.equal(fixture.read.media.bgm !== undefined, forms[0] === 'file', name)
        assert.equal(fixture.read.media.cover !== undefined, forms[1] === 'file', name)
        assert.equal(fixture.read.media.preview !== undefined, forms[2] === 'file', name)
    }
    // The head records a BGM the unticked file left out: the file has no `bgm` key.
    const unticked = await whole('bgm-unticked.nxsp')
    const head = stateFromRecords(unticked.history.headRecords)
    assert.ok(head.bgm.meta)
    assert.equal(unticked.project.bgm, undefined)
    // The head matches the parsed level, so the binding does not name a changed file.
    const chart = parseLevelDataChart(
        level(unticked.read).entities,
        unticked.project.editor.defaultGuideColors,
    )
    const live = levelState(
        chart,
        level(unticked.read).bgmOffset,
        unticked.project,
        stateFromRecords(unticked.history.headRecords),
    )
    assert.deepEqual(live.bgm.meta, head.bgm.meta)
})

test("completeFrom is placed as written: an ancestor in the carrying files, the file's own id otherwise", async () => {
    // Catches a later reader that misplaces `completeFrom` (a carried one read as the file's own
    // id, so a later Save claims the whole history is in a file that lacks part of it), or one that
    // loses `replaces`.
    const full = await whole('full.nxsp')
    const carrying = ['full.nxsp', 'kept-first.nxsp', 'carried.nxsp']
    for (const name of carrying) {
        const { project } = await whole(name)
        const revision = project.revision
        assert.ok(revision, name)
        const placed = placedCompleteFrom(revision)
        assert.notEqual(placed, revision.id, name)
        assert.ok(revision.ancestors.includes(placed ?? ''), name)
        assert.equal(placed, placedCompleteFrom(full.project.revision), name)
    }
    for (const name of [
        'not-carried.nxsp',
        'media-not-held.nxsp',
        'bgm-unticked.nxsp',
        'no-media.nxsp',
    ]) {
        const { project } = await whole(name)
        assert.equal(placedCompleteFrom(project.revision), project.revision?.id, name)
        assert.equal(project.revision?.completeFrom, project.revision?.id, name)
    }
    // A file without history has none.
    const plain = await opened(blobOf('no-history.nxsp'))
    assert.equal(plain.project?.revision?.completeFrom, undefined)
    // Replace wrote `replaces`; the other fixtures never replaced.
    for (const name of withHistory) {
        const { project } = await whole(name)
        assert.equal(
            typeof project.revision?.replaces === 'string',
            name === 'kept-first.nxsp',
            name,
        )
    }
})

test('full.nxsp holds the history of two devices, a segment and the head manifest', async () => {
    // Catches a later reader that drops a segment (the oldest history lost on the next Save) or
    // the second device's `save` entries.
    const { project, history } = await whole('full.nxsp')
    assert.equal(project.history?.segments?.length, 1)
    assert.equal(project.history?.entries, history.entries.length)
    assert.ok(history.entries.length > 500)
    const saves = history.entries.filter((entry) => entry.kind === 'save')
    assert.equal(new Set(saves.map((entry) => entry.device?.id)).size, 2)
    assert.equal(history.entries.filter((entry) => entry.kept === false).length, 1)
    const read = await opened(blobOf('full.nxsp'))
    assert.deepEqual(read.extra, {
        zzTopLevel: { carried: true },
        metadata: { zzMeta: ['carried', 1] },
    })
})

/** The ZIP's chunk indexes and the head state's chunks, to flip a byte where it matters. */
const chunkLayout = async (name: string) => {
    const { history } = await whole(name)
    const headRoot = history.roots.get(history.head)
    assert.ok(headRoot)
    const [, headerHash, kinds] = headRoot as unknown as [number, string, [string, string][]]
    const inHead = new Set<string>([headerHash])
    const walk = (hash: string) => {
        const node = history.nodes.get(hash) as unknown as [string, number, string[]]
        for (const child of node[2]) {
            if (node[1] === 0) inHead.add(child)
            else walk(child)
        }
    }
    for (const [, hash] of kinds) walk(hash)
    // Every root's header chunk is read at open, so a chunk that only a kind of another root names
    // is the one that can go bad quietly.
    const headers = new Set(
        [...history.roots.values()].map((root) => (root as unknown as string[])[1]!),
    )
    const outside = [...history.index].find(([hash]) => !inHead.has(hash) && !headers.has(hash))
    const inside = [...history.index].find(([hash]) => inHead.has(hash) && hash !== headerHash)
    assert.ok(outside && inside)
    return { history, outside, inside, headerHash }
}

const flipByte = async (name: string, offset: number) =>
    crafted((items) => {
        const chunks = items.find((item) => item.name === 'history/chunks.bin')
        assert.ok(chunks)
        chunks.data = chunks.data.slice()
        chunks.data[offset] = chunks.data[offset]! ^ 0xff
    }, blobOf(name))

test('a damaged chunk outside the head state opens fully and fails only its read; one in the head state is unreadable history', async () => {
    // Catches a later reader that stops accepting a file for one bad chunk the head does not need
    // (a user's whole file refused for an old step), or one that trusts a damaged head chunk.
    const { history, outside, inside } = await chunkLayout('full.nxsp')
    const quiet = await opened(await flipByte('full.nxsp', outside[1].offset + 1))
    assert.equal(quiet.open, 'full')
    assert.deepEqual(quiet.report, [])
    assert.ok(quiet.history)
    await assert.rejects(quiet.history.chunks.read(outside[0]))
    // Every other chunk still reads.
    const another = [...history.index.keys()].find((hash) => hash !== outside[0])!
    await quiet.history.chunks.read(another)

    const bad = await opened(await flipByte('full.nxsp', inside[1].offset + 1))
    assert.equal(bad.history, undefined)
    assert.ok(bad.report.some((item) => item.reason === 'history-unreadable'))
    assert.equal(bad.open, 'partial')
})

test('only metadata.title edited is a change: the open takes the level and project metadata over the head', async () => {
    // Catches a later reader that no longer notices a file edited outside the editor (a user's edit
    // lost under the head's older state), or one that takes every file as edited.
    const file = await crafted((items) => {
        const project = jsonOf(items, 'project.json')
        project.metadata.title = 'Edited elsewhere'
        setJson(items, 'project.json', project)
    }, blobOf('full.nxsp'))
    const read = await opened(file)
    assert.equal(read.open, 'full')
    assert.ok(read.project)
    assert.ok(read.history)
    const head = stateFromRecords(read.history.headRecords)
    assert.equal(
        matchesHead(level(read).entities, level(read).bgmOffset, read.project, head),
        false,
    )
    const chart = parseLevelDataChart(level(read).entities, read.project.editor.defaultGuideColors)
    const live = levelState(chart, level(read).bgmOffset, read.project, head)
    assert.equal(live.levelInfo.title, 'Edited elsewhere')
    assert.notEqual(head.levelInfo.title, 'Edited elsewhere')
})

test('an OS re-zip opens fully: DEFLATE everywhere, data descriptors, __MACOSX and Thumbs.db, a Japanese BGM name without the UTF-8 flag', async () => {
    // Catches a later reader that stops accepting what a file manager's re-zip makes of a v1 file.
    const { items } = await unzip(blobOf('full.nxsp'))
    const project = jsonOf(items, 'project.json')
    const bgm = items.find((item) => item.name.startsWith('bgm/'))
    assert.ok(bgm)
    const name = 'bgm/バス.wav'
    bgm.name = name
    project.bgm.file = name.normalize('NFD')
    setJson(items, 'project.json', project)
    const encoder = new TextEncoder()
    const entries: RawEntry[] = items.map((item) => ({
        name: encoder.encode(item.name),
        data: item.data,
        method: 8,
        flags: 0x0008,
    }))
    entries.push(
        { name: '__MACOSX/._project.json', data: encoder.encode('x'), method: 8, flags: 8 },
        { name: 'Thumbs.db', data: encoder.encode('x'), method: 8, flags: 8 },
    )
    const read = await opened(new Blob([rawZip(entries)]))
    assert.deepEqual(read.report, [])
    assert.equal(read.open, 'full')
    assert.ok(read.history)
    assert.ok(read.media.bgm)
    // The history is the fixture's: every chunk of its head state still reads.
    const original = await whole('full.nxsp')
    assert.equal(read.history.entries.length, original.history.entries.length)
    assert.equal(read.history.head, original.history.head)
})

test('the independent checker reads every fixture as a whole file', () => {
    // Catches a reader of another language (the apps') that reads a v1 file differently from the
    // editor; the checker is the independent one in this repository.
    const probe = spawnSync('uv', ['--version'], { encoding: 'utf8' })
    if (probe.status !== 0) {
        console.log('uv is not installed: the checker test is skipped')
        return
    }
    const repo = join(import.meta.dirname, '..', '..')
    const files = names.map((name) => join(root, name))
    const result = spawnSync(
        'uv',
        ['run', 'python', '-I', join(repo, 'tools', 'nxsp_check.py'), '--read', ...files],
        { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const lines = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.equal(lines.length, names.length)
    for (const line of lines) {
        assert.equal(line.kind, 'nxsp')
        assert.equal(line.open, 'full')
        assert.deepEqual(line.report, [])
    }
    // And the writer-mode check of every fixture (each is what a v1 writer must produce).
    const strict = spawnSync(
        'uv',
        ['run', 'python', '-I', join(repo, 'tools', 'nxsp_check.py'), ...files],
        {
            encoding: 'utf8',
        },
    )
    assert.equal(strict.status, 0, `${strict.stdout}${strict.stderr}`)
})

test("every state a file holds decodes through the reader, and each entry's noteCount is its state's", async () => {
    // Catches a later decoder that misreads an earlier state (a wrong peek, Restore or Undo, or an
    // earlier BGM read as damage) while the head still decodes. Only the chunk the writer damaged on
    // purpose may fail, and only for a row that is not kept.
    const utf8 = new TextDecoder()
    for (const name of withHistory) {
        const { history } = await whole(name)
        const parsed = new Map<string, unknown>()
        for (const hash of history.index.keys()) {
            try {
                parsed.set(hash, JSON.parse(utf8.decode(await history.chunks.read(hash))))
            } catch {
                // A damaged chunk: the roots that name it are checked below.
            }
        }
        const counts = new Map<string, number | undefined>()
        for (const [hash, root] of history.roots) {
            try {
                const records = decodeSnapshot(root, {
                    node: (node) => history.nodes.get(node),
                    chunk: (chunk) => {
                        if (!parsed.has(chunk)) throw new Error(`No chunk ${chunk}`)
                        return parsed.get(chunk)
                    },
                })
                counts.set(hash, noteCountOf(records.kinds))
            } catch {
                counts.set(hash, undefined)
            }
        }
        assert.ok(history.index.size - parsed.size <= 1, `${name}: damaged chunks`)
        for (const entry of history.entries) {
            const count = counts.get(entry.snapshot)
            if (count === undefined) {
                assert.equal(entry.kept, false, `${name}: an unreadable state of a kept row`)
                continue
            }
            if (entry.noteCount !== undefined)
                assert.equal(entry.noteCount, count, `${name}: seq ${entry.time}`)
        }
        assert.ok(
            [...counts.values()].filter((count) => count === undefined).length <= 2,
            `${name}: unreadable roots`,
        )
    }
})
