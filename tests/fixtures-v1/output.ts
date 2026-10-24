import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodeValue, readDump, type Dump, type DumpStore } from '../../src/local/dump'
import { compareKeys, normalizeKey } from '../../src/local/kv/keys'
import type { Key } from '../../src/local/kv/types'
import type { Products } from './products'

// The writer's last step: the dumps edited in the few ways the scenario names, the folders' README
// and SHA256SUMS, and the files written into empty folders.

const root = resolve(import.meta.dirname, '../..')

type Row = Record<string, unknown>

const storeOf = (dump: Dump, name: string): DumpStore => {
    const store = dump.stores.find((each) => each.name === name)
    if (!store) throw new Error(`The dump has no ${name} store`)
    return store
}

const valuesOf = (dump: Dump, name: string) =>
    storeOf(dump, name).records.map((record) => record.value as Row)

const keyOf = (record: { key: unknown }) => normalizeKey(decodeValue(record.key)) as Key

/** Every store's records in key order again (the dumper's order), after rows were added. */
const sortRecords = (dump: Dump) => {
    for (const store of dump.stores) store.records.sort((a, b) => compareKeys(keyOf(a), keyOf(b)))
}

/** The handles a real Chromium dump holds: a tag naming the file, which the seeder leaves out. */
const tagHandles = (dump: Dump) => {
    for (const row of valuesOf(dump, 'handles')) {
        const handle = row.handle as { testHandle?: string } | undefined
        if (typeof handle?.testHandle !== 'string') throw new Error('A handle row has no token')
        row.handle = { $handle: 'file', name: handle.testHandle }
    }
}

/**
 * Newer-build data (r11 S10; r11f evolvability F6, integrity S2), which no v1 build writes:
 * `zzFixtureChainField` on chain A, `zzFixtureEntryField` and `x` on two of its entries, and a later
 * session on chain P with an entry of an unknown kind.
 */
const addNewerData = (dump: Dump, chains: Record<string, string>) => {
    const chainRows = valuesOf(dump, 'chains')
    const chainA = chainRows.find((row) => row.chainId === chains.A)
    if (!chainA) throw new Error('No chain A')
    chainA.zzFixtureChainField = 'carried'

    const sessions = storeOf(dump, 'sessions')
    const sessionIds = new Set(
        sessions.records
            .map((record) => record.value as Row)
            .filter((row) => row.chainId === chains.A)
            .map((row) => row.id),
    )
    const entries = storeOf(dump, 'entries')
    const edits = entries.records
        .map((record) => record.value as Row)
        .filter((row) => sessionIds.has(row.sessionId) && row.kind === 'edit')
    if (edits.length < 2) throw new Error('Chain A has fewer than two edit entries')
    edits[0]!.zzFixtureEntryField = 1
    edits[1]!.x = { zzFixtureX: 1 }

    // Chain P: a session after its head, with one entry of a kind this build does not know.
    const chainP = chainRows.find((row) => row.chainId === chains.P)
    if (!chainP) throw new Error('No chain P')
    const head = sessions.records
        .map((record) => record.value as Row)
        .find((row) => row.id === chainP.head)
    if (!head) throw new Error('Chain P has no head session')
    const headEntries = entries.records
        .map((record) => record.value as Row)
        .filter((row) => row.sessionId === head.id)
    const template = headEntries.filter((row) => row.kind === 'continue').at(-1)
    if (!template) throw new Error('Chain P has no continue entry to copy')
    const id = randomUUID()
    const startedAt = (head.updatedAt as number) + 1000
    const later: Row = {
        ...structuredClone(head),
        id,
        startedAt,
        updatedAt: startedAt + 1000,
        parent: { id: head.id, uptoSeq: head.lastSeq },
        lastSeq: 1,
        entryCount: 1,
    }
    sessions.records.push({ key: id, value: later })
    const unknown: Row = {
        ...structuredClone(template),
        sessionId: id,
        seq: 1,
        kind: 'zzFixtureKind',
        time: startedAt + 500,
    }
    entries.records.push({ key: [id, 1], value: unknown })
    chainP.head = id
    chainP.updatedAt = later.updatedAt
}

export const processAll = (dump: Dump, chains: Record<string, string>) => {
    tagHandles(dump)
    addNewerData(dump, chains)
    sortRecords(dump)
    return readDump(JSON.parse(JSON.stringify(dump)))
}

export const processDownload = (dump: Dump) => {
    tagHandles(dump)
    sortRecords(dump)
    return readDump(JSON.parse(JSON.stringify(dump)))
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

export const nxspNames = [
    'full.nxsp',
    'kept-first.nxsp',
    'carried.nxsp',
    'not-carried.nxsp',
    'media-not-held.nxsp',
    'bgm-unticked.nxsp',
    'no-history.nxsp',
    'no-media.nxsp',
] as const

export const webNames = [
    'nse-local-data.json',
    'nse-local-data-download.json',
    'raw-export.zip',
    'saving-marker-file.nxsp',
    'journal-unavailable.json',
    'legacy-raw.json',
] as const

const sums = (files: Map<string, Uint8Array | string>) =>
    `${[...files].map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n')}\n`

/** Where the fixtures go: the repository's folders, or `NSE_FIXTURES_OUT`'s two. */
export const outputFolders = () => {
    const out = process.env.NSE_FIXTURES_OUT
    return out
        ? { nxsp: resolve(out, 'nxsp-v1'), web: resolve(out, 'web-storage-v1') }
        : {
              nxsp: join(root, 'tests/native/fixtures/nxsp-v1'),
              web: join(root, 'tests/fixtures/web-storage-v1'),
          }
}

const emptyOrMissing = (dir: string) => !existsSync(dir) || readdirSync(dir).length === 0

/** The folders to write, refusing when either holds anything: the fixtures are written once. */
export const emptyOutputFolders = () => {
    const folders = outputFolders()
    for (const dir of Object.values(folders))
        if (!emptyOrMissing(dir))
            throw new Error(
                `${dir} is not empty: the fixtures are written once, into an empty folder`,
            )
    return folders
}

/** Writes both folders, or refuses when either holds anything. */
export const writeFixtures = (
    products: Products,
    dumps: { main: Dump; download: Dump },
    readmes: { nxsp: string; web: string },
) => {
    const folders = emptyOutputFolders()
    const nxsp = new Map<string, Uint8Array | string>(
        nxspNames.map((name) => [name, products.bytes(name)]),
    )
    const json = (value: unknown) => `${JSON.stringify(value)}
`
    const web = new Map<string, Uint8Array | string>([
        ['nse-local-data.json', json(dumps.main)],
        ['nse-local-data-download.json', json(dumps.download)],
        ['raw-export.zip', products.bytes('raw-export.zip')],
        ['saving-marker-file.nxsp', products.bytes('saving-marker-file.nxsp')],
        ['journal-unavailable.json', products.text('journal-unavailable.json')],
        ['legacy-raw.json', products.text('legacy-raw.json')],
    ])
    for (const [dir, files, readme] of [
        [folders.nxsp, nxsp, readmes.nxsp],
        [folders.web, web, readmes.web],
    ] as const) {
        mkdirSync(dir, { recursive: true })
        for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes)
        writeFileSync(join(dir, 'README.md'), readme)
        writeFileSync(join(dir, 'SHA256SUMS'), sums(files))
    }
    return folders
}
