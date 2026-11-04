// A pick in progress, kept from just before a save picker opens until the write to the chosen file
// ends. A browser closed in between (Android may end it while its picker is in front) leaves the
// marker, and the next start of the same chain says the save did not finish.
//
// It lives in IndexedDB, in a database of its own: Chrome can delay committing a localStorage
// change, and IndexedDB does not use that delay. The connection opens before the picker, so the
// write starts synchronously and no await stands between the activation check and the picker. Each
// chain has its own marker, so one tab never ends or replaces another's. Storage that fails never
// stops a pick: the marker is a hint only.

type PickSurface = 'save' | 'export' | 'video'
export type PickMarker = { chainId: string; surface: PickSurface; at: number }

/** Where the markers are kept, one per chain: IndexedDB in the page, memory in Node tests. */
export type MarkerStore = {
    /** Opens the store ahead of a pick; called again, it does nothing. */
    prepare(): void
    /** Starts writing at once, with no await; a store not open yet writes once it opens. */
    put(marker: PickMarker): void
    remove(chainId: string): void
    get(chainId: string): Promise<unknown>
    /** Removes every marker written before `before`, and any that is not a marker. */
    sweep(before: number): void
}

const DB_NAME = 'nse-pick'
const STORE = 'pick'
/** A marker older than this is dropped unread. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** How long a start waits for the marker before it goes on without it. */
const READ_WAIT_MS = 1000

const indexedDbStore = (): MarkerStore => {
    let db: IDBDatabase | undefined
    let opening: Promise<IDBDatabase | undefined> | undefined
    const open = () =>
        (opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
            try {
                const request = indexedDB.open(DB_NAME, 1)
                request.onupgradeneeded = () => request.result.createObjectStore(STORE)
                request.onsuccess = () => {
                    db = request.result
                    resolve(db)
                }
                request.onerror = () => {
                    resolve(undefined)
                }
                request.onblocked = () => {
                    resolve(undefined)
                }
            } catch {
                resolve(undefined)
            }
        }))
    const write = (run: (store: IDBObjectStore) => void) => {
        const go = (connection: IDBDatabase | undefined) => {
            if (!connection) return
            try {
                run(connection.transaction(STORE, 'readwrite').objectStore(STORE))
            } catch {
                // A hint only.
            }
        }
        if (db) go(db)
        else void open().then(go)
    }
    return {
        prepare: () => {
            void open()
        },
        put: (marker) => {
            write((store) => store.put(marker, marker.chainId))
        },
        remove: (chainId) => {
            write((store) => store.delete(chainId))
        },
        sweep: (before) => {
            write((store) => {
                const request = store.openCursor()
                request.onsuccess = () => {
                    const cursor = request.result
                    if (!cursor) return
                    if (!isMarker(cursor.value) || cursor.value.at < before) cursor.delete()
                    cursor.continue()
                }
            })
        },
        get: async (chainId) => {
            const connection = await open()
            if (!connection) return undefined
            return new Promise<unknown>((resolve) => {
                try {
                    const request = connection.transaction(STORE).objectStore(STORE).get(chainId)
                    request.onsuccess = () => {
                        resolve(request.result)
                    }
                    request.onerror = () => {
                        resolve(undefined)
                    }
                } catch {
                    resolve(undefined)
                }
            })
        },
    }
}

const noStore: MarkerStore = {
    prepare: () => undefined,
    put: () => undefined,
    remove: () => undefined,
    get: () => Promise.resolve(undefined),
    sweep: () => undefined,
}

let store: MarkerStore | undefined
const current = () => (store ??= typeof indexedDB === 'undefined' ? noStore : indexedDbStore())

/** Tests swap the store; undefined restores the default. */
export const setMarkerStoreForTests = (replacement: MarkerStore | undefined) => {
    store = replacement
}

const guarded = (run: () => void) => {
    try {
        run()
    } catch {
        // A hint only.
    }
}

/** Opens the store while the save prepares, so the marker's write needs no await later. */
export const preparePick = () => {
    guarded(() => {
        current().prepare()
    })
}

/** Called synchronously just before the picker opens; `chainId` is the open session's chain. */
export const markPick = (chainId: string, surface: PickSurface) => {
    guarded(() => {
        current().put({ chainId, surface, at: Date.now() })
    })
}

/** The chain's write to the chosen file ended, landed or not, or no file was chosen. */
export const endPick = (chainId: string) => {
    guarded(() => {
        current().remove(chainId)
    })
}

function isMarker(value: unknown): value is PickMarker {
    if (typeof value !== 'object' || value === null) return false
    const { chainId, surface, at } = value as Record<string, unknown>
    return (
        typeof chainId === 'string' &&
        typeof at === 'number' &&
        (surface === 'save' || surface === 'export' || surface === 'video')
    )
}

/**
 * At start: the pick this chain left unfinished, once. Markers of any chain older than a day go
 * unread.
 */
export const takeUnfinishedPick = async (chainId: string): Promise<PickSurface | undefined> => {
    guarded(() => {
        current().sweep(Date.now() - MAX_AGE_MS)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const value = await Promise.race([
        // A store that throws, even at once, reads as no marker.
        Promise.resolve()
            .then(() => current().get(chainId))
            .catch(() => undefined),
        new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
                resolve(undefined)
            }, READ_WAIT_MS)
        }),
    ])
    clearTimeout(timer)
    if (value === undefined) return
    endPick(chainId)
    if (!isMarker(value) || value.chainId !== chainId) return
    return Date.now() - value.at > MAX_AGE_MS ? undefined : value.surface
}
