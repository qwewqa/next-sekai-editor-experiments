import type { KvTx } from './kv/types'

// The `handles` store: a chain's stored file handles, one row per chain and
// role, never on the chain record or the journal descriptor, so startup and recovery read none.
// A row is written in the transaction that writes its field, and holds the field's name then, so a
// handle never outlives the binding or Export target it was stored for.

export const HANDLES = 'handles'

/** The chain fields a handle belongs to: the binding and Export's remembered target. */
export const HANDLE_ROLES = ['file', 'exportTarget'] as const

export type HandleRole = (typeof HANDLE_ROLES)[number]

/** A `handles` row: the handle (or the specs' token), and its field's name when stored. */
export type HandleRow = { chainId: string; role: HandleRole; name: string; handle: unknown }

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

const isRole = (key: string): key is HandleRole => (HANDLE_ROLES as readonly string[]).includes(key)

// Every database has the store (the creation step makes every store of the set). A transaction
// without it in scope fails: a handle is never dropped silently.

let reads = 0

/** Test: how many times this worker read a stored handle (never at startup or recovery). */
export const handleReadsForTests = () => reads

/** The handle stored for a chain's field, while the field still names what it was stored for. */
export const readHandleRow = async (tx: KvTx, chainId: string, role: HandleRole) => {
    reads++
    const chain = await tx.get('chains', chainId)
    const field = isRow(chain) ? chain[role] : undefined
    if (!isRow(field) || typeof field.name !== 'string') return
    const row = await tx.get(HANDLES, [chainId, role])
    if (!isRow(row) || row.name !== field.name) return
    return row.handle
}

/** Whether a handle is stored for a chain's field, without reading it. */
export const hasHandleRow = async (tx: KvTx, chainId: string, role: HandleRole) =>
    (await tx.getKey(HANDLES, [chainId, role])) !== undefined

/** Stores a field's handle, or removes it when there is none. */
export const writeHandleRow = async (
    tx: KvTx,
    chainId: string,
    role: HandleRole,
    name: string,
    handle: unknown,
) => {
    if (handle === undefined || handle === null) await tx.delete(HANDLES, [chainId, role])
    else await tx.put(HANDLES, { chainId, role, name, handle } satisfies HandleRow)
}

export const deleteHandleRow = async (tx: KvTx, chainId: string, role: HandleRole) => {
    await tx.delete(HANDLES, [chainId, role])
}

/** Removes every handle of a chain: in the transaction that deletes its record. */
export const deleteChainHandles = async (tx: KvTx, chainId: string) => {
    for (const role of HANDLE_ROLES) await deleteHandleRow(tx, chainId, role)
    // Earlier builds stored a partial open's source handle under this role.
    await tx.delete(HANDLES, [chainId, 'kept'])
}

/**
 * Chain fields as a write sets them (`null` removing one), with the handles taken out: a binding
 * or Export target set with a `handle` stores it in `handles`, one set without loses its row, and
 * a field removed loses its row. Returns the fields without handles.
 */
export const splitHandles = async (tx: KvTx, chainId: string, fields: Row): Promise<Row> => {
    const out: Row = { ...fields }
    for (const [key, value] of Object.entries(fields)) {
        if (!isRole(key)) continue
        if (!isRow(value)) {
            if (value === null || value === undefined) await deleteHandleRow(tx, chainId, key)
            continue
        }
        const { handle, ...rest } = value
        out[key] = rest
        await writeHandleRow(
            tx,
            chainId,
            key,
            typeof rest.name === 'string' ? rest.name : '',
            handle,
        )
    }
    return out
}

/** A record as stored: never a handle on it. */
export const withoutHandles = (record: Row): Row => {
    const out: Row = { ...record }
    for (const role of HANDLE_ROLES) {
        const field = out[role]
        if (isRow(field) && 'handle' in field) {
            const { handle: _handle, ...rest } = field
            out[role] = rest
        }
    }
    return out
}
