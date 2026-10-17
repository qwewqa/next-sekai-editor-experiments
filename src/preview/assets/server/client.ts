import type { ServerFetchInit } from '../../../platform/types'
import { LIMITS } from '../files/limits'
import { displayText, isItemName, isSrl, type Srl } from '../files/package'
import type { AssetType } from '../types'

// The Sonolus server client (Part 2, 2.5.3; Part 1 §1.5.8): plain GETs with no credentials and no
// custom headers, so a browser sends no preflight. A request times out after 30 s, and at most 4
// are open at once. A failed web fetch is told apart by repeating it once with `no-cors`.

export type ServerErrorCode =
    /** The device has no network. */
    | 'offline'
    /** Reachable, but the server sends no CORS headers. */
    | 'blocked'
    | 'unreachable'
    /** A 401 */
    | 'auth'
    /** An http address on the web */
    | 'insecure'
    | 'notFound'
    /** Any other failing status */
    | 'status'
    /** Not what a Sonolus server sends */
    | 'invalid'
    | 'tooBig'

export class ServerError extends Error {
    constructor(
        readonly code: ServerErrorCode,
        readonly status?: number,
        options?: ErrorOptions,
    ) {
        super(status === undefined ? code : `${code} (${status})`, options)
        this.name = 'ServerError'
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
    /** Repeat a failed fetch as `no-cors` to tell a blocked page from an unreachable server. */
    corsProbe?: boolean
    /** Plain http, for the apps' local servers. */
    allowHttp?: boolean
    timeoutMs?: number
    concurrency?: number
}

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

export const createServerClient = (options: ServerClientOptions) => {
    const {
        language,
        corsProbe = true,
        allowHttp = false,
        timeoutMs = 30_000,
        concurrency = 4,
    } = options
    const isOnline =
        options.isOnline ??
        // Node's `navigator` has no `onLine`.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
        (() => typeof navigator === 'undefined' || navigator.onLine !== false)

    // At most `concurrency` requests at once; the rest wait their turn.
    let active = 0
    const waiting: (() => void)[] = []
    const acquire = async (signal: AbortSignal | undefined) => {
        while (active >= concurrency) {
            await new Promise<void>((resolve, reject) => {
                const wake = () => {
                    signal?.removeEventListener('abort', onAbort)
                    resolve()
                }
                const onAbort = () => {
                    waiting.splice(waiting.indexOf(wake), 1)
                    reject(new DOMException('Aborted', 'AbortError'))
                }
                waiting.push(wake)
                signal?.addEventListener('abort', onAbort, { once: true })
            })
        }
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        active++
    }
    const release = () => {
        active--
        waiting.shift()?.()
    }

    /** What went wrong with a fetch that threw: no network, a blocked page, or no answer. */
    const classify = async (url: string, signal: AbortSignal | undefined) => {
        if (!isOnline()) return new ServerError('offline')
        if (!corsProbe) return new ServerError('unreachable')
        const probe = new AbortController()
        const stop = () => {
            probe.abort()
        }
        signal?.addEventListener('abort', stop, { once: true })
        try {
            await options.fetch(url, {
                method: 'GET',
                mode: 'no-cors',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                signal: probe.signal,
            })
            // An opaque answer: the server is there, and the browser will not show it to a page.
            return new ServerError('blocked')
        } catch {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
            return new ServerError('unreachable')
        } finally {
            signal?.removeEventListener('abort', stop)
            probe.abort()
        }
    }

    /** Reads a body, stopping once it passes the cap. */
    const readBody = async (response: Response, maxBytes: number) => {
        const declared = Number(response.headers.get('content-length'))
        if (declared > maxBytes) throw new ServerError('tooBig')
        const reader = response.body?.getReader()
        if (!reader) {
            const bytes = new Uint8Array(await response.arrayBuffer())
            if (bytes.length > maxBytes) throw new ServerError('tooBig')
            return bytes
        }
        const chunks: Uint8Array[] = []
        let size = 0
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            if (size > maxBytes) {
                void reader.cancel().catch(() => undefined)
                throw new ServerError('tooBig')
            }
            chunks.push(value)
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
    const get = async (url: string, maxBytes: number, outer?: AbortSignal) => {
        if (/^http:/i.test(url) && !allowHttp) throw new ServerError('insecure')
        if (!isOnline()) throw new ServerError('offline')
        await acquire(outer)
        const controller = new AbortController()
        let timedOut = false
        // A function, so TypeScript does not keep `false` across the awaits.
        const hasTimedOut = () => timedOut
        const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
        }, timeoutMs)
        const abort = () => {
            controller.abort()
        }
        outer?.addEventListener('abort', abort, { once: true })
        // It may have been aborted while the request waited for its turn.
        if (outer?.aborted) controller.abort()
        try {
            let response: Response
            try {
                response = await options.fetch(url, {
                    method: 'GET',
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer',
                    signal: controller.signal,
                })
            } catch (error) {
                if (outer?.aborted) throw new DOMException('Aborted', 'AbortError')
                if (hasTimedOut()) throw new ServerError('unreachable', undefined, { cause: error })
                if (isAbort(error)) throw error
                throw await classify(url, outer)
            }
            if (response.status === 401) throw new ServerError('auth', 401)
            if (response.status === 404) throw new ServerError('notFound', 404)
            if (!response.ok) throw new ServerError('status', response.status)
            try {
                return { url: response.url || url, bytes: await readBody(response, maxBytes) }
            } catch (error) {
                if (outer?.aborted) throw new DOMException('Aborted', 'AbortError')
                if (error instanceof ServerError && error.code === 'tooBig') throw error
                // A body that broke off on the way, or never finished.
                throw new ServerError('unreachable', undefined, { cause: error })
            }
        } finally {
            clearTimeout(timer)
            outer?.removeEventListener('abort', abort)
            release()
        }
    }

    const getJson = async (url: string, signal?: AbortSignal) => {
        const { url: finalUrl, bytes } = await get(url, LIMITS.json, signal)
        try {
            return { url: finalUrl, json: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
        } catch (error) {
            throw new ServerError('invalid', undefined, { cause: error })
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

    const listItem = (address: string, raw: unknown): ServerListItem | undefined => {
        if (!isRecord(raw) || !isItemName(raw.name)) return
        const thumbnail: Srl = isSrl(raw.thumbnail) ? raw.thumbnail : undefined
        return {
            name: raw.name,
            title: displayText(raw.title) || raw.name,
            author: displayText(raw.author),
            thumbnail: resolveUrl(address, thumbnail?.url),
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
        ): Promise<Record<string, unknown>> => {
            const params = new URLSearchParams({ localization: language() })
            const { json } = await getJson(`${itemUrl(address, type, name)}?${params}`, signal)
            if (!isRecord(json) || !isRecord(json.item)) throw new ServerError('invalid')
            return json.item
        },

        /** A resource's bytes, up to a cap. */
        resource: async (url: string, maxBytes: number, signal?: AbortSignal) =>
            (await get(url, maxBytes, signal)).bytes,
    }
}

export type ServerClient = ReturnType<typeof createServerClient>
