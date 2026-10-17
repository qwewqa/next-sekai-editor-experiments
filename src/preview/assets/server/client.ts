import type { ServerFetchInit } from '../../../platform/types'
import { LIMITS } from '../files/limits'
import { displayText, isItemName, isSrl, type Srl } from '../files/package'
import { isLocalHost } from '../serverUrl'
import type { AssetType } from '../types'

// The Sonolus server client (Part 2, 2.5.3; Part 1 §1.5.8), for the apps: plain GETs with no
// credentials and no custom headers. A request fails after 30 s without response headers, 30 s
// without a body byte, or 10 minutes in all (DECISIONS D12), and at most 4 are open at once; the
// user's own requests go before background ones (thumbnails, the other types' lookups).

export type ServerErrorCode =
    /** The device has no network. */
    | 'offline'
    /** No answer, or one that stalled or took too long */
    | 'unreachable'
    /** A 401 */
    | 'auth'
    /** An http address where http is not allowed */
    | 'insecure'
    | 'notFound'
    /** Any other failing status */
    | 'status'
    /** Not what a Sonolus server sends */
    | 'invalid'
    | 'tooBig'

export class ServerError extends Error {
    /** The address of the request that failed, when there was one. */
    readonly url: string | undefined
    constructor(
        readonly code: ServerErrorCode,
        readonly status?: number,
        options?: ErrorOptions & { url?: string },
    ) {
        super(status === undefined ? code : `${code} (${status})`, options)
        this.name = 'ServerError'
        this.url = options?.url
    }
}

export const serverCategoryOf = {
    skin: 'skins',
    particle: 'particles',
    background: 'backgrounds',
    effect: 'effects',
} as const satisfies Record<AssetType, string>

export type ServerFetch = (url: string, init?: ServerFetchInit) => Promise<Response>

export type ServerClientOptions = {
    fetch: ServerFetch
    /** The language of the editor's interface, for `localization=`. */
    language: () => string
    /** Whether the device is online; `navigator.onLine` by default. */
    isOnline?: () => boolean
    /** Plain http, for the apps' local servers. */
    allowHttp?: boolean
    /** Thumbnails on this device or its network, with the apps' local servers allowed. */
    allowLocal?: boolean
    /** How long a request may wait for its headers, or for its body's next byte */
    timeoutMs?: number
    /** How long a request may take in all */
    totalTimeoutMs?: number
    concurrency?: number
}

/** A background request waits behind every request the user made. */
export type RequestPriority = 'user' | 'background'

/** One item of a server's list. */
export type ServerListItem = {
    name: string
    title: string
    author: string
    /** The thumbnail's address, when it has one that can be shown */
    thumbnail: string | undefined
}

export type ServerPage = {
    items: ServerListItem[]
    /** What follows: the next `page`, or the `cursor` to send; undefined at the end. */
    next: { page: number } | { cursor: string } | undefined
}

export type ServerInfo = {
    /** The server address, from the final URL of the info request */
    address: string
    title: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
const abortError = () => new DOMException('Aborted', 'AbortError')

/** Settles with the promise, or rejects as soon as the signal aborts. */
const raced = <T>(promise: Promise<T>, signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(abortError())
        }
        if (signal.aborted) onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort)
        })
    })

export const createServerClient = (options: ServerClientOptions) => {
    const {
        language,
        allowHttp = false,
        allowLocal = false,
        timeoutMs = 30_000,
        totalTimeoutMs = 600_000,
        concurrency = 4,
    } = options
    const isOnline =
        options.isOnline ??
        // Node's `navigator` has no `onLine`.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
        (() => typeof navigator === 'undefined' || navigator.onLine !== false)

    // At most `concurrency` requests at once. A slot that frees goes straight to the next waiter,
    // the user's first, so no turn is lost.
    let active = 0
    const waiting: Record<RequestPriority, (() => void)[]> = { user: [], background: [] }
    const acquire = (signal: AbortSignal | undefined, priority: RequestPriority) =>
        new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
                reject(abortError())
                return
            }
            if (active < concurrency) {
                active++
                resolve()
                return
            }
            const queue = waiting[priority]
            const wake = () => {
                signal?.removeEventListener('abort', onAbort)
                active++
                resolve()
            }
            const onAbort = () => {
                queue.splice(queue.indexOf(wake), 1)
                reject(abortError())
            }
            queue.push(wake)
            signal?.addEventListener('abort', onAbort, { once: true })
        })
    const release = () => {
        active--
        const next = waiting.user.shift() ?? waiting.background.shift()
        next?.()
    }

    /** Reads a body, stopping once it passes the cap; each chunk is progress. */
    const readBody = async (
        response: Response,
        maxBytes: number,
        signal: AbortSignal,
        progress: () => void,
    ) => {
        const declared = Number(response.headers.get('content-length'))
        if (declared > maxBytes) throw new ServerError('tooBig')
        const reader = response.body?.getReader()
        if (!reader) {
            const bytes = new Uint8Array(await raced(response.arrayBuffer(), signal))
            if (bytes.length > maxBytes) throw new ServerError('tooBig')
            return bytes
        }
        const chunks: Uint8Array[] = []
        let size = 0
        try {
            for (;;) {
                const { done, value } = await raced(reader.read(), signal)
                if (done) break
                progress()
                size += value.length
                if (size > maxBytes) throw new ServerError('tooBig')
                chunks.push(value)
            }
        } catch (error) {
            void reader.cancel().catch(() => undefined)
            throw error
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.length
        }
        return bytes
    }

    /** One GET: the answer's final address and its body, or the reason it failed. */
    const get = async (
        url: string,
        maxBytes: number,
        outer?: AbortSignal,
        priority: RequestPriority = 'user',
    ) => {
        if (/^http:/i.test(url) && !allowHttp) throw new ServerError('insecure', undefined, { url })
        if (!isOnline()) throw new ServerError('offline', undefined, { url })
        await acquire(outer, priority)
        const controller = new AbortController()
        let timedOut = false
        // A function, so TypeScript does not keep `false` across the awaits.
        const hasTimedOut = () => timedOut
        const expire = () => {
            timedOut = true
            controller.abort()
        }
        let stall = setTimeout(expire, timeoutMs)
        const total = setTimeout(expire, totalTimeoutMs)
        const progress = () => {
            clearTimeout(stall)
            stall = setTimeout(expire, timeoutMs)
        }
        const abort = () => {
            controller.abort()
        }
        outer?.addEventListener('abort', abort, { once: true })
        // It may have been aborted while the request waited for its turn.
        if (outer?.aborted) controller.abort()
        const failure = (code: ServerErrorCode, cause?: unknown) =>
            new ServerError(code, undefined, { url, cause })
        try {
            let response: Response
            try {
                response = await raced(
                    options.fetch(url, {
                        method: 'GET',
                        credentials: 'omit',
                        referrerPolicy: 'no-referrer',
                        signal: controller.signal,
                    }),
                    controller.signal,
                )
            } catch (error) {
                if (outer?.aborted) throw abortError()
                if (hasTimedOut()) throw failure('unreachable', error)
                if (isAbort(error)) throw error
                throw failure(isOnline() ? 'unreachable' : 'offline', error)
            }
            progress()
            if (response.status === 401) throw new ServerError('auth', 401, { url })
            if (response.status === 404) throw new ServerError('notFound', 404, { url })
            if (!response.ok) throw new ServerError('status', response.status, { url })
            try {
                return {
                    url: response.url || url,
                    bytes: await readBody(response, maxBytes, controller.signal, progress),
                }
            } catch (error) {
                if (outer?.aborted) throw abortError()
                if (error instanceof ServerError && error.code === 'tooBig') throw failure('tooBig')
                // A body that broke off on the way, stalled, or never finished.
                throw failure(isOnline() || hasTimedOut() ? 'unreachable' : 'offline', error)
            }
        } finally {
            clearTimeout(stall)
            clearTimeout(total)
            outer?.removeEventListener('abort', abort)
            release()
        }
    }

    const getJson = async (url: string, signal?: AbortSignal, priority?: RequestPriority) => {
        const { url: finalUrl, bytes } = await get(url, LIMITS.json, signal, priority)
        try {
            return { url: finalUrl, json: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
        } catch (error) {
            throw new ServerError('invalid', undefined, { cause: error, url })
        }
    }

    /** Joins an SRL's url to the server address; only https (or http, if allowed) is used. */
    const resolveUrl = (address: string, url: string | null | undefined) => {
        if (!url) return
        let full: string
        if (url.startsWith('/')) {
            if (url.startsWith('//')) return
            full = address + url
        } else full = url
        try {
            const parsed = new URL(full)
            if (parsed.username || parsed.password) return
            if (parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:'))
                return parsed.href
        } catch {
            // Not an address.
        }
        return
    }

    /** A thumbnail's address; one on this device or its network is not fetched (D11). */
    const thumbnailUrl = (address: string, url: string | null | undefined) => {
        const resolved = resolveUrl(address, url)
        if (!resolved || (!allowLocal && isLocalHost(new URL(resolved).hostname))) return
        return resolved
    }

    const listItem = (address: string, raw: unknown): ServerListItem | undefined => {
        if (!isRecord(raw) || !isItemName(raw.name)) return
        const thumbnail: Srl = isSrl(raw.thumbnail) ? raw.thumbnail : undefined
        return {
            name: raw.name,
            title: displayText(raw.title) || raw.name,
            author: displayText(raw.author),
            thumbnail: thumbnailUrl(address, thumbnail?.url),
        }
    }

    const itemUrl = (address: string, type: AssetType, name?: string) =>
        `${address}/sonolus/${serverCategoryOf[type]}/${name === undefined ? 'list' : encodeURIComponent(name)}`

    return {
        resolveUrl,
        listItem,

        /** `GET {base}/sonolus/info`; the server address is the final URL's, after redirects. */
        connect: async (base: string, signal?: AbortSignal): Promise<ServerInfo> => {
            const { url, json } = await getJson(`${base}/sonolus/info`, signal)
            if (!isRecord(json) || typeof json.title !== 'string') throw new ServerError('invalid')
            let address = base
            try {
                const final = new URL(url)
                const match = /^(.*)\/sonolus\/info\/?$/.exec(final.pathname)
                if (match) address = final.origin + (match[1] ?? '')
            } catch {
                // Keep the address that was asked.
            }
            return { address, title: displayText(json.title) }
        },

        /** One page of a type's list, by page or cursor; `keywords` is a quick search. */
        list: async (
            address: string,
            type: AssetType,
            query: { page?: number; cursor?: string; keywords?: string } = {},
            signal?: AbortSignal,
        ): Promise<ServerPage> => {
            const params = new URLSearchParams({ localization: language() })
            if (query.keywords !== undefined) {
                params.set('type', 'quick')
                params.set('keywords', query.keywords)
            }
            if (query.cursor !== undefined) params.set('cursor', query.cursor)
            else params.set('page', String(query.page ?? 0))
            let json: unknown
            try {
                json = (await getJson(`${itemUrl(address, type)}?${params}`, signal)).json
            } catch (error) {
                // A server with no list of this type has no items of it.
                if (error instanceof ServerError && error.code === 'notFound')
                    return { items: [], next: undefined }
                throw error
            }
            if (!isRecord(json) || !Array.isArray(json.items) || typeof json.pageCount !== 'number')
                throw new ServerError('invalid')
            const items = (json.items as unknown[])
                .slice(0, LIMITS.listed)
                .map((raw) => listItem(address, raw))
                .filter((item): item is ServerListItem => item !== undefined)
            const { pageCount } = json
            const page = query.page ?? 0
            let next: ServerPage['next']
            if (pageCount < 0) {
                // Cursor-based: the server hands out the next cursor until it has none.
                if (
                    typeof json.cursor === 'string' &&
                    json.cursor !== '' &&
                    json.cursor !== query.cursor
                )
                    next = { cursor: json.cursor }
            } else if (query.cursor === undefined && page + 1 < pageCount) next = { page: page + 1 }
            return { items, next }
        },

        /** An item's details (the `item` object) from `GET {base}/sonolus/{type}s/{name}`. */
        details: async (
            address: string,
            type: AssetType,
            name: string,
            signal?: AbortSignal,
            priority?: RequestPriority,
        ): Promise<Record<string, unknown>> => {
            const params = new URLSearchParams({ localization: language() })
            const { json } = await getJson(
                `${itemUrl(address, type, name)}?${params}`,
                signal,
                priority,
            )
            if (!isRecord(json) || !isRecord(json.item)) throw new ServerError('invalid')
            return json.item
        },

        /** A resource's bytes, up to a cap. */
        resource: async (url: string, maxBytes: number, signal?: AbortSignal) =>
            (await get(url, maxBytes, signal)).bytes,

        /** A listed item's thumbnail, behind the user's own requests. */
        thumbnail: async (url: string, signal?: AbortSignal) =>
            (await get(url, LIMITS.thumbnail, signal, 'background')).bytes,
    }
}

export type ServerClient = ReturnType<typeof createServerClient>
