import { resolveHandle } from '../../../local/handles'
import type { StorageWorker } from '../../../local/worker/client'

/** A remembered, never-registered target requires a successful check of known owners. */
export const knownTargetAvailable = async (
    worker: Pick<StorageWorker, 'call'>,
    chainId: string,
    handle: FileSystemFileHandle,
) => {
    try {
        const owners = await worker.call('listHandleOwners')
        for (const owner of owners) {
            if (!owner.handle) continue
            const stored = resolveHandle(
                await worker.call('readHandle', { chainId: owner.chainId, role: owner.role }),
            )
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
