import assert from 'node:assert/strict'
import test from 'node:test'
import { createServerClient, ServerError } from '../../../src/preview/assets/server/client'
import { createFakeServer, json, type FakeServerOptions } from './fakeServer'

// The server client (Part 2, 2.5.3, 2.11): requests, paging, quick search, SRL resolution and the
// failures of a web page told apart.

const setup = (options: FakeServerOptions = {}, client: { isOnline?: () => boolean } = {}) => {
    const server = createFakeServer(options)
    return {
        server,
        client: createServerClient({
            fetch: server.fetch,
            language: () => 'ja',
            ...client,
        }),
    }
}

const rejectsWith = async (promise: Promise<unknown>, code: string) =>
    assert.rejects(
        promise,
        (error) => error instanceof ServerError && error.code === code,
        `expected ${code}`,
    )

const listPage = (names: string[], extra: Record<string, unknown> = {}) =>
    json({
        pageCount: 1,
        items: names.map((name) => ({ name, title: name.toUpperCase() })),
        ...extra,
    })

test('connecting asks for the info of the server, with a plain GET', async () => {
    const { server, client } = setup({
        files: { '/sonolus/info': json({ title: 'Fake Server', buttons: [] }) },
    })
    const info = await client.connect(server.base)
    assert.deepEqual(info, { address: server.base, title: 'Fake Server' })
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0]!.url, `${server.base}/sonolus/info`)
    // No credentials, no referrer and no custom headers: a browser sends no preflight.
    assert.deepEqual(server.requests[0]!.init, {
        method: 'GET',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: server.requests[0]!.init!.signal,
    })
    assert.equal(server.requests[0]!.init!.headers, undefined)
})

test('the server address is the final address of the info request, after a redirect', async () => {
    const { server, client } = setup({
        handler: (url) =>
            url.href === 'https://old.test/sonolus/info'
                ? {
                      body: json({ title: 'Moved' }),
                      url: 'https://new.test/moved/sonolus/info',
                  }
                : undefined,
    })
    const info = await client.connect('https://old.test')
    assert.equal(info.address, 'https://new.test/moved')
    // A relative SRL joins the address that answered, not the one that was typed.
    assert.equal(
        client.resolveUrl(info.address, '/sonolus/repository/abc'),
        'https://new.test/moved/sonolus/repository/abc',
    )
    assert.ok(server)
})

test('SRL urls: absolute ones are kept, relative ones join the address, anything else is refused', () => {
    const { client } = setup()
    const base = 'https://server.test/api'
    assert.equal(
        client.resolveUrl(base, 'https://cdn.test/files/a.png'),
        'https://cdn.test/files/a.png',
    )
    assert.equal(
        client.resolveUrl(base, '/sonolus/repository/abc'),
        `${base}/sonolus/repository/abc`,
    )
    assert.equal(client.resolveUrl(base, 'http://cdn.test/a.png'), undefined)
    assert.equal(client.resolveUrl(base, 'https://user:pass@cdn.test/a.png'), undefined)
    assert.equal(client.resolveUrl(base, '//cdn.test/a.png'), undefined)
    assert.equal(client.resolveUrl(base, 'relative/path'), undefined)
    assert.equal(client.resolveUrl(base, 'javascript:alert(1)'), undefined)
    assert.equal(client.resolveUrl(base, null), undefined)
    assert.equal(client.resolveUrl(base, ''), undefined)
})

test('a list is asked for by page with the interface language, and its next page follows', async () => {
    const { server, client } = setup({
        handler: (url) => {
            if (url.pathname !== '/api/sonolus/skins/list') return
            const page = Number(url.searchParams.get('page'))
            return { body: listPage([`item${page}`], { pageCount: 3 }) }
        },
    })
    const first = await client.list(server.base, 'skin')
    assert.deepEqual(
        first.items.map((item) => item.name),
        ['item0'],
    )
    assert.deepEqual(first.next, { page: 1 })
    const url = new URL(server.requests[0]!.url)
    assert.equal(url.searchParams.get('localization'), 'ja')
    assert.equal(url.searchParams.get('page'), '0')
    assert.equal(url.searchParams.has('type'), false)
    assert.equal(url.searchParams.has('cursor'), false)

    const second = await client.list(server.base, 'skin', { page: 1 })
    assert.deepEqual(second.next, { page: 2 })
    const last = await client.list(server.base, 'skin', { page: 2 })
    assert.equal(last.next, undefined)
    assert.equal(last.items[0]!.name, 'item2')
})

test('a negative page count means cursors: each answer names the next, until there is none', async () => {
    const cursors = new Map([
        [null, 'c1'],
        ['c1', 'c2'],
        ['c2', undefined],
    ])
    const { server, client } = setup({
        handler: (url) => {
            const cursor = url.searchParams.get('cursor')
            if (url.pathname !== '/api/sonolus/particles/list') return
            const next = cursors.get(cursor)
            return {
                body: listPage([`after-${cursor ?? 'start'}`], { pageCount: -1, cursor: next }),
            }
        },
    })
    const first = await client.list(server.base, 'particle')
    assert.deepEqual(first.next, { cursor: 'c1' })
    // The first request asks for page 0; the later ones send the cursor and no page.
    assert.equal(new URL(server.requests[0]!.url).searchParams.get('page'), '0')
    const second = await client.list(server.base, 'particle', { cursor: 'c1' })
    assert.deepEqual(second.next, { cursor: 'c2' })
    const request = new URL(server.requests[1]!.url)
    assert.equal(request.searchParams.get('cursor'), 'c1')
    assert.equal(request.searchParams.has('page'), false)
    const third = await client.list(server.base, 'particle', { cursor: 'c2' })
    assert.equal(third.next, undefined)
    assert.equal(third.items[0]!.name, 'after-c2')
})

test('a cursor that repeats itself ends the list', async () => {
    const { server, client } = setup({
        handler: () => ({ body: listPage(['a'], { pageCount: -1, cursor: 'same' }) }),
    })
    assert.deepEqual((await client.list(server.base, 'skin')).next, { cursor: 'same' })
    assert.equal((await client.list(server.base, 'skin', { cursor: 'same' })).next, undefined)
})

test('a quick search sends type=quick and the keywords, on page 0', async () => {
    const { server, client } = setup({ handler: () => ({ body: listPage(['neon']) }) })
    await client.list(server.base, 'effect', { keywords: 'neon night & day' })
    const url = new URL(server.requests[0]!.url)
    assert.equal(url.pathname, '/api/sonolus/effects/list')
    assert.equal(url.searchParams.get('type'), 'quick')
    assert.equal(url.searchParams.get('keywords'), 'neon night & day')
    assert.equal(url.searchParams.get('page'), '0')
    assert.equal(url.searchParams.get('localization'), 'ja')
})

test('list items are read with a bounded text, and a thumbnail resolves against the address', async () => {
    const { server, client } = setup({
        handler: () => ({
            body: json({
                pageCount: 1,
                items: [
                    {
                        name: 'neon',
                        title: 'N'.repeat(500),
                        author: 'Someone',
                        thumbnail: { hash: 'a'.repeat(40), url: '/sonolus/repository/t' },
                    },
                    { name: 'a/b', title: 'Bad name' },
                    { title: 'No name' },
                    { name: 'plain' },
                    { name: 'remote', thumbnail: { url: 'http://cdn.test/t.png' } },
                ],
            }),
        }),
    })
    const { items } = await client.list(server.base, 'skin')
    assert.deepEqual(
        items.map((item) => [item.name, item.title.length, item.author, item.thumbnail]),
        [
            ['neon', 200, 'Someone', `${server.base}/sonolus/repository/t`],
            ['plain', 5, '', undefined],
            ['remote', 6, '', undefined],
        ],
    )
})

test('a server without a list of a type has no items of it', async () => {
    const { server, client } = setup({ files: {} })
    assert.deepEqual(await client.list(server.base, 'background'), { items: [], next: undefined })
})

test('details are the item object of the item’s own address', async () => {
    const { server, client } = setup({
        files: {
            '/sonolus/skins/neon%20night': json({ item: { name: 'neon night', title: 'Neon' } }),
        },
    })
    const item = await client.details(server.base, 'skin', 'neon night')
    assert.equal(item.title, 'Neon')
    assert.equal(new URL(server.requests[0]!.url).pathname, '/api/sonolus/skins/neon%20night')
    await rejectsWith(client.details(server.base, 'skin', 'other'), 'notFound')
})

test('a 401 says the server needs a sign-in; other statuses and bad answers are told apart', async () => {
    const answers = new Map<string, { status?: number; body?: string }>([
        ['/api/sonolus/info', { status: 401 }],
        ['/api/sonolus/skins/list', { status: 500 }],
        ['/api/sonolus/particles/list', { body: 'not json' }],
        ['/api/sonolus/effects/list', { body: '{"items": []}' }],
        ['/api/sonolus/backgrounds/neon', { body: '{"item": 1}' }],
    ])
    const { server, client } = setup({ handler: (url) => answers.get(url.pathname) })
    await rejectsWith(client.connect(server.base), 'auth')
    await assert.rejects(
        client.list(server.base, 'skin'),
        (error) => error instanceof ServerError && error.code === 'status' && error.status === 500,
    )
    await rejectsWith(client.list(server.base, 'particle'), 'invalid')
    await rejectsWith(client.list(server.base, 'effect'), 'invalid')
    await rejectsWith(client.details(server.base, 'background', 'neon'), 'invalid')
    // A Sonolus server answers with a title.
    answers.set('/api/sonolus/info', { body: '{"buttons": []}' })
    await rejectsWith(client.connect(server.base), 'invalid')
})

test('a response past the cap stops reading', async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(0x20)
    const { server, client } = setup({ handler: () => ({ body: big }) })
    await rejectsWith(client.connect(server.base), 'tooBig')
    await rejectsWith(client.resource(`${server.base}/x`, 1024), 'tooBig')
    assert.equal((await client.resource(`${server.base}/x`, big.length)).length, big.length)
})

test('a TypeError with a resolving no-cors probe says the server blocks web pages', async () => {
    const { server, client } = setup()
    server.state.failing = true
    server.state.reachable = true
    await rejectsWith(client.connect(server.base), 'blocked')
    // The probe repeats the same GET once, with no credentials and no referrer.
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[1]!.url, server.requests[0]!.url)
    assert.deepEqual(
        { ...server.requests[1]!.init, signal: undefined },
        {
            method: 'GET',
            mode: 'no-cors',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: undefined,
        },
    )
})

test('a TypeError with a rejected probe says the server could not be reached', async () => {
    const { server, client } = setup()
    server.state.failing = true
    server.state.reachable = false
    await rejectsWith(client.connect(server.base), 'unreachable')
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[1]!.init!.mode, 'no-cors')
})

test('without the probe (the apps) a failed fetch is only unreachable', async () => {
    const server = createFakeServer()
    server.state.failing = true
    server.state.reachable = true
    const client = createServerClient({
        fetch: server.fetch,
        language: () => 'en',
        corsProbe: false,
    })
    await rejectsWith(client.connect(server.base), 'unreachable')
    assert.equal(server.requests.length, 1)
})

test('offline asks nothing and says so; a fetch that fails while the device goes offline says so too', async () => {
    let online = false
    const { server, client } = setup({}, { isOnline: () => online })
    await rejectsWith(client.connect(server.base), 'offline')
    assert.equal(server.requests.length, 0)

    online = true
    server.state.failing = true
    server.state.reachable = true
    const failing = client.connect(server.base)
    // The device lost its network before the probe could tell.
    online = false
    await rejectsWith(failing, 'offline')
})

test('an http address is refused before any request, unless http is allowed', async () => {
    const { server, client } = setup()
    await rejectsWith(client.connect('http://server.test/api'), 'insecure')
    await rejectsWith(client.resource('http://cdn.test/a.png', 10), 'insecure')
    assert.equal(server.requests.length, 0)

    const local = createFakeServer({
        base: 'http://localhost:3000',
        files: { '/sonolus/info': json({ title: 'Local' }) },
    })
    const allowing = createServerClient({
        fetch: local.fetch,
        language: () => 'en',
        allowHttp: true,
    })
    assert.equal((await allowing.connect(local.base)).title, 'Local')
})

test('a request that never answers times out as unreachable and frees its slot', async () => {
    const client = createServerClient({
        language: () => 'en',
        timeoutMs: 20,
        fetch: (_url, init) =>
            new Promise((_resolve, reject) => {
                const abort = () => reject(new DOMException('Aborted', 'AbortError'))
                if (init?.signal?.aborted) abort()
                init?.signal?.addEventListener('abort', abort)
            }),
    })
    await rejectsWith(client.connect('https://slow.test'), 'unreachable')
})

test('a caller’s abort is an abort, not a failure', async () => {
    const controller = new AbortController()
    const client = createServerClient({
        language: () => 'en',
        fetch: (_url, init) =>
            new Promise((_resolve, reject) => {
                const abort = () => reject(new DOMException('Aborted', 'AbortError'))
                if (init?.signal?.aborted) abort()
                init?.signal?.addEventListener('abort', abort)
            }),
    })
    const pending = client.connect('https://slow.test', controller.signal)
    controller.abort()
    await assert.rejects(
        pending,
        (error) => error instanceof DOMException && error.name === 'AbortError',
    )
})

test('at most four requests are open at once', async () => {
    let open = 0
    let most = 0
    const releases: (() => void)[] = []
    const client = createServerClient({
        language: () => 'en',
        fetch: () => {
            open++
            most = Math.max(most, open)
            return new Promise<Response>((resolve) =>
                releases.push(() => {
                    open--
                    resolve(new Response(new Uint8Array(4)))
                }),
            )
        },
    })
    const all = Array.from({ length: 10 }, (_, index) =>
        client.resource(`https://cdn.test/${index}`, 100),
    )
    for (let round = 0; round < 10; round++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        assert.ok(open <= 4)
        releases.splice(0).forEach((release) => release())
    }
    await Promise.all(all)
    assert.equal(most, 4)
})
