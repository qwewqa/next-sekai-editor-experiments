import { readMeta } from './db'
import type { KvTx } from './kv/types'
import type { NameParts } from './names'
import { readRecent, type RecentFile } from './recent'
import { ids, sessionsOf } from './removal'
import { nextTime } from './time'

// What Delete Sessions… reads of the stored chains (deletion design §3.6; Local Data design §3.7),
// in one transaction: every chain not marked for Delete, with the facts the page needs for the
// ranges and for `notSavedToFile`. The page decides what is in range, the zone being its own.

export type DeleteCandidate = {
    chainId: string
    /** The head session and the chain's last write: the removal's `expect`. */
    head: string
    updatedAt: number
    /** Every session of the chain, oldest first: what the page locks. */
    sessions: string[]
    /** The head's start: dates an untitled name. */
    startedAt: number
    nameParts: NameParts
    /** `newer`: a session this build can't read; such a chain is deleted all the same. */
    readable: 'yes' | 'newer'
    file?: Pick<RecentFile, 'event' | 'confirmed'>
    changed: boolean
    hasContent: boolean
}

export type DeleteCandidates = { now: number; chains: DeleteCandidate[] }

/**
 * The worker's `now` and the chains: a chain without a readable head record (Recent Sessions lists
 * it as damaged) is left out, since a removal is expected against its head.
 */
export const readDeleteCandidates = async (tx: KvTx, wall: number): Promise<DeleteCandidates> => {
    const now = nextTime((await readMeta(tx, 'maxSeenTime')) ?? 0, wall)
    const chains: DeleteCandidate[] = []
    for (const recent of await readRecent(tx)) {
        if (!recent.head.sessionId) continue
        const record = (await tx.get('chains', recent.chainId)) as
            Record<string, unknown> | undefined
        const { file } = recent
        chains.push({
            chainId: recent.chainId,
            head: recent.head.sessionId,
            updatedAt: recent.updatedAt,
            sessions: ids(await sessionsOf(tx, recent.chainId)),
            startedAt: recent.head.startedAt,
            nameParts: recent.nameParts,
            readable: recent.readable === 'newer' ? 'newer' : 'yes',
            ...(file
                ? {
                      file: {
                          ...(file.event === undefined ? {} : { event: file.event }),
                          ...(file.confirmed ? { confirmed: true } : {}),
                      },
                  }
                : {}),
            changed: recent.changed,
            hasContent: record?.hasContent === true,
        })
    }
    return { now, chains }
}
