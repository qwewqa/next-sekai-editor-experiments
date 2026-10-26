import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { storedChoice } from '../../../src/preview/assets/files/chooser'
import type { AssetImportError } from '../../../src/preview/assets/files/errors'
import { createMemoryStore } from '../../../src/preview/assets/files/store'
import {
    createServerChooser,
    type ServerChooserDeps,
} from '../../../src/preview/assets/server/chooser'
import { createServerClient } from '../../../src/preview/assets/server/client'
import {
    serverErrorText,
    serverItemMessage,
    type ServerStrings,
} from '../../../src/preview/assets/server/text'
import type { AssetChoice, AssetType } from '../../../src/preview/assets/types'
import { rawZip, scpEntries, utf8, wav, type NamedEntry, type ScpOptions } from '../files/fixtures'
import { createFakeServer, filesFromEntries, json, type FakeAnswer } from './fakeServer'

const en = (
    JSON.parse(readFileSync('src/i18n/en/index.json', 'utf8')) as {
        commands: { previewAssets: ServerStrings }
    }
).commands.previewAssets
const number = (value: number) => new Intl.NumberFormat('en').format(value)

// The chooser's From a Server view: listing, paging, search, "Also use
// … from this server", Use.

const merge = (items: [AssetType, ScpOptions?][]) => {
    const entries = new Map<string, NamedEntry>()
    for (const [type, options] of items)
        for (const entry of scpEntries(type, options)) {
            const before = entries.get(entry.name as string)
            if (before && (entry.name as string).endsWith('/list')) {
                const list = JSON.parse(new TextDecoder().decode(before.data)) as {
                    items: unknown[]
                }
                const more = JSON.parse(new TextDecoder().decode(entry.data)) as {
                    items: unknown[]
                }
                list.items.push(...more.items)
                entries.set(entry.name as string, { ...entry, data: utf8(JSON.stringify(list)) })
            } else entries.set(entry.name as string, entry)
        }
    return [...entries.values()]
}

const named = (name: string, title: string): ScpOptions => ({ name, title })
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    return { promise, resolve }
}

const setup = (
    items: [AssetType, ScpOptions?][],
    options: {
        handler?: (url: URL) => FakeAnswer | undefined
        online?: () => boolean
        info?: unknown
    } = {},
) => {
    const server = createFakeServer({
        files: filesFromEntries(merge(items), options.info),
        handler: options.handler,
    })
    const store = createMemoryStore()
    const applied: Partial<Record<AssetType, AssetChoice>>[] = []
    const remembered: string[] = []
    const closed: boolean[] = []
    const handedOver: [AssetType, string][] = []
    const deps = (type: AssetType): ServerChooserDeps => ({
        client: createServerClient({
            fetch: server.fetch,
            language: () => 'en',
            isOnline: options.online,
        }),
        store,
        maxTextureSide: () => 4096,
        decodeImage: async () => undefined,
        decodeAudio: async () => ({ duration: 1 }) as AudioBuffer,
        apply: (choices) => applied.push(choices),
        describe: (error: AssetImportError) =>
            serverItemMessage(error, en, number, (bytes) => `${bytes} bytes`),
        toChoice: storedChoice,
        recent: () => remembered.slice().reverse(),
        remember: (address) => remembered.push(address),
        close: () => closed.push(true),
        handOver: (other, input) => handedOver.push([other, input]),
        // `type` only keeps each chooser's deps apart in a test that builds two.
        now: () => (type === 'skin' ? 1 : 2),
    })
    return { server, store, applied, remembered, closed, handedOver, deps }
}

const collection = () =>
    [
        ['skin', named('neon', 'Neon Skin')],
        ['particle', named('neon', 'Neon Particle')],
        ['background', named('other', 'Other Background')],
        ['effect', named('neon', 'Neon Sounds')],
    ] satisfies [AssetType, ScpOptions][]

test('connecting lists the type’s items, remembers the server and takes its address', async () => {
    const { server, deps, remembered } = setup(collection())
    const chooser = createServerChooser('skin', deps('skin'))
    assert.equal(chooser.mode.value, 'file')
    chooser.address.value = `${server.base}/`
    await chooser.connect()
    assert.equal(chooser.phase.value, 'listed')
    assert.equal(chooser.title.value, 'Fake Server')
    assert.equal(chooser.address.value, server.base)
    assert.deepEqual(
        chooser.items.value.map((item) => [item.name, item.title, item.author]),
        [['neon', 'Neon Skin', 'Author']],
    )
    // A lone item is preselected.
    assert.equal(chooser.selected.value, 'neon')
    assert.deepEqual(remembered, [server.base])
    assert.equal(chooser.error.value, undefined)
})

test('the last server connected to prefills an empty field, once', async () => {
    const { server, deps } = setup(collection())
    const first = createServerChooser('skin', deps('skin'))
    first.address.value = server.base
    await first.connect()
    const second = createServerChooser('particle', deps('particle'))
    second.prefill()
    assert.equal(second.address.value, server.base)
    second.address.value = 'https://other.test'
    second.prefill()
    assert.equal(second.address.value, 'https://other.test')
})

test('other types are offered only when the server has an item of the same name, and after a row is selected', async () => {
    const { deps, server } = setup(collection())
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await settle()
    // One checkbox per type: the particle and the sound effects; the background has another name.
    assert.deepEqual(
        chooser.also.value.map((option) => [option.type, option.title, option.ticked]),
        [
            ['particle', 'Neon Particle', false],
            ['effect', 'Neon Sounds', false],
        ],
    )
})

test('a lookup that fails offers no checkbox', async () => {
    const { deps, server } = setup(collection(), {
        handler: (url) =>
            url.pathname === '/api/sonolus/effects/neon' ? { status: 500 } : undefined,
    })
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await settle()
    assert.deepEqual(
        chooser.also.value.map((option) => option.type),
        ['particle'],
    )
})

test('with several items nothing is selected until one is, and the checkboxes follow it', async () => {
    const { deps, server } = setup([
        ['skin', named('a', 'First')],
        ['skin', named('b', 'Second')],
        ['particle', named('b', 'Second Particle')],
    ])
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    assert.equal(chooser.items.value.length, 2)
    assert.equal(chooser.selected.value, undefined)
    assert.equal(chooser.also.value.length, 0)
    chooser.select('b')
    await settle()
    assert.deepEqual(
        chooser.also.value.map((option) => option.title),
        ['Second Particle'],
    )
    chooser.select('a')
    assert.equal(chooser.also.value.length, 0)
    await settle()
    assert.equal(chooser.also.value.length, 0)
})

test('Use downloads the selected item and every ticked one, checks them, stores them and applies them together', async () => {
    const { deps, server, store, applied, closed } = setup(collection())
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await settle()
    chooser.toggle('particle', true)
    await chooser.use()

    assert.equal(applied.length, 1)
    const choices = applied[0]!
    assert.deepEqual(Object.keys(choices).sort(), ['particle', 'skin'])
    assert.equal(choices.skin?.source, 'server')
    assert.equal(choices.skin?.source === 'server' && choices.skin.origin, server.base)
    assert.equal(choices.skin?.source === 'server' && choices.skin.title, 'Neon Skin')
    const stored = await store.list()
    assert.deepEqual(stored.map((meta) => meta.type).sort(), ['particle', 'skin'])
    assert.ok(stored.every((meta) => meta.origin === server.base))
    assert.deepEqual(closed, [true])
    // The chooser is as new again.
    assert.equal(chooser.phase.value, 'idle')
    assert.equal(chooser.items.value.length, 0)
})

test('the stored package is a standard single-item package the file chooser would have made', async () => {
    const { deps, server, store } = setup(collection())
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await chooser.use()
    const [meta] = await store.list()
    const record = await store.get(meta!.key)
    assert.equal(record?.name, 'neon')
    assert.equal(record?.key.length, 64)
    assert.ok(record!.size > 0 && record!.size === record!.bytes.size)
})

test('an item whose checksum does not match is refused with the server’s wording, and nothing is stored', async () => {
    const { deps, server, store, applied } = setup([
        ['skin', { ...named('neon', 'Neon'), hashes: 'bad' }],
    ])
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await chooser.use()
    assert.equal(chooser.phase.value, 'listed')
    assert.deepEqual(applied, [])
    assert.deepEqual(await store.list(), [])
    const error = chooser.useError.value
    assert.equal(error?.kind, 'item')
    assert.equal(
        error?.kind === 'item' && error.message,
        'The server’s checksum for this item does not match what it sent.',
    )
})

test('an item the checks refuse says so as an item of the server, not of a file', async () => {
    const { deps, server } = setup([
        [
            'skin',
            { ...named('neon', 'Neon'), resources: { texture: new Uint8Array([1, 2, 3, 4]) } },
        ],
    ])
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await chooser.use()
    const error = chooser.useError.value
    assert.equal(
        error?.kind === 'item' && error.message,
        'This item’s skin texture is not a PNG or JPEG image.',
    )
})

test('a ticked item that fails stores nothing, not even the selected one', async () => {
    const { deps, server, store, applied } = setup([
        ['skin', named('neon', 'Neon')],
        ['particle', { ...named('neon', 'Neon'), hashes: 'bad' }],
    ])
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await settle()
    chooser.toggle('particle', true)
    await chooser.use()
    assert.deepEqual(await store.list(), [])
    assert.deepEqual(applied, [])
    assert.equal(chooser.useError.value?.kind, 'item')
})

test('a resource that is missing is the item’s, and one that cannot be fetched is the server’s', async () => {
    const missing = setup([['skin', named('neon', 'Neon')]], {
        handler: (url) => (url.pathname.includes('/repository/') ? { status: 404 } : undefined),
    })
    const first = createServerChooser('skin', missing.deps('skin'))
    first.address.value = missing.server.base
    await first.connect()
    await first.use()
    assert.equal(
        first.useError.value?.kind === 'item' && first.useError.value.message,
        'This item’s skin data is missing.',
    )

    const dropped = setup([['skin', named('neon', 'Neon')]])
    const second = createServerChooser('skin', dropped.deps('skin'))
    second.address.value = dropped.server.base
    await second.connect()
    dropped.server.state.failing = true
    await second.use()
    assert.deepEqual(second.useError.value, {
        kind: 'server',
        code: 'unreachable',
        status: undefined,
    })
    assert.equal(second.phase.value, 'listed')
})

test('a share link to an item of the type lists it first and selects it', async () => {
    const { deps, server } = setup([
        ['skin', named('a', 'First')],
        ['skin', named('b', 'Second')],
    ])
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = `${server.base}/skins/b`
    await chooser.connect()
    assert.deepEqual(
        chooser.items.value.map((item) => item.name),
        ['b', 'a'],
    )
    assert.equal(chooser.selected.value, 'b')
    assert.equal(chooser.address.value, server.base)
    assert.equal(chooser.error.value, undefined)
})

test('a share link to an item the server lacks says so and still lists', async () => {
    const { deps, server } = setup([
        ['skin', named('a', 'First')],
        ['skin', named('b', 'Second')],
    ])
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = `${server.base}/sonolus/skins/gone`
    await chooser.connect()
    assert.equal(chooser.phase.value, 'listed')
    assert.equal(chooser.items.value.length, 2)
    assert.equal(chooser.selected.value, undefined)
    assert.deepEqual(chooser.error.value, { kind: 'server', code: 'notFound', status: 404 })
})

test('a share link to another type’s item goes to that type’s chooser', async () => {
    const { deps, server, handedOver } = setup(collection())
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = `${server.base}/particles/neon`
    await chooser.connect()
    assert.deepEqual(handedOver, [['particle', `${server.base}/particles/neon`]])
    assert.equal(chooser.phase.value, 'idle')
    assert.equal(server.requests.length, 0)

    // The chooser that takes it switches to the server view and connects.
    const other = createServerChooser('particle', deps('particle'))
    await other.connectTo(`${server.base}/particles/neon`)
    assert.equal(other.mode.value, 'server')
    assert.equal(other.selected.value, 'neon')
})

test('paging: More appends the next page and ends with the last', async () => {
    const pages = ['one', 'two', 'three'].map((name) => ({ name, title: name }))
    const { deps, server } = setup([], {
        handler: (url) => {
            if (url.pathname === '/api/sonolus/info') return { body: json({ title: 'Paged' }) }
            if (url.pathname !== '/api/sonolus/skins/list') return
            const page = Number(url.searchParams.get('page'))
            return { body: json({ pageCount: 3, items: [pages[page]!] }) }
        },
    })
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    assert.deepEqual(
        chooser.items.value.map((item) => item.name),
        ['one'],
    )
    assert.equal(chooser.hasMore.value, true)
    await chooser.more()
    await chooser.more()
    assert.deepEqual(
        chooser.items.value.map((item) => item.name),
        ['one', 'two', 'three'],
    )
    assert.equal(chooser.hasMore.value, false)
    await chooser.more()
    assert.equal(chooser.items.value.length, 3)
})

test('paging by cursor follows the cursors the server hands out', async () => {
    const { deps, server } = setup([], {
        handler: (url) => {
            if (url.pathname === '/api/sonolus/info') return { body: json({ title: 'Cursors' }) }
            if (url.pathname !== '/api/sonolus/skins/list') return
            const cursor = url.searchParams.get('cursor')
            return cursor === null
                ? {
                      body: json({
                          pageCount: -1,
                          cursor: 'next',
                          items: [{ name: 'a', title: 'A' }],
                      }),
                  }
                : { body: json({ pageCount: -1, items: [{ name: 'b', title: 'B' }] }) }
        },
    })
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    assert.equal(chooser.hasMore.value, true)
    await chooser.more()
    assert.deepEqual(
        chooser.items.value.map((item) => item.name),
        ['a', 'b'],
    )
    assert.equal(chooser.hasMore.value, false)
})

test('a quick search replaces the list, drops a selection it removed, and an empty search lists all again', async () => {
    const { deps, server } = setup([], {
        handler: (url) => {
            if (url.pathname === '/api/sonolus/info') return { body: json({ title: 'Search' }) }
            if (url.pathname !== '/api/sonolus/skins/list') return
            const keywords = url.searchParams.get('keywords')
            const items =
                keywords === 'night'
                    ? [{ name: 'night', title: 'Night' }]
                    : [
                          { name: 'day', title: 'Day' },
                          { name: 'dusk', title: 'Dusk' },
                      ]
            return { body: json({ pageCount: 1, items }) }
        },
    })
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    chooser.select('day')
    await chooser.search('  night ')
    assert.deepEqual(
        chooser.items.value.map((item) => item.name),
        ['night'],
    )
    const request = new URL(server.requests.at(-1)!.url)
    assert.equal(request.searchParams.get('type'), 'quick')
    assert.equal(request.searchParams.get('keywords'), 'night')
    assert.equal(chooser.selected.value, undefined)
    await chooser.search('')
    assert.equal(chooser.items.value.length, 2)
    assert.equal(new URL(server.requests.at(-1)!.url).searchParams.has('keywords'), false)
})

test('only the newest search shows', async () => {
    const releases = new Map<string, () => void>()
    const { deps, server } = setup([], {
        handler: (url) =>
            url.pathname === '/api/sonolus/info' ? { body: json({ title: 'Race' }) } : undefined,
    })
    const real = server.fetch
    const delayed = (url: string, init?: Parameters<typeof real>[1]) => {
        const keywords = new URL(url).searchParams.get('keywords')
        if (!keywords) return real(url, init)
        return new Promise<Response>((resolve) => {
            releases.set(keywords, () =>
                resolve(
                    new Response(
                        JSON.stringify({
                            pageCount: 1,
                            items: [{ name: keywords, title: keywords }],
                        }),
                    ),
                ),
            )
            init?.signal?.addEventListener('abort', () =>
                resolve(new Response('{}', { status: 500 })),
            )
        })
    }
    const base = deps('skin')
    const chooser = createServerChooser('skin', {
        ...base,
        client: createServerClient({ fetch: delayed, language: () => 'en' }),
    })
    chooser.address.value = server.base
    await chooser.connect()
    const first = chooser.search('slow')
    const second = chooser.search('fast')
    await settle()
    releases.get('fast')?.()
    releases.get('slow')?.()
    await Promise.all([first, second])
    assert.deepEqual(
        chooser.items.value.map((item) => item.name),
        ['fast'],
    )
    assert.equal(chooser.loading.value, false)
})

test('the failures read as 2.5.3 words them', async () => {
    const say = (error: Parameters<typeof serverErrorText>[0]) => serverErrorText(error, en)

    const down = setup(collection())
    down.server.state.failing = true
    const first = createServerChooser('skin', down.deps('skin'))
    first.address.value = down.server.base
    await first.connect()
    assert.equal(first.phase.value, 'idle')
    assert.equal(
        say(first.error.value!),
        'Could not reach this server. Check the address, or try again later.',
    )

    const auth = setup(collection(), { handler: () => ({ status: 401 }) })
    const second = createServerChooser('skin', auth.deps('skin'))
    second.address.value = auth.server.base
    await second.connect()
    assert.equal(say(second.error.value!), 'The editor cannot use servers that require signing in.')

    const offline = setup(collection(), { online: () => false })
    const third = createServerChooser('skin', offline.deps('skin'))
    third.address.value = offline.server.base
    await third.connect()
    assert.equal(say(third.error.value!), 'You are offline.')
    assert.equal(offline.server.requests.length, 0)
})

test('an http address is refused before anything is fetched, and a bad field says why', async () => {
    const { deps, server } = setup(collection())
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = 'http://server.test/api'
    await chooser.connect()
    assert.equal(serverErrorText(chooser.error.value!, en), 'The editor cannot use http servers.')
    chooser.address.value = ''
    await chooser.connect()
    assert.equal(serverErrorText(chooser.error.value!, en), 'Enter a server address.')
    chooser.address.value = 'https://user:pw@server.test'
    await chooser.connect()
    assert.equal(
        serverErrorText(chooser.error.value!, en),
        'A server address cannot contain a user name or password.',
    )
    assert.equal(server.requests.length, 0)
})

test('an address with no Sonolus server behind it says so', async () => {
    const { deps } = setup([])
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = 'https://server.test/api/elsewhere'
    await chooser.connect()
    assert.equal(serverErrorText(chooser.error.value!, en), 'This address is not a Sonolus server.')
})

test('cancelling while connecting leaves nothing behind', async () => {
    const { deps, server } = setup(collection())
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    const connecting = chooser.connect()
    assert.equal(chooser.phase.value, 'connecting')
    chooser.cancel()
    await connecting
    await settle()
    assert.equal(chooser.phase.value, 'idle')
    assert.equal(chooser.items.value.length, 0)
    assert.equal(chooser.error.value, undefined)
})

test('cancelling during Use stores nothing', async () => {
    const { deps, server, store, applied } = setup(collection())
    let refreshed = 0
    const chooser = createServerChooser('skin', {
        ...deps('skin'),
        onStorageChanged: () => refreshed++,
    })
    chooser.address.value = server.base
    await chooser.connect()
    const using = chooser.use()
    assert.equal(chooser.phase.value, 'working')
    chooser.cancel()
    await using
    await settle()
    assert.deepEqual(await store.list(), [])
    assert.deepEqual(applied, [])
    assert.equal(chooser.phase.value, 'idle')
    assert.equal(refreshed, 0)
})

test('late server cancellation preserves another caller’s verified choice and a newer connection', async (t) => {
    const { deps, server, store, applied, closed } = setup([['skin', named('neon', 'Neon')]])
    const reading = deferred()
    const release = deferred()
    const remove = t.mock.fn(store.remove)
    const shared = { ...store, remove }
    let refreshed = 0
    const first = createServerChooser('skin', {
        ...deps('skin'),
        store: {
            ...shared,
            get: async (key) => {
                const record = await store.get(key)
                reading.resolve()
                await release.promise
                return record
            },
        },
        onStorageChanged: () => refreshed++,
    })
    const second = createServerChooser('skin', { ...deps('skin'), store: shared })
    await first.connectTo(server.base)
    const using = first.use()
    await reading.promise
    await second.connectTo(server.base)
    await second.use()
    const choice = applied[0]?.skin
    assert.ok(choice?.source === 'server')
    first.cancel()
    await first.connectTo(server.base)
    assert.equal(refreshed, 0)
    release.resolve()
    await using
    assert.equal(applied.length, 1)
    assert.equal(first.phase.value, 'listed')
    assert.equal(first.selected.value, 'neon')
    assert.equal(closed.length, 1)
    assert.equal(refreshed, 1)
    assert.equal(remove.mock.callCount(), 0)
    const record = await store.get(choice.key)
    assert.ok(record)
    assert.equal(record.bytes.size, record.size)
    assert.equal(applied[0]?.skin, choice)
})

test('failed server readback applies nothing and refreshes the retained row', async (t) => {
    t.mock.method(console, 'error', () => {})
    const { deps, server, store, applied, closed } = setup([['skin', named('neon', 'Neon')]])
    let refreshed = 0
    const chooser = createServerChooser('skin', {
        ...deps('skin'),
        store: {
            ...store,
            get: () => Promise.reject(new Error('Read failed')),
        },
        onStorageChanged: () => refreshed++,
    })
    await chooser.connectTo(server.base)
    await chooser.use()
    assert.deepEqual(applied, [])
    assert.deepEqual(closed, [])
    assert.equal(chooser.phase.value, 'listed')
    assert.deepEqual(chooser.useError.value, {
        kind: 'item',
        message: 'This item could not be stored.',
    })
    assert.equal((await store.list()).length, 1)
    assert.equal(refreshed, 1)
})

test('a new server connection started by apply survives the old Use finishing', async () => {
    const { deps, server, closed } = setup([['skin', named('neon', 'Neon')]])
    let connected: Promise<void> | undefined
    const chooser = createServerChooser('skin', {
        ...deps('skin'),
        apply: () => {
            connected = chooser.connectTo(server.base)
        },
    })
    await chooser.connectTo(server.base)
    await chooser.use()
    await connected
    assert.equal(chooser.phase.value, 'listed')
    assert.equal(chooser.selected.value, 'neon')
    assert.deepEqual(closed, [])
})

/** A client over the server whose other-type lookups never answer until they are stopped. */
const stuckLookups = (server: ReturnType<typeof setup>['server']) => {
    const stopped: string[] = []
    const client = createServerClient({
        language: () => 'en',
        fetch: (url, init) => {
            const path = new URL(url).pathname
            if (/\/sonolus\/(particles|backgrounds|effects)\/[^/]+$/.test(path))
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        stopped.push(path)
                        reject(new DOMException('Aborted', 'AbortError'))
                    })
                })
            return server.fetch(url, init)
        },
    })
    return { client, stopped }
}

test('moving to another row stops the last row’s lookups, and Use does not wait for any', async () => {
    const parts = setup([
        ['skin', named('a', 'First')],
        ['skin', named('b', 'Second')],
    ])
    const { client, stopped } = stuckLookups(parts.server)
    const chooser = createServerChooser('skin', { ...parts.deps('skin'), client })
    chooser.address.value = parts.server.base
    await chooser.connect()
    chooser.select('a')
    await settle()
    assert.deepEqual(stopped, [])
    chooser.select('b')
    await settle()
    assert.deepEqual(stopped.sort(), [
        '/api/sonolus/backgrounds/a',
        '/api/sonolus/effects/a',
        '/api/sonolus/particles/a',
    ])
    // Use goes ahead while b's lookups hang, and stops them.
    await chooser.use()
    assert.equal(parts.applied.length, 1)
    assert.equal(parts.applied[0]!.skin?.source === 'server' && parts.applied[0]!.skin.name, 'b')
    assert.equal(stopped.length, 6)
})

test('Use does not ask again for the details a lookup found', async () => {
    const { deps, server } = setup(collection())
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await settle()
    chooser.toggle('particle', true)
    await chooser.use()
    const asked = server.requests.filter(
        (request) => new URL(request.url).pathname === '/api/sonolus/particles/neon',
    )
    assert.equal(asked.length, 1)
})

test('a server effect whose audio expands too far is refused as the item’s', async () => {
    const { deps, server } = setup([
        [
            'effect',
            {
                ...named('boom', 'Boom'),
                resources: { audio: rawZip([{ name: 'perfect.mp3', data: wav(100), method: 8 }]) },
            },
        ],
    ])
    const chooser = createServerChooser('effect', deps('effect'))
    chooser.address.value = server.base
    await chooser.connect()
    await chooser.use()
    const error = chooser.useError.value
    assert.equal(
        error?.kind === 'item' && error.message,
        'This item’s sound effects audio expands to more than 200 times its size.',
    )
})

test('details too large for an item are the item’s, and details the server lacks say so', async () => {
    const big = setup([['skin', named('neon', 'Neon')]], {
        handler: (url) =>
            url.pathname === '/api/sonolus/skins/neon'
                ? { body: new Uint8Array(4_000_001).fill(0x20) }
                : undefined,
    })
    const first = createServerChooser('skin', big.deps('skin'))
    first.address.value = big.server.base
    await first.connect()
    await first.use()
    assert.equal(
        first.useError.value?.kind === 'item' && first.useError.value.message,
        'This item’s skin detail entry is larger than 4000000 bytes.',
    )
    // Gone from the server between the list and Use.
    const gone = setup([['skin', named('neon', 'Neon')]])
    const second = createServerChooser('skin', gone.deps('skin'))
    second.address.value = gone.server.base
    await second.connect()
    gone.server.files.delete('/sonolus/skins/neon')
    await second.use()
    assert.equal(
        second.useError.value?.kind === 'item' && second.useError.value.message,
        'This server does not have that item.',
    )
})

test('files that cannot be fetched from another host name that host', async () => {
    const { deps, server } = setup([['skin', named('neon', 'Neon')]])
    const path = '/sonolus/skins/neon'
    const details = JSON.parse(new TextDecoder().decode(server.files.get(path) as Uint8Array)) as {
        item: { texture: { url: string } }
    }
    // The fake server answers nothing outside its own address.
    details.item.texture = { url: 'https://cdn.test/texture.png' }
    server.files.set(path, json(details))
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await chooser.use()
    assert.deepEqual(chooser.useError.value, {
        kind: 'server',
        code: 'unreachable',
        status: undefined,
        host: 'cdn.test',
    })
    assert.equal(
        serverErrorText(chooser.useError.value!, en),
        'Could not download this item’s files from cdn.test.',
    )
})

test('More stops at 1,000 items', async () => {
    const page = (index: number) =>
        Array.from({ length: 600 }, (_, item) => ({ name: `i${index}-${item}`, title: 'Item' }))
    const { deps, server } = setup([], {
        handler: (url) => {
            if (url.pathname === '/api/sonolus/info') return { body: json({ title: 'Big' }) }
            if (url.pathname !== '/api/sonolus/skins/list') return
            const index = Number(url.searchParams.get('page'))
            return { body: json({ pageCount: 10, items: page(index) }) }
        },
    })
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = server.base
    await chooser.connect()
    await chooser.more()
    assert.equal(chooser.items.value.length, 1000)
    assert.equal(chooser.hasMore.value, false)
})

test('a share link whose item has no usable name says the server does not have it', async () => {
    const { deps, server } = setup([['skin', named('a', 'First')]], {
        handler: (url) =>
            url.pathname === '/api/sonolus/skins/odd'
                ? { body: json({ item: { name: '../odd', title: 'Odd' } }) }
                : undefined,
    })
    const chooser = createServerChooser('skin', deps('skin'))
    chooser.address.value = `${server.base}/skins/odd`
    await chooser.connect()
    assert.equal(chooser.phase.value, 'listed')
    assert.deepEqual(chooser.error.value, { kind: 'server', code: 'notFound' })
})

test('thumbnails are fetched as object URLs, not from a local address, and go with the list', async () => {
    const parts = setup([
        ['skin', named('a', 'First')],
        ['skin', named('b', 'Second')],
    ])
    const list = JSON.parse(
        new TextDecoder().decode(parts.server.files.get('/sonolus/skins/list') as Uint8Array),
    ) as { items: { name: string; thumbnail: { url: string } }[] }
    list.items[1]!.thumbnail = { url: 'https://192.168.1.2/t.png' }
    parts.server.files.set('/sonolus/skins/list', json(list))
    const made: Blob[] = []
    const revoked: string[] = []
    const chooser = createServerChooser('skin', {
        ...parts.deps('skin'),
        objectUrls: {
            create: (blob) => `blob:${made.push(blob)}`,
            revoke: (url) => revoked.push(url),
        },
    })
    chooser.address.value = parts.server.base
    await chooser.connect()
    await settle()
    assert.deepEqual([...chooser.thumbnails.value], [['a', 'blob:1']])
    assert.equal(made[0]?.type, 'image/png')
    assert.ok(!parts.server.requests.some((request) => request.url.startsWith('https://192.168.')))
    chooser.cancel()
    assert.deepEqual(revoked, ['blob:1'])
    assert.equal(chooser.thumbnails.value.size, 0)
})
