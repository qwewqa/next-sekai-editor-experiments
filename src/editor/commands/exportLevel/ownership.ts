import { handleOf } from '../../../local/handles'
import { storedRead, type ReadWorker } from '../../../local/storedRead'

/** A remembered, never-registered target requires a successful check of known owners. */
export const knownTargetAvailable = async (
    worker: ReadWorker,
    chainId: string,
    handle: FileSystemFileHandle,
) => {
    try {
        const list = await storedRead(worker, 'listHandleOwners', undefined)
        // Not proved free when the owners or one handle can't be read.
        if (list.storedRead === 'failed') return false
        for (const owner of list.storedValue) {
            if (!owner.handle) continue
            const read = await handleOf(worker, owner.chainId, owner.role)
            const stored = read.storedRead === 'value' ? read.storedValue : undefined
            if (!stored) return false
            let same: boolean
            try {
                same = stored === handle || (await stored.isSameEntry(handle))
            } catch {
                same = await handle.isSameEntry(stored)
            }
            if (same && (owner.role !== 'exportTarget' || owner.chainId !== chainId)) return false
        }
        return true
    } catch {
        return false
    }
}
