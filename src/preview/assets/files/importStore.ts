import type { AssetChoice, AssetType } from '../types'
import type { DecodeImage } from './decodeImage'
import { importItem } from './importer'
import type { SourcePackage } from './package'
import type { UserAssetMeta, UserAssetRecord, UserAssetStore } from './store'
import { storeRecords } from './storeRecords'

// The Preview Assets import: check and repack every item wanted, store them all in one
// transaction, then make them the ones in use. The chooser's Use and Open's package list run it.

export type ImportDeps = {
    store: UserAssetStore
    maxTextureSide: () => number
    decodeAudio: (data: ArrayBuffer) => Promise<AudioBuffer>
    decodeImage: DecodeImage
    /** Sets the choices an import made, all together. */
    apply: (choices: Partial<Record<AssetType, AssetChoice>>) => void
    now?: () => number
    /** Called after a storage attempt settles, so lists and the footer follow. */
    onStorageChanged?: () => void
}

/** The choice of a stored item: a file's, or a server's by its address. */
export const storedChoice = (meta: UserAssetMeta): AssetChoice => ({
    source: isServerOrigin(meta.origin) ? 'server' : 'file',
    key: meta.key,
    name: meta.name,
    title: meta.title,
    author: meta.author,
    origin: meta.origin,
})

/** A stored item's origin is a file name or a server's address; only an address has a scheme. */
const isServerOrigin = (origin: string) => /^https?:\/\//i.test(origin)

/**
 * Imports items of a package and applies them. Resolves to the stored metas, or undefined when
 * `isCurrent` turned false by the time they were stored (a closed dialog), which applies nothing.
 * A refused item rejects with its `AssetImportError`, and storing nothing.
 */
export const importAndUse = async (
    source: SourcePackage,
    wanted: readonly { type: AssetType; name: string }[],
    {
        origin,
        signal,
        isCurrent,
    }: {
        /** The file name, recorded with each item. */
        origin: string
        signal: AbortSignal
        isCurrent: () => boolean
    },
    deps: ImportDeps,
): Promise<UserAssetMeta[] | undefined> => {
    let storageAttempted = false
    try {
        const records: UserAssetRecord[] = []
        for (const entry of wanted)
            records.push(
                await importItem(source, entry.type, entry.name, {
                    maxTextureSide: deps.maxTextureSide(),
                    decodeAudio: deps.decodeAudio,
                    decodeImage: deps.decodeImage,
                    signal,
                    origin,
                    now: deps.now ?? Date.now,
                }),
            )
        // Checked all: only now is anything stored, all in one transaction, so a bad item
        // stores nothing.
        signal.throwIfAborted()
        storageAttempted = true
        const { metas } = await storeRecords(deps.store, records)
        if (!isCurrent()) return
        deps.apply(Object.fromEntries(metas.map((meta) => [meta.type, storedChoice(meta)])))
        return metas
    } finally {
        if (storageAttempted) deps.onStorageChanged?.()
    }
}
