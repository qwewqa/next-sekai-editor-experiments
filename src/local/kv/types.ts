// The key-value and transaction interface the storage core runs on (Part 1 §1.6.1): IndexedDB in
// browsers (idb.ts), and an in-memory model for Node tests and tabs without storage (memory.ts).

/** An IndexedDB key: binary keys read back as ArrayBuffer. */
export type Key = number | string | Date | ArrayBuffer | ArrayBufferView | Key[]

/** A range of keys, as IDBKeyRange. */
export class KeyRange {
    private constructor(
        readonly lower: Key | undefined,
        readonly upper: Key | undefined,
        readonly lowerOpen: boolean,
        readonly upperOpen: boolean,
    ) {}

    static only(key: Key) {
        return new KeyRange(key, key, false, false)
    }

    static bound(lower: Key, upper: Key, lowerOpen = false, upperOpen = false) {
        return new KeyRange(lower, upper, lowerOpen, upperOpen)
    }

    static lowerBound(lower: Key, open = false) {
        return new KeyRange(lower, undefined, open, false)
    }

    static upperBound(upper: Key, open = false) {
        return new KeyRange(undefined, upper, false, open)
    }
}

export type Query = Key | KeyRange

export type KeyPath = string | readonly string[]

export type TxMode = 'readonly' | 'readwrite'

/** A hint: routine flushes are relaxed; hides, switches, restores and imports strict (§1.6.1). */
export type Durability = 'default' | 'strict' | 'relaxed'

export type CursorEntry = { key: Key; primaryKey: Key; value: unknown }

export type EntriesOptions = {
    index?: string
    query?: Query
    direction?: 'next' | 'prev'
    limit?: number
}

export type StoreInfo = { keyPath: KeyPath | null; indexes: Record<string, KeyPath> }

export type KvIndex = {
    get: (query: Query) => Promise<unknown>
    getKey: (query: Query) => Promise<Key | undefined>
    getAll: (query?: Query, count?: number) => Promise<unknown[]>
    getAllKeys: (query?: Query, count?: number) => Promise<Key[]>
    count: (query?: Query) => Promise<number>
}

/**
 * A transaction's requests. Await only these inside a transaction: any other await (crypto.subtle,
 * a worker message, a Blob read) lets it commit, and a later request throws TransactionInactiveError.
 */
export type KvTx = {
    readonly mode: TxMode
    get: (store: string, query: Query) => Promise<unknown>
    getKey: (store: string, query: Query) => Promise<Key | undefined>
    getAll: (store: string, query?: Query, count?: number) => Promise<unknown[]>
    getAllKeys: (store: string, query?: Query, count?: number) => Promise<Key[]>
    count: (store: string, query?: Query) => Promise<number>
    put: (store: string, value: unknown, key?: Key) => Promise<Key>
    /**
     * A put that WebKit's refusal of a Blob in a private window (`isBlobRefusal`) leaves the
     * transaction running after: resolves whether the row was stored. Any other failure fails the
     * transaction, as a put's does.
     */
    tryPut: (store: string, value: unknown, key?: Key) => Promise<boolean>
    add: (store: string, value: unknown, key?: Key) => Promise<Key>
    delete: (store: string, query: Query) => Promise<void>
    index: (store: string, name: string) => KvIndex
    /** Rows in key order through a cursor, newest first with direction 'prev'. */
    entries: (store: string, options?: EntriesOptions) => Promise<CursorEntry[]>
    describe: (store: string) => StoreInfo
}

export type TransactionOptions = { durability?: Durability }

export type KvDatabase = {
    readonly name: string
    readonly version: number
    readonly storeNames: readonly string[]
    /**
     * Runs fn in one transaction and commits it explicitly. Resolves with fn's result once it has
     * committed; rejects, with nothing written, when fn throws or a request fails.
     */
    transaction: <T>(
        stores: readonly string[],
        mode: TxMode,
        fn: (tx: KvTx) => Promise<T>,
        options?: TransactionOptions,
    ) => Promise<T>
    /** Closes once the transactions in flight finish. */
    close: () => void
    /** Another connection wants a newer version (null: the database is being deleted). */
    onversionchange: ((newVersion: number | null) => void) | undefined
    /** Closed by the browser, such as Safari's lost connection after backgrounding. */
    onclose: (() => void) | undefined
}

/** The one versionchange transaction of an upgrade: synchronous, as onupgradeneeded is. */
export type KvUpgrade = {
    readonly oldVersion: number
    readonly newVersion: number
    readonly storeNames: readonly string[]
    createStore: (name: string, options: { keyPath?: KeyPath }) => void
    createIndex: (store: string, name: string, keyPath: KeyPath) => void
    put: (store: string, value: unknown, key?: Key) => void
}

export type OpenOptions = {
    /** Runs in the versionchange transaction; a throw aborts the upgrade. */
    upgrade?: (upgrade: KvUpgrade) => void
    /** Other connections stay open after their versionchange. */
    blocked?: () => void
}

export type KvFactory = {
    /** Opens at version, or without one at the current version (a missing database at 1). */
    open: (name: string, version: number | undefined, options?: OpenOptions) => Promise<KvDatabase>
}

/** An error with a DOMException name, as the browser gives. */
export const domError = (name: string, message: string = name) => new DOMException(message, name)

/** An unknown rejection as an Error, keeping errors and DOMExceptions as they are. */
export const asError = (error: unknown): Error =>
    error instanceof Error || error instanceof DOMException ? error : new Error(String(error))

export const errorName = (error: unknown) =>
    error instanceof Error || error instanceof DOMException ? error.name : undefined

/**
 * WebKit's refusal to store a Blob in a private window: an `UnknownError` while preparing Blob or
 * File data. A quota or any other error is not one.
 */
export const isBlobRefusal = (error: unknown) =>
    errorName(error) === 'UnknownError' && (error as Error).message.includes('Blob')
