import { ZipError, ZipReader, type ZipEntry } from '../../../zip'
import { END_TAIL_SIZE, findEnd } from '../../../zip/directory'
import type { AssetType } from '../types'
import { AssetImportError, type ImportPart } from './errors'
import { CapExceeded, gunzipCapped } from './gunzip'
import { LIMITS } from './limits'

// A Sonolus package (.scp) read lazily from a Blob, under the limits of Part 2, 2.5.5. The same
// reader opens the file a user picks (import) and the package we stored (load).

export const categoryOf = {
    skin: 'skins',
    particle: 'particles',
    background: 'backgrounds',
    effect: 'effects',
} as const satisfies Record<AssetType, string>

/** An SRL as a server sends it: a hash and a url, either of which may be absent or null. */
export type Srl = { hash?: string | null; url?: string | null } | null | undefined

/** What the chooser lists of an item. */
export type ListedItem = {
    name: string
    title: string
    author: string
    thumbnail: Srl
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

export const isSrl = (value: unknown): value is NonNullable<Srl> =>
    isRecord(value) &&
    (value.hash === undefined || value.hash === null || typeof value.hash === 'string') &&
    (value.url === undefined || value.url === null || typeof value.url === 'string')

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A name that makes a safe entry path: the one thing about an item's name this code relies on. */
export const isItemName = (name: unknown): name is string =>
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= LIMITS.text &&
    !/[/\\\0]/.test(name) &&
    name !== '.' &&
    name !== '..'

/** Titles and authors render as text, cut to 200 characters. */
export const displayText = (value: unknown) => {
    const characters = Array.from(text(value))
    return (characters.length > LIMITS.text ? characters.slice(0, LIMITS.text) : characters)
        .join('')
        .trim()
}

// A backslash separates segments in names made on Windows, so it counts as a slash here.
const isBadName = (name: string) => {
    const path = name.replaceAll('\\', '/')
    return path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')
}

const mapZipError = (
    error: unknown,
    type?: AssetType,
    part?: ImportPart,
    limit?: number,
): never => {
    if (error instanceof AssetImportError) throw error
    if (error instanceof ZipError) {
        if (error.code === 'too-large') throw new AssetImportError('tooBig', { type, part, limit })
        if (error.code === 'limit')
            throw new AssetImportError('tooManyEntries', { limit: LIMITS.entries })
        throw new AssetImportError('damaged', { type, part }, { cause: error })
    }
    throw error
}

export type SourcePackage = {
    /** The raw bytes of an entry, or undefined when it is not in the package. */
    entry: (path: string, options: EntryOptions) => Promise<Uint8Array | undefined>
    /** An entry parsed as JSON. */
    json: (path: string, type: AssetType, part: ImportPart) => Promise<unknown>
    /** The path an SRL names in this package, if it names one. */
    resolve: (srl: Srl) => string | undefined
    /**
     * The items of a type: the list, else the details entries, as many as 16 MB of them hold.
     * The signal stops a long read between entries.
     */
    list: (type: AssetType, signal?: AbortSignal) => Promise<ListedItem[]>
    /** One item's details (the item object), or undefined when the package has none by that name. */
    details: (type: AssetType, name: string) => Promise<Record<string, unknown> | undefined>
}

export type EntryOptions = {
    type: AssetType
    part: ImportPart
    maxSize: number
}

/**
 * Opens a package, refusing one that is not a plain ZIP32 under the limits: an end record outside
 * the last 64 KiB, ZIP64, a directory that has to be rebuilt by scanning, more than 20,000 entries
 * or a name with `..` or a leading `/`.
 */
export const openSourcePackage = async (file: Blob): Promise<SourcePackage> => {
    if (file.size > LIMITS.file) throw new AssetImportError('fileTooLarge', { limit: LIMITS.file })

    try {
        const tail = new Uint8Array(
            await file.slice(Math.max(0, file.size - END_TAIL_SIZE)).arrayBuffer(),
        )
        const end = findEnd(tail)
        if (end.zip64Offset !== undefined) throw new AssetImportError('zip64')
        if (end.entryCount > LIMITS.entries)
            throw new AssetImportError('tooManyEntries', { limit: LIMITS.entries })
        // The directory is read whole: names past 1 KiB, or large extra fields, are not read.
        if (end.cdSize > LIMITS.entries * (46 + LIMITS.entryName) + 4 * 1024 * 1024)
            throw new AssetImportError('damaged')
    } catch (error) {
        return mapZipError(error)
    }

    let reader: ZipReader
    try {
        reader = await ZipReader.open(file)
    } catch (error) {
        return mapZipError(error)
    }
    // A directory the reader had to rebuild by scanning is a bad end record.
    if (reader.recovered) throw new AssetImportError('damaged')
    if (reader.entries.length > LIMITS.entries)
        throw new AssetImportError('tooManyEntries', { limit: LIMITS.entries })
    if (
        reader.entries.some(
            (entry) => isBadName(entry.name) || entry.rawName.length > LIMITS.entryName,
        )
    )
        throw new AssetImportError('badName')
    // ZIP64 sizes or offsets in an entry's extra field, which only ZIP64 needs.
    if (reader.entries.some((entry) => entry.zip64)) throw new AssetImportError('zip64')

    const entry = async (path: string, options: EntryOptions) => {
        const key = path.normalize('NFC')
        // A name that appears twice, or whose data overlaps another's, cannot be told apart.
        if (reader.ambiguous.has(key)) throw new AssetImportError('damaged', options)
        const found: ZipEntry | undefined = reader.get(path)
        if (!found) return
        // The ratio is checked on what the entry declares, before anything inflates.
        if (
            found.method !== 0 &&
            found.size > LIMITS.ratioFloor &&
            found.size > LIMITS.ratio * Math.max(found.compressedSize, 1)
        )
            throw new AssetImportError('ratio', options)
        try {
            return await reader.read(found, { maxSize: options.maxSize })
        } catch (error) {
            return mapZipError(error, options.type, options.part, options.maxSize)
        }
    }

    const json = async (path: string, type: AssetType, part: ImportPart) => {
        const bytes = await entry(path, { type, part, maxSize: LIMITS.json })
        if (!bytes) return
        try {
            return JSON.parse(new TextDecoder().decode(bytes)) as unknown
        } catch (error) {
            throw new AssetImportError('unreadable', { type, part }, { cause: error })
        }
    }

    const resolve = (srl: Srl) => {
        const url = srl?.url
        if (!url) return
        const path = url.replace(/^\/+/, '')
        return path === '' || isBadName(path) ? undefined : path
    }

    const names = (type: AssetType) => {
        const prefix = `sonolus/${categoryOf[type]}/`
        return reader.entries
            .filter((item) => !item.isDirectory && item.key.startsWith(prefix))
            .map((item) => item.key.slice(prefix.length))
            .filter((name) => name !== 'list' && name !== 'info' && !name.includes('/'))
    }

    const toListed = (item: unknown): ListedItem | undefined => {
        if (!isRecord(item) || !isItemName(item.name)) return
        return {
            name: item.name,
            title: displayText(item.title) || item.name,
            author: displayText(item.author),
            thumbnail: isSrl(item.thumbnail) ? item.thumbnail : undefined,
        }
    }

    const details = async (type: AssetType, name: string) => {
        if (!isItemName(name)) return
        const raw = await json(`sonolus/${categoryOf[type]}/${name}`, type, 'details')
        if (isRecord(raw) && isRecord(raw.item)) return raw.item
        // Without a details entry, the list's own entry stands in for it.
        if (raw !== undefined) throw new AssetImportError('unreadable', { type, part: 'details' })
        const listed = await json(`sonolus/${categoryOf[type]}/list`, type, 'list')
        if (isRecord(listed) && Array.isArray(listed.items))
            return (listed.items as unknown[]).find(
                (item): item is Record<string, unknown> => isRecord(item) && item.name === name,
            )
        return
    }

    const list = async (type: AssetType, signal?: AbortSignal) => {
        const category = categoryOf[type]
        const raw = await json(`sonolus/${category}/list`, type, 'list')
        if (raw !== undefined) {
            if (!isRecord(raw) || !Array.isArray(raw.items))
                throw new AssetImportError('unreadable', { type, part: 'list' })
            return (raw.items as unknown[])
                .slice(0, LIMITS.listed)
                .map(toListed)
                .filter((item): item is ListedItem => item !== undefined)
        }
        // No list: the detail entries are the items, up to what a budget of their JSON holds.
        const listed: ListedItem[] = []
        let budget = LIMITS.listing
        for (const name of names(type).slice(0, LIMITS.listed)) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
            budget -= reader.get(`sonolus/${category}/${name}`)?.size ?? 0
            if (budget < 0) break
            const item = toListed(await details(type, name))
            if (item) listed.push(item)
        }
        return listed
    }

    return { entry, json, resolve, list, details }
}

/** A gzipped data entry's JSON, under the data limits. */
export const parseDataJson = (
    bytes: Uint8Array,
    type: AssetType,
    part: ImportPart = 'data',
    maxInflated: number = LIMITS.dataInflated,
): unknown => {
    if (bytes.length > LIMITS.dataGzip)
        throw new AssetImportError('tooBig', { type, part, limit: LIMITS.dataGzip })
    let inflated: Uint8Array
    try {
        inflated = gunzipCapped(bytes, maxInflated)
    } catch (error) {
        throw error instanceof CapExceeded
            ? new AssetImportError('tooBig', { type, part, limit: maxInflated })
            : new AssetImportError('unreadable', { type, part }, { cause: error })
    }
    try {
        return JSON.parse(new TextDecoder().decode(inflated)) as unknown
    } catch (error) {
        throw new AssetImportError('unreadable', { type, part }, { cause: error })
    }
}
