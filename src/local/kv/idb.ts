import { runTransaction } from './run'
import {
    asError,
    domError,
    isBlobRefusal,
    KeyRange,
    type CursorEntry,
    type KvDatabase,
    type KvFactory,
    type KvIndex,
    type KvTx,
    type KvUpgrade,
    type Query,
    type TxMode,
} from './types'

// The IndexedDB implementation (§1.6.1). Requests are promises resolved in their success events,
// so a transaction stays active across awaits of its own requests and commits explicitly.

const request = <T>(req: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        req.onsuccess = () => {
            resolve(req.result)
        }
        req.onerror = () => {
            reject(req.error ?? domError('UnknownError'))
        }
    })

const toIdbQuery = (query: Query | undefined): IDBValidKey | IDBKeyRange | undefined => {
    if (!(query instanceof KeyRange)) return query as IDBValidKey | undefined
    const { lower, upper, lowerOpen, upperOpen } = query
    if (lower !== undefined && upper !== undefined)
        return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen)
    if (lower !== undefined) return IDBKeyRange.lowerBound(lower, lowerOpen)
    return IDBKeyRange.upperBound(upper, upperOpen)
}

const toIdbKeyOrRange = (query: Query): IDBValidKey | IDBKeyRange =>
    toIdbQuery(query) ?? IDBKeyRange.only(query)

const indexOf = (source: IDBObjectStore | IDBIndex): KvIndex => ({
    get: (query) => request(source.get(toIdbKeyOrRange(query))),
    getKey: (query) => request<IDBValidKey | undefined>(source.getKey(toIdbKeyOrRange(query))),
    getAll: (query, count) => request(source.getAll(toIdbQuery(query), count)),
    getAllKeys: (query, count) => request(source.getAllKeys(toIdbQuery(query), count)),
    count: (query) => request(source.count(toIdbQuery(query))),
})

const wrapTx = (tx: IDBTransaction): KvTx => {
    const store = (name: string) => tx.objectStore(name)
    return {
        mode: tx.mode === 'readonly' ? 'readonly' : 'readwrite',
        get: (name, query) => indexOf(store(name)).get(query),
        getKey: (name, query) => indexOf(store(name)).getKey(query),
        getAll: (name, query, count) => indexOf(store(name)).getAll(query, count),
        getAllKeys: (name, query, count) => indexOf(store(name)).getAllKeys(query, count),
        count: (name, query) => indexOf(store(name)).count(query),
        put: (name, value, key) => request(store(name).put(value, key as IDBValidKey | undefined)),
        tryPut: (name, value, key) => {
            const req = store(name).put(value, key as IDBValidKey | undefined)
            return new Promise<boolean>((resolve, reject) => {
                req.onsuccess = () => {
                    resolve(true)
                }
                req.onerror = (event) => {
                    const error = req.error ?? domError('UnknownError')
                    // Anything but the Blob refusal aborts the transaction, as a put's does.
                    if (!isBlobRefusal(error, value)) {
                        reject(error)
                        return
                    }
                    // Handled: the transaction goes on without the row.
                    event.preventDefault()
                    event.stopPropagation()
                    resolve(false)
                }
            })
        },
        add: (name, value, key) => request(store(name).add(value, key as IDBValidKey | undefined)),
        delete: (name, query) => request(store(name).delete(toIdbKeyOrRange(query))),
        index: (name, index) => indexOf(store(name).index(index)),
        entries: (name, { index, query, direction, limit } = {}) =>
            new Promise<CursorEntry[]>((resolve, reject) => {
                const source = index === undefined ? store(name) : store(name).index(index)
                const req = source.openCursor(toIdbQuery(query), direction ?? 'next')
                const out: CursorEntry[] = []
                req.onsuccess = () => {
                    const cursor = req.result
                    if (!cursor || (limit && out.length >= limit)) {
                        resolve(out)
                        return
                    }
                    out.push({
                        key: cursor.key,
                        primaryKey: cursor.primaryKey,
                        value: cursor.value as unknown,
                    })
                    cursor.continue()
                }
                req.onerror = () => {
                    reject(req.error ?? domError('UnknownError'))
                }
            }),
        describe: (name) => {
            const objectStore = store(name)
            const indexes: Record<string, string | string[]> = {}
            for (const indexName of Array.from(objectStore.indexNames))
                indexes[indexName] = objectStore.index(indexName).keyPath
            return { keyPath: objectStore.keyPath, indexes }
        },
    }
}

const wrapDatabase = (db: IDBDatabase): KvDatabase => {
    const wrapper: KvDatabase = {
        name: db.name,
        get version() {
            return db.version
        },
        get storeNames() {
            return Array.from(db.objectStoreNames).sort()
        },
        transaction: (stores, mode: TxMode, fn, options) => {
            let tx: IDBTransaction
            try {
                tx = db.transaction([...stores], mode, { durability: options?.durability })
            } catch (error) {
                return Promise.reject(asError(error))
            }
            const done = new Promise<void>((resolve, reject) => {
                tx.oncomplete = () => {
                    resolve()
                }
                tx.onabort = () => {
                    reject(tx.error ?? domError('AbortError', 'The transaction was aborted'))
                }
            })
            return runTransaction(
                {
                    tx: wrapTx(tx),
                    commit: () => {
                        try {
                            // Older engines lack commit(); the transaction then commits on its own.
                            ;(tx as { commit?: () => void }).commit?.()
                        } catch {
                            // Already finished.
                        }
                    },
                    abort: () => {
                        try {
                            tx.abort()
                        } catch {
                            // Already finished.
                        }
                    },
                    done,
                },
                fn,
            )
        },
        close: () => {
            db.close()
        },
        onversionchange: undefined,
        onclose: undefined,
    }
    db.onversionchange = (event) => {
        wrapper.onversionchange?.(event.newVersion)
    }
    db.onclose = () => {
        wrapper.onclose?.()
    }
    return wrapper
}

const wrapUpgrade = (
    db: IDBDatabase,
    tx: IDBTransaction,
    oldVersion: number,
    newVersion: number,
): KvUpgrade => ({
    oldVersion,
    newVersion,
    get storeNames() {
        return Array.from(db.objectStoreNames).sort()
    },
    createStore: (name, options) => {
        db.createObjectStore(
            name,
            options.keyPath === undefined ? {} : { keyPath: options.keyPath as string | string[] },
        )
    },
    createIndex: (store, name, keyPath) => {
        tx.objectStore(store).createIndex(name, keyPath as string | string[])
    },
    put: (store, value, key) => {
        tx.objectStore(store).put(value, key as IDBValidKey | undefined)
    },
})

/** IndexedDB as a KvFactory. */
export const idbFactory = (factory: IDBFactory): KvFactory => ({
    open: (name, version, options = {}) =>
        new Promise<KvDatabase>((resolve, reject) => {
            const req = version === undefined ? factory.open(name) : factory.open(name, version)
            req.onupgradeneeded = (event) => {
                const tx = req.transaction
                if (!tx) return
                try {
                    options.upgrade?.(
                        wrapUpgrade(
                            req.result,
                            tx,
                            event.oldVersion,
                            event.newVersion ?? version ?? 1,
                        ),
                    )
                } catch (error) {
                    console.error(error)
                    tx.abort()
                }
            }
            req.onblocked = () => {
                options.blocked?.()
            }
            req.onsuccess = () => {
                resolve(wrapDatabase(req.result))
            }
            req.onerror = () => {
                reject(req.error ?? domError('UnknownError'))
            }
        }),
})
