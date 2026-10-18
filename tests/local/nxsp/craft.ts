import { executePlan, planNxsp, readNxsp, type NxspRead } from '../../../src/local/nxsp'
import { assembleZip, prepareEntry, ZipReader, type DosTime } from '../../../src/zip'
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
