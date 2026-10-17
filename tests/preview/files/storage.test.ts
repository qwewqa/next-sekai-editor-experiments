import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserAssetRecord } from '../../../src/local/userAssets'
import type { StorageStatus } from '../../../src/local/worker/core'
import { lazyStoredProviders } from '../../../src/preview/assets/files/lazy'
import { createStoredProviders } from '../../../src/preview/assets/files/provider'
import {
    createMemoryStore,
    createWorkerStore,
    refreshStored,
    storedLoaded,
    storedUnavailable,
    type StoreWorker,
} from '../../../src/preview/assets/files/store'
import { createAssetLoader } from '../../../src/preview/assets/loader'
import { reasonKey } from '../../../src/preview/assets/reasons'
import {
    AssetError,
    type AssetChoice,
    type AssetDefaults,
    type Loaded,
} from '../../../src/preview/assets/types'
import { decodeTestAudio, scp } from './fixtures'

// Storage that cannot be opened is not storage that lost the file (review A3 finding 3): the
// stored item cannot be read, which is its own reason, with no Choose Again.

/** A storage worker over a memory store, in the mode its status says. */
const fakeWorker = (mode: StorageStatus['mode']) => {
    const rows = createMemoryStore()
    const worker: StoreWorker = {
        status: { mode },
        call: (method, arg) => {
            switch (method) {
                case 'userAssetGet':
                    return rows.get(arg as string)
                case 'userAssetPut':
                    return rows.put(arg as UserAssetRecord)
                case 'userAssetList':
                    return rows.list()
                default:
                    return Promise.resolve()
            }
        },
    }
    return { rows, store: createWorkerStore(async () => worker) }
}

const choice: AssetChoice = {
    source: 'file',
    key: 'k'.repeat(64),
    name: 'fixture',
    title: 'Fixture',
    author: 'Author',
    origin: 'fixture.scp',
}

const defaults: AssetDefaults = {
    skin: async () => ({ title: 'default skin' }) as unknown as Loaded['skin'],
    particle: async () => ({ title: 'default particle' }) as Loaded['particle'],
    background: async () => ({ title: 'default background' }) as unknown as Loaded['background'],
    effect: async () => ({ title: 'default effect' }) as Loaded['effect'],
}

const loadSkin = (store: ReturnType<typeof fakeWorker>['store']) =>
    createAssetLoader({
        defaults,
        providers: createStoredProviders({ store, maxTextureSide: () => 4096 }),
    }).load('skin', choice, { signal: new AbortController().signal, decodeAudio: decodeTestAudio })

test('a package not found while storage runs in memory is unavailable, not gone', async (t) => {
    t.mock.method(console, 'error', () => {})
    const result = await loadSkin(fakeWorker('memory').store)
    assert.deepEqual(result?.status, { active: 'default', reason: 'unavailable' })
    assert.equal(reasonKey(choice, result.status), 'storageUnavailable')

    // Stored storage that does not have it: the file is gone.
    const gone = await loadSkin(fakeWorker('stored').store)
    assert.deepEqual(gone?.status, { active: 'default', reason: 'missing' })
    assert.equal(reasonKey(choice, gone.status), 'fileGone')
})

test('a package stored in memory this session still loads', async () => {
    const { rows, store } = fakeWorker('memory')
    const bytes = scp('skin')
    await rows.put({
        key: choice.source === 'file' ? choice.key : '',
        type: 'skin',
        name: 'fixture',
        title: 'Fixture',
        author: 'Author',
        origin: 'fixture.scp',
        bytes: new Blob([new Uint8Array(bytes)]),
        size: bytes.length,
        addedAt: 1,
        lastUsedAt: 1,
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: async () => ({ width: 64, height: 64, close: () => undefined }),
    })
    const result = await loadSkin(store)
    assert.deepEqual(result?.status, { active: 'chosen' })
})

test('the Stored tab knows when storage could not be opened', async () => {
    await refreshStored(fakeWorker('memory').store)
    assert.equal(storedLoaded.value, true)
    assert.equal(storedUnavailable.value, true)

    await refreshStored(fakeWorker('stored').store)
    assert.equal(storedUnavailable.value, false)

    await refreshStored({
        ...createMemoryStore(),
        list: () => Promise.reject(new Error('The storage worker did not start')),
    })
    assert.equal(storedUnavailable.value, true)
})

test('a reader chunk that failed to load is unavailable, and is tried again', async () => {
    let attempts = 0
    const providers = lazyStoredProviders(async () => {
        attempts++
        if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module')
        return {
            createStoredProviders: () => ({
                skin: async () => ({ title: 'loaded' }) as unknown as Loaded['skin'],
            }),
        } as unknown as typeof import('../../../src/preview/assets/files/provider')
    })
    const context = { signal: new AbortController().signal, decodeAudio: decodeTestAudio }
    await assert.rejects(
        providers.skin!(choice as never, context),
        (error: unknown) => error instanceof AssetError && error.code === 'unavailable',
    )
    const loaded = await providers.skin!(choice as never, context)
    assert.equal(loaded.title, 'loaded')
    assert.equal(attempts, 2)
})
