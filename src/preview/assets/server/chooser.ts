import { shallowRef } from 'vue'
import { assetTypes } from '../choice'
import type { AlsoOption } from '../files/chooser'
import type { DecodeImage } from '../files/decodeImage'
import { AssetImportError } from '../files/errors'
import { readImageSize } from '../files/image'
import { importItem } from '../files/importer'
import { LIMITS } from '../files/limits'
import { displayText } from '../files/package'
import type { UserAssetMeta, UserAssetRecord, UserAssetStore } from '../files/store'
import { storeRecords } from '../files/storeRecords'
import {
    parseServerUrl,
    ServerUrlError,
    type ServerCategory,
    type ServerUrlErrorCode,
} from '../serverUrl'
import type { AssetChoice, AssetType } from '../types'
import {
    serverCategoryOf,
    ServerError,
    type ServerClient,
    type ServerErrorCode,
    type ServerListItem,
    type ServerPage,
} from './client'
import { createServerSource } from './source'

// The chooser's From a Server view, in the apps, without its markup: connect,
// list one type's items with paging and quick search, offer the other types' items of the same
// name, and on Use download, check, repack and store what was selected and ticked. One per type
// lives with the dialog, beside the From a File chooser, so a tab keeps its state while another
// shows. Thumbnails are fetched like the rest and shown as object URLs.

export type ServerChooserError =
    | { kind: 'address'; code: ServerUrlErrorCode }
    /** `host`: the failing request was to another host than the server's (its files' CDN). */
    | { kind: 'server'; code: ServerErrorCode; status?: number; host?: string }
    /** A problem with the item itself, already worded. */
    | { kind: 'item'; message: string }

export type ServerChooserDeps = {
    client: ServerClient
    store: UserAssetStore
    maxTextureSide: () => number
    decodeAudio: (data: ArrayBuffer) => Promise<AudioBuffer>
    decodeImage: DecodeImage
    /** Sets the choices a Use made, all together. */
    apply: (choices: Partial<Record<AssetType, AssetChoice>>) => void
    /** The plain message for an item that is refused. */
    describe: (error: AssetImportError) => string
    /** The choice a stored package becomes. */
    toChoice: (meta: UserAssetMeta) => AssetChoice
    /** The servers connected to, newest first. */
    recent: () => string[]
    /** Notes a server as connected to. */
    remember: (address: string) => void
    /** Closes the chooser once Use has finished. */
    close: () => void
    /** A share link to an item of another type: that type's chooser takes it. */
    handOver?: (type: AssetType, input: string) => void
    /** Plain http, for the apps' local servers. */
    allowHttp?: boolean
    now?: () => number
    onStorageChanged?: () => void
    /** Object URLs for the thumbnails; `URL`'s by default. */
    objectUrls?: { create: (blob: Blob) => string; revoke: (url: string) => void }
}

export type ServerPhase = 'idle' | 'connecting' | 'listed' | 'working'

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

const typeOfCategory = (category: ServerCategory): AssetType => {
    const found = assetTypes.find((type) => serverCategoryOf[type] === category)
    if (!found) throw new Error(`No type for ${category}`)
    return found
}

export const createServerChooser = (type: AssetType, deps: ServerChooserDeps) => {
    const { client } = deps

    /** Which of the two views the chooser shows; it starts with a file. */
    const mode = shallowRef<'file' | 'server'>('file')
    const address = shallowRef('')
    const phase = shallowRef<ServerPhase>('idle')
    /** A page or a search is loading. */
    const loading = shallowRef(false)
    const title = shallowRef('')
    const items = shallowRef<ServerListItem[]>([])
    const hasMore = shallowRef(false)
    const query = shallowRef('')
    const selected = shallowRef<string | undefined>()
    const also = shallowRef<AlsoOption[]>([])
    /** Why connecting or listing failed: shown under the address. */
    const error = shallowRef<ServerChooserError | undefined>()
    /** Why Use failed: shown next to Use. */
    const useError = shallowRef<ServerChooserError | undefined>()
    /** Object URLs of the listed items' thumbnails, by item name. */
    const thumbnails = shallowRef<ReadonlyMap<string, string>>(new Map())
    const objectUrls = deps.objectUrls ?? {
        create: (blob: Blob) => URL.createObjectURL(blob),
        revoke: (url: string) => {
            URL.revokeObjectURL(url)
        },
    }

    /** The connected server's address, after redirects. */
    let server = ''
    let next: ServerPage['next']
    let controller = new AbortController()
    let generation = 0
    // The newest page or search; an older answer is dropped.
    let operation = 0
    let operationController = new AbortController()
    // The other types' lookups of the selected row; a new selection stops them.
    let lookupController = new AbortController()
    // The thumbnails of what is listed; a new list stops them.
    let thumbnailController = new AbortController()
    /** Details found by the lookups while connected, by `type:name`; Use starts from them. */
    const found = new Map<string, Record<string, unknown>>()
    /** Lookups that found nothing, so a row is not asked about twice. */
    const missing = new Set<string>()

    const dropThumbnails = () => {
        thumbnailController.abort()
        thumbnailController = new AbortController()
        for (const url of thumbnails.value.values()) objectUrls.revoke(url)
        thumbnails.value = new Map()
    }

    /** Fetches the thumbnails of items that have none yet, behind the user's own requests. */
    const loadThumbnails = (listed: ServerListItem[]) => {
        const { signal } = thumbnailController
        for (const item of listed) {
            const url = item.thumbnail
            if (!url || thumbnails.value.has(item.name)) continue
            void client.thumbnail(url, signal).then(
                (bytes) => {
                    const size = readImageSize(bytes)
                    if (signal.aborted || !size || thumbnails.value.has(item.name)) return
                    if (size.width > LIMITS.thumbnailSide || size.height > LIMITS.thumbnailSide)
                        return
                    const mime = size.format === 'jpeg' ? 'image/jpeg' : 'image/png'
                    const objectUrl = objectUrls.create(
                        new Blob([new Uint8Array(bytes)], { type: mime }),
                    )
                    thumbnails.value = new Map(thumbnails.value).set(item.name, objectUrl)
                },
                () => {
                    // A picture that cannot be fetched is the type's glyph.
                },
            )
        }
    }

    const reset = () => {
        controller.abort()
        operationController.abort()
        lookupController.abort()
        controller = new AbortController()
        operationController = new AbortController()
        lookupController = new AbortController()
        dropThumbnails()
        generation++
        operation++
        server = ''
        next = undefined
        found.clear()
        missing.clear()
        phase.value = 'idle'
        loading.value = false
        title.value = ''
        items.value = []
        hasMore.value = false
        query.value = ''
        selected.value = undefined
        also.value = []
        error.value = undefined
        useError.value = undefined
    }

    const hostOf = (url: string | undefined) => {
        try {
            return url === undefined ? undefined : new URL(url).host
        } catch {
            return
        }
    }

    const toError = (failure: unknown): ServerChooserError => {
        if (failure instanceof ServerError) {
            const host = hostOf(failure.url)
            return {
                kind: 'server',
                code: failure.code,
                status: failure.status,
                ...(server !== '' && host !== undefined && host !== hostOf(server) ? { host } : {}),
            }
        }
        if (failure instanceof ServerUrlError) return { kind: 'address', code: failure.code }
        if (failure instanceof AssetImportError)
            return { kind: 'item', message: deps.describe(failure) }
        console.error('Could not use the server item:', failure)
        return {
            kind: 'item',
            message: deps.describe(new AssetImportError('storeFailed', { type })),
        }
    }

    /** The other types' items of the same name, in the background; stopped with the selection. */
    const lookUpAlso = async (name: string, mine: number, signal: AbortSignal) => {
        const options: AlsoOption[] = []
        await Promise.all(
            assetTypes
                .filter((other) => other !== type)
                .map(async (other) => {
                    const key = `${other}:${name}`
                    if (missing.has(key)) return
                    let details = found.get(key)
                    if (!details) {
                        try {
                            details = await client.details(
                                server,
                                other,
                                name,
                                signal,
                                'background',
                            )
                        } catch (failure) {
                            // A lookup that fails or finds nothing offers no checkbox; one that
                            // was stopped is asked again when the row is selected again.
                            if (!isAbort(failure) && !signal.aborted) missing.add(key)
                            return
                        }
                        found.set(key, details)
                    }
                    options.push({
                        type: other,
                        name,
                        title: displayText(details.title) || name,
                        ticked: false,
                    })
                }),
        )
        if (mine !== generation || selected.value !== name || signal.aborted) return
        also.value = assetTypes.flatMap((other) =>
            options.filter((option) => option.type === other),
        )
    }

    const select = (name: string) => {
        if (selected.value === name) return
        selected.value = name
        also.value = []
        lookupController.abort()
        lookupController = new AbortController()
        void lookUpAlso(name, generation, lookupController.signal)
    }

    const connect = async () => {
        let parsed
        try {
            parsed = parseServerUrl(address.value, { allowHttp: deps.allowHttp })
        } catch (failure) {
            reset()
            error.value = toError(failure)
            return
        }
        const linkType = parsed.item ? typeOfCategory(parsed.item.category) : undefined
        if (linkType && linkType !== type && deps.handOver) {
            // The link is to another type's item: that tab's chooser connects with it.
            deps.handOver(linkType, address.value)
            return
        }
        reset()
        const mine = generation
        const { signal } = controller
        phase.value = 'connecting'
        try {
            const info = await client.connect(parsed.base, signal)
            if (mine !== generation) return
            deps.remember(info.address)
            const page = await client.list(info.address, type, { page: 0 }, signal)
            if (mine !== generation) return
            // A share link to an item of this type puts it first and selected.
            let linked: ServerListItem | undefined
            let linkError: ServerChooserError | undefined
            if (parsed.item && linkType === type) {
                try {
                    const raw = await client.details(info.address, type, parsed.item.name, signal)
                    if (mine !== generation) return
                    linked = client.listItem(info.address, raw)
                    // Details with no usable name are no item this chooser can take.
                    if (!linked) linkError = { kind: 'server', code: 'notFound' }
                } catch (failure) {
                    if (mine !== generation || isAbort(failure)) return
                    linkError = toError(failure)
                }
            }
            server = info.address
            address.value = info.address
            title.value = info.title
            items.value = linked
                ? [linked, ...page.items.filter((item) => item.name !== linked.name)]
                : page.items
            next = page.next
            hasMore.value = !!next
            error.value = linkError
            phase.value = 'listed'
            loadThumbnails(items.value)
            // With exactly one item, there is nothing to choose.
            if (linked) select(linked.name)
            else if (items.value.length === 1 && items.value[0]) select(items.value[0].name)
        } catch (failure) {
            if (mine !== generation || isAbort(failure)) return
            phase.value = 'idle'
            // An address with no `/sonolus/info` is not a Sonolus server.
            error.value =
                failure instanceof ServerError && failure.code === 'notFound'
                    ? { kind: 'server', code: 'invalid' }
                    : toError(failure)
        }
    }

    /** Asks for a page, or a search's first page; the newest ask wins. */
    const load = async (
        request: { cursor: string } | { page: number },
        keywords: string | undefined,
        append: boolean,
    ) => {
        if (phase.value !== 'listed') return
        operationController.abort()
        operationController = new AbortController()
        const mine = ++operation
        const mineGeneration = generation
        // `reset` aborts this one too, so it stands for both.
        const { signal } = operationController
        loading.value = true
        error.value = undefined
        try {
            const page = await client.list(server, type, { ...request, keywords }, signal)
            if (mine !== operation || mineGeneration !== generation) return
            const held = new Set(items.value.map((item) => item.name))
            // At most as many as a file lists: More stops there.
            const loaded = append
                ? [...items.value, ...page.items.filter((item) => !held.has(item.name))].slice(
                      0,
                      LIMITS.listed,
                  )
                : page.items
            if (!append) dropThumbnails()
            items.value = loaded
            next = loaded.length < LIMITS.listed ? page.next : undefined
            hasMore.value = !!next
            loadThumbnails(loaded)
            // A selection that a new search dropped is gone with it.
            if (
                selected.value !== undefined &&
                !loaded.some((item) => item.name === selected.value)
            ) {
                selected.value = undefined
                also.value = []
                lookupController.abort()
            }
        } catch (failure) {
            if (mine !== operation || mineGeneration !== generation || isAbort(failure)) return
            error.value = toError(failure)
        } finally {
            if (mine === operation) loading.value = false
        }
    }

    /** A quick search; an empty text lists everything again. */
    const search = async (text: string) => {
        const keywords = text.trim()
        query.value = text
        await load({ page: 0 }, keywords === '' ? undefined : keywords, false)
    }

    const more = async () => {
        if (!next || loading.value) return
        const keywords = query.value.trim()
        await load(next, keywords === '' ? undefined : keywords, true)
    }

    const toggle = (other: AssetType, ticked: boolean) => {
        also.value = also.value.map((option) =>
            option.type === other ? { ...option, ticked } : option,
        )
    }

    /** Downloads, checks, repacks and stores the selected item and every ticked one, then applies them. */
    const use = async () => {
        const name = selected.value
        if (name === undefined || phase.value !== 'listed') return
        const mine = generation
        const { signal } = controller
        const wanted = [
            { type, name },
            ...also.value
                .filter((option) => option.ticked)
                .map((option) => ({ type: option.type, name: option.name })),
        ]
        phase.value = 'working'
        useError.value = undefined
        // The checkboxes are settled: lookups still under way would only hold up Use.
        lookupController.abort()
        let storageAttempted = false
        try {
            // What the lookups already fetched is not asked for again.
            const seed = wanted.flatMap(({ type: wantedType, name: wantedName }) => {
                const details = found.get(`${wantedType}:${wantedName}`)
                return details ? [[wantedType, wantedName, details] as const] : []
            })
            const source = createServerSource(client, server, signal, seed)
            const records: UserAssetRecord[] = []
            for (const entry of wanted)
                records.push(
                    await importItem(source, entry.type, entry.name, {
                        maxTextureSide: deps.maxTextureSide(),
                        decodeAudio: deps.decodeAudio,
                        decodeImage: deps.decodeImage,
                        signal,
                        origin: server,
                        now: deps.now ?? Date.now,
                    }),
                )
            // Checked all: only now is anything stored, all in one transaction and read back, so a
            // bad item stores nothing.
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
            storageAttempted = true
            const { metas } = await storeRecords(deps.store, records)
            if (mine !== generation) return
            deps.apply(Object.fromEntries(metas.map((meta) => [meta.type, deps.toChoice(meta)])))
            if (mine !== generation) return
            reset()
            deps.close()
        } catch (failure) {
            if (mine !== generation || isAbort(failure)) return
            phase.value = 'listed'
            useError.value = toError(failure)
        } finally {
            if (storageAttempted) deps.onStorageChanged?.()
        }
    }

    return {
        type,
        mode,
        address,
        phase,
        loading,
        title,
        items,
        hasMore,
        query,
        selected,
        also,
        error,
        useError,
        thumbnails,
        /** Switches between the two views. */
        setMode: (value: 'file' | 'server') => {
            mode.value = value
        },
        /** Fills an empty field with the last server connected to. */
        prefill: () => {
            if (address.value === '' && phase.value === 'idle')
                address.value = deps.recent()[0] ?? ''
        },
        /** Takes a link another chooser handed over and connects with it. */
        connectTo: async (input: string) => {
            mode.value = 'server'
            address.value = input
            await connect()
        },
        connect,
        search,
        more,
        select,
        toggle,
        use,
        /** Stops what the chooser was doing and forgets the connection. */
        cancel: reset,
        dispose: reset,
    }
}

export type ServerChooser = ReturnType<typeof createServerChooser>
