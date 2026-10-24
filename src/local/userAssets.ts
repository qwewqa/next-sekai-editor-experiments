import type { KvTx } from './kv/types'

// The `userAssets` store: one record per stored preview asset package,
// keyed by its sha256. Never swept by GC or retention; only the Preview Assets dialog removes one.

export type UserAssetType = 'skin' | 'particle' | 'background' | 'effect'

export type UserAssetMeta = {
    /** sha256 of the stored package, 64 hex characters */
    key: string
    type: UserAssetType
    name: string
    title: string
    author: string
    /** The file name, or the server address */
    origin: string
    size: number
    addedAt: number
    lastUsedAt: number
}

export type UserAssetRecord = UserAssetMeta & { bytes: Blob }

export const USER_ASSETS = 'userAssets'

/** A record without its bytes. */
export const metaOf = (record: UserAssetRecord): UserAssetMeta => ({
    key: record.key,
    type: record.type,
    name: record.name,
    title: record.title,
    author: record.author,
    origin: record.origin,
    size: record.size,
    addedAt: record.addedAt,
    lastUsedAt: record.lastUsedAt,
})

/** Stores a package; one already stored keeps its time added. Returns what is stored. */
export const putUserAsset = async (tx: KvTx, record: UserAssetRecord): Promise<UserAssetMeta> => {
    const existing = (await tx.get(USER_ASSETS, record.key)) as UserAssetRecord | undefined
    const row: UserAssetRecord = existing ? { ...record, addedAt: existing.addedAt } : record
    await tx.put(USER_ASSETS, row)
    return metaOf(row)
}

/** What a put of several packages stored, and which of them were not stored before. */
export type UserAssetsPut = { metas: UserAssetMeta[]; added: string[] }

/** Stores several packages in the one transaction, so either all are stored or none. */
export const putUserAssets = async (
    tx: KvTx,
    records: UserAssetRecord[],
): Promise<UserAssetsPut> => {
    const metas: UserAssetMeta[] = []
    const added: string[] = []
    for (const record of records) {
        if (!(await tx.get(USER_ASSETS, record.key)) && !added.includes(record.key))
            added.push(record.key)
        metas.push(await putUserAsset(tx, record))
    }
    return { metas, added }
}

/** Every record without its bytes, newest first. */
export const listUserAssets = async (tx: KvTx): Promise<UserAssetMeta[]> =>
    ((await tx.getAll(USER_ASSETS)) as UserAssetRecord[])
        .map(metaOf)
        .sort((a, b) => b.addedAt - a.addedAt || (a.key < b.key ? -1 : 1))

export const getUserAsset = async (tx: KvTx, key: string) =>
    (await tx.get(USER_ASSETS, key)) as UserAssetRecord | undefined

/** Marks a record as used now; false when it is not stored. */
export const touchUserAsset = async (tx: KvTx, key: string, time: number) => {
    const row = await getUserAsset(tx, key)
    if (!row) return false
    await tx.put(USER_ASSETS, { ...row, lastUsedAt: time })
    return true
}

export const removeUserAsset = async (tx: KvTx, key: string) => {
    await tx.delete(USER_ASSETS, key)
}
