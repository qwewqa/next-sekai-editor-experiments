import { equalBytes } from '../hash'
import type { KvTx } from '../kv/types'
import { blockOf, blockSlot, type StackBlockRow } from '../timeline'

// Earlier sessions on an opened file's document (Part 1 §1.5.4 step 4), read in the storage worker
// in one transaction: each other chain with the same `docId`, its latest session, its base
// revision, whether it's bound (and with a handle), and whether its head's state differs from its
// file event's (§1.3.4: for a session that isn't open, the head snapshot's hash against `file.hash`).

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** A chain as the open's notice reads it; `openElsewhere` is the page's to fill in. */
export type StoredEarlierChain = {
    chainId: string
    sessionId: string
    revision?: { id: string; ancestors: string[] }
    bound?: { handle: boolean }
    changed: boolean
    updatedAt: number
}

/** The head slot's root of a session: its stack's index slot. */
const headOf = async (tx: KvTx, session: Row) => {
    const stack = session.stack as { index?: unknown } | undefined
    if (typeof stack?.index !== 'number') return
    const row = (await tx.get('stackBlocks', [session.id as string, blockOf(stack.index)])) as
        StackBlockRow | undefined
    return blockSlot(row, stack.index)?.snapshot
}

export const readEarlierChains = async (
    tx: KvTx,
    docId: string,
    exclude: string,
): Promise<StoredEarlierChain[]> => {
    const out: StoredEarlierChain[] = []
    for (const chain of (await tx.index('chains', 'docId').getAll(docId)) as Row[]) {
        if (chain.chainId === exclude || chain.deleting !== undefined) continue
        const sessionId = chain.head
        if (typeof sessionId !== 'string') continue
        const session = await tx.get('sessions', sessionId)
        if (!isRow(session)) continue
        const file = isRow(chain.file) ? chain.file : undefined
        const head = await headOf(tx, session)
        const changed =
            !!file && (!(file.hash instanceof Uint8Array) || !head || !equalBytes(head, file.hash))
        const revision = isRow(chain.revision) ? chain.revision : undefined
        out.push({
            chainId: String(chain.chainId),
            sessionId,
            ...(typeof revision?.id === 'string'
                ? {
                      revision: {
                          id: revision.id,
                          ancestors: Array.isArray(revision.ancestors)
                              ? revision.ancestors.filter(
                                    (id): id is string => typeof id === 'string',
                                )
                              : [],
                      },
                  }
                : {}),
            ...(file ? { bound: { handle: file.handle !== undefined } } : {}),
            changed,
            updatedAt: typeof chain.updatedAt === 'number' ? chain.updatedAt : 0,
        })
    }
    return out
}
