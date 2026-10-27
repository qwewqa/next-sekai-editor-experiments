import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { inflateStrict } from '../../src/local/chunkVerify'
import { hashKey } from '../../src/local/db'
import { documentDeviceId } from '../../src/local/deviceId'
import { DUMP_FORMAT, DUMP_VERSION, readDump, type Dump } from '../../src/local/dump'
import { fromHex16 } from '../../src/local/hash'
import { keyText } from '../../src/local/kv/keys'
import type { NxspRead } from '../../src/local/nxsp'
import { readNxsp } from '../../src/local/nxsp'
import { noteCountOf } from '../../src/local/records/records'
import { nodeJsonFromRow, rootJsonFromRow } from '../../src/local/records/rows'
import { decodeSnapshot } from '../../src/local/records/snapshot'
import { seedDump, seedRawExport } from '../../src/local/seed'
import { createWorld } from '../../src/local/testing/world'
import { ZipReader } from '../../src/zip'
import { nxspFolder, webFolder } from '../fixtures-v1/folders'
import { FIXTURE_BUILDS, SUMS_DIGESTS } from './fixturesV1Pins'
import { rows } from './flush/harness'

// The v1 fixtures as a set: their checksums, that both dumps and the raw
// export's dump load, and what the files and rows together exercise. Each test names the bug it
// catches. The fixtures are the v0.6.0 editor's own output and never change; this test is why a
// later build's regeneration of them cannot go unnoticed.

const here = import.meta.dirname
const nxspDir = nxspFolder
const webDir = webFolder
const fields = JSON.parse(
    readFileSync(join(here, '..', '..', 'tools', 'fields-v1.json'), 'utf8'),
) as Record<string, { name: string; type: string; optional?: boolean }[] | Record<string, unknown>>

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test("every fixture matches its folder's SHA256SUMS, and every file is listed", () => {
    // Catches a regeneration by a later build (the files would then prove nothing: they must be the
    // v0.6.0 code's output), a file edited by hand, and one added without a checksum.
    // The SHA256SUMS files are rewritten by every run of the writer, so each is itself pinned in the
    // test source (fixturesV1Pins.ts): an emptied folder written again cannot pass.
    for (const [dir, expected, folder] of [
        [nxspDir, 8, 'nxsp-v1'],
        [webDir, 5, 'web-storage-v1'],
    ] as const) {
        assert.equal(sha256(readFileSync(join(dir, 'SHA256SUMS'))), SUMS_DIGESTS[folder], folder)
        const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
        assert.ok(sums.endsWith('\n'))
        assert.ok(!sums.includes('\r'))
        const listed = new Map(
            sums
                .trimEnd()
                .split('\n')
                .map((line) => {
                    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line)
                    assert.ok(match, `a SHA256SUMS line: ${line}`)
                    return [match[2]!, match[1]!] as const
                }),
        )
        assert.equal(listed.size, expected, dir)
        const files = readdirSync(dir).filter(
            (name) => name !== 'README.md' && name !== 'SHA256SUMS',
        )
        assert.deepEqual([...listed.keys()].sort(), files.sort(), dir)
        for (const [name, hash] of listed)
            assert.equal(sha256(readFileSync(join(dir, name))), hash, name)
    }
})

/** The raw export's `dump.json`, read from its ZIP. */
const rawExportDump = async () => {
    const reader = await ZipReader.open(new Blob([readFileSync(join(webDir, 'raw-export.zip'))]))
    const entry = reader.get('dump.json')
    assert.ok(entry)
    return JSON.parse(
        new TextDecoder().decode(await reader.read(entry, { maxSize: 1 << 30 })),
    ) as unknown
}

const dumpFiles = async () =>
    [
        [
            'nse-local-data.json',
            JSON.parse(readFileSync(join(webDir, 'nse-local-data.json'), 'utf8')) as unknown,
        ],
        [
            'nse-local-data-download.json',
            JSON.parse(
                readFileSync(join(webDir, 'nse-local-data-download.json'), 'utf8'),
            ) as unknown,
        ],
        ["raw-export.zip's dump.json", await rawExportDump()],
    ] as const

test("readDump accepts both dumps and the raw export's dump.json, and seedDump writes each into an empty database", async () => {
    // Catches a dump reader or seeder that refuses a v1 dump: a maintainer could then not load a
    // user's data to get their work out (docs/release/storage-bug.md).
    for (const [name, json] of await dumpFiles()) {
        const dump = readDump(json)
        assert.equal(dump.format, DUMP_FORMAT, name)
        assert.equal(dump.version, DUMP_VERSION, name)
        const world = createWorld()
        const tab = world.tab('a')
        const stored: Record<string, string> = {}
        const storage = { setItem: (key: string, value: string) => void (stored[key] = value) }
        // The raw export seeds through its ZIP, each `$blobEntry` read from its `blobs/<n>` entry.
        const result = await tab.run(() =>
            name.startsWith('raw-export.zip')
                ? seedRawExport(
                      tab.kv,
                      new Blob([readFileSync(join(webDir, 'raw-export.zip'))]),
                      storage,
                  )
                : seedDump(tab.kv, dump, storage),
        )
        assert.deepEqual(result, { seeded: true }, name)
        assert.deepEqual(stored, dump.localStorage, name)
        // Every chain is in, and every store holds as many rows as the dump (a handle's row goes
        // whole, since its handle is not in a dump).
        for (const store of dump.stores) {
            const written = rows(world, store.name).size
            if (store.name === 'handles') assert.ok(written <= store.records.length, name)
            else assert.equal(written, store.records.length, `${name} ${store.name}`)
        }
        await world.idle()
    }
})

// What the fixtures exercise (record forms) -----------------------------------------------------

type Rec = unknown[]

type Row = Record<string, unknown>

/** A form's field positions, from the generated table. */
const position = (form: string, name: string) => {
    const list = fields[form] as { name: string; optional?: boolean }[]
    const at = list.findIndex((field) => field.name === name)
    assert.ok(at >= 0, `${form}.${name}`)
    return at
}

const has = (record: Rec, form: string, name: string) => record.length > position(form, name)

const kindForms = fields.kinds as Record<string, string>

/** A lane position that is a third of a lane (a decimal that does not end). */
const isThird = (left: number) =>
    !Number.isInteger(left) && Math.abs(left * 3 - Math.round(left * 3)) < 1e-9

/** Facts about the forms a header chunk uses, as `form` or `form.variant` names. */
const observeHeader = (header: Rec, facts: Set<string>) => {
    const at = (name: string) => header[position('header', name)]
    facts.add('header')
    facts.add(header.length > position('header', 'bgm') ? 'header.bgm' : 'header.noBgm')
    facts.add(at('isDynamicStages') ? 'header.dynamic' : 'header.static')
    for (const group of at('groups') as Rec[]) {
        facts.add('group')
        facts.add(has(group, 'group', 'folderId') ? 'group.folder' : 'group.noFolder')
    }
    for (const stage of at('stages') as Rec[]) {
        facts.add('stage')
        facts.add(has(stage, 'stage', 'folderId') ? 'stage.folder' : 'stage.noFolder')
    }
    for (const [list, kind] of [
        [at('groupFolders'), 'group'],
        [at('stageFolders'), 'stage'],
    ] as const)
        for (const folder of list as Rec[]) {
            facts.add('folder')
            facts.add(`folder.${kind}`)
            if (has(folder, 'folder', 'folderId')) facts.add('folder.nested')
        }
    const info = at('levelInfo') as Rec
    facts.add('levelInfo')
    if (has(info, 'levelInfo', 'rating')) facts.add('levelInfo.rating')
    for (const name of ['cover', 'preview'] as const) {
        const media = info[position('levelInfo', name)] as Rec
        facts.add(media.length === 0 ? `levelInfo.${name}.empty` : `levelInfo.${name}.mediaRef`)
        if (media.length) facts.add('mediaRef')
    }
    if ((info[position('levelInfo', 'tags')] as Rec[]).length) facts.add('tag')
    if (header.length > position('header', 'bgm')) {
        const bgm = at('bgm') as Rec
        facts.add('bgm')
        facts.add(has(bgm, 'bgm', 'durationMs') ? 'bgm.durationMs' : 'bgm.noDurationMs')
    }
}

/** The forms one chunk of a kind's records uses. */
const observeChunk = (kind: string, chunk: Rec, facts: Set<string>) => {
    facts.add(kindForms[kind]!)
    if (kind === 'stageStyleEvents') {
        for (const event of chunk) {
            const color = (event as Rec)[position('stageStyleEvent', 'laneColor')]
            if (color !== 'default') facts.add('stageStyleEvent.laneColor')
        }
    }
    if (kind !== 'slides') return
    for (const slide of chunk as Rec[][]) {
        facts.add('slide')
        if (slide.length >= 2) facts.add('slide.multi')
        for (const note of slide) {
            facts.add('note')
            if (isThird(note[position('note', 'left')] as number)) facts.add('note.third')
            if (note[position('note', 'elevation')] !== 0) facts.add('note.elevation')
            if (note[position('note', 'isAttached')] === true) facts.add('note.attached')
        }
    }
}

/** What a set of states stores: roots, kind nodes and chunks, however a source reads them. */
type Source = {
    roots: Map<string, Rec>
    node: (hash: string) => Rec
    chunk: (hash: string) => Promise<Rec>
}

/**
 * The facts of every root a source holds (each distinct header and chunk read once), or of one.
 * `bodies: false` leaves the kind chunks unread (the header and the nodes tell enough). A chunk
 * that does not read is left out and counted: the dump holds the one a test damaged on purpose.
 */
const walk = async (
    source: Source,
    { only, bodies = true }: { only?: string; bodies?: boolean } = {},
) => {
    const skipped = { chunks: 0 }
    const facts = new Set<string>()
    const headers = new Set<string>()
    const chunks = new Map<string, string>()
    for (const [hash, root] of source.roots) {
        if (only !== undefined && hash !== only) continue
        facts.add('root')
        headers.add(root[1] as string)
        for (const [kind, top] of root[2] as [string, string][]) {
            facts.add(`kindRef:${kind}`)
            const node = source.node(top)
            facts.add('node')
            facts.add(`node:${String(node[1])}`)
            for (const child of node[2] as string[]) {
                if (node[1] === 0) chunks.set(child, kind)
                else {
                    const leaf = source.node(child)
                    facts.add('node:0')
                    for (const hex of leaf[2] as string[]) chunks.set(hex, kind)
                }
            }
        }
    }
    const read = async (hash: string) => {
        try {
            return await source.chunk(hash)
        } catch {
            skipped.chunks++
            return undefined
        }
    }
    for (const hash of headers) {
        const header = await read(hash)
        if (header) observeHeader(header, facts)
    }
    if (bodies)
        for (const [hash, kind] of chunks) {
            const chunk = await read(hash)
            if (chunk) observeChunk(kind, chunk, facts)
        }
    return Object.assign(facts, { skipped: skipped.chunks, chunkKinds: chunks, headers })
}

const utf8 = new TextDecoder()

/** A `.nxsp`'s read, with its facts over every state and over its head alone. */
const loadNxsp = async (name: string, bodies: boolean) => {
    const read = (await readNxsp(new Blob([readFileSync(join(nxspDir, name))]))) as Extract<
        NxspRead,
        { kind: 'nxsp' }
    >
    const { history } = read
    if (!history) return { read, all: new Set<string>(), head: new Set<string>() }
    const source: Source = {
        roots: history.roots as Map<string, Rec>,
        node: (hash) => history.nodes.get(hash) as Rec,
        chunk: async (hash) => JSON.parse(utf8.decode(await history.chunks.read(hash))) as Rec,
    }
    return {
        read,
        all: await walk(source, { bodies }),
        head: await walk(source, { only: history.head, bodies }),
    }
}

const nxspCache = new Map<string, ReturnType<typeof loadNxsp>>()

/** Each file is walked once for the whole run; only `full.nxsp` has its kind chunks read. */
const nxspFacts = (name: string) => {
    if (!nxspCache.has(name)) nxspCache.set(name, loadNxsp(name, name === 'full.nxsp'))
    return nxspCache.get(name)!
}

/** A dump's `nodes` and `chunks` rows, seeded into a world, as a source. */
const dumpSource = async (json: unknown) => {
    const dump = readDump(json)
    const world = createWorld()
    const tab = world.tab('a')
    assert.deepEqual(await tab.run(() => seedDump(tab.kv, dump, { setItem: () => undefined })), {
        seeded: true,
    })
    const nodes = rows(world, 'nodes')
    const chunks = rows(world, 'chunks')
    const rowOf = (store: Map<string, Row>, hex: string) =>
        store.get(keyText(hashKey(fromHex16(hex))))
    const roots = new Map<string, Rec>()
    for (const [key, row] of nodes) {
        if (row.t !== 'root') continue
        roots.set(key, rootJsonFromRow(row as unknown as Parameters<typeof rootJsonFromRow>[0]))
    }
    assert.ok(roots.size > 0)
    const source: Source = {
        roots,
        node: (hex) => {
            const node = rowOf(nodes, hex)
            assert.equal(node?.t, 'node')
            return nodeJsonFromRow(node as unknown as Parameters<typeof nodeJsonFromRow>[0])
        },
        chunk: (hex) => {
            const chunk = rowOf(chunks, hex) as { bytes: Uint8Array } | undefined
            assert.ok(chunk, `chunk ${hex}`)
            return Promise.resolve(JSON.parse(utf8.decode(inflateStrict(chunk.bytes))) as Rec)
        },
    }
    return source
}

/** The facts of every state a dump's `nodes` and `chunks` rows hold. */
const dumpFacts = async (json: unknown) => walk(await dumpSource(json))

const everything = [
    'root',
    ...Object.keys(fields.kinds as object).map((kind) => `kindRef:${kind}`),
    'node:0',
    'node:1',
    'header',
    'header.bgm',
    'header.noBgm',
    'header.dynamic',
    'header.static',
    'group',
    'group.folder',
    'group.noFolder',
    'stage',
    'stage.folder',
    'stage.noFolder',
    'folder',
    'folder.group',
    'folder.stage',
    'levelInfo',
    'levelInfo.rating',
    'levelInfo.cover.mediaRef',
    'levelInfo.cover.empty',
    'levelInfo.preview.mediaRef',
    'levelInfo.preview.empty',
    'tag',
    'mediaRef',
    'bgm',
    'bgm.durationMs',
    'slide',
    'slide.multi',
    'note',
    'note.third',
    'note.elevation',
    'note.attached',
    'stageStyleEvent.laneColor',
    ...Object.values(fields.kinds as Record<string, string>),
]

const missing = (facts: Set<string>, wanted: string[]) => wanted.filter((fact) => !facts.has(fact))

test('full.nxsp and the main dump exercise every record form, optional positions set and unset', async () => {
    // Catches a fixture that stopped exercising a form (a later build's reader then passes without
    // reading it), and a reader that misreads a form no fixture holds. Not exercised, by design
    // (the records goldens hold them): a folder's `folderId` (this build never nests folders) and a
    // `bgm` without `durationMs`.
    const full = await nxspFacts('full.nxsp')
    assert.deepEqual(missing(full.all, everything), [], 'full.nxsp')
    const facts = await dumpFacts(
        JSON.parse(readFileSync(join(webDir, 'nse-local-data.json'), 'utf8')),
    )
    assert.deepEqual(missing(facts, everything), [], 'nse-local-data.json')
    // The only chunk the dump cannot read is the one the writer damaged on purpose (chain A's `badChunks`).
    assert.equal(facts.skipped, 1)
    assert.ok(!full.all.has('folder.nested'))
})

test('the files that carry history exercise what the table says', async () => {
    // The same, per file: the media forms of the three that differ in them, and a state with none.
    for (const name of ['kept-first.nxsp', 'carried.nxsp', 'not-carried.nxsp']) {
        const { all } = await nxspFacts(name)
        assert.deepEqual(
            missing(all, [
                'root',
                'node:1',
                'header.bgm',
                'levelInfo.cover.mediaRef',
                'levelInfo.preview.mediaRef',
            ]),
            [],
            name,
        )
    }
    // Only the head's header: its BGM, cover and preview named, none of them in the ZIP.
    const notHeld = await nxspFacts('media-not-held.nxsp')
    assert.deepEqual(
        missing(notHeld.head, [
            'header.bgm',
            'levelInfo.cover.mediaRef',
            'levelInfo.preview.mediaRef',
        ]),
        [],
    )
    const zip = await ZipReader.open(new Blob([readFileSync(join(nxspDir, 'media-not-held.nxsp'))]))
    assert.deepEqual(
        zip.entries
            .map((entry) => entry.name)
            .filter((entry) => entry.startsWith('bgm/') || entry.startsWith('assets/')),
        [],
    )
    // The head records a BGM the file has no key for.
    const unticked = await nxspFacts('bgm-unticked.nxsp')
    assert.equal(unticked.head.has('header.bgm'), true)
    assert.equal(unticked.read.projectJson.bgm, undefined)
    // No state of the file has a BGM, a cover or a preview.
    const none = await nxspFacts('no-media.nxsp')
    assert.deepEqual(
        [...none.all].filter(
            (fact) =>
                ['header.bgm', 'bgm', 'mediaRef'].includes(fact) || fact.endsWith('.mediaRef'),
        ),
        [],
    )
    assert.deepEqual(
        missing(none.all, ['header.noBgm', 'levelInfo.cover.empty', 'levelInfo.preview.empty']),
        [],
    )
    // No history: nothing to walk.
    assert.equal((await nxspFacts('no-history.nxsp').catch(() => undefined))?.all.size ?? 0, 0)
})

// What the fixtures exercise (files and rows) ---------------------------------------------------

test('the eight files together hold every project.json key, entry kind and field of v1', async () => {
    // Catches a fixture set that stopped covering a key (a reader's rule for it goes untested).
    const keys = new Set<string>()
    const kinds = new Set<string>()
    const saveKeys = new Set<string>()
    const recoveredKeys = new Set<string>()
    const entryKeys = new Set<string>()
    const forms = new Set<string>()
    for (const name of readdirSync(nxspDir).filter((each) => each.endsWith('.nxsp'))) {
        const { read } = await nxspFacts(name)
        const project = read.projectJson as Record<string, unknown>
        for (const key of Object.keys(project)) keys.add(key)
        for (const key of Object.keys((project.revision ?? {}) as object))
            keys.add(`revision.${key}`)
        for (const key of Object.keys((project.editor ?? {}) as object)) keys.add(`editor.${key}`)
        for (const key of Object.keys((project.history ?? {}) as object)) keys.add(`history.${key}`)
        for (const key of Object.keys((project.summary ?? {}) as object)) keys.add(`summary.${key}`)
        const metadata = (project.metadata ?? {}) as Record<string, unknown>
        for (const key of Object.keys(metadata)) keys.add(`metadata.${key}`)
        for (const key of ['bgm', 'cover', 'preview'] as const) {
            const form = (key === 'bgm' ? project.bgm : metadata[key]) as
                Record<string, unknown> | undefined
            forms.add(
                `${key}.${form === undefined ? 'absent' : form.file === undefined ? 'metadata' : 'file'}`,
            )
        }
        for (const entry of read.history?.entries ?? []) {
            kinds.add(entry.kind)
            for (const key of Object.keys(entry)) {
                entryKeys.add(key)
                if (entry.kind === 'save') saveKeys.add(key)
                if (entry.kind === 'recovered') recoveredKeys.add(key)
            }
            if (entry.kept === false) entryKeys.add('kept:false')
        }
        if (read.history?.undoStack) entryKeys.add('undoStack')
    }
    for (const key of [
        'format',
        'version',
        'minor',
        'patch',
        'levelVersion',
        'appVersion',
        'id',
        'lineageId',
        'revision',
        'revision.id',
        'revision.parent',
        'revision.n',
        'revision.savedAt',
        'revision.device',
        'revision.fileName',
        'summary.noteCount',
        'summary.durationMs',
        'summary.revisionId',
        'revision.ancestors',
        'revision.completeFrom',
        'revision.replaces',
        'exportName',
        'level',
        'editor',
        'editor.defaultGuideColors',
        'history',
        'history.segments',
        'history.manifest',
        'history.chunks',
        'history.entries',
        'summary',
        'metadata',
        'metadata.title',
        'metadata.artists',
        'metadata.author',
        'metadata.description',
        'metadata.rating',
        'metadata.tags',
        'metadata.cover',
        'metadata.preview',
        'bgm',
        'zzTopLevel',
        'metadata.zzMeta',
    ])
        assert.ok(keys.has(key), `project.json: ${key}`)
    for (const form of ['bgm', 'cover', 'preview'])
        for (const variant of ['file', 'metadata', 'absent'])
            assert.ok(forms.has(`${form}.${variant}`), `${form} ${variant}`)
    assert.deepEqual([...kinds].sort(), [
        'continue',
        'edit',
        'export',
        'init',
        'recovered',
        'redo',
        'restore',
        'save',
        'undo',
    ])
    for (const key of ['dirty', 'kept:false', 'undoStack']) assert.ok(entryKeys.has(key), key)
    for (const key of ['revisionId', 'device', 'appVersion'])
        assert.ok(saveKeys.has(key), `save ${key}`)
    for (const key of ['stack', 'recoveryContext'])
        assert.ok(recoveredKeys.has(key), `recovered ${key}`)
})

const valuesOf = (dump: Dump, store: string) =>
    (dump.stores.find((each) => each.name === store)?.records ?? []).map(
        (record) => record.value as Row,
    )

const fieldsOf = (list: Row[]) => new Set(list.flatMap((row) => Object.keys(row)))

test('the main dump holds every stored row form of v1', async () => {
    // Catches a dump that stopped holding a row form, so a later build's reader of it (seeded in the
    // browser spec, Recent Sessions, the Timeline) goes without a test.
    const dump = readDump(JSON.parse(readFileSync(join(webDir, 'nse-local-data.json'), 'utf8')))
    const chains = valuesOf(dump, 'chains')
    const chainFields = fieldsOf(chains)
    for (const field of [
        'chainId',
        'head',
        'docId',
        'lineageId',
        'revision',
        'name',
        'exportName',
        'sourceName',
        'file',
        'exportTarget',
        'partialImport',
        'replaced',
        'extra',
        'startedAt',
        'updatedAt',
        'day',
        'summary',
        'edited',
        'hasContent',
        'badChunks',
        'deleting',
        'appVersion',
    ])
        assert.ok(chainFields.has(field), `chains.${field}`)
    const files = chains.flatMap((chain) => (chain.file ? [chain.file as Row] : []))
    assert.deepEqual([...new Set(files.map((file) => file.event))].sort(), ['opened', 'saved'])
    for (const field of ['entry', 'completeFrom', 'disk', 'hash', 'at'])
        assert.ok(fieldsOf(files).has(field), `file.${field}`)
    assert.ok(files.some((file) => (file.entry as Row | undefined)?.notKept))
    // An append whose base has no row of its own makes an inexact cut (build.ts).
    assert.ok(files.some((file) => (file.entry as Row | undefined)?.inexact === true))
    const targets = chains.flatMap((chain) =>
        chain.exportTarget ? [chain.exportTarget as Row] : [],
    )
    assert.ok(targets.some((target) => target.opened === true))
    assert.ok(targets.length >= 2)
    assert.ok(chains.some((chain) => (chain.extra as Row | undefined)?.metadata))
    const summary = fieldsOf(
        chains.flatMap((chain) => (chain.summary ? [chain.summary as Row] : [])),
    )
    for (const field of ['rating', 'tags', 'bgmName', 'noteCount'])
        assert.ok(summary.has(field), `summary.${field}`)

    const handles = valuesOf(dump, 'handles')
    assert.deepEqual([...new Set(handles.map((row) => row.role))].sort(), [
        'exportTarget',
        'file',
        'kept',
    ])
    for (const row of handles)
        assert.deepEqual(Object.keys(row.handle as object).sort(), ['$handle', 'name'])

    const sessions = valuesOf(dump, 'sessions')
    assert.deepEqual([...new Set(sessions.map((row) => row.origin))].sort(), [
        'continued',
        'import',
        'migrated',
        'new',
        'nxsp',
    ])
    for (const field of [
        'parent',
        'stack',
        'lastSeq',
        'view',
        'entryCount',
        'activeMs',
        'importPending',
    ])
        assert.ok(fieldsOf(sessions).has(field), `sessions.${field}`)

    const entries = valuesOf(dump, 'entries')
    const kinds = new Set(entries.map((row) => row.kind))
    for (const kind of [
        'init',
        'continue',
        'edit',
        'undo',
        'redo',
        'restore',
        'save',
        'export',
        'recovered',
    ])
        assert.ok(kinds.has(kind), `entries ${kind}`)
    assert.deepEqual([...new Set(entries.map((row) => row.dirty))].sort(), [false, true])
    assert.deepEqual([...new Set(entries.map((row) => row.kept))].sort(), [false, true])
    for (const field of ['revisionId', 'device', 'appVersion'])
        assert.ok(
            entries.some((row) => row.kind === 'save' && field in row),
            `save ${field}`,
        )
    for (const field of ['stack', 'recoveryContext'])
        assert.ok(
            entries.some((row) => row.kind === 'recovered' && field in row),
            `recovered ${field}`,
        )

    assert.ok(valuesOf(dump, 'stackBlocks').length > 0)
    const nodes = valuesOf(dump, 'nodes')
    assert.ok(nodes.some((row) => row.t === 'root'))
    assert.deepEqual(
        [...new Set(nodes.filter((row) => row.t === 'node').map((row) => row.depth))].sort(),
        [0, 1],
    )
    assert.ok(valuesOf(dump, 'chunks').every((row) => typeof row.crc32 === 'number'))
    const media = valuesOf(dump, 'media')
    assert.deepEqual([...new Set(media.map((row) => row.kind))].sort(), ['bgm', 'cover', 'preview'])
    assert.ok(media.every((row) => typeof row.filename === 'string'))
    const recovered = valuesOf(dump, 'recovered')
    assert.ok(
        recovered.length > 0 &&
            recovered.every((row) => row.source === 'journal' && typeof row.sessionId === 'string'),
    )
    assert.ok(valuesOf(dump, 'userAssets').length > 0)
    const meta = new Map(valuesOf(dump, 'meta').map((row) => [row.key, row.value]))
    for (const key of [
        'formatVersion',
        'epoch',
        'maxSeenTime',
        'dbInstanceId',
        'deviceId',
        'daysOfUse',
        'lastUseDate',
        'lastGcAt',
        'deletionsPending',
        'migratedHashes',
        'createdBy',
    ])
        assert.ok(meta.has(key), `meta.${key}`)
    assert.ok(((meta.get('migratedHashes') as unknown[]) ?? []).length > 0)

    const keys = Object.keys(dump.localStorage).map((key) =>
        key.replace('sonolus-next-sekai-editor.', ''),
    )
    for (const prefix of ['journal.', 'saving.'])
        assert.ok(
            keys.some((key) => key.startsWith(prefix)),
            prefix,
        )
    for (const key of ['canary', 'deviceId', 'lastAppVersion']) assert.ok(keys.includes(key), key)

    // The newer-build data the script added: kept on a row, an entry of an unknown kind on a chain's later session.
    assert.ok(chains.some((chain) => chain.zzFixtureChainField === 'carried'))
    assert.ok(entries.some((row) => row.zzFixtureEntryField === 1))
    assert.ok(entries.some((row) => (row.x as Row | undefined)?.zzFixtureX === 1))
    assert.ok(entries.some((row) => row.kind === 'zzFixtureKind'))
})

test('the download dump holds a downloaded binding and badChunks', () => {
    // Catches a dump that stopped holding what only a browser without pickers writes.
    const dump = readDump(
        JSON.parse(readFileSync(join(webDir, 'nse-local-data-download.json'), 'utf8')),
    )
    const chains = valuesOf(dump, 'chains')
    assert.equal(chains.length, 1)
    const [chain] = chains as [Row]
    assert.equal((chain.file as Row).event, 'downloaded')
    assert.ok(chain.badChunks)
    assert.equal(valuesOf(dump, 'handles').length, 0)
})

test("saving-marker-file.nxsp is the write the dump's saving marker names", async () => {
    // Catches a fixture pair that drifted apart: the browser spec relies on the marker and the file
    // describing one Save, and on a binding that does not yet hold its revision.
    const dump = readDump(JSON.parse(readFileSync(join(webDir, 'nse-local-data.json'), 'utf8')))
    const prefix = 'sonolus-next-sekai-editor.'
    const markers = Object.keys(dump.localStorage).filter((key) =>
        key.startsWith(`${prefix}saving.`),
    )
    assert.equal(markers.length, 1)
    const marker = JSON.parse(dump.localStorage[markers[0]!]!) as {
        entry: { revisionId: string; sessionId: string; seq: number }
        parent: string | null
    }
    const read = await readNxsp(new Blob([readFileSync(join(webDir, 'saving-marker-file.nxsp'))]))
    assert.equal(read.kind, 'nxsp')
    if (read.kind !== 'nxsp') return
    assert.equal(read.open, 'full')
    const revision = read.projectJson.revision as Row
    assert.equal(revision.id, marker.entry.revisionId)
    assert.equal(revision.parent ?? null, marker.parent)
    const chain = valuesOf(dump, 'chains').find((row) =>
        markers[0]!.endsWith(row.chainId as string),
    )
    assert.ok(chain)
    // The binding still holds the revision before it.
    assert.equal(((chain.revision ?? {}) as Row).id, marker.parent)
})

/** A project file's `project.json`, read from its ZIP alone. */
const projectOf = async (path: string) => {
    const zip = await ZipReader.open(new Blob([readFileSync(path)]))
    const entry = zip.get('project.json')
    assert.ok(entry, path)
    return JSON.parse(utf8.decode(await zip.read(entry, { maxSize: 1 << 24 }))) as Row
}

test('every file and dump was written by a pinned build', async () => {
    // Catches a fixture written by another build than the one the pins name: regenerated by a later
    // build, or a file added from a second run.
    const files = [
        ...readdirSync(nxspDir)
            .filter((each) => each.endsWith('.nxsp'))
            .map((each) => join(nxspDir, each)),
        join(webDir, 'saving-marker-file.nxsp'),
    ]
    for (const path of files)
        assert.ok(FIXTURE_BUILDS.includes((await projectOf(path)).appVersion as string), path)
    for (const [name, json] of await dumpFiles())
        assert.ok(FIXTURE_BUILDS.includes((json as { appVersion: string }).appVersion), name)
})

test('every handle row of the three dumps is tagged as a Chromium export writes it', async () => {
    // Catches a fixture that holds the test override's tokens, a state no v1 build produces: a
    // later seeder would then meet plain objects where a real profile has none (it leaves tagged
    // rows without a handle out).
    let seen = 0
    for (const [name, json] of await dumpFiles()) {
        const dump = json as { stores: { name: string; records: { value: Row }[] }[] }
        for (const record of dump.stores.find((store) => store.name === 'handles')?.records ?? []) {
            assert.deepEqual(
                Object.keys(record.value.handle as Row).sort(),
                ['$handle', 'name'],
                name,
            )
            seen++
        }
    }
    assert.ok(seen > 0)
})

/** `meta.deviceId` and the editor's `deviceId` key: the same value, which a dump carries twice. */
const deviceIdOf = (dump: Dump) => {
    const meta = valuesOf(dump, 'meta').find((row) => row.key === 'deviceId')?.value
    assert.equal(typeof meta, 'string')
    const stored = JSON.parse(dump.localStorage['sonolus-next-sekai-editor.deviceId']!) as string
    assert.equal(stored, meta)
    return meta as string
}

/** Each `save` entry of a dump, with whether its device is this install's own for the chain's lineage. */
const saveDevices = (dump: Dump) => {
    const deviceId = deviceIdOf(dump)
    const lineages = new Map(
        valuesOf(dump, 'sessions').map((session) => {
            const chain = valuesOf(dump, 'chains').find((row) => row.chainId === session.chainId)
            assert.ok(chain)
            return [session.id as string, chain.lineageId as string] as const
        }),
    )
    return valuesOf(dump, 'entries')
        .filter((entry) => entry.kind === 'save')
        .map((entry) => {
            const lineage = lineages.get(entry.sessionId as string)
            assert.ok(lineage)
            const id = (entry.device as Row).id as string
            return { id, lineage, own: id === documentDeviceId(deviceId, lineage) }
        })
}

test("a file's device id is per document: own saves match the install's derivation, foreign ones do not", async () => {
    // Catches a later change to the derivation (HMAC-SHA-256 of the lineage under the install's
    // `deviceId`, as a UUIDv8): every v1 save would then read as another device's, the user's own
    // completed Save would meet a conflict dialog. The browser
    // specs pin it too, but only the Node tests run on every push.
    const main = saveDevices(
        readDump(JSON.parse(readFileSync(join(webDir, 'nse-local-data.json'), 'utf8'))),
    )
    assert.ok(main.length > 0)
    assert.deepEqual(
        main.filter((save) => !save.own),
        [],
    )
    const download = saveDevices(
        readDump(JSON.parse(readFileSync(join(webDir, 'nse-local-data-download.json'), 'utf8'))),
    )
    assert.ok(download.some((save) => save.own))
    assert.ok(download.some((save) => !save.own))
    // Two lineages, two ids: the same install is not linkable across documents by it.
    const byLineage = new Map(main.map((save) => [save.lineage, save.id]))
    assert.ok(byLineage.size > 1)
    assert.equal(new Set(byLineage.values()).size, byLineage.size)
    // The marker file's Save is this install's own for its lineage.
    const dump = readDump(JSON.parse(readFileSync(join(webDir, 'nse-local-data.json'), 'utf8')))
    const marker = await readNxsp(new Blob([readFileSync(join(webDir, 'saving-marker-file.nxsp'))]))
    assert.equal(marker.kind, 'nxsp')
    if (marker.kind !== 'nxsp') return
    const revision = marker.projectJson.revision as { device: { id: string } }
    assert.equal(
        revision.device.id,
        documentDeviceId(deviceIdOf(dump), marker.projectJson.lineageId as string),
    )
})

test("every state of the main dump decodes through the reader, and each entry's noteCount is its state's", async () => {
    // Catches a later decoder that misreads an earlier stored state while the head still decodes
    // (a wrong peek, Restore or Undo). Only the chunk the writer damaged on purpose may fail.
    const json = JSON.parse(readFileSync(join(webDir, 'nse-local-data.json'), 'utf8')) as unknown
    const source = await dumpSource(json)
    const parsed = new Map<string, Rec>()
    const all = await walk(source)
    for (const hash of [...all.chunkKinds.keys(), ...all.headers]) {
        try {
            parsed.set(hash, await source.chunk(hash))
        } catch {
            // The damaged chunk.
        }
    }
    const counts = new Map<string, number | undefined>()
    for (const [key, root] of source.roots) {
        try {
            counts.set(
                key,
                noteCountOf(
                    decodeSnapshot(root, {
                        node: (hash) => source.node(hash),
                        chunk: (hash) => {
                            if (!parsed.has(hash)) throw new Error(`No chunk ${hash}`)
                            return parsed.get(hash)
                        },
                    }).kinds,
                ),
            )
        } catch {
            counts.set(key, undefined)
        }
    }
    assert.ok([...counts.values()].filter((count) => count === undefined).length <= 2)
    let checked = 0
    for (const entry of valuesOf(readDump(json), 'entries')) {
        const snapshot = (entry.snapshot as { $u8?: string } | undefined)?.$u8
        if (snapshot === undefined) continue
        const count = counts.get(keyText(hashKey(new Uint8Array(Buffer.from(snapshot, 'base64')))))
        if (count === undefined) {
            assert.equal(entry.kept, false, 'an unreadable state of a kept row')
            continue
        }
        if (entry.noteCount !== undefined) assert.equal(entry.noteCount, count)
        checked++
    }
    assert.ok(checked > 500)
})
