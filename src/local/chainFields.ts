// A chain record's own fields and a fork's copy of it (§1.6.11.2), shared by the page (a fork's
// journal descriptor) and the worker (a fork's record).

type Row = Record<string, unknown>

/** Fields a record keeps for itself, which a fork and a journal descriptor leave out. */
export const CHAIN_OWN_FIELDS: readonly string[] = [
    'chainId',
    'head',
    'updatedAt',
    'day',
    'deleting',
    'appVersion',
]

/** Fields a fork drops: the binding, the Export target, the export name and `edited`. */
const FORK_DROPS: readonly string[] = ['file', 'exportTarget', 'exportName', 'edited']

/**
 * A fork's chain record (§1.6.11.2): the old record copied by exclusion, so fields a newer build
 * added carry, without the binding, the Export target, the export name or `edited`.
 */
export const forkRecord = (old: Row | undefined): Row => {
    const record: Row = {}
    if (old)
        for (const [key, value] of Object.entries(old))
            if (!CHAIN_OWN_FIELDS.includes(key) && !FORK_DROPS.includes(key)) record[key] = value
    return record
}
