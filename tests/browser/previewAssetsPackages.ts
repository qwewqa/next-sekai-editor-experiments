import { readFileSync } from 'node:fs'
import { ZipReader } from '../../src/zip'
import { rawZip, utf8, type RawEntry } from '../zip/rawZip'

// Packages for the From a File specs, made from the Built-in set: real, decodable resources with
// the items' names and titles changed, or several items in one file.

export type Type = 'skin' | 'particle' | 'background' | 'effect'
export const types: Type[] = ['skin', 'particle', 'background', 'effect']
const categories = {
    skin: 'skins',
    particle: 'particles',
    background: 'backgrounds',
    effect: 'effects',
} as const

export const builtinBytes = (type: Type) =>
    new Uint8Array(readFileSync(`public/builtin/${type}.scp`))

type Entries = Map<string, Uint8Array>

const entriesOf = async (bytes: Uint8Array): Promise<Entries> => {
    const reader = await ZipReader.open(new Blob([new Uint8Array(bytes)]))
    const entries: Entries = new Map()
    for (const entry of reader.entries)
        if (!entry.isDirectory)
            entries.set(entry.name, await reader.read(entry, { maxSize: 64 * 1024 * 1024 }))
    return entries
}

const json = (bytes: Uint8Array | undefined) =>
    JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>

export type Variant = { name: string; title?: string; author?: string }

/** The Built-in package of a type with its item renamed, or several items sharing its resources. */
export const variants = async (type: Type, items: Variant[]): Promise<Uint8Array> => {
    const entries = await entriesOf(builtinBytes(type))
    const category = categories[type]
    const list = json(entries.get(`sonolus/${category}/list`)) as {
        items: Record<string, unknown>[]
    }
    const [original] = list.items
    if (!original) throw new Error('The Built-in package has no item')
    const originalName = String(original.name)
    entries.delete(`sonolus/${category}/${originalName}`)
    const made = items.map(({ name, title, author }) => ({
        ...original,
        name,
        ...(title === undefined ? {} : { title }),
        ...(author === undefined ? {} : { author }),
    }))
    entries.set(`sonolus/${category}/list`, utf8(JSON.stringify({ pageCount: 1, items: made })))
    for (const item of made)
        entries.set(
            `sonolus/${category}/${String(item.name)}`,
            utf8(JSON.stringify({ item, description: '', actions: [], hasCommunity: false })),
        )
    return pack(entries)
}

const pack = (entries: Entries) =>
    rawZip([...entries].map(([name, data]): RawEntry => ({ name, data, method: 0 })))

/** One package holding items of several types, as a collection does. */
export const collection = async (parts: Partial<Record<Type, Variant[]>>): Promise<Uint8Array> => {
    const merged: Entries = new Map()
    for (const type of types) {
        const items = parts[type]
        if (!items) continue
        for (const [name, data] of await entriesOf(await variants(type, items)))
            if (!name.endsWith('/info') && !merged.has(name)) merged.set(name, data)
    }
    return pack(merged)
}

export { rawZip, utf8 }

export type Field = 'thumbnail' | 'data' | 'texture' | 'image' | 'configuration' | 'audio'

export type Patch = {
    /** New bytes for resources, by field. */
    resources?: Partial<Record<Field, Uint8Array>>
    /** How the item's SRLs carry their hashes: wrong ones, or null. The real ones are kept by default. */
    hashes?: 'bad' | 'null'
    /** Entries stored deflated rather than stored, by field: a bomb has to be compressed. */
    deflate?: Field[]
}

/** The Built-in package of a type with some of its resources replaced, to be refused or accepted. */
export const patched = async (type: Type, patch: Patch): Promise<Uint8Array> => {
    const entries = await entriesOf(builtinBytes(type))
    const category = categories[type]
    const list = json(entries.get(`sonolus/${category}/list`)) as {
        items: Record<string, { hash?: string | null; url?: string | null }>[]
    }
    const [item] = list.items
    if (!item) throw new Error('The Built-in package has no item')
    const deflated = new Set<string>()
    for (const [field, bytes] of Object.entries(patch.resources ?? {})) {
        const srl = item[field]
        if (!srl?.url) throw new Error(`The item has no ${field}`)
        const path = srl.url.replace(/^\//, '')
        entries.set(path, bytes)
        if (patch.deflate?.includes(field as Field)) deflated.add(path)
    }
    for (const srl of Object.values(item))
        if (srl && typeof srl === 'object' && 'hash' in srl) {
            // A replaced resource no longer has its hash; null means none.
            if (patch.hashes === 'bad') srl.hash = 'f'.repeat(40)
            else if (patch.hashes === 'null' || patch.resources) srl.hash = null
        }
    const details = { item, description: '', actions: [], hasCommunity: false }
    entries.set(`sonolus/${category}/list`, utf8(JSON.stringify({ pageCount: 1, items: [item] })))
    entries.set(`sonolus/${category}/${String(item.name)}`, utf8(JSON.stringify(details)))
    return rawZip(
        [...entries].map(([name, data]): RawEntry => ({
            name,
            data,
            method: deflated.has(name) ? 8 : 0,
        })),
    )
}

export { pack }
