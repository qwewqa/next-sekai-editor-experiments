import { deleteHandleRow } from '../handleRows'
import type { KvTx } from '../kv/types'
import { isReadableSessionVersion } from '../records/unknownValues'
import type { RowKey, SaveIdentity } from './build'

// The identity unit a write that binds commits: the chain's `docId`, its
// `revision` and the binding, with the marks the write made, in one transaction, so a binding is
// never stored without them (the carry test counts on every row its file lacks being stored
// `kept: false`).

/** The stores `commitIdentity` writes and reads. */
export const IDENTITY_STORES = ['chains', 'sessions', 'entries', 'handles'] as const

export const sessionVersionReader = (
    tx: KvTx,
    known: readonly (readonly [string, unknown])[] = [],
) => {
    const rows = new Map(known.map(([id, row]) => [id, Promise.resolve(row)]))
    return (id: string) => {
        let row = rows.get(id)
        if (!row) {
            row = tx.get('sessions', id)
            rows.set(id, row)
        }
        return row
    }
}

export const writableSession = (row: unknown) =>
    typeof row === 'object' && row !== null && isReadableSessionVersion((row as { v?: unknown }).v)

export const marksHaveSupportedSessions = async (
    marks: readonly RowKey[],
    read: ReturnType<typeof sessionVersionReader>,
) => {
    for (const id of new Set(marks.map((mark) => mark.sessionId))) {
        const row = await read(id)
        if (row !== undefined && !writableSession(row)) return false
    }
    return true
}

export type IdentityUnit = {
    clearExport?: true
    docId: string
    revision: SaveIdentity['revision']
    /** The binding as stored, its `entry` complete. */
    file: Record<string, unknown>
    marks: readonly RowKey[]
    /**
     * The record's binding as the Save found it (its `file.at` and `replaced.at`): a record that
     * changed since, a takeover's revocation, never takes the unit.
     */
    from?: { fileAt?: number; replacedAt?: number }
}

/** Whether a record still holds the binding a unit was made from (no `from`: any). */
export const unitApplies = (chain: Record<string, unknown>, unit: IdentityUnit) => {
    const { from } = unit
    if (!from) return true
    const at = (field: unknown) =>
        typeof field === 'object' &&
        field !== null &&
        typeof (field as { at?: unknown }).at === 'number'
            ? (field as { at: number }).at
            : undefined
    return at(chain.file) === from.fileAt && at(chain.replaced) === from.replacedAt
}

/**
 * Stores a write's marks: each stored row `kept: false`. False, writing nothing, while a marked
 * row isn't stored but its session is; a row whose session was deleted needs no mark. The flush
 * that commits a Save's identity unit runs it first (the seam `commitIdentity` shares).
 */
export const storeMarks = async (
    tx: KvTx,
    marks: readonly RowKey[],
    read = sessionVersionReader(tx),
) => {
    if (!(await marksHaveSupportedSessions(marks, read))) return false
    const marked: Record<string, unknown>[] = []
    for (const { sessionId, seq } of marks) {
        const stored = (await tx.get('entries', [sessionId, seq])) as
            Record<string, unknown> | undefined
        if (stored) {
            if (stored.kept !== false) marked.push(stored)
        } else if (await read(sessionId)) return false
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
    const read = sessionVersionReader(tx)
    if (typeof chain.head !== 'string' || !writableSession(await read(chain.head))) return false
    if (!(await storeMarks(tx, unit.marks, read))) return false
    const record = {
        ...chain,
        docId: unit.docId,
        revision: unit.revision,
        file: unit.file,
    }
    await clearIdentityExport(tx, chainId, record, unit)
    await tx.put('chains', record)
    return true
}

/** Save As drops its Export destination in the identity transaction. */
export const clearIdentityExport = async (
    tx: KvTx,
    chainId: string,
    chain: Record<string, unknown>,
    unit: IdentityUnit,
) => {
    if (!unit.clearExport) return
    delete chain.exportTarget
    delete chain.exportName
    await deleteHandleRow(tx, chainId, 'exportTarget')
}
