import { shallowRef } from 'vue'
import { assetTypes } from '../choice'
import type { AlsoOption } from '../files/chooser'
import type { DecodeImage } from '../files/decodeImage'
import { AssetImportError } from '../files/errors'
import { importItem } from '../files/importer'
import { displayText } from '../files/package'
import type { UserAssetMeta, UserAssetRecord, UserAssetStore } from '../files/store'
import { rollBack, storeRecords } from '../files/storeRecords'
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

// The chooser's From a Server view (Part 2, 2.5.3, 2.6) without its markup: connect, list one
// type's items with paging and quick search, offer the other types' items of the same name, and
// on Use download, check, repack and store what was selected and ticked. One per type lives with
// the dialog, beside the From a File chooser, so a tab keeps its state while another shows.

export type ServerChooserError =
    | { kind: 'address'; code: ServerUrlErrorCode }
    | { kind: 'server'; code: ServerErrorCode; status?: number }
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
    onStored?: (metas: UserAssetMeta[]) => void
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

    /** The connected server's address, after redirects. */
    let server = ''
    let next: ServerPage['next']
    let controller = new AbortController()
    let generation = 0
    // The newest page or search; an older answer is dropped.
    let operation = 0
    let operationController = new AbortController()
    const lookups = new Map<string, Promise<string>>()

    const reset = () => {
        controller.abort()
        operationController.abort()
        controller = new AbortController()
        operationController = new AbortController()
        generation++
        operation++
        server = ''
        next = undefined
        lookups.clear()
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

    const toError = (failure: unknown): ServerChooserError => {
        if (failure instanceof ServerError)
            return { kind: 'server', code: failure.code, status: failure.status }
        if (failure instanceof ServerUrlError) return { kind: 'address', code: failure.code }
        if (failure instanceof AssetImportError)
            return { kind: 'item', message: deps.describe(failure) }
        console.error('Could not use the server item:', failure)
        return {
            kind: 'item',
            message: deps.describe(new AssetImportError('storeFailed', { type })),
        }
    }

    /** The other types' items of the same name. */
    const lookUpAlso = async (name: string, mine: number) => {
        const { signal } = controller
        const found: AlsoOption[] = []
        await Promise.all(
            assetTypes
                .filter((other) => other !== type)
                .map(async (other) => {
                    const key = `${other}:${name}`
                    let lookup = lookups.get(key)
                    if (!lookup) {
                        lookup = client
                            .details(server, other, name, signal)
                            .then((raw) => displayText(raw.title) || name)
                        lookups.set(key, lookup)
                    }
                    try {
                        found.push({ type: other, name, title: await lookup, ticked: false })
                    } catch {
                        // A lookup that fails or finds nothing offers no checkbox.
                    }
                }),
        )
        if (mine !== generation || selected.value !== name) return
        also.value = assetTypes.flatMap((other) => found.filter((option) => option.type === other))
    }

    const select = (name: string) => {
        if (selected.value === name) return
        selected.value = name
        also.value = []
        void lookUpAlso(name, generation)
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
            const loaded = append
                ? [
                      ...items.value,
                      ...page.items.filter(
                          (item) => !items.value.some((held) => held.name === item.name),
                      ),
                  ]
                : page.items
            items.value = loaded
            next = page.next
            hasMore.value = !!next
            // A selection that a new search dropped is gone with it.
            if (
                selected.value !== undefined &&
                !loaded.some((item) => item.name === selected.value)
            ) {
                selected.value = undefined
                also.value = []
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
        try {
            const source = createServerSource(client, server, signal)
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
            const { metas, added } = await storeRecords(deps.store, records)
            // Closed or cancelled while storing: what this Use added goes again.
            if (mine !== generation) {
                await rollBack(deps.store, added)
                return
            }
            deps.apply(Object.fromEntries(metas.map((meta) => [meta.type, deps.toChoice(meta)])))
            deps.onStored?.(metas)
            reset()
            deps.close()
        } catch (failure) {
            if (mine !== generation || isAbort(failure)) return
            phase.value = 'listed'
            useError.value = toError(failure)
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
