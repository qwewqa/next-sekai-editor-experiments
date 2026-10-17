import type { Actor, Scheduler } from '../scheduler'
import { compareKeys, inRange, keyAtPath, normalizeKey, requireKey, toRange } from './keys'
import { runTransaction } from './run'
import {
    domError,
    KeyRange,
    type CursorEntry,
    type EntriesOptions,
    type Key,
    type KeyPath,
    type KvDatabase,
    type KvFactory,
    type KvIndex,
    type KvTx,
    type KvUpgrade,
    type OpenOptions,
    type Query,
    type TxMode,
} from './types'

// The in-memory key-value store (§1.6.1). It models what breaks real browsers: a transaction goes
// inactive when its task ends with no request of its own pending, and commits then; overlapping
// read-write transactions run in creation order across connections; values are cloned on write
// and read; versions, versionchange, blocked and the connection queue follow IndexedDB. Every
// delivery is a scheduler task of the connection's actor, so a killed actor's transactions abort.

type Row = { key: Key; value: unknown }

class StoreData {
    rows: Row[] = []
    readonly indexes = new Map<string, KeyPath>()
    constructor(readonly keyPath: KeyPath | null) {}

    /** The position of key, or where it would go. */
    find(key: Key) {
        let lo = 0
        let hi = this.rows.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            const row = this.rows[mid]
            if (!row) break
            const c = compareKeys(row.key, key)
            if (c === 0) return { index: mid, found: true }
            if (c < 0) lo = mid + 1
            else hi = mid
        }
        return { index: lo, found: false }
    }

    inRange(range: KeyRange) {
        return this.rows.filter((row) => inRange(range, row.key))
    }

    /** Index entries in index order: index key, then primary key. */
    indexEntries(name: string, range?: KeyRange) {
        const keyPath = this.indexes.get(name)
        if (keyPath === undefined) throw domError('NotFoundError', `No index ${name}`)
        const entries: { key: Key; row: Row }[] = []
        for (const row of this.rows) {
            const key = keyAtPath(row.value, keyPath)
            if (key === undefined || (range && !inRange(range, key))) continue
            entries.push({ key, row })
        }
        return entries.sort(
            (a, b) => compareKeys(a.key, b.key) || compareKeys(a.row.key, b.row.key),
        )
    }

    copy() {
        const copy = new StoreData(this.keyPath)
        copy.rows = [...this.rows]
        for (const [name, path] of this.indexes) copy.indexes.set(name, path)
        return copy
    }
}

type Database = {
    readonly name: string
    version: number
    stores: Map<string, StoreData>
    connections: Set<Connection>
    /** Unfinished transactions in creation order. */
    transactions: Transaction[]
    openQueue: OpenRequest[]
    /** The open request being processed, if it waits for others to close. */
    pendingUpgrade?: { request: OpenRequest; version: number }
}

type OpenRequest = {
    actor: Actor
    version: number | undefined
    options: OpenOptions
    resolve: (db: KvDatabase) => void
    reject: (error: Error) => void
    blockedFired?: boolean
}

const clone = <T>(value: T): T => {
    try {
        return structuredClone(value)
    } catch (error) {
        throw domError('DataCloneError', error instanceof Error ? error.message : String(error))
    }
}

/** IndexedDB's count: 0 or absent is every row. */
const upTo = (count: number | undefined) => (count === 0 ? undefined : count)

const scopesOverlap = (a: readonly string[], b: readonly string[]) => a.some((s) => b.includes(s))

type Request = {
    run: () => unknown
    resolve: (value: unknown) => void
    reject: (error: Error) => void
}

class Transaction {
    state: 'waiting' | 'running' | 'finished' = 'waiting'
    active = true
    commitRequested = false
    outstanding = 0
    private readonly queued: Request[] = []
    private readonly undo: (() => void)[] = []
    private resolveDone!: () => void
    private rejectDone!: (error: Error) => void
    readonly done = new Promise<void>((resolve, reject) => {
        this.resolveDone = resolve
        this.rejectDone = reject
    })

    constructor(
        readonly memory: MemoryKv,
        readonly connection: Connection,
        readonly scope: readonly string[],
        readonly mode: TxMode | 'versionchange',
    ) {}

    get db() {
        return this.connection.db
    }

    get actor() {
        return this.connection.actor
    }

    check() {
        if (this.state === 'finished' || !this.active || this.commitRequested)
            throw domError('TransactionInactiveError', 'The transaction is not active')
    }

    place(run: () => unknown) {
        this.check()
        return new Promise<unknown>((resolve, reject) => {
            const request = { run, resolve, reject }
            this.outstanding++
            if (this.state === 'running') this.dispatch(request)
            else this.queued.push(request)
        })
    }

    start() {
        this.state = 'running'
        for (const request of this.queued.splice(0)) this.dispatch(request)
    }

    private dispatch(request: Request) {
        this.memory.scheduler.post(this.actor, this, () => {
            if (this.state !== 'running') return
            this.outstanding--
            let result: unknown
            try {
                result = request.run()
            } catch (error) {
                const failure = error instanceof Error ? error : domError('UnknownError')
                this.active = true
                this.memory.touch(this)
                request.reject(failure)
                this.abort(failure)
                return
            }
            this.active = true
            this.memory.touch(this)
            request.resolve(result)
        })
    }

    log(undo: () => void) {
        this.undo.push(undo)
    }

    commit() {
        this.state = 'finished'
        this.undo.length = 0
        this.memory.finish(this)
        this.memory.scheduler.post(this.actor, this, () => {
            this.resolveDone()
        })
    }

    abort(error: Error = domError('AbortError', 'The transaction was aborted'), deliver = true) {
        if (this.state === 'finished') return
        this.state = 'finished'
        for (const undo of this.undo.splice(0).reverse()) undo()
        const pending = this.queued.splice(0)
        this.outstanding = 0
        this.memory.finish(this)
        if (!deliver) return
        this.memory.scheduler.post(this.actor, this, () => {
            for (const request of pending) request.reject(domError('AbortError'))
            this.rejectDone(error)
        })
    }
}

class Connection {
    closePending = false
    closed = false
    onversionchange: ((newVersion: number | null) => void) | undefined
    onclose: (() => void) | undefined
    constructor(
        readonly memory: MemoryKv,
        readonly db: Database,
        readonly actor: Actor,
    ) {}

    get unfinished() {
        return this.db.transactions.filter((tx) => tx.connection === this)
    }
}

const sorted = <T>(rows: T[], direction: 'next' | 'prev' | undefined) =>
    direction === 'prev' ? rows.reverse() : rows

/** The requests of one transaction over the shared data. */
const makeTx = (tx: Transaction): KvTx => {
    const store = (name: string) => {
        if (!tx.scope.includes(name))
            throw domError('NotFoundError', `${name} is not in the transaction`)
        const data = tx.db.stores.get(name)
        if (!data) throw domError('NotFoundError', `No store ${name}`)
        return data
    }
    const writable = () => {
        tx.check()
        if (tx.mode === 'readonly') throw domError('ReadOnlyError', 'A read-only transaction')
    }
    const first = (data: StoreData, query: Query) => data.inRange(toRange(query))[0]
    const all = (data: StoreData, query: Query | undefined, count?: number) => {
        const rows = query === undefined ? [...data.rows] : data.inRange(toRange(query))
        return rows.slice(0, upTo(count))
    }

    const write = (name: string, value: unknown, key: Key | undefined, add: boolean) => {
        writable()
        const data = store(name)
        const copy = clone(value)
        let rowKey: Key
        if (data.keyPath !== null) {
            if (key !== undefined) throw domError('DataError', 'A key with an inline key path')
            const inline = keyAtPath(copy, data.keyPath)
            if (inline === undefined) throw domError('DataError', 'No valid key at the key path')
            rowKey = inline
        } else {
            if (key === undefined) throw domError('DataError', 'An out-of-line key is needed')
            rowKey = requireKey(key)
        }
        return tx.place(() => {
            const { index, found } = data.find(rowKey)
            if (found && add) throw domError('ConstraintError', 'The key already exists')
            const old = found ? data.rows[index] : undefined
            const row = { key: rowKey, value: copy }
            if (found) data.rows[index] = row
            else data.rows.splice(index, 0, row)
            tx.log(() => {
                const at = data.find(rowKey)
                if (old) data.rows[at.index] = old
                else if (at.found) data.rows.splice(at.index, 1)
            })
            return normalizeKey(rowKey)
        }) as Promise<Key>
    }

    const index = (name: string, indexName: string): KvIndex => {
        const entries = (query?: Query) => {
            const data = store(name)
            return data.indexEntries(indexName, query === undefined ? undefined : toRange(query))
        }
        return {
            get: (query) => {
                const range = toRange(query)
                return tx.place(() => {
                    const entry = entries(range)[0]
                    return entry && clone(entry.row.value)
                })
            },
            getKey: (query) => {
                const range = toRange(query)
                return tx.place(() => entries(range)[0]?.row.key) as Promise<Key | undefined>
            },
            getAll: (query, count) => {
                const range = query === undefined ? undefined : toRange(query)
                return tx.place(() =>
                    entries(range)
                        .slice(0, upTo(count))
                        .map((entry) => clone(entry.row.value)),
                ) as Promise<unknown[]>
            },
            getAllKeys: (query, count) => {
                const range = query === undefined ? undefined : toRange(query)
                return tx.place(() =>
                    entries(range)
                        .slice(0, upTo(count))
                        .map((entry) => entry.row.key),
                ) as Promise<Key[]>
            },
            count: (query) => {
                const range = query === undefined ? undefined : toRange(query)
                return tx.place(() => entries(range).length) as Promise<number>
            },
        }
    }

    return {
        mode: tx.mode === 'versionchange' ? 'readwrite' : tx.mode,
        get: (name, query) => {
            const data = store(name)
            const range = toRange(query)
            return tx.place(() => {
                const row = first(data, range)
                return row && clone(row.value)
            })
        },
        getKey: (name, query) => {
            const data = store(name)
            const range = toRange(query)
            return tx.place(() => first(data, range)?.key) as Promise<Key | undefined>
        },
        getAll: (name, query, count) => {
            const data = store(name)
            const range = query === undefined ? undefined : toRange(query)
            return tx.place(() =>
                all(data, range, count).map((row) => clone(row.value)),
            ) as Promise<unknown[]>
        },
        getAllKeys: (name, query, count) => {
            const data = store(name)
            const range = query === undefined ? undefined : toRange(query)
            return tx.place(() => all(data, range, count).map((row) => row.key)) as Promise<Key[]>
        },
        count: (name, query) => {
            const data = store(name)
            const range = query === undefined ? undefined : toRange(query)
            return tx.place(() => all(data, range).length) as Promise<number>
        },
        put: (name, value, key) => write(name, value, key, false),
        add: (name, value, key) => write(name, value, key, true),
        delete: (name, query) => {
            writable()
            const data = store(name)
            const range = toRange(query)
            return tx.place(() => {
                const before = data.rows
                data.rows = before.filter((row) => !inRange(range, row.key))
                if (data.rows.length !== before.length)
                    tx.log(() => {
                        data.rows = before
                    })
            }) as Promise<void>
        },
        index,
        entries: (name, options: EntriesOptions = {}) => {
            const data = store(name)
            const range = options.query === undefined ? undefined : toRange(options.query)
            const { index: indexName, direction, limit } = options
            return tx.place(() => {
                const list: CursorEntry[] =
                    indexName === undefined
                        ? (range ? data.inRange(range) : [...data.rows]).map((row) => ({
                              key: row.key,
                              primaryKey: row.key,
                              value: clone(row.value),
                          }))
                        : data.indexEntries(indexName, range).map((entry) => ({
                              key: entry.key,
                              primaryKey: entry.row.key,
                              value: clone(entry.row.value),
                          }))
                return sorted(list, direction).slice(0, upTo(limit))
            }) as Promise<CursorEntry[]>
        },
        describe: (name) => {
            const data = store(name)
            return { keyPath: data.keyPath, indexes: Object.fromEntries(data.indexes) }
        },
    }
}

/** Faults a test injects: an error to fail a request or a commit with. */
export type MemoryFaults = {
    request?: (stores: readonly string[], mode: TxMode) => Error | undefined
}

/** A browser profile's databases, in memory. */
export class MemoryKv {
    private readonly databases = new Map<string, Database>()
    private readonly touched = new Set<Transaction>()
    faults: MemoryFaults = {}

    constructor(readonly scheduler: Scheduler) {
        scheduler.onTaskEnd(() => {
            this.endTask()
        })
    }

    /** A factory whose connections belong to the actor. */
    factory(actor: Actor = this.scheduler.main): KvFactory {
        this.scheduler.onKill(actor, () => {
            this.killActor(actor)
        })
        return {
            open: (name, version, options = {}) =>
                new Promise<KvDatabase>((resolve, reject) => {
                    if (version !== undefined && !(Number.isInteger(version) && version >= 1))
                        throw new TypeError('A version is a positive integer')
                    const db = this.database(name)
                    db.openQueue.push({ actor, version, options, resolve, reject })
                    this.scheduler.post(actor, this.scheduler.lane(), () => {
                        this.processOpens(db)
                    })
                }),
        }
    }

    /** Every row of every store, cloned, for invariant checks outside any transaction. */
    dump(name: string): Map<string, Row[]> {
        const db = this.databases.get(name)
        const out = new Map<string, Row[]>()
        if (!db) return out
        for (const [storeName, data] of db.stores)
            out.set(
                storeName,
                data.rows.map((row) => ({ key: row.key, value: clone(row.value) })),
            )
        return out
    }

    version(name: string) {
        return this.databases.get(name)?.version ?? 0
    }

    /** Drops every connection of the database as the browser does on a lost connection. */
    loseConnections(name: string) {
        const db = this.databases.get(name)
        if (!db) return
        for (const connection of [...db.connections]) {
            for (const tx of connection.unfinished) tx.abort(domError('UnknownError', 'Lost'))
            this.closeNow(connection)
            this.scheduler.post(connection.actor, this.scheduler.lane(), () => {
                connection.onclose?.()
            })
        }
    }

    touch(tx: Transaction) {
        this.touched.add(tx)
    }

    finish(tx: Transaction) {
        const db = tx.db
        db.transactions = db.transactions.filter((other) => other !== tx)
        this.startWaiting(db)
        this.checkCloses(db)
    }

    private database(name: string) {
        let db = this.databases.get(name)
        if (!db) {
            db = {
                name,
                version: 0,
                stores: new Map(),
                connections: new Set(),
                transactions: [],
                openQueue: [],
            }
            this.databases.set(name, db)
        }
        return db
    }

    private endTask() {
        for (const tx of this.touched) tx.active = false
        this.touched.clear()
        // Inactive with nothing pending: commit, which may start others that are already done.
        for (let changed = true; changed;) {
            changed = false
            for (const db of this.databases.values())
                for (const tx of [...db.transactions])
                    if (tx.state === 'running' && !tx.active && tx.outstanding === 0) {
                        tx.commit()
                        changed = true
                    }
        }
    }

    private startWaiting(db: Database) {
        for (const [i, tx] of db.transactions.entries()) {
            if (tx.state !== 'waiting') continue
            const blocked = db.transactions
                .slice(0, i)
                .some(
                    (earlier) =>
                        earlier.mode === 'versionchange' ||
                        tx.mode === 'versionchange' ||
                        ((earlier.mode === 'readwrite' || tx.mode === 'readwrite') &&
                            scopesOverlap(earlier.scope, tx.scope)),
                )
            if (!blocked) tx.start()
        }
    }

    private createTransaction(
        connection: Connection,
        scope: readonly string[],
        mode: TxMode | 'versionchange',
    ) {
        const tx = new Transaction(this, connection, scope, mode)
        connection.db.transactions.push(tx)
        this.touch(tx)
        // Outside a task (the worker's in-memory fallback), a task still ends its activity.
        if (!this.scheduler.inTask) this.scheduler.post(connection.actor, tx, () => undefined)
        this.startWaiting(connection.db)
        return tx
    }

    private wrap(connection: Connection): KvDatabase {
        const db = connection.db
        return {
            name: db.name,
            get version() {
                return db.version
            },
            get storeNames() {
                return [...db.stores.keys()].sort()
            },
            transaction: <T>(
                stores: readonly string[],
                mode: TxMode,
                fn: (tx: KvTx) => Promise<T>,
            ): Promise<T> => {
                if (connection.closePending || connection.closed)
                    return Promise.reject(domError('InvalidStateError', 'The connection is closed'))
                if (!stores.length)
                    return Promise.reject(domError('InvalidAccessError', 'No stores'))
                for (const name of stores)
                    if (!db.stores.has(name))
                        return Promise.reject(domError('NotFoundError', `No store ${name}`))
                if (this.scheduler.seeded && !this.scheduler.inTask)
                    return Promise.reject(
                        new Error('Start transactions inside a scheduler task (a tab’s run)'),
                    )
                const tx = this.createTransaction(connection, [...new Set(stores)], mode)
                const kvTx = makeTx(tx)
                const fault = this.faults.request?.(stores, mode)
                if (fault) {
                    const fail = () =>
                        tx.place(() => {
                            throw fault
                        }) as Promise<never>
                    Object.assign(kvTx, { put: fail, add: fail, delete: fail })
                }
                return runTransaction(
                    {
                        tx: kvTx,
                        commit: () => {
                            if (tx.state !== 'finished') tx.commitRequested = true
                        },
                        abort: () => {
                            tx.abort()
                        },
                        done: tx.done,
                    },
                    fn,
                )
            },
            close: () => {
                if (connection.closed) return
                connection.closePending = true
                this.checkCloses(db)
            },
            get onversionchange() {
                return connection.onversionchange
            },
            set onversionchange(handler) {
                connection.onversionchange = handler
            },
            get onclose() {
                return connection.onclose
            },
            set onclose(handler) {
                connection.onclose = handler
            },
        }
    }

    private closeNow(connection: Connection) {
        connection.closed = true
        connection.closePending = true
        connection.db.connections.delete(connection)
        this.checkUpgrade(connection.db)
    }

    private checkCloses(db: Database) {
        for (const connection of [...db.connections])
            if (connection.closePending && !connection.unfinished.length) this.closeNow(connection)
    }

    private killActor(actor: Actor) {
        for (const db of this.databases.values()) {
            for (const tx of [...db.transactions])
                if (tx.actor === actor) tx.abort(domError('AbortError'), false)
            for (const connection of [...db.connections])
                if (connection.actor === actor) this.closeNow(connection)
            if (db.pendingUpgrade?.request.actor === actor) {
                db.pendingUpgrade = undefined
                db.openQueue.shift()
            }
            db.openQueue = db.openQueue.filter((request) => request.actor !== actor)
            this.processOpens(db)
        }
    }

    private processOpens(db: Database) {
        if (db.pendingUpgrade) return
        const request = db.openQueue[0]
        if (!request) return
        const { actor } = request
        if (!actor.alive) {
            db.openQueue.shift()
            this.processOpens(db)
            return
        }
        const version = request.version ?? (db.version || 1)
        if (version < db.version) {
            db.openQueue.shift()
            this.scheduler.post(actor, this.scheduler.lane(), () => {
                request.reject(domError('VersionError', 'The database is newer'))
            })
            this.processOpens(db)
            return
        }
        if (version === db.version) {
            db.openQueue.shift()
            const connection = new Connection(this, db, actor)
            db.connections.add(connection)
            this.scheduler.post(actor, this.scheduler.lane(), () => {
                request.resolve(this.wrap(connection))
            })
            this.processOpens(db)
            return
        }
        db.pendingUpgrade = { request, version }
        const others = [...db.connections].filter((connection) => !connection.closePending)
        let left = others.length
        for (const connection of others)
            this.scheduler.post(connection.actor, this.scheduler.lane(), () => {
                if (!connection.closePending) connection.onversionchange?.(version)
                if (--left === 0) this.checkBlocked(db)
            })
        if (!others.length) this.checkUpgrade(db)
    }

    private checkBlocked(db: Database) {
        const pending = db.pendingUpgrade
        if (!pending) return
        if ([...db.connections].some((connection) => !connection.closePending)) {
            if (pending.request.blockedFired) return
            pending.request.blockedFired = true
            this.scheduler.post(pending.request.actor, this.scheduler.lane(), () => {
                pending.request.options.blocked?.()
            })
        }
        this.checkUpgrade(db)
    }

    private checkUpgrade(db: Database) {
        const pending = db.pendingUpgrade
        if (!pending || db.connections.size) return
        const { request, version } = pending
        this.scheduler.post(request.actor, this.scheduler.lane(), () => {
            if (db.pendingUpgrade !== pending) return
            this.runUpgrade(db, request, version)
        })
    }

    private runUpgrade(db: Database, request: OpenRequest, version: number) {
        const oldVersion = db.version
        const oldStores = db.stores
        db.stores = new Map([...oldStores].map(([name, data]) => [name, data.copy()]))
        db.version = version
        const connection = new Connection(this, db, request.actor)
        db.connections.add(connection)
        const upgrade: KvUpgrade = {
            oldVersion,
            newVersion: version,
            get storeNames() {
                return [...db.stores.keys()].sort()
            },
            createStore: (name, options) => {
                if (db.stores.has(name)) throw domError('ConstraintError', `${name} exists`)
                db.stores.set(name, new StoreData(options.keyPath ?? null))
            },
            createIndex: (name, indexName, keyPath) => {
                const data = db.stores.get(name)
                if (!data) throw domError('NotFoundError', `No store ${name}`)
                if (data.indexes.has(indexName))
                    throw domError('ConstraintError', `${indexName} exists`)
                data.indexes.set(indexName, keyPath)
            },
            put: (name, value, key) => {
                const data = db.stores.get(name)
                if (!data) throw domError('NotFoundError', `No store ${name}`)
                const copy = clone(value)
                const rowKey =
                    data.keyPath === null ? requireKey(key) : keyAtPath(copy, data.keyPath)
                if (rowKey === undefined) throw domError('DataError', 'No valid key')
                const { index, found } = data.find(rowKey)
                if (found) data.rows[index] = { key: rowKey, value: copy }
                else data.rows.splice(index, 0, { key: rowKey, value: copy })
            },
        }
        db.pendingUpgrade = undefined
        db.openQueue.shift()
        try {
            request.options.upgrade?.(upgrade)
        } catch (error) {
            db.stores = oldStores
            db.version = oldVersion
            db.connections.delete(connection)
            this.scheduler.post(request.actor, this.scheduler.lane(), () => {
                request.reject(error instanceof Error ? error : domError('AbortError'))
            })
            this.processOpens(db)
            return
        }
        this.scheduler.post(request.actor, this.scheduler.lane(), () => {
            request.resolve(this.wrap(connection))
        })
        this.processOpens(db)
    }
}

/** A blank range covering every key, for tests. */
export const everything = () => KeyRange.lowerBound(-Infinity)
