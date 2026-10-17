import type { ServerFetchInit } from '../../../src/platform/types'
import { utf8, type NamedEntry } from '../files/fixtures'

// A fake Sonolus server for the From a Server tests: a fake `fetch` that answers from a table of
// paths, records every request, and can redirect or fail as an unreachable server does.

export type Request = { url: string; init: ServerFetchInit | undefined }

export type FakeAnswer = {
    status?: number
    body?: Uint8Array | string
    headers?: Record<string, string>
    /** The address the answer says it came from, after redirects */
    url?: string
}

export type FakeServerOptions = {
    /** The server address, with no trailing slash */
    base?: string
    /** Paths under the base (`/sonolus/info`), without their query. */
    files?: Record<string, Uint8Array | string>
    /** Answers a request itself; undefined falls through to the files. */
    handler?: (url: URL, init: ServerFetchInit | undefined) => FakeAnswer | undefined
}

export const json = (value: unknown) => utf8(JSON.stringify(value))

export const createFakeServer = (options: FakeServerOptions = {}) => {
    const base = options.base ?? 'https://server.test/api'
    const files = new Map(Object.entries(options.files ?? {}))
    const requests: Request[] = []
    const state = {
        /** Every `fetch` throws a TypeError, as an unreachable server does. */
        failing: false,
        handler: options.handler,
    }

    const answer = (
        url: string,
        { status = 200, body = '', headers = {}, url: finalUrl }: FakeAnswer,
    ) => {
        const response = new Response(typeof body === 'string' ? body : new Uint8Array(body), {
            status,
            headers,
        })
        Object.defineProperty(response, 'url', { value: finalUrl ?? url })
        return response
    }

    const fetch = (url: string, init?: ServerFetchInit): Promise<Response> => {
        requests.push({ url, init })
        if (state.failing) return Promise.reject(new TypeError('Failed to fetch'))
        const parsed = new URL(url)
        const custom = state.handler?.(parsed, init)
        if (custom) return Promise.resolve(answer(url, custom))
        const path = `${parsed.origin}${parsed.pathname}`
        if (!path.startsWith(base)) return Promise.reject(new TypeError('Failed to fetch'))
        const body = files.get(path.slice(base.length))
        return Promise.resolve(
            body === undefined ? answer(url, { status: 404 }) : answer(url, { body }),
        )
    }

    return { base, files, requests, state, fetch }
}

export type FakeServer = ReturnType<typeof createFakeServer>

/** The files of a server from package entries: the same layout as a static server's. */
export const filesFromEntries = (
    entries: NamedEntry[],
    info: unknown = { title: 'Fake Server' },
): Record<string, Uint8Array> => ({
    '/sonolus/info': json(info),
    ...Object.fromEntries(entries.map((entry) => [`/${entry.name as string}`, entry.data])),
})
