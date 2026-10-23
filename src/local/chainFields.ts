// A chain record's own fields and a fork's copy of it (§1.6.11.2), shared by the page (a fork's
// journal descriptor) and the worker (a fork's record).

type Row = Record<string, unknown>

/**
 * Fields a record keeps for itself, which a fork and a journal descriptor leave out. `startedAt` is
 * the chain's first start, which dates an untitled name (§1.3.5); every maker of a record sets it.
 */
export const CHAIN_OWN_FIELDS: readonly string[] = [
    'chainId',
    'head',
    'startedAt',
    'updatedAt',
    'day',
    'deleting',
    'appVersion',
]

/** A chain's first start, else its head session's: what dates an untitled name (§1.3.5). */
export const chainStartOf = (chain: Row | undefined, headStart: unknown) => {
    const own = chain?.startedAt
    if (typeof own === 'number' && Number.isFinite(own)) return own
    return typeof headStart === 'number' && Number.isFinite(headStart) ? headStart : undefined
}

/** Fields a fork drops: the binding, the Export target, the export name, `edited` and `replaced`. */
const FORK_DROPS: readonly string[] = ['file', 'exportTarget', 'exportName', 'edited', 'replaced']

/**
 * A fork's chain record (§1.6.11.2): the old record copied by exclusion, so fields a newer build
 * added carry, without the binding, the Export target, the export name, `edited` or `replaced`.
 */
export const forkRecord = (old: Row | undefined): Row => {
    const record: Row = {}
    if (old)
        for (const [key, value] of Object.entries(old))
            if (!CHAIN_OWN_FIELDS.includes(key) && !FORK_DROPS.includes(key)) record[key] = value
    return record
}
