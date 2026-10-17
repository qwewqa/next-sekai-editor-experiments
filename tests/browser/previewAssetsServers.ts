import type { Page } from '@playwright/test'
import { ZipReader } from '../../src/zip'

// Fake Sonolus servers for the From a Server specs. The web build fetches no servers, so the
// page gets the apps' capability through a test platform whose `fetchServer` asks these servers,
// in Node, by an exposed function: no request leaves the page, and the web policy is unchanged.
// Knobs cover each way a server can fail.

export const ORIGIN = 'https://server.test'
export const BASE = `${ORIGIN}/api`

export type Files = Map<string, Uint8Array>

/** Every entry of a package, by its path. */
export const filesOf = async (bytes: Uint8Array): Promise<Files> => {
    const reader = await ZipReader.open(new Blob([new Uint8Array(bytes)]))
    const files: Files = new Map()
    for (const entry of reader.entries)
        if (!entry.isDirectory)
            files.set(entry.name, await reader.read(entry, { maxSize: 64 * 1024 * 1024 }))
    return files
}

export type ServerOptions = {
    origin?: string
    /** The server address's path, with no trailing slash */
    path?: string
    title?: string
    files?: Files
    /** Answers a list request itself (the fields: category, query). */
    list?: (category: string, query: URLSearchParams) => unknown
    /** Delays answers whose path (and query) matches, in ms. */
    delay?: (path: string, query: URLSearchParams) => number
    /** Answers whose path matches fail with this status. */
    status?: (path: string) => number | undefined
}

export type ServerState = {
    /** Every request fails, as an unreachable host does. */
    down: boolean
    requests: string[]
}

/** What the page's `fetchServer` gets back: an answer, or a failed request. */
type Answer = { status: number; body: string; url: string } | { failed: true }
type Handler = (url: URL) => Promise<Answer>

const handlers = new WeakMap<Page, Map<string, Handler>>()

const json = (value: unknown) => Buffer.from(JSON.stringify(value))
const answer = (url: URL, status: number, body: Uint8Array = new Uint8Array()): Answer => ({
    status,
    body: Buffer.from(body).toString('base64'),
    url: url.href,
})

/** Gives the page the apps' server capability, its fetch answered by the servers served here. */
export const installServers = async (page: Page) => {
    await page.evaluate(async () => {
        const module =
            await window.editorTest.appImport<typeof import('../../src/platform')>(
                '/src/platform/index.ts',
            )
        const ask = (window as unknown as { nseServerFetch: (url: string) => Promise<Answer> })
            .nseServerFetch
        const base = module.platform
        module.setPlatformForTests(
            Object.create(base, {
                capabilities: { value: { ...base.capabilities, serverFetch: true } },
                fetchServer: {
                    value: (url: string, init?: { signal?: AbortSignal | null }) =>
                        new Promise<Response>((resolve, reject) => {
                            const signal = init?.signal
                            const abort = () =>
                                reject(new DOMException('The request was aborted', 'AbortError'))
                            if (signal?.aborted) return abort()
                            signal?.addEventListener('abort', abort, { once: true })
                            void ask(url).then((result) => {
                                if (signal?.aborted) return
                                if ('failed' in result)
                                    return reject(new TypeError('Failed to fetch'))
                                const bytes = Uint8Array.from(atob(result.body), (c) =>
                                    c.charCodeAt(0),
                                )
                                const response = new Response(
                                    result.status === 204 ? null : bytes,
                                    { status: result.status },
                                )
                                Object.defineProperty(response, 'url', { value: result.url })
                                resolve(response)
                            })
                        }),
                },
            }) as typeof base,
        )
    })
}

/** Serves the files of a server at `https://server.test/api`, and lets the page fetch it. */
export const serve = async (page: Page, options: ServerOptions = {}) => {
    const origin = options.origin ?? ORIGIN
    const path = options.path ?? '/api'
    const files = options.files ?? new Map()
    const state: ServerState = { down: false, requests: [] }

    const handle: Handler = async (url) => {
        state.requests.push(`${url.pathname}${url.search}`)
        const delay = options.delay?.(url.pathname, url.searchParams) ?? 0
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        if (state.down) return { failed: true }
        const status = options.status?.(url.pathname)
        if (status) return answer(url, status)
        const rest = url.pathname.startsWith(path) ? url.pathname.slice(path.length) : undefined
        if (rest === undefined) return answer(url, 404)
        if (rest === '/sonolus/info')
            return answer(url, 200, json({ title: options.title ?? 'Test Server', buttons: [] }))
        const listing = /^\/sonolus\/(\w+)\/list$/.exec(rest)
        if (listing && options.list) {
            const body = options.list(listing[1]!, url.searchParams)
            if (body !== undefined) return answer(url, 200, json(body))
        }
        const bytes = files.get(rest.slice(1)) ?? files.get(decodeURIComponent(rest.slice(1)))
        return bytes ? answer(url, 200, bytes) : answer(url, 404)
    }

    let servers = handlers.get(page)
    if (!servers) {
        const registered = new Map<string, Handler>()
        servers = registered
        handlers.set(page, registered)
        await page.exposeFunction('nseServerFetch', async (address: string) => {
            const url = new URL(address)
            const handler = registered.get(url.origin)
            // A host nobody serves cannot be reached.
            return handler ? handler(url) : { failed: true }
        })
    }
    // A later server at the same origin takes its place.
    servers.set(origin, handle)
    await installServers(page)
    return { state, files, origin, base: `${origin}${path}` }
}
