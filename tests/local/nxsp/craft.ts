import { executePlan, planNxsp, readNxsp, type NxspRead } from '../../../src/local/nxsp'
import { gunzipLevel, gzipLevel } from '../../../src/local/nxsp/gzip'
import { NXSP_CAPS } from '../../../src/local/nxsp/read'
import { assembleZip, prepareEntry, ZipReader, type DosTime } from '../../../src/zip'
import { rawZip } from '../../zip/rawZip'
import { fresh } from './chain'

// Crafting files for the reader and checker tests: a good file unzipped into items, changed, and
// zipped again with the writer's pinned headers, so only the intended fault remains.

/** Parsed JSON the tests change freely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = Record<string, any>

export type Item = { name: string; data: Uint8Array; method: 'store' | 'deflate' }

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export const unzip = async (file: Blob) => {
    const reader = await ZipReader.open(file)
    const items: Item[] = []
    for (const entry of reader.entries) {
        items.push({
            name: entry.name,
            data: await reader.read(entry, { maxSize: 1 << 30 }),
            method: entry.method === 0 ? 'store' : 'deflate',
        })
    }
    const modified = {
        dosTime: reader.entries[0]?.dosTime ?? 0,
        dosDate: reader.entries[0]?.dosDate ?? 33,
    }
    return { items, modified }
}

export const zipItems = async (items: readonly Item[], modified?: DosTime) => {
    const prepared = await Promise.all(
        items.map((item) =>
            prepareEntry({ name: item.name, method: item.method, data: new Uint8Array(item.data) }),
        ),
    )
    return new Blob(assembleZip(prepared, modified ? { modified } : {}))
}

export const jsonOf = (items: readonly Item[], name: string) => {
    const item = items.find((i) => i.name === name)
    if (!item) throw new Error(`No ${name}`)
    return JSON.parse(decoder.decode(item.data)) as Loose
}

export const setJson = (items: Item[], name: string, value: unknown) => {
    const item = items.find((i) => i.name === name)
    if (!item) throw new Error(`No ${name}`)
    item.data = encoder.encode(JSON.stringify(value))
}

export const levelOf = (items: readonly Item[]) => {
    const name = jsonOf(items, 'project.json').level as string
    const item = items.find((entry) => entry.name === name)
    if (!item) throw new Error(`No ${name}`)
    return JSON.parse(
        decoder.decode(
            name === 'level.json.gz' ? gunzipLevel(item.data, NXSP_CAPS.level) : item.data,
        ),
    ) as Loose
}

export const setLevel = (items: Item[], value: unknown) => {
    const name = jsonOf(items, 'project.json').level as string
    const item = items.find((entry) => entry.name === name)
    if (!item) throw new Error(`No ${name}`)
    const bytes = encoder.encode(JSON.stringify(value))
    item.data = name === 'level.json.gz' ? gzipLevel(bytes) : bytes
}

/** The shared chain's file, written fresh. */
export const freshFile = async () => {
    const { input } = fresh()
    return executePlan(planNxsp(input).plan, new Map())
}

/** A good file with `change` applied to its items (and their JSON, through the helpers). */
export const crafted = async (change: (items: Item[]) => void | Item[], file?: Blob) => {
    const { items, modified } = await unzip(file ?? (await freshFile()))
    const next = change(items) ?? items
    return zipItems(next, modified)
}

/** Reads a file and returns its report's reasons and paths, for terse assertions. */
export const reasonsOf = (read: NxspRead) =>
    read.kind === 'not-project' ? [] : read.report.map(({ reason, path }) => `${reason} ${path}`)

export const readCrafted = async (change: (items: Item[]) => void | Item[]) =>
    readNxsp(await crafted(change))

/**
 * A file whose manifest and segments declare more than the history cap together (three segments
 * declaring 180 MB each in the central directory), without holding it: the cap is checked from
 * declared sizes before any part is read.
 */
export const overHistoryCap = async (file: Blob) => {
    const { items } = await unzip(file)
    const names = [1, 2, 3].map((n) => `history/segments/${n}.json`)
    const project = jsonOf(items, 'project.json')
    project.history.segments = names
    setJson(items, 'project.json', project)
    const segment = encoder.encode('{"entries":[],"roots":{},"nodes":{},"chunks":[]}')
    const at = items.findIndex((item) => item.name === 'history/manifest.json')
    const entries = items.map((item) => ({
        name: item.name,
        data: item.data,
        method: item.method === 'store' ? (0 as const) : (8 as const),
    }))
    entries.splice(
        at,
        0,
        ...names.map((name) => ({
            name,
            data: segment,
            method: 8 as const,
            central: { size: 180 * 1024 * 1024 },
        })),
    )
    return rawZip(entries)
}
