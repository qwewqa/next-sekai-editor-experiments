import type { KvTx } from './kv/types'
import type { NameParts } from './names'
import { readRecentChains, type RecentReadable } from './recent'
import { fileAtOf, ids } from './removal'

// What Delete Sessions… reads of the stored chains,
// in one transaction: every chain not marked for Delete, with the facts the page needs for the
// ranges and for `notSavedToFile`. The page decides what is in range, the zone being its own.

export type DeleteCandidate = {
    chainId: string
    /** The head session (absent on a damaged chain) and the chain's last write: the removal's `expect`. */
    head?: string
    updatedAt: number
    /** The file binding's `at`, which the removal expects unchanged. */
    fileAt?: number
    /** Every session of the chain, oldest first: what the page locks. */
    sessions: string[]
    /** The head's start: dates an untitled name. */
    startedAt: number
    nameParts: NameParts
    /** `newer` or `damaged`: a session this build can't read, or a missing head; deleted all the same. */
    readable: RecentReadable
    /** The chain has a bound file. */
    bound: boolean
    changed: boolean
    hasContent: boolean
}

/**
 * The chains. A chain without a readable head (Recent Sessions lists it as damaged) is included,
 * with no `head`: a removal is expected against none, and it counts as not saved to a file.
 */
export const readDeleteCandidates = async (tx: KvTx): Promise<DeleteCandidate[]> => {
    const chains: DeleteCandidate[] = []
    for (const { recent, record, sessions } of await readRecentChains(tx)) {
        const { file } = recent
        const fileAt = fileAtOf(record)
        chains.push({
            chainId: recent.chainId,
            ...(recent.head.sessionId ? { head: recent.head.sessionId } : {}),
            updatedAt: recent.updatedAt,
            ...(fileAt === undefined ? {} : { fileAt }),
            sessions: ids([...sessions].sort((a, b) => Number(a.startedAt) - Number(b.startedAt))),
            startedAt: recent.head.startedAt,
            nameParts: recent.nameParts,
            readable: recent.readable,
            bound: file !== undefined,
            changed: recent.changed,
            hasContent: record.hasContent === true,
        })
    }
    return chains
}
