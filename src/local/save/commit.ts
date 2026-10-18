import type { KvTx } from '../kv/types'
import type { RowKey, SaveIdentity } from './build'

// The identity unit a write that binds commits (§1.3.2, §1.6.11.6): the chain's `docId`, its
// `revision` and the binding, with the marks the write made, in one transaction, so a binding is
// never stored without them (D25: the carry test counts on every row its file lacks being stored
// `kept: false`).

/** The stores `commitIdentity` writes and reads. */
export const IDENTITY_STORES = ['chains', 'sessions', 'entries'] as const

export type IdentityUnit = {
    docId: string
    revision: SaveIdentity['revision']
    /** The binding as stored (§1.6.11.2), its `entry` complete. */
    file: Record<string, unknown>
    marks: readonly RowKey[]
}

/**
 * Stores a write's marks: each stored row `kept: false`. False, writing nothing, while a marked
 * row isn't stored but its session is; a row whose session was deleted needs no mark. The flush
 * that commits a Save's identity unit runs it first (the seam `commitIdentity` shares).
 */
export const storeMarks = async (tx: KvTx, marks: readonly RowKey[]) => {
    const marked: Record<string, unknown>[] = []
    for (const { sessionId, seq } of marks) {
        const stored = (await tx.get('entries', [sessionId, seq])) as
            Record<string, unknown> | undefined
        if (stored) {
            if (stored.kept !== false) marked.push(stored)
        } else if (await tx.get('sessions', sessionId)) return false
    }
    for (const row of marked) await tx.put('entries', { ...row, kept: false })
    return true
}

/**
 * Stores the identity unit after its marks. Run it in the transaction that stores the write's
 * pending rows, after them: a marked row that isn't stored while its session is commits nothing
 * (false), and the binding stays in memory with its marks until it can be stored with them. A row
 * whose session was deleted needs no mark.
 */
export const commitIdentity = async (tx: KvTx, chainId: string, unit: IdentityUnit) => {
    const chain = (await tx.get('chains', chainId)) as Record<string, unknown> | undefined
    if (!chain) return false
    if (!(await storeMarks(tx, unit.marks))) return false
    await tx.put('chains', {
        ...chain,
        docId: unit.docId,
        revision: unit.revision,
        file: unit.file,
    })
    return true
}
