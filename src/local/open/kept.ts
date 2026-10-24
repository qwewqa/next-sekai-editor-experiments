import { KEPT_BYTES_LIMIT } from '../../editor/commands/exportLevel/memory'
import { storableHandle } from '../handles'
import type { StorageWorker } from '../worker/client'

// The bytes kept at a partial or unlinked open: a save
// picker that empties that file puts them back. They're copied into the origin private
// file system, whatever their size, with the open's handle in the `handles` store, so a reload of
// the session keeps them; where OPFS fails, in memory up to 64 MB. Copies can be reclaimed
// only after definite deletion; an absent session lock can be a reload in progress.

type Worker = Pick<StorageWorker, 'call'>

const DIR = 'nse-kept'

/** The copies' folder: made by the first copy only, so nothing else leaves one behind. */
const directory = async (create = false) =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create })

/** A chain's kept bytes as an OPFS file, or undefined when there is none (a 0-byte copy is none). */
export const readKeptCopy = async (chainId: string): Promise<Blob | undefined> => {
    try {
        const copy = await (await (await directory()).getFileHandle(chainId)).getFile()
        return copy.size > 0 ? copy : undefined
    } catch {
        return
    }
}

/** The chains with a kept copy in OPFS, for the load's reclaim after definite deletion. */
export const keptCopyChains = async (): Promise<string[]> => {
    try {
        const names: string[] = []
        const folder = (await directory()) as unknown as { keys: () => AsyncIterable<string> }
        for await (const name of folder.keys()) names.push(name)
        return names
    } catch {
        return []
    }
}

/** Removes a deleted chain's kept copy; one left behind is tried again at the next load. */
export const removeKeptCopy = async (chainId: string) => {
    try {
        await (await directory()).removeEntry(chainId)
    } catch {
        // Tried again at the next load.
    }
}

/** The copies being made now: a save picker waits for them (spec B, rule 3). */
const copying = new Set<Promise<unknown>>()

/** Whether a copy of an opened file is still being kept. */
export const copiesRunning = () => copying.size > 0

/** Resolves once no copy is being kept, or at once when `signal` aborts. */
export const whenCopied = async (signal?: AbortSignal) => {
    while (copying.size > 0 && !signal?.aborted)
        await new Promise<void>((resolve) => {
            const done = () => {
                signal?.removeEventListener('abort', done)
                resolve()
            }
            signal?.addEventListener('abort', done, { once: true })
            void Promise.allSettled([...copying]).then(done)
        })
}

/**
 * Keeps a file's bytes for a chain, with its handle: resolves the copy once it's whole,
 * or undefined when it couldn't be kept.
 */
export const keepCopy = (
    worker: Worker,
    chainId: string,
    file: Blob,
    handle: FileSystemFileHandle,
): Promise<Blob | undefined> => {
    // In the set before its first await.
    const copy = copyBytes(worker, chainId, file, handle)
    const done = () => {
        copying.delete(copy)
    }
    copying.add(copy)
    copy.then(done, done)
    return copy
}

const copyBytes = async (
    worker: Worker,
    chainId: string,
    file: Blob,
    handle: FileSystemFileHandle,
): Promise<Blob | undefined> => {
    // Keep recognition even when the bytes cannot be copied.
    const stored = await storableHandle(handle)
    if (stored)
        await worker
            .call('keepHandle', { chainId, name: handle.name, handle: stored })
            .catch(() => undefined)
    let made: Blob | undefined
    try {
        const target = await (await directory(true)).getFileHandle(chainId, { create: true })
        const writable = await target.createWritable()
        await writable.write(file)
        await writable.close()
        const written = await target.getFile()
        if (written.size === file.size) made = written
    } catch {
        // No OPFS here: memory below the cap.
    }
    if (!made && file.size <= KEPT_BYTES_LIMIT)
        made = await file.arrayBuffer().then(
            (bytes) => new Blob([bytes]),
            () => undefined,
        )
    return made
}
