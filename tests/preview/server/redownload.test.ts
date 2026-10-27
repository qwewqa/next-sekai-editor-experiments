import assert from 'node:assert/strict'
import test from 'node:test'
import { storedChoice } from '../../../src/preview/assets/files/chooser'
import { createStoredProviders } from '../../../src/preview/assets/files/provider'
import { createMemoryStore } from '../../../src/preview/assets/files/store'
import { createAssetLoader } from '../../../src/preview/assets/loader'
import { fallbackOf } from '../../../src/preview/assets/notices'
import { createServerChooser } from '../../../src/preview/assets/server/chooser'
import { createServerClient } from '../../../src/preview/assets/server/client'
import { createRedownload, followedChoices } from '../../../src/preview/assets/server/redownload'
import type {
    AssetChoice,
    AssetDefaults,
    LoadContext,
    Loaded,
} from '../../../src/preview/assets/types'
import { scpEntries } from '../files/fixtures'
import { createFakeServer, filesFromEntries } from './fakeServer'

// A server item whose package left storage is downloaded again at load, and Default is used when
// that cannot be done.

Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({ width: 64, height: 64, close() {} }),
})

const context = (): LoadContext => ({
    signal: new AbortController().signal,
    decodeAudio: async () => ({ duration: 1 }) as AudioBuffer,
})

const defaults: AssetDefaults = {
    skin: async () => ({ title: 'default skin' }) as unknown as Loaded['skin'],
    particle: async () => ({ title: 'default particle' }) as Loaded['particle'],
    background: async () => ({ title: 'default background' }) as unknown as Loaded['background'],
    effect: async () => ({ title: 'default effect' }) as Loaded['effect'],
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** A server with one skin, chosen through the chooser, so the choice is what a real one would be. */
const chosen = async (title = 'Neon Skin') => {
    const server = createFakeServer({
        files: filesFromEntries(scpEntries('skin', { name: 'neon', title })),
    })
    const store = createMemoryStore()
    const net = { online: true }
    const client = createServerClient({
        fetch: server.fetch,
        language: () => 'en',
        isOnline: () => net.online,
    })
    let choice: AssetChoice | undefined
    const chooser = createServerChooser('skin', {
        client,
        store,
        maxTextureSide: () => 4096,
        decodeImage: async () => undefined,
        decodeAudio: async () => ({ duration: 1 }) as AudioBuffer,
        apply: (choices) => (choice = choices.skin),
        describe: (error) => error.code,
        toChoice: storedChoice,
        recent: () => [],
        remember: () => {},
        close: () => {},
    })
    chooser.address.value = server.base
    await chooser.connect()
    await chooser.use()
    assert.ok(choice)
    return { server, store, client, net, choice, served: server.requests.length }
}

const loaderOver = (parts: Awaited<ReturnType<typeof chosen>>, replaced: [string, string][] = []) =>
    createAssetLoader({
        defaults,
        providers: createStoredProviders({
            store: parts.store,
            maxTextureSide: () => 4096,
            redownload: createRedownload({
                client: parts.client,
                store: parts.store,
                maxTextureSide: () => 4096,
                decodeImage: async () => undefined,
                replace: (_type, oldKey, record) => replaced.push([oldKey, record.key]),
            }),
        }),
    })

const evict = async (parts: Awaited<ReturnType<typeof chosen>>) => {
    assert.equal(parts.choice.source, 'server')
    if (parts.choice.source === 'server') await parts.store.remove(parts.choice.key)
}

test('a stored server item loads without asking the server', async () => {
    const parts = await chosen()
    const before = parts.server.requests.length
    const result = await loaderOver(parts).load('skin', parts.choice, context())
    assert.deepEqual(result?.status, { active: 'chosen' })
    assert.equal(parts.server.requests.length, before)
})

test('a server item missing from the store is downloaded again, stored and chosen', async () => {
    const parts = await chosen()
    await evict(parts)
    assert.deepEqual(await parts.store.list(), [])
    const before = parts.server.requests.length
    const replaced: [string, string][] = []
    const result = await loaderOver(parts, replaced).load('skin', parts.choice, context())

    assert.deepEqual(result?.status, { active: 'chosen' })
    assert.equal(result?.value.title, 'Neon Skin')
    assert.ok(parts.server.requests.length > before)
    // Stored again under the same key, so the setting needs no change.
    const [meta] = await parts.store.list()
    assert.equal(meta?.key, parts.choice.source === 'server' && parts.choice.key)
    assert.deepEqual(replaced, [])
})

test('an item the server changed comes back under a new key, which the choice follows', async () => {
    const parts = await chosen()
    await evict(parts)
    const newer = scpEntries('skin', { name: 'neon', title: 'Neon Skin 2' })
    parts.server.files.clear()
    for (const [path, body] of Object.entries(filesFromEntries(newer)))
        parts.server.files.set(path, body)
    const replaced: [string, string][] = []
    const result = await loaderOver(parts, replaced).load('skin', parts.choice, context())
    assert.equal(result?.value.title, 'Neon Skin 2')
    const [meta] = await parts.store.list()
    assert.equal(replaced.length, 1)
    assert.deepEqual(replaced[0], [
        parts.choice.source === 'server' ? parts.choice.key : '',
        meta?.key,
    ])
})

test('offline, Default is used, the reason is being offline, and the choice is untouched', async (t) => {
    t.mock.method(console, 'error', () => {})
    const parts = await chosen()
    await evict(parts)
    const before = parts.server.requests.length
    parts.net.online = false
    const result = await loaderOver(parts).load('skin', parts.choice, context())
    assert.equal(result?.value.title, 'default skin')
    assert.deepEqual(result?.status, { active: 'default', reason: 'offline' })
    const fallback = fallbackOf('skin', {
        state: 'ready',
        choice: parts.choice,
        status: result!.status,
    })
    assert.equal(fallback?.reason, 'offline')
    assert.equal(parts.server.requests.length, before)
    assert.deepEqual(await parts.store.list(), [])
})

test("a server that cannot be reached gives Default, with the server's reason", async (t) => {
    t.mock.method(console, 'error', () => {})
    const parts = await chosen()
    await evict(parts)
    parts.server.state.failing = true
    const result = await loaderOver(parts).load('skin', parts.choice, context())
    assert.equal(result?.value.title, 'default skin')
    assert.deepEqual(result?.status, { active: 'default', reason: 'unavailable' })
    const fallback = fallbackOf('skin', {
        state: 'ready',
        choice: parts.choice,
        status: result!.status,
    })
    assert.equal(fallback?.reason, 'serverFailed')
    assert.equal(fallback?.origin, parts.server.base)
    assert.deepEqual(await parts.store.list(), [])
})

test('an item the server no longer has is a failed download, not a bad item', async (t) => {
    t.mock.method(console, 'error', () => {})
    const parts = await chosen()
    await evict(parts)
    parts.server.files.delete('/sonolus/skins/neon')
    parts.server.files.delete('/sonolus/skins/list')
    const result = await loaderOver(parts).load('skin', parts.choice, context())
    assert.deepEqual(result?.status, { active: 'default', reason: 'missing' })
})

test('an item that no longer passes the checks falls back as unreadable', async (t) => {
    t.mock.method(console, 'error', () => {})
    const parts = await chosen()
    await evict(parts)
    parts.server.files.clear()
    for (const [path, body] of Object.entries(
        filesFromEntries(scpEntries('skin', { name: 'neon', hashes: 'bad' })),
    ))
        parts.server.files.set(path, body)
    const result = await loaderOver(parts).load('skin', parts.choice, context())
    assert.deepEqual(result?.status, { active: 'default', reason: 'corrupt' })
    assert.deepEqual(await parts.store.list(), [])
})

test('a file choice that is gone is not looked for on a server', async (t) => {
    t.mock.method(console, 'error', () => {})
    const parts = await chosen()
    await evict(parts)
    const before = parts.server.requests.length
    const fileChoice: AssetChoice = {
        source: 'file',
        key: 'gone',
        name: 'neon',
        title: 'Neon',
        author: '',
        origin: parts.server.base,
    }
    const result = await loaderOver(parts).load('skin', fileChoice, context())
    assert.deepEqual(result?.status, { active: 'default', reason: 'missing' })
    assert.equal(parts.server.requests.length, before)
    await settle()
})

test('a server item is downloaded again even when the store cannot be read', async () => {
    const parts = await chosen()
    const unreadable = {
        ...parts.store,
        get: () => Promise.reject(new Error('The storage worker did not start')),
    }
    const result = await loaderOver({ ...parts, store: unreadable }).load(
        'skin',
        parts.choice,
        context(),
    )
    assert.deepEqual(result?.status, { active: 'chosen' })
    assert.equal(result?.value.title, 'Neon Skin')
})

test('a downloaded item that does not read back is used this time, and the choice stays', async (t) => {
    t.mock.method(console, 'error', () => {})
    const parts = await chosen()
    await evict(parts)
    const newer = scpEntries('skin', { name: 'neon', title: 'Neon Skin 2' })
    parts.server.files.clear()
    for (const [path, body] of Object.entries(filesFromEntries(newer)))
        parts.server.files.set(path, body)
    // The store takes the record but gives back other bytes.
    const lossy = {
        ...parts.store,
        get: async (key: string) => {
            const record = await parts.store.get(key)
            return record && { ...record, bytes: new Blob([new Uint8Array(record.size)]) }
        },
    }
    const replaced: [string, string][] = []
    const result = await loaderOver({ ...parts, store: lossy }, replaced).load(
        'skin',
        parts.choice,
        context(),
    )
    assert.deepEqual(result?.status, { active: 'chosen' })
    assert.equal(result?.value.title, 'Neon Skin 2')
    assert.deepEqual(replaced, [])
    // An uncertain shared row stays, while this load keeps its independently checked bytes.
    const [stored] = await parts.store.list()
    assert.equal(stored?.title, 'Neon Skin 2')
    assert.notEqual(stored?.key, parts.choice.source === 'server' && parts.choice.key)
})

test('the choice follows a new key only while it still names the old one', () => {
    const server = (key: string): AssetChoice => ({
        source: 'server',
        key,
        name: 'neon',
        title: 'Neon',
        author: 'A',
        origin: 'https://server.test/api',
    })
    const choices = {
        skin: server('old'),
        particle: { source: 'default' },
        background: { source: 'default' },
        effect: { source: 'default' },
    } satisfies Record<string, AssetChoice>
    const record = {
        key: 'new',
        title: 'Neon 2',
        author: 'B',
        origin: 'https://server.test/v2',
    } as Parameters<typeof followedChoices>[3]
    assert.deepEqual(followedChoices(choices, 'skin', 'old', record)?.skin, {
        ...server('new'),
        title: 'Neon 2',
        author: 'B',
        origin: 'https://server.test/v2',
    })
    // The user picked another item, or Default, while it downloaded.
    assert.equal(
        followedChoices({ ...choices, skin: server('other') }, 'skin', 'old', record),
        undefined,
    )
    assert.equal(
        followedChoices({ ...choices, skin: { source: 'default' } }, 'skin', 'old', record),
        undefined,
    )
})
