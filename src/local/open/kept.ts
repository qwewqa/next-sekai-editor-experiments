import { KEPT_BYTES_LIMIT } from '../../editor/commands/exportLevel/memory'
import type { LockService } from '../../platform/types'
import { storableHandle } from '../handles'
import { sessionLock } from '../locks'
import type { StorageWorker } from '../worker/client'

// The bytes kept at a partial or unlinked open (Part 1 §1.5.4, owner decision log D5, D26): a save
// picker that empties that file puts them back (§1.4.7 R7). They're copied into the origin private
// file system, whatever their size, with the open's handle in the `handles` store, so a reload of
// the session keeps them; where OPFS fails, in memory up to 64 MB. They go when the session closes
// in this tab, and a later load drops those of sessions no tab holds.

type Worker = Pick<StorageWorker, 'call'>

const DIR = 'nse-kept'

const directory = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true })

/** A chain's kept bytes as an OPFS file, or undefined when there is none. */
export const readKeptCopy = async (chainId: string): Promise<Blob | undefined> => {
    try {
        return await (await (await directory()).getFileHandle(chainId)).getFile()
    } catch {
        return
    }
}

const removeCopy = async (chainId: string) => {
    try {
        await (await directory()).removeEntry(chainId)
    } catch {
        // Gone already.
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
    // The handle first: a load's sweep never drops a copy whose row isn't written yet.
    const stored = await storableHandle(handle)
    if (stored)
        await worker
            .call('keepHandle', { chainId, name: handle.name, handle: stored })
            .catch(() => undefined)
    let copy: Blob | undefined
    try {
        const target = await (await directory()).getFileHandle(chainId, { create: true })
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

/** Lets a chain's kept bytes go: its session closed in this tab. */
export const dropKept = async (worker: Worker, chainId: string) => {
    await worker.call('dropKept', chainId).catch(() => undefined)
    await removeCopy(chainId)
}

/**
 * At a load, once its session opened: kept bytes of chains whose head session no tab holds are
 * dropped, with copies no row names.
 */
export const sweepKept = async (worker: Worker, locks: LockService) => {
    const kept = await worker.call('listKept').catch(() => undefined)
    if (!kept) return
    let held: Set<string>
    try {
        const snapshot = await locks.query()
        held = new Set([...snapshot.held, ...snapshot.pending].map((lock) => lock.name))
    } catch {
        return
    }
    const live = new Set<string>()
    for (const { chainId, head } of kept)
        if (head !== undefined && held.has(sessionLock(head))) live.add(chainId)
        else await dropKept(worker, chainId)
    try {
        const dir = await directory()
        const names: string[] = []
        for await (const name of (dir as unknown as { keys: () => AsyncIterable<string> }).keys())
            names.push(name)
        for (const name of names) if (!live.has(name)) await removeCopy(name)
    } catch {
        // No OPFS: nothing kept there.
    }
}
