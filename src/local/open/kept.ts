import { KEPT_BYTES_LIMIT } from '../../editor/commands/exportLevel/memory'
import { storableHandle } from '../handles'
import type { StorageWorker } from '../worker/client'

// The bytes kept at a partial or unlinked open (Part 1 §1.5.4, owner decision log D5, D26): a save
// picker that empties that file puts them back (§1.4.7 R7). They're copied into the origin private
// file system, whatever their size, with the open's handle in the `handles` store, so a reload of
// the session keeps them; where OPFS fails, in memory up to 64 MB. Copies can be reclaimed
// only after definite deletion; an absent session lock can be a reload in progress.

type Worker = Pick<StorageWorker, 'call'>

const DIR = 'nse-kept'

/** The copies' folder: made by the first copy only, so nothing else leaves one behind. */
const directory = async (create = false) =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create })

/** A chain's kept bytes as an OPFS file, or undefined when there is none. */
export const readKeptCopy = async (chainId: string): Promise<Blob | undefined> => {
    try {
        return await (await (await directory()).getFileHandle(chainId)).getFile()
    } catch {
        return
    }
}

/**
 * Keeps a file's bytes for a chain, with its handle (§1.5.4): resolves the copy once it's whole,
 * or undefined when it couldn't be kept.
 */
export const keepCopy = async (
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
    let copy: Blob | undefined
    try {
        const target = await (await directory(true)).getFileHandle(chainId, { create: true })
        const writable = await target.createWritable()
        await writable.write(file)
        await writable.close()
        const written = await target.getFile()
        if (written.size === file.size) copy = written
    } catch {
        // No OPFS here: memory below the cap.
    }
    if (!copy && file.size <= KEPT_BYTES_LIMIT)
        copy = await file.arrayBuffer().then(
            (bytes) => new Blob([bytes]),
            () => undefined,
        )
    return copy
}
