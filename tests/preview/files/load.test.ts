import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { shallowRef } from 'vue'
import { checkParticleData, checkSkinData } from '../../../src/preview/assets/files/itemData'
import { createStoredProviders } from '../../../src/preview/assets/files/provider'
import { createMemoryStore, type UserAssetStore } from '../../../src/preview/assets/files/store'
import { createAssetLoader } from '../../../src/preview/assets/loader'
import { fallbackOf } from '../../../src/preview/assets/notices'
import { createAssetSession } from '../../../src/preview/assets/session'
import {
    AssetError,
    type AssetChoice,
    type AssetDefaults,
    type AssetType,
    type LoadContext,
    type Loaded,
} from '../../../src/preview/assets/types'
import {
    audioZip,
    backgroundData,
    concat,
    decodeTestAudio,
    effectData,
    gz,
    particleData,
    png,
    pngHeader,
    rawZip,
    scp,
    scpEntries,
    skinData,
    utf8,
    wav,
} from './fixtures'

// Fallback at load (Part 2, 2.4.2, 2.5.5): a stored package is checked again under the same
// limits, and one that fails falls back to Default with a reason, whatever stored it.

const closed: ImageBitmap[] = []
const bitmap = (size = { width: 64, height: 64 }) => {
    const texture = {
        ...size,
        close() {
            closed.push(this as unknown as ImageBitmap)
        },
    }
    return texture
}
Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => bitmap(),
})

const decodeAudio = decodeTestAudio
const context = (signal = new AbortController().signal): LoadContext => ({ signal, decodeAudio })

const defaults: AssetDefaults = {
    skin: async () => ({ title: 'default skin', texture: bitmap() }) as unknown as Loaded['skin'],
    particle: async () => ({ title: 'default particle' }) as Loaded['particle'],
    background: async () => ({ title: 'default background' }) as unknown as Loaded['background'],
    effect: async () => ({ title: 'default effect' }) as Loaded['effect'],
}

const choiceFor = (key: string, name = 'fixture'): AssetChoice => ({
    source: 'file',
    key,
    name,
    title: 'Fixture',
    author: 'Author',
    origin: 'fixture.scp',
})

let counter = 0
/** Puts bytes into the store as a stored package would be, whatever they hold. */
const stored = async (
    store: UserAssetStore,
    type: AssetType,
    bytes: Uint8Array,
    name = 'fixture',
) => {
    const key = `key${counter++}`
    await store.put({
        key,
        type,
        name,
        title: 'Fixture',
        author: 'Author',
        origin: 'fixture.scp',
        bytes: new Blob([new Uint8Array(bytes)]),
        size: bytes.length,
        addedAt: 1,
        lastUsedAt: 1,
    })
    return choiceFor(key, name)
}

const loaderOver = (store: UserAssetStore) =>
    createAssetLoader({
        defaults,
        providers: createStoredProviders({ store, maxTextureSide: () => 4096 }),
    })

const load = async (type: AssetType, bytes: Uint8Array) => {
    const store = createMemoryStore()
    const choice = await stored(store, type, bytes)
    return loaderOver(store).load(type, choice, context())
}

test('a valid stored item of each type loads as the chosen source', async () => {
    for (const type of ['skin', 'particle', 'background', 'effect'] as const) {
        const result = await load(type, scp(type))
        assert.deepEqual(result?.status, { active: 'chosen' }, type)
        assert.equal((result?.value as { title: string }).title, 'Fixture')
    }
})

test('SRLs with null or absent hashes load', async () => {
    for (const hashes of ['null', 'omit'] as const)
        for (const type of ['skin', 'particle', 'background', 'effect'] as const) {
            const result = await load(type, scp(type, { hashes }))
            assert.equal(result?.status.active, 'chosen', `${type} ${hashes}`)
        }
})

test('a background with no aspect ratio uses its image’s own', async () => {
    const result = await load('background', scp('background'))
    const background = result?.value as Loaded['background']
    assert.equal(background.aspectRatio, 160 / 90)
    background.dispose?.()
    const withRatio = await load(
        'background',
        scp('background', { resources: { data: gz(backgroundData({ aspectRatio: 2 })) } }),
    )
    assert.equal((withRatio?.value as Loaded['background']).aspectRatio, 2)
})

test('a stored package that is missing falls back to Default and says it is missing', async (t) => {
    t.mock.method(console, 'error', () => {})
    const store = createMemoryStore()
    const result = await loaderOver(store).load('skin', choiceFor('gone'), context())
    assert.equal(result?.value.title, 'default skin')
    assert.deepEqual(result?.status, { active: 'default', reason: 'missing' })
})

/** A particle package whose only effect has these groups. */
const particleWith = (groups: unknown[]) =>
    scp('particle', {
        resources: {
            data: gz(particleData({ effects: [{ ...particleData().effects[0], groups }] })),
        },
    })
const oneParticle = particleData().effects[0]!.groups[0]!.particles[0]

const ratioTexture = concat(png(64, 64), new Uint8Array(30_000_000))

const broken: [string, AssetType, Uint8Array][] = [
    ['a huge count with no particles', 'particle', particleWith([{ count: 1e15, particles: [] }])],
    [
        'a tiny count over many particles',
        'particle',
        particleWith([
            { count: 0.005, particles: Array.from({ length: 100_000 }, () => oneParticle) },
        ]),
    ],
    [
        'many groups with no count',
        'particle',
        particleWith(Array.from({ length: 200_000 }, () => ({ count: 0, particles: [] }))),
    ],
    ['a bad end record', 'skin', scp('skin').slice(0, -10)],
    ['ZIP64', 'skin', rawZip(scpEntries('skin'), { zip64End: true })],
    [
        'a ratio bomb',
        'skin',
        rawZip(
            // A texture whose header passes, so only the ratio refuses it.
            scpEntries('skin', { resources: { texture: ratioTexture } }).map((entry) =>
                entry.data.length === ratioTexture.length
                    ? { ...entry, method: 8 as const }
                    : entry,
            ),
        ),
    ],
    [
        'invalid JSON',
        'skin',
        scp('skin', { resources: { data: new Uint8Array(gzipSync('not json')) } }),
    ],
    ['a wrong schema', 'skin', scp('skin', { resources: { data: gz({ width: 'wide' }) } })],
    [
        'NaN',
        'skin',
        scp('skin', {
            resources: {
                data: new Uint8Array(
                    gzipSync(
                        '{"width":64,"height":64,"sprites":[{"name":"a","x":NaN,"y":0,"w":1,"h":1}]}',
                    ),
                ),
            },
        }),
    ],
    [
        'an infinite number',
        'skin',
        scp('skin', {
            resources: {
                data: new Uint8Array(
                    gzipSync(
                        '{"width":64,"height":64,"sprites":[{"name":"a","x":1e999,"y":0,"w":1,"h":1}]}',
                    ),
                ),
            },
        }),
    ],
    ['an SRL SHA-1 mismatch', 'skin', scp('skin', { hashes: 'bad' })],
    [
        'an oversized texture',
        'skin',
        scp('skin', { resources: { texture: pngHeader(8192, 8192) } }),
    ],
    [
        'a particle over the count cap',
        'particle',
        scp('particle', {
            resources: {
                data: gz(
                    particleData({
                        effects: [
                            {
                                ...particleData().effects[0],
                                groups: [{ ...particleData().effects[0]!.groups[0], count: 600 }],
                            },
                        ],
                    }),
                ),
            },
        }),
    ],
    [
        'sound effects without #PERFECT',
        'effect',
        scp('effect', {
            resources: {
                data: gz(effectData({ clips: [{ name: 'Sekai Tick', filename: 'tick.mp3' }] })),
                audio: audioZip({ 'tick.mp3': wav(1) }),
            },
        }),
    ],
    [
        'a clip that will not decode',
        'effect',
        scp('effect', { resources: { audio: audioZip({ 'perfect.mp3': wav(1, true) }) } }),
    ],
    [
        'a missing resource',
        'skin',
        rawZip(scpEntries('skin').filter((entry) => entry.data.length !== png(64, 64).length)),
    ],
    [
        'a name that climbs out',
        'skin',
        rawZip([...scpEntries('skin'), { name: '../up', data: utf8('x') }]),
    ],
]

test('a stored package that fails a check falls back to Default as unreadable', async (t) => {
    t.mock.method(console, 'error', () => {})
    for (const [name, type, bytes] of broken) {
        const result = await load(type, bytes)
        assert.deepEqual(result?.status, { active: 'default', reason: 'corrupt' }, name)
    }
})

test('a stored package that cannot be decoded falls back as unreadable', async (t) => {
    t.mock.method(console, 'error', () => {})
    const decoder = globalThis.createImageBitmap
    Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: async () => {
            throw new Error('The source image could not be decoded')
        },
    })
    try {
        const result = await load('skin', scp('skin'))
        assert.deepEqual(result?.status, { active: 'default', reason: 'corrupt' })
    } finally {
        Object.defineProperty(globalThis, 'createImageBitmap', {
            configurable: true,
            value: decoder,
        })
    }
})

test('a stored background whose image does not decode falls back as unreadable', async (t) => {
    t.mock.method(console, 'error', () => {})
    const decoder = globalThis.createImageBitmap
    Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: async () => {
            throw new Error('The source image could not be decoded')
        },
    })
    try {
        const result = await load('background', scp('background'))
        assert.deepEqual(result?.status, { active: 'default', reason: 'corrupt' })
    } finally {
        Object.defineProperty(globalThis, 'createImageBitmap', {
            configurable: true,
            value: decoder,
        })
    }
})

test('a store that does not answer falls back as unavailable', async (t) => {
    t.mock.method(console, 'error', () => {})
    const store: UserAssetStore = {
        ...createMemoryStore(),
        get: () => Promise.reject(new Error('The storage worker did not start')),
    }
    const result = await loaderOver(store).load('skin', choiceFor('any'), context())
    assert.deepEqual(result?.status, { active: 'default', reason: 'unavailable' })
})

test('a sprite outside the texture is refused at import and dropped at load', () => {
    const data = skinData({
        sprites: [
            { name: 'in', x: 0, y: 0, w: 16, h: 16, transform: {} },
            { name: 'out', x: 60, y: 0, w: 16, h: 16, transform: {} },
        ],
    })
    assert.throws(() => checkSkinData(data, 'import'), { code: 'spriteOutside' })
    assert.deepEqual(
        checkSkinData(data, 'load').sprites.map((sprite) => sprite.name),
        ['in'],
    )
})

test('a stored skin with a bad sprite still loads, without the sprite', async () => {
    const result = await load(
        'skin',
        scp('skin', {
            resources: {
                data: gz(
                    skinData({
                        sprites: [{ name: 'out', x: 60, y: 0, w: 16, h: 16, transform: {} }],
                    }),
                ),
            },
        }),
    )
    assert.equal(result?.status.active, 'chosen')
})

test('transforms, eases and colours are rebuilt from what passed', () => {
    const [effect] = particleData().effects
    assert.ok(effect)
    const hostile = {
        ...effect,
        groups: effect.groups.map((group) => ({
            ...group,
            particles: group.particles.map((particle) => ({
                ...particle,
                color: 'url(javascript:alert(1))',
                x: { from: { c: 1, constructor: 5, __proto__: 7 }, ease: 'constructor' },
            })),
        })),
    }
    const data = checkParticleData(particleData({ effects: [hostile] }))
    const particle = data.effects[0]?.groups[0]?.particles[0]
    assert.equal(particle?.color, '#ffffff')
    assert.equal(particle?.x.ease, 'linear')
    assert.deepEqual(Object.keys(particle?.x.from ?? {}), ['c'])
})

test('a missing stored package leaves the choice as it was, with the reason shown', async (t) => {
    t.mock.method(console, 'error', () => {})
    const choice = choiceFor('gone')
    const choices = shallowRef<Record<AssetType, AssetChoice>>({
        skin: choice,
        particle: { source: 'default' },
        background: { source: 'default' },
        effect: { source: 'default' },
    })
    const session = createAssetSession({
        loader: loaderOver(createMemoryStore()),
        choices: () => choices.value,
        decodeAudio,
    })
    session.ensure('skin')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const slot = session.slots.skin.value
    assert.equal(slot.state, 'ready')
    assert.deepEqual(slot.status, { active: 'default', reason: 'missing' })
    // The setting is untouched, and the row says why Default is used.
    assert.deepEqual(choices.value.skin, choice)
    const fallback = fallbackOf('skin', slot)
    assert.equal(fallback?.reason, 'fileGone')
    assert.equal(fallback.using, 'default')
    session.dispose()
})

test('when a switch fails everywhere, a stored item that was showing keeps showing', async (t) => {
    t.mock.method(console, 'error', () => {})
    const store = createMemoryStore()
    const first = await stored(store, 'skin', scp('skin', { title: 'Neon Skin' }))
    const choices = shallowRef<Record<AssetType, AssetChoice>>({
        skin: first,
        particle: { source: 'default' },
        background: { source: 'default' },
        effect: { source: 'default' },
    })
    const failing: AssetDefaults = {
        ...defaults,
        skin: () => Promise.reject(new AssetError('unavailable', 'offline')),
    }
    const session = createAssetSession({
        loader: createAssetLoader({
            defaults: failing,
            providers: createStoredProviders({ store, maxTextureSide: () => 4096 }),
        }),
        choices: () => choices.value,
        decodeAudio,
    })
    session.ensure('skin')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(session.slots.skin.value.status?.active, 'chosen')

    choices.value = { ...choices.value, skin: choiceFor('gone') }
    await new Promise((resolve) => setTimeout(resolve, 20))
    const slot = session.slots.skin.value
    assert.equal(slot.state, 'ready')
    assert.equal(slot.value?.title, 'Neon Skin')
    assert.equal(slot.status?.active, 'chosen')
    const fallback = fallbackOf('skin', slot)
    assert.equal(fallback?.using, 'stored')
    assert.equal(fallback.usingTitle, 'Neon Skin')
    session.dispose()
})
