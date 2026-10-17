import type { Page, Route } from '@playwright/test'
import { ZipReader } from '../../src/zip'

// Fake Sonolus servers for the From a Server specs: an SCP's entries served at the layout of a
// static server, with CORS headers like GitHub Pages sends, and knobs for each way a server can
// fail. The page's own fetch goes through the browser's real CORS check.

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
    /** Delays answers whose path matches, in ms. */
    delay?: (path: string) => number
    /** Answers whose path matches fail with this status. */
    status?: (path: string) => number | undefined
}

export type ServerState = {
    /**
     * A server that sends no CORS headers: the page’s own requests fail as the browser’s check
     * would fail them (Playwright adds the headers to what it fulfils), and a `no-cors` request
     * still gets its opaque answer.
     */
    blocked: boolean
    /** Every request aborted, as an unreachable host does. */
    down: boolean
    requests: string[]
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value))

/** Serves the files of a server at the page's `https://server.test/api`. */
export const serve = async (page: Page, options: ServerOptions = {}) => {
    const origin = options.origin ?? ORIGIN
    const path = options.path ?? '/api'
    const files = options.files ?? new Map()
    const state: ServerState = { blocked: false, down: false, requests: [] }

    const handle = async (route: Route) => {
        const request = route.request()
        const url = new URL(request.url())
        state.requests.push(`${url.pathname}${url.search}`)
        if (state.down) return route.abort('connectionrefused')
        // A cross-origin `cors` request carries the page’s Origin; a `no-cors` GET does not.
        if (state.blocked && (await request.allHeaders()).origin) return route.abort('failed')
        const cors = { 'access-control-allow-origin': '*' }
        const rest = url.pathname.startsWith(path) ? url.pathname.slice(path.length) : undefined
        const delay = options.delay?.(url.pathname) ?? 0
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        const status = options.status?.(url.pathname)
        if (status) return route.fulfill({ status, headers: cors, body: '' })
        if (rest === undefined) return route.fulfill({ status: 404, headers: cors, body: '' })
        if (rest === '/sonolus/info')
            return route.fulfill({
                headers: cors,
                body: json({ title: options.title ?? 'Test Server', buttons: [] }),
            })
        const listing = /^\/sonolus\/(\w+)\/list$/.exec(rest)
        if (listing && options.list) {
            const body = options.list(listing[1]!, url.searchParams)
            if (body !== undefined) return route.fulfill({ headers: cors, body: json(body) })
        }
        const bytes = files.get(rest.slice(1)) ?? files.get(decodeURIComponent(rest.slice(1)))
        if (!bytes) return route.fulfill({ status: 404, headers: cors, body: '' })
        return route.fulfill({ headers: cors, body: Buffer.from(bytes) })
    }
    await page.route(`${origin}/**`, handle)
    return { state, files, origin, base: `${origin}${path}` }
}
