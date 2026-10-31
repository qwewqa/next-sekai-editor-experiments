import { shallowRef } from 'vue'
import { isAbort } from '../../../utils/error'
import { assetTypes } from '../choice'
import type { AssetChoice, AssetType } from '../types'
import { AssetImportError } from './errors'
import { importAndUse, type ImportDeps } from './importStore'
import { LIMITS } from './limits'
import { openSourcePackage, type ListedItem, type SourcePackage } from './package'
import type { UserAssetMeta } from './store'
import { StoreFailed } from './storeRecords'
import { loadThumbnails } from './thumbnails'

// The chooser's From a File view without its markup: pick a package, list the
// items of one type, offer the other types' items of the same name, and on Use check, repack and
// store what was selected and ticked. One chooser per type lives with the dialog, so it keeps its
// state across tabs, and closing the dialog disposes it, which cancels what is running.

export type AlsoOption = {
    type: AssetType
    name: string
    title: string
    ticked: boolean
}

export type ChooserDeps = ImportDeps & {
    /** The plain message for a package that is refused. */
    describe: (error: AssetImportError) => string
}

export type ChooserPhase = 'idle' | 'reading' | 'listed' | 'working'

export const storedChoice = (meta: UserAssetMeta): AssetChoice => ({
    source: isServerOrigin(meta.origin) ? 'server' : 'file',
    key: meta.key,
    name: meta.name,
    title: meta.title,
    author: meta.author,
    origin: meta.origin,
})

/** A stored item's origin is a file name or a server's address; only an address has a scheme. */
export const isServerOrigin = (origin: string) => /^https?:\/\//i.test(origin)

export const createAssetChooser = (type: AssetType, deps: ChooserDeps) => {
    // Whatever went wrong reads as a problem with the package, with reading the file (moved or
    // changed since it was picked), or with storing it.
    const describe = (failure: unknown) =>
        deps.describe(
            failure instanceof AssetImportError
                ? failure
                : new AssetImportError(
                      failure instanceof StoreFailed ? 'storeFailed' : 'fileUnreadable',
                      { type },
                  ),
        )

    const open = shallowRef(false)
    const phase = shallowRef<ChooserPhase>('idle')
    const fileName = shallowRef('')
    const items = shallowRef<ListedItem[]>([])
    const selected = shallowRef<string | undefined>()
    const also = shallowRef<AlsoOption[]>([])
    /** Why the picked file could not be listed: shown under Select File…. */
    const error = shallowRef<string | undefined>()
    /** Why Use failed: shown next to Use. */
    const useError = shallowRef<string | undefined>()
    /** Object URLs of the listed items' thumbnails, by item name. */
    const thumbnails = shallowRef<ReadonlyMap<string, string>>(new Map())

    let pkg: SourcePackage | undefined
    let controller = new AbortController()
    let generation = 0
    const otherLists = new Map<AssetType, Promise<ListedItem[]>>()

    const revoke = () => {
        for (const url of thumbnails.value.values()) URL.revokeObjectURL(url)
        thumbnails.value = new Map()
    }

    const reset = () => {
        controller.abort()
        controller = new AbortController()
        generation++
        revoke()
        pkg = undefined
        otherLists.clear()
        phase.value = 'idle'
        fileName.value = ''
        items.value = []
        selected.value = undefined
        also.value = []
        error.value = undefined
        useError.value = undefined
    }

    /** The thumbnails of the first items, as small images checked by their headers. */
    const pictures = (source: SourcePackage, listed: ListedItem[], mine: number) =>
        loadThumbnails(
            listed.map((item) => ({
                key: item.name,
                read: async () => {
                    const path = source.resolve(item.thumbnail)
                    return path
                        ? source.entry(path, { type, part: 'thumbnail', maxSize: LIMITS.thumbnail })
                        : undefined
                },
            })),
            () => mine === generation,
            (name, url) => {
                thumbnails.value = new Map(thumbnails.value).set(name, url)
            },
        )

    /** The other types' items that share the selected item's name. */
    const lookUpAlso = async (name: string, mine: number) => {
        const source = pkg
        if (!source) return
        const found: AlsoOption[] = []
        for (const other of assetTypes) {
            if (other === type) continue
            try {
                let list = otherLists.get(other)
                if (!list) otherLists.set(other, (list = source.list(other, controller.signal)))
                const match = (await list).find((item) => item.name === name)
                if (match) found.push({ type: other, name, title: match.title, ticked: false })
            } catch {
                // A type whose lookup fails offers no checkbox.
            }
        }
        if (mine === generation && selected.value === name) also.value = found
    }

    const select = (name: string) => {
        if (selected.value === name) return
        selected.value = name
        also.value = []
        void lookUpAlso(name, generation)
    }

    /** Reads a package and lists its items of this type. */
    const pick = async (file: Blob, name: string) => {
        reset()
        const mine = generation
        open.value = true
        fileName.value = name
        phase.value = 'reading'
        try {
            const source = await openSourcePackage(file)
            const listed = await source.list(type, controller.signal)
            if (mine !== generation) return
            pkg = source
            items.value = listed
            phase.value = 'listed'
            void pictures(source, listed, mine)
            // With exactly one item, there is nothing to choose.
            if (listed.length === 1 && listed[0]) select(listed[0].name)
        } catch (failure) {
            if (mine !== generation || isAbort(failure)) return
            phase.value = 'idle'
            error.value = describe(failure)
        }
    }

    const toggle = (other: AssetType, ticked: boolean) => {
        also.value = also.value.map((option) =>
            option.type === other ? { ...option, ticked } : option,
        )
    }

    /** Checks, repacks and stores the selected item and every ticked one, then applies them. */
    const use = async () => {
        const source = pkg
        const name = selected.value
        if (!source || name === undefined || phase.value === 'working') return
        const mine = generation
        const { signal } = controller
        const wanted: { type: AssetType; name: string }[] = [
            { type, name },
            ...also.value
                .filter((option) => option.ticked)
                .map((option) => ({ type: option.type, name: option.name })),
        ]
        phase.value = 'working'
        useError.value = undefined
        try {
            const metas = await importAndUse(
                source,
                wanted,
                {
                    origin: fileName.value,
                    signal,
                    isCurrent: () => mine === generation,
                    toChoice: storedChoice,
                },
                deps,
            )
            if (!metas || mine !== generation) return
            reset()
            open.value = false
        } catch (failure) {
            // A cancel or a closed dialog is not a failure.
            if (mine !== generation || isAbort(failure)) return
            phase.value = 'listed'
            useError.value = describe(failure)
            // A refused package is the file's doing, and the message says so; the rest is ours.
            if (!(failure instanceof AssetImportError))
                console.error('Could not store the preview asset:', failure)
        }
    }

    return {
        type,
        open,
        phase,
        fileName,
        items,
        selected,
        also,
        error,
        useError,
        thumbnails,
        /** Opens the chooser with nothing picked. */
        show: () => {
            reset()
            open.value = true
        },
        pick,
        select,
        toggle,
        use,
        /** Closes the chooser and stops what it was doing, keeping the previous choice. */
        cancel: () => {
            reset()
            open.value = false
        },
        dispose: reset,
    }
}

export type AssetChooser = ReturnType<typeof createAssetChooser>
