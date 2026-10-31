import { computed, shallowRef } from 'vue'
import type { Inventory, PackageAsset, PackageLevel } from '../../../files/package/inventory'
import { i18n } from '../../../i18n'
import { platform } from '../../../platform'
import { savePoint } from '../../../platform/testPause'
import { isAssetSafeModeActive } from '../../../preview/assets'
import { choiceRow } from '../../../preview/assets/choice'
import { defaultName, typeLabel } from '../../../preview/assets/fallbackText'
import { storedChoice } from '../../../preview/assets/files/chooser'
import { AssetImportError } from '../../../preview/assets/files/errors'
import type { AssetIdentity } from '../../../preview/assets/files/identity'
import { pageImportDeps } from '../../../preview/assets/files/importDeps'
import { importAndUse } from '../../../preview/assets/files/importStore'
import { LIMITS } from '../../../preview/assets/files/limits'
import type { ItemType, Srl } from '../../../preview/assets/files/package'
import { StoreFailed } from '../../../preview/assets/files/storeRecords'
import { loadThumbnails } from '../../../preview/assets/files/thumbnails'
import type { AssetChoice } from '../../../preview/assets/types'
import { settings } from '../../../settings'
import { interpolateRaw } from '../../../utils/interpolate'

// The package list's state, kept while the flow lasts: the list shows again with it after an Open
// that failed or was cancelled, nothing read again. One item works at a time. Disposing it stops a
// running Import (nothing is stored unless the store already committed) and frees the pictures.

export type ListRow =
    | { kind: 'level'; id: string; level: PackageLevel; title: string; detail: string }
    | {
          kind: 'asset'
          id: string
          index: number
          asset: PackageAsset
          title: string
          detail: string
          /** What the row offers: Import, Use, "In use", or nothing in Safe Mode. */
          state: 'import' | 'use' | 'inUse' | 'none'
      }

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

const hasDefault = platform.capabilities.defaultAssets

/** The name Preview Assets shows a built-in source by. */
const sourceName = (identity: AssetIdentity & { kind: 'builtin' }, asset: PackageAsset) => {
    const strings = i18n.value.commands.previewAssets
    if (identity.source === 'default') return defaultName(asset.type)
    return identity.source === 'nextSekai02' ? strings.nextSekai02 : strings.builtin
}

export const createPackageList = (
    inventory: Inventory,
    identities: readonly AssetIdentity[],
    origin: string,
) => {
    const deps = pageImportDeps()
    const known = shallowRef<readonly AssetIdentity[]>(identities)
    /** The id of the row whose Import runs. */
    const working = shallowRef<string>()
    const errors = shallowRef<ReadonlyMap<string, string>>(new Map())
    /** What a screen reader hears of the last action: Storing…, its result, or its error. */
    const status = shallowRef('')
    /** The level row whose Open was pressed last, where the list shows again after it fails. */
    const pressed = shallowRef<string>()
    const pictures = shallowRef<ReadonlyMap<string, string>>(new Map())
    const controller = new AbortController()
    const life = { disposed: false }
    const isDisposed = () => life.disposed

    const inUse = (identity: AssetIdentity, asset: PackageAsset) =>
        identity.kind !== 'new' &&
        choiceRow(identity.choice, asset.type, hasDefault) ===
            choiceRow(settings.previewAssets[asset.type], asset.type, hasDefault)

    const rows = computed<ListRow[]>(() => {
        const strings = i18n.value
        const levels = inventory.levels.map((level, i): ListRow => ({
            kind: 'level',
            id: `level-${i}`,
            level,
            title: level.title,
            detail: [
                level.data === undefined ? strings.open.package.dataMissing : level.artists,
                level.author,
            ]
                .filter(Boolean)
                .join(' · '),
        }))
        const assets = inventory.assets.map((asset, index): ListRow => {
            const identity = known.value[index] ?? { kind: 'new' }
            const used = !isAssetSafeModeActive && inUse(identity, asset)
            // The marker leads, so it stays when the line is cut short.
            const marker =
                identity.kind === 'new' || used
                    ? ''
                    : identity.kind === 'stored'
                      ? strings.open.package.stored
                      : sourceName(identity, asset)
            return {
                kind: 'asset',
                id: `asset-${index}`,
                index,
                asset,
                title: asset.title,
                detail: [marker, typeLabel(asset.type), asset.author].filter(Boolean).join(' · '),
                state: isAssetSafeModeActive
                    ? 'none'
                    : used
                      ? 'inUse'
                      : identity.kind === 'new'
                        ? 'import'
                        : 'use',
            }
        })
        return [...levels, ...assets]
    })

    const setError = (id: string, message: string | undefined) => {
        const next = new Map(errors.value)
        if (message === undefined) next.delete(id)
        else next.set(id, message)
        errors.value = next
    }

    // Whatever went wrong reads as a problem with the package, with reading the file, or with
    // storing it, as in the chooser.
    const describe = (failure: unknown, asset: PackageAsset) =>
        deps.describe(
            failure instanceof AssetImportError
                ? failure
                : new AssetImportError(
                      failure instanceof StoreFailed ? 'storeFailed' : 'fileUnreadable',
                      { type: asset.type },
                  ),
        )

    const inUseText = (row: ListRow) => `${row.title} · ${i18n.value.commands.previewAssets.inUse}`

    /** Checks, stores and uses one asset, as the chooser's Use does. */
    const importRow = async (row: ListRow & { kind: 'asset' }) => {
        if (working.value !== undefined || isDisposed()) return
        const { signal } = controller
        working.value = row.id
        setError(row.id, undefined)
        status.value = i18n.value.commands.previewAssets.progress.storing
        try {
            const metas = await importAndUse(
                inventory.pkg,
                [{ type: row.asset.type, name: row.asset.name }],
                {
                    origin,
                    signal,
                    isCurrent: () => !life.disposed && !signal.aborted,
                    toChoice: storedChoice,
                },
                deps,
            )
            const meta = metas?.[0]
            if (!meta) return
            known.value = known.value.map((identity, index) =>
                index === row.index ? { kind: 'stored', choice: storedChoice(meta) } : identity,
            )
            status.value = inUseText(row)
        } catch (failure) {
            if (isDisposed() || isAbort(failure)) return
            const message = describe(failure, row.asset)
            setError(row.id, message)
            status.value = message
            if (!(failure instanceof AssetImportError))
                console.error('Could not store the preview asset:', failure)
        } finally {
            if (working.value === row.id) working.value = undefined
            // A spec waits for this to know the Import has settled, cancelled or not.
            void savePoint('packageImportEnded')
        }
    }

    /** Uses an item already in Preview Assets, as selecting it there does. */
    const useRow = (row: ListRow & { kind: 'asset' }) => {
        const identity = known.value[row.index]
        if (!identity || identity.kind === 'new' || working.value !== undefined) return
        const choice: AssetChoice = identity.choice
        settings.previewAssets = { ...settings.previewAssets, [row.asset.type]: choice }
        status.value = inUseText(row)
        // Using a stored item marks it used; the mark is only a note.
        if (choice.source === 'file' || choice.source === 'server')
            void deps.store.touch(choice.key).catch(() => undefined)
    }

    /** The first rows' covers and thumbnails, read once. */
    const loadPictures = () => {
        const read = (type: ItemType, srl: Srl) => async () => {
            const path = inventory.pkg.resolve(srl)
            return path
                ? inventory.pkg.entry(path, { type, part: 'thumbnail', maxSize: LIMITS.thumbnail })
                : undefined
        }
        void loadThumbnails(
            [
                ...inventory.levels.map((level, i) => ({
                    key: `level-${i}`,
                    read: read('level', level.cover),
                })),
                ...inventory.assets.map((asset, i) => ({
                    key: `asset-${i}`,
                    read: read(asset.type, asset.thumbnail),
                })),
            ],
            () => !life.disposed,
            (key, url) => {
                pictures.value = new Map(pictures.value).set(key, url)
            },
        )
    }
    loadPictures()

    return {
        rows,
        working,
        errors,
        pictures,
        status,
        pressed,
        /** Remembers the level row whose Open was pressed. */
        press: (id: string) => {
            pressed.value = id
        },
        /** The line above the first asset row in Safe Mode, if any. */
        safeModeLine: computed(() =>
            isAssetSafeModeActive && hasDefault && inventory.assets.length
                ? interpolateRaw(
                      i18n.value.commands.previewAssets.safeMode,
                      i18n.value.commands.previewAssets.default,
                  )
                : undefined,
        ),
        importRow,
        useRow,
        /** Stops a running Import, and frees the pictures. */
        dispose: () => {
            life.disposed = true
            controller.abort()
            for (const url of pictures.value.values()) URL.revokeObjectURL(url)
            pictures.value = new Map()
        },
    }
}

export type PackageList = ReturnType<typeof createPackageList>
