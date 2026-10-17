import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { createScp } from '../../scripts/release-assets.mjs'
import { loadEffectFromUrls } from '../../src/preview/assets/effect'
import { createAssetLoader } from '../../src/preview/assets/loader'
import { readItem } from '../../src/preview/assets/scpItem'
import {
    AssetError,
    sfxSlots,
    type AssetChoice,
    type AssetDefaults,
    type LoadContext,
    type Loaded,
    type SfxSlot,
} from '../../src/preview/assets/types'
import { loadParticle } from '../../src/preview/particle'
import { loadSkin } from '../../src/preview/skin'

// The loader tests pass a fake defaults provider and never import the web defaults.
const background = { url: 'bg', aspectRatio: 16 / 9, fit: 'cover', color: 'transparent', blur: 0 }
const fakeDefaults = (overrides: Partial<AssetDefaults> = {}): AssetDefaults => ({
    skin: async () => ({ title: 'default skin' }) as Loaded['skin'],
    particle: async () => ({ title: 'default particle' }) as Loaded['particle'],
    background: async () => background as Loaded['background'],
    effect: async () => ({ title: 'default effect' }) as Loaded['effect'],
    ...overrides,
})
const context = (signal = new AbortController().signal): LoadContext => ({
    signal,
    decodeAudio: async () => ({}) as AudioBuffer,
})
const fileChoice: AssetChoice = {
    source: 'file',
    key: 'abc',
    name: 'item',
    title: 'Item',
    author: 'Author',
    origin: 'item.scp',
}
const slotUrls = Object.fromEntries(sfxSlots.map((slot) => [slot, `/${slot}.mp3`])) as Record<
    SfxSlot,
    string
>

test('the default is used when the choice is Default', async () => {
    const loader = createAssetLoader({ defaults: fakeDefaults() })
    const result = await loader.load('skin', { source: 'default' }, context())
    assert.equal(result?.value.title, 'default skin')
    assert.deepEqual(result?.status, { active: 'default', reason: undefined })
})

test('a chosen source with a provider is used and says so', async () => {
    const loader = createAssetLoader({
        defaults: fakeDefaults(),
        providers: { skin: async () => ({ title: 'chosen skin' }) as Loaded['skin'] },
    })
    const result = await loader.load('skin', fileChoice, context())
    assert.equal(result?.value.title, 'chosen skin')
    assert.deepEqual(result?.status, { active: 'chosen' })
})

test('a failing or absent chosen provider falls back to Default with the reason', async (t) => {
    t.mock.method(console, 'error', () => {})
    const loader = createAssetLoader({
        defaults: fakeDefaults(),
        providers: {
            particle: async () => {
                throw new AssetError('missing', 'not stored')
            },
            effect: async () => {
                throw new Error('unexpected')
            },
        },
    })
    assert.deepEqual((await loader.load('particle', fileChoice, context()))?.status, {
        active: 'default',
        reason: 'missing',
    })
    assert.deepEqual((await loader.load('effect', fileChoice, context()))?.status, {
        active: 'default',
        reason: 'corrupt',
    })
    assert.deepEqual((await loader.load('background', fileChoice, context()))?.status, {
        active: 'default',
        reason: 'unavailable',
    })
})

test('a Default that is missing rejects as missing', async () => {
    const loader = createAssetLoader({ defaults: fakeDefaults({ skin: async () => undefined }) })
    await assert.rejects(
        loader.load('skin', { source: 'default' }, context()),
        (error) => error instanceof AssetError && error.code === 'missing',
    )
})

test('a Default that fails rejects with its own error', async () => {
    const failure = new Error('HTTP 500')
    const loader = createAssetLoader({
        defaults: fakeDefaults({
            skin: async () => {
                throw failure
            },
        }),
    })
    await assert.rejects(loader.load('skin', { source: 'default' }, context()), failure)
})

test('an aborted load resolves undefined and does not fall back', async () => {
    const controller = new AbortController()
    let defaultsCalled = false
    const loader = createAssetLoader({
        defaults: fakeDefaults({
            skin: async () => {
                defaultsCalled = true
                return undefined
            },
        }),
        providers: {
            skin: async () => {
                controller.abort()
                throw new Error('aborted')
            },
        },
    })
    assert.equal(await loader.load('skin', fileChoice, context(controller.signal)), undefined)
    assert.equal(defaultsCalled, false)

    const late = new AbortController()
    const lateLoader = createAssetLoader({
        defaults: fakeDefaults({
            skin: async () => {
                late.abort()
                return undefined
            },
        }),
    })
    assert.equal(
        await lateLoader.load('skin', { source: 'default' }, context(late.signal)),
        undefined,
    )
})

test('readItem reads the first item, or a named one, and resources by SRL URL', () => {
    const items = ['a', 'b'].map((name) => ({ name, title: name, data: { url: '/data' } }))
    const bytes = createScp({
        'sonolus/skins/list': Buffer.from(JSON.stringify({ items })),
        'sonolus/skins/b': Buffer.from(
            JSON.stringify({ item: { name: 'b', title: 'details of b', data: { url: '/data' } } }),
        ),
        data: Buffer.from('payload'),
    })
    const buffer = Uint8Array.from(bytes).buffer

    const first = readItem<{ name: string; title: string }>(buffer, 'skins')
    assert.equal(first?.item.name, 'a')
    const named = readItem<{ name: string; title: string }>(buffer, 'skins', 'b')
    assert.equal(named?.item.title, 'details of b')
    assert.equal(Buffer.from(named?.getResource({ url: '/data' }) ?? []).toString(), 'payload')
    assert.equal(named?.getResource({ url: null }), undefined)
    assert.equal(named?.getResource({}), undefined)
    assert.equal(named?.getResource(undefined), undefined)
    assert.equal(named?.getResource({ url: '/missing' }), undefined)
    assert.equal(readItem(buffer, 'skins', 'c'), undefined)
    assert.equal(readItem(buffer, 'particles'), undefined)
})

test('the skin and particle parsers take details and a resource getter', async (t) => {
    const texture = { close() {} } as ImageBitmap
    Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: async () => texture,
    })
    t.after(() => {
        Reflect.deleteProperty(globalThis, 'createImageBitmap')
    })
    const data = gzipSync(
        JSON.stringify({ width: 1, height: 1, interpolation: false, sprites: [], effects: [] }),
    )
    const requested: (string | null | undefined)[] = []
    const getResource = (srl: { url?: string | null } | undefined) => {
        requested.push(srl?.url)
        return srl?.url === '/data' ? new Uint8Array(data) : new Uint8Array(1)
    }
    const item = { name: 'x', title: 'X', data: { url: '/data' }, texture: { url: '/texture' } }

    const skin = await loadSkin(item as never, getResource)
    assert.equal(skin.title, 'X')
    assert.equal(skin.texture, texture)
    assert.equal(skin.interpolation, false)
    assert.deepEqual(requested, ['/data', '/texture'])
    assert.equal((await loadParticle(item as never, getResource)).title, 'X')

    await assert.rejects(
        loadSkin(item as never, () => undefined),
        /Missing skin data/,
    )
    await assert.rejects(
        loadParticle(item as never, (srl) =>
            srl?.url === '/data' ? new Uint8Array(data) : undefined,
        ),
        /Missing particle texture/,
    )
})

test('a synthetic effect decodes each slot and leaves a failing one undefined', async (t) => {
    const fetched: string[] = []
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        fetched.push(url)
        return { arrayBuffer: async () => new TextEncoder().encode(url).buffer } as Response
    })
    const effect = await loadEffectFromUrls('Fake', slotUrls, {
        signal: new AbortController().signal,
        decodeAudio: async (data) => {
            const url = new TextDecoder().decode(data)
            if (url === '/criticalTrace.mp3') throw new Error('cannot decode')
            return { url } as unknown as AudioBuffer
        },
    })
    assert.equal(effect?.title, 'Fake')
    assert.equal(fetched.length, 10)
    assert.equal(effect?.buffers.criticalTrace, undefined)
    assert.deepEqual(effect?.buffers.normalTap, { url: '/normalTap.mp3' })
    assert.deepEqual(Object.keys(effect?.buffers ?? {}).sort(), [...sfxSlots].sort())
})

test('an aborted effect load resolves undefined', async (t) => {
    const controller = new AbortController()
    t.mock.method(globalThis, 'fetch', async () => {
        controller.abort()
        return { arrayBuffer: async () => new ArrayBuffer(0) } as Response
    })
    assert.equal(await loadEffectFromUrls('Fake', slotUrls, context(controller.signal)), undefined)
})
