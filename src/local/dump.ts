import { compareKeys, keyAtPath, normalizeKey } from './kv/keys'
import type { Key, KeyPath, KvDatabase } from './kv/types'

// The dump format `nse-local-data-dump` v1: every row of every store read with
// plain cursors and written undecoded, plus the editor's localStorage keys. It uses no record
// decoder, so a bug there can't stop it. The reader validates a dump and turns it back into values.
// A Blob is inline base64 (`$blob`) in a JSON dump, and a `$blobEntry` naming a ZIP entry beside
// `dump.json` in Export Raw Data…'s ZIP, so the export never holds a Blob's bytes whole; there, one
// that could not be read is a `$blobUnreadable` with its type and size.

export const DUMP_FORMAT = 'nse-local-data-dump'
export const DUMP_VERSION = 1

export type DumpIndex = { name: string; keyPath: KeyPath; unique: boolean; multiEntry: boolean }

export type DumpRecord = { key: unknown; value: unknown }

export type DumpStore = {
    name: string
    keyPath: KeyPath | null
    autoIncrement: boolean
    indexes: DumpIndex[]
    records: DumpRecord[]
}

export type Dump = {
    format: typeof DUMP_FORMAT
    version: typeof DUMP_VERSION
    appVersion: string
    database: { name: string; version: number }
    stores: DumpStore[]
    localStorage: Record<string, string>
}

export class DumpError extends Error {
    override name = 'DumpError'
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** The ZIP entry of a dump's nth Blob (from 0, in the order the dumper meets them). */
export const blobEntryName = (n: number) => `blobs/${n}`

const BLOB_ENTRY = /^blobs\/(?:0|[1-9][0-9]*)$/

/** Standard alphabet, padded. */
export const toBase64 = (bytes: Uint8Array) => {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}

export const fromBase64 = (text: string) => {
    if (!BASE64.test(text)) throw new DumpError('Not padded standard base64')
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

const isPlainObject = (value: object): value is Record<string, unknown> => {
    const prototype = Object.getPrototypeOf(value) as unknown
    return prototype === Object.prototype || prototype === null
}

const isFileHandle = (value: unknown): value is FileSystemFileHandle =>
    typeof FileSystemFileHandle !== 'undefined' && value instanceof FileSystemFileHandle

/** Every Blob a value holds, in the order `encodeValue` meets them. */
const collectBlobs = (value: unknown, found: Set<Blob>) => {
    if (typeof value !== 'object' || value === null) return
    if (typeof Blob !== 'undefined' && value instanceof Blob) found.add(value)
    else if (Array.isArray(value)) for (const item of value) collectBlobs(item, found)
    else if (isPlainObject(value))
        for (const item of Object.values(value)) collectBlobs(item, found)
}

const blobsOf = (values: unknown[]) => {
    const found = new Set<Blob>()
    for (const value of values) collectBlobs(value, found)
    return found
}

const escapeKey = (key: string) => (key.startsWith('$') ? `$${key}` : key)

const unescapeKey = (key: string) => (key.startsWith('$$') ? key.slice(1) : key)

/** A Blob's tag: `$blob` with its bytes, `$blobEntry` with its entry's name, or `$blobUnreadable`. */
export type BlobTag = (blob: Blob) => Record<string, unknown>

/** A value as JSON with tags; throws on a type it has no tag for. */
export const encodeValue = (value: unknown, blobTag: BlobTag): unknown => {
    if (value === undefined) return { $undefined: true }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new DumpError(`No tag for the number ${value}`)
        return value
    }
    if (typeof value !== 'object') throw new DumpError(`No tag for a ${typeof value}`)
    if (value instanceof ArrayBuffer) return { $ab: toBase64(new Uint8Array(value)) }
    // The view's own bytes, never its whole buffer.
    if (value instanceof Uint8Array && value.constructor === Uint8Array)
        return { $u8: toBase64(value) }
    if (typeof File !== 'undefined' && value instanceof File)
        throw new DumpError('No tag for a File')
    if (typeof Blob !== 'undefined' && value instanceof Blob) return blobTag(value)
    if (isFileHandle(value)) return { $handle: 'file', name: value.name }
    if (Array.isArray(value)) {
        const out: unknown[] = []
        for (const item of value) out.push(encodeValue(item, blobTag))
        return out
    }
    if (!isPlainObject(value)) throw new DumpError(`No tag for a ${value.constructor.name}`)
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
        out[escapeKey(key)] = encodeValue(item, blobTag)
    return out
}

/** Each Blob read once, ahead, so encoding stays synchronous, and written as base64. */
const inlineTags = async (values: unknown[]): Promise<BlobTag> => {
    const read = new Map<Blob, Uint8Array>()
    for (const blob of blobsOf(values)) read.set(blob, new Uint8Array(await blob.arrayBuffer()))
    return (blob) => {
        const bytes = read.get(blob)
        if (!bytes) throw new DumpError('A Blob was not read')
        return { $blob: toBase64(bytes), type: blob.type }
    }
}

/**
 * Writes a Blob's ZIP entry, and says whether it could. Each Blob is handed over once, ahead and in
 * the order met, with the name its entry gets, `blobs/<n>`, `n` counting the entries written before
 * it. One whose entry was not written is a `$blobUnreadable`.
 */
export type BlobEntries = (blob: Blob, name: string) => Promise<boolean>

/** Each Blob handed to `take`, its tag naming its entry, or `$blobUnreadable` when not taken. */
const entryTags = async (values: unknown[], take: BlobEntries): Promise<BlobTag> => {
    const names = new Map<Blob, string>()
    const unreadable = new Set<Blob>()
    for (const blob of blobsOf(values)) {
        const name = blobEntryName(names.size)
        if (await take(blob, name)) names.set(blob, name)
        else unreadable.add(blob)
    }
    return (blob) => {
        const name = names.get(blob)
        if (name !== undefined) return { $blobEntry: name, type: blob.type }
        if (!unreadable.has(blob)) throw new DumpError('A Blob was not handed over')
        return { $blobUnreadable: true, type: blob.type, size: blob.size }
    }
}

/**
 * What `decodeValue` does with a `$handle` (by default the field is left out) and a `$blobEntry`
 * (`blobEntry` gives the Blob from the ZIP; without it the tag throws). A `$blobUnreadable` is an
 * empty Blob of its type.
 */
export type DecodeOptions = {
    handle?: (name: string) => unknown
    blobEntry?: (name: string, type: string) => unknown
}

const OMIT = Symbol('omit')

const decodeTag = (tag: Record<string, unknown>, options: DecodeOptions): unknown => {
    const keys = Object.keys(tag).sort().join(',')
    const text = (field: string) => {
        const value = tag[field]
        if (typeof value !== 'string') throw new DumpError(`A tag's ${field} is not a string`)
        return value
    }
    if (keys === '$undefined' && tag.$undefined === true) return undefined
    if (keys === '$ab') return fromBase64(text('$ab')).buffer
    if (keys === '$u8') return fromBase64(text('$u8'))
    if (keys === '$blob,type') return new Blob([fromBase64(text('$blob'))], { type: text('type') })
    if (keys === '$blobEntry,type') {
        const name = text('$blobEntry')
        if (!BLOB_ENTRY.test(name)) throw new DumpError(`Not a Blob entry: ${name}`)
        if (!options.blobEntry) throw new DumpError(`${name} is in a ZIP that was not given`)
        return options.blobEntry(name, text('type'))
    }
    if (keys === '$blobUnreadable,size,type' && tag.$blobUnreadable === true) {
        const size = tag.size
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
            throw new DumpError("A tag's size is not a byte count")
        return new Blob([], { type: text('type') })
    }
    if (keys === '$handle,name' && tag.$handle === 'file')
        return options.handle ? options.handle(text('name')) : OMIT
    throw new DumpError(`An unknown tag: ${keys}`)
}

const decodeInner = (value: unknown, options: DecodeOptions): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new DumpError('A number is not finite')
        return value
    }
    if (Array.isArray(value)) {
        return value.map((item) => {
            const decoded = decodeInner(item, options)
            if (decoded === OMIT) throw new DumpError('A file handle in an array')
            return decoded
        })
    }
    if (typeof value !== 'object') throw new DumpError('Not JSON')
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.some(([key]) => key.startsWith('$') && !key.startsWith('$$')))
        return decodeTag(value as Record<string, unknown>, options)
    const out: Record<string, unknown> = {}
    for (const [key, item] of entries) {
        const decoded = decodeInner(item, options)
        if (decoded !== OMIT) out[unescapeKey(key)] = decoded
    }
    return out
}

/** A tagged value back as the value stored. */
export const decodeValue = (value: unknown, options: DecodeOptions = {}): unknown => {
    const decoded = decodeInner(value, options)
    if (decoded === OMIT) throw new DumpError('A file handle as a whole value')
    return decoded
}

/** Every localStorage key under the prefix, as raw strings. */
export const dumpLocalStorage = (storage: Storage, prefix: string) => {
    const out: Record<string, string> = {}
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys.sort()) {
        const value = storage.getItem(key)
        if (value !== null) out[key] = value
    }
    return out
}

/** The longest one task spends encoding the dump. */
const ENCODE_SLICE_MS = 16

/** A new task, through a message: timers are slowed to once a second or less in a hidden tab. */
const nextTask = () =>
    new Promise<void>((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
            channel.port1.close()
            resolve()
        }
        channel.port2.postMessage(null)
    })

/**
 * A dump's JSON as UTF-8 bytes, written a record at a time with a task between slices, so a dump
 * of tens of megabytes never takes one long task. It parses to the same value as
 * `JSON.stringify(dump)`; its keys come in another order.
 */
export const dumpJsonBytes = async (dump: Dump): Promise<Uint8Array<ArrayBuffer>[]> => {
    const encoder = new TextEncoder()
    const parts: Uint8Array<ArrayBuffer>[] = []
    let text = ''
    let since = performance.now()
    const add = async (piece: string) => {
        text += piece
        if (performance.now() - since <= ENCODE_SLICE_MS) return
        parts.push(encoder.encode(text))
        text = ''
        await nextTask()
        since = performance.now()
    }
    // Each object's other keys, open for its last key: `{"a":1,` or `{`.
    const opening = (value: Record<string, unknown>) => {
        const json = JSON.stringify(value)
        return json === '{}' ? '{' : `${json.slice(0, -1)},`
    }
    const { stores, ...rest } = dump
    await add(`${opening(rest)}"stores":[`)
    for (const [i, store] of stores.entries()) {
        const { records, ...meta } = store
        await add(`${i ? ',' : ''}${opening(meta)}"records":[`)
        for (const [j, record] of records.entries())
            await add(`${j ? ',' : ''}${JSON.stringify(record)}`)
        await add(']}')
    }
    text += ']}'
    parts.push(encoder.encode(text))
    return parts
}

/**
 * Dumps every store of an open database, read in one transaction with plain cursors. Blobs are
 * read after it commits, since reading one would end the transaction. With `blobEntries` no Blob
 * is read here: each is handed to it for the caller to write its entry (see `BlobEntries`).
 */
export const dumpDatabase = async (
    db: KvDatabase,
    {
        appVersion,
        localStorage = {},
        blobEntries,
    }: { appVersion: string; localStorage?: Record<string, string>; blobEntries?: BlobEntries },
): Promise<Dump> => {
    const names = [...db.storeNames].sort()
    const read = names.length
        ? await db.transaction(names, 'readonly', async (tx) => {
              const out = []
              for (const name of names) {
                  const info = tx.describe(name)
                  const entries = await tx.entries(name)
                  out.push({ name, info, entries })
              }
              return out
          })
        : []
    const values = read.flatMap(({ entries }) => entries.map((entry) => entry.value))
    const blobTag = blobEntries ? await entryTags(values, blobEntries) : await inlineTags(values)
    // Encoded in slices of about a frame, with a task between them: a long history is tens of
    // megabytes of base64, and Export Raw Data… runs on the page.
    let since = performance.now()
    const encoded: DumpRecord[][] = []
    for (const { entries } of read) {
        const records: DumpRecord[] = []
        for (const entry of entries) {
            records.push({
                key: encodeValue(entry.primaryKey, blobTag),
                value: encodeValue(entry.value, blobTag),
            })
            if (performance.now() - since > ENCODE_SLICE_MS) {
                await nextTask()
                since = performance.now()
            }
        }
        encoded.push(records)
    }
    return {
        format: DUMP_FORMAT,
        version: DUMP_VERSION,
        appVersion,
        database: { name: db.name, version: db.version },
        stores: read.map(({ name, info }, i) => ({
            name,
            keyPath: info.keyPath,
            autoIncrement: false,
            indexes: Object.entries(info.indexes)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([index, keyPath]) => ({
                    name: index,
                    keyPath,
                    unique: false,
                    multiEntry: false,
                })),
            records: encoded[i] ?? [],
        })),
        localStorage,
    }
}

const isKeyPath = (value: unknown): value is KeyPath =>
    typeof value === 'string' ||
    (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string'))

const fail = (where: string, what: string): never => {
    throw new DumpError(`${where}: ${what}`)
}

const record = (value: unknown, where: string) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : fail(where, 'not an object')

const sameKey = (a: Key | undefined, b: Key) => a !== undefined && compareKeys(a, b) === 0

/**
 * Validates a parsed dump: its header, each store's shape, every tag, keys valid and in order,
 * in-line keys matching their values. Returns it typed; throws a DumpError naming the problem.
 */
export const readDump = (json: unknown): Dump => {
    const dump = record(json, 'The dump')
    if (dump.format !== DUMP_FORMAT) fail('The dump', 'not an nse-local-data dump')
    if (typeof dump.version !== 'number' || !Number.isInteger(dump.version))
        fail('The dump', 'no version')
    if ((dump.version as number) > DUMP_VERSION)
        fail('The dump', `version ${String(dump.version)} is newer`)
    if (dump.version !== DUMP_VERSION) fail('The dump', `unknown version ${String(dump.version)}`)
    if (typeof dump.appVersion !== 'string') fail('The dump', 'no appVersion')
    const database = record(dump.database, 'database')
    if (typeof database.name !== 'string') fail('database', 'no name')
    const version = database.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
        fail('database', 'no version')
    if (!Array.isArray(dump.stores)) fail('The dump', 'no stores')
    const seen = new Set<string>()
    for (const [i, item] of (dump.stores as unknown[]).entries()) {
        const store = record(item, `stores[${i}]`)
        const name = store.name
        if (typeof name !== 'string' || !name) fail(`stores[${i}]`, 'no name')
        const where = `Store ${String(name)}`
        if (seen.has(name as string)) fail(where, 'listed twice')
        seen.add(name as string)
        const keyPath = store.keyPath
        if (keyPath !== null && !isKeyPath(keyPath)) fail(where, 'a bad keyPath')
        if (typeof store.autoIncrement !== 'boolean') fail(where, 'no autoIncrement')
        if (!Array.isArray(store.indexes)) fail(where, 'no indexes')
        for (const index of store.indexes as unknown[]) {
            const fields = record(index, `${where} index`)
            if (typeof fields.name !== 'string' || !isKeyPath(fields.keyPath))
                fail(where, 'a bad index')
            if (typeof fields.unique !== 'boolean' || typeof fields.multiEntry !== 'boolean')
                fail(where, 'a bad index')
        }
        if (!Array.isArray(store.records)) fail(where, 'no records')
        let previous: Key | undefined
        for (const [r, row] of (store.records as unknown[]).entries()) {
            const at = `${where} record ${r}`
            const fields = record(row, at)
            if (!('key' in fields) || !('value' in fields)) fail(at, 'no key or value')
            let key: Key | undefined
            let value: unknown
            try {
                key = normalizeKey(decodeValue(fields.key))
                value = decodeValue(fields.value, { handle: () => null, blobEntry: () => null })
            } catch (error) {
                fail(at, error instanceof Error ? error.message : String(error))
            }
            if (key === undefined) return fail(at, 'not a valid key')
            if (previous !== undefined && compareKeys(previous, key) >= 0)
                fail(at, 'out of key order')
            if (keyPath !== null && !sameKey(keyAtPath(value, keyPath as KeyPath), key))
                fail(at, 'its key is not the one in its value')
            previous = key
        }
    }
    const storage = record(dump.localStorage, 'localStorage')
    for (const [key, value] of Object.entries(storage))
        if (typeof value !== 'string') fail('localStorage', `${key} is not a string`)
    return json as Dump
}
