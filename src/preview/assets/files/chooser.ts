import { shallowRef } from 'vue'
import { assetTypes } from '../choice'
import type { AssetChoice, AssetType } from '../types'
import type { DecodeImage } from './decodeImage'
import { AssetImportError } from './errors'
import { readImageSize } from './image'
import { importItem } from './importer'
import { LIMITS } from './limits'
import { openSourcePackage, type ListedItem, type SourcePackage } from './package'
import type { UserAssetMeta, UserAssetStore } from './store'

// The chooser's From a File view (Part 2, 2.5.2, 2.6) without its markup: pick a package, list the
// items of one type, offer the other types' items of the same name, and on Use check, repack and
// store what was selected and ticked. One chooser per type lives with the dialog, so it keeps its
// state across tabs, and closing the dialog disposes it, which cancels what is running.

export type AlsoOption = {
    type: AssetType
    name: string
    title: string
    ticked: boolean
}

export type ChooserDeps = {
    store: UserAssetStore
    maxTextureSide: () => number
    decodeAudio: (data: ArrayBuffer) => Promise<AudioBuffer>
    decodeImage: DecodeImage
    /** Sets the choices a Use made, all together. */
    apply: (choices: Partial<Record<AssetType, AssetChoice>>) => void
    /** The plain message for a package that is refused. */
    describe: (error: AssetImportError) => string
    now?: () => number
    /** Called after packages were stored, so lists and the footer follow. */
    onStored?: (metas: UserAssetMeta[]) => void
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

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

export const createAssetChooser = (type: AssetType, deps: ChooserDeps) => {
    // Whatever went wrong reads as a problem with the package, or with storing it.
    const describe = (failure: unknown) =>
        deps.describe(
            failure instanceof AssetImportError
                ? failure
                : new AssetImportError('storeFailed', { type }),
        )

    const open = shallowRef(false)
    const phase = shallowRef<ChooserPhase>('idle')
    const fileName = shallowRef('')
    const items = shallowRef<ListedItem[]>([])
    const selected = shallowRef<string | undefined>()
    const also = shallowRef<AlsoOption[]>([])
    const error = shallowRef<string | undefined>()
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
    }

    /** The thumbnails of the first items, as small images checked by their headers. */
    const loadThumbnails = async (source: SourcePackage, listed: ListedItem[], mine: number) => {
        for (const item of listed.slice(0, 50)) {
            if (mine !== generation) return
            try {
                const path = source.resolve(item.thumbnail)
                const bytes = path
                    ? await source.entry(path, {
                          type,
                          part: 'thumbnail',
                          maxSize: LIMITS.thumbnail,
                      })
                    : undefined
                const size = bytes && readImageSize(bytes)
                if (!bytes || !size || size.width > LIMITS.thumbnailSide) continue
                if (size.height > LIMITS.thumbnailSide || mine !== generation) continue
                const url = URL.createObjectURL(
                    new Blob([new Uint8Array(bytes)], {
                        type: size.format === 'jpeg' ? 'image/jpeg' : 'image/png',
                    }),
                )
                thumbnails.value = new Map(thumbnails.value).set(item.name, url)
            } catch {
                // A picture that cannot be read is no picture; Use reports real problems.
            }
        }
    }

    /** The other types' items that share the selected item's name. */
    const lookUpAlso = async (name: string, mine: number) => {
        const source = pkg
        if (!source) return
        const found: AlsoOption[] = []
        for (const other of assetTypes) {
            if (other === type) continue
            try {
                let list = otherLists.get(other)
                if (!list) otherLists.set(other, (list = source.list(other)))
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
            const listed = await source.list(type)
            if (mine !== generation) return
            pkg = source
            items.value = listed
            phase.value = 'listed'
            void loadThumbnails(source, listed, mine)
            // With exactly one item, there is nothing to choose.
            if (listed.length === 1 && listed[0]) select(listed[0].name)
        } catch (failure) {
            if (mine !== generation) return
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
        error.value = undefined
        try {
            const records = []
            for (const entry of wanted)
                records.push(
                    await importItem(source, entry.type, entry.name, {
                        maxTextureSide: deps.maxTextureSide(),
                        decodeAudio: deps.decodeAudio,
                        decodeImage: deps.decodeImage,
                        signal,
                        origin: fileName.value,
                        now: deps.now ?? Date.now,
                    }),
                )
            // Checked all: only now is anything stored, so a bad item stores nothing.
            const metas: UserAssetMeta[] = []
            for (const record of records) {
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
                metas.push(await deps.store.put(record))
            }
            if (mine !== generation) return
            deps.apply(Object.fromEntries(metas.map((meta) => [meta.type, storedChoice(meta)])))
            deps.onStored?.(metas)
            reset()
            open.value = false
        } catch (failure) {
            // A cancel or a closed dialog is not a failure.
            if (mine !== generation || isAbort(failure)) return
            phase.value = 'listed'
            error.value = describe(failure)
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
