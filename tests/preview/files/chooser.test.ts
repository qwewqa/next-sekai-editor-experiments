import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAssetChooser, type ChooserDeps } from '../../../src/preview/assets/files/chooser'
import type { AssetImportError } from '../../../src/preview/assets/files/errors'
import {
    formatImportMessage,
    type ImportStrings,
} from '../../../src/preview/assets/files/importMessage'
import { createMemoryStore } from '../../../src/preview/assets/files/store'
import type { AssetChoice, AssetType } from '../../../src/preview/assets/types'
import {
    audioZip,
    blobOf,
    effectData,
    gz,
    rawZip,
    scp,
    scpEntries,
    scpMulti,
    utf8,
} from './fixtures'

const en = (
    JSON.parse(readFileSync('src/i18n/en/index.json', 'utf8')) as {
        commands: { previewAssets: ImportStrings }
    }
).commands.previewAssets
const importMessage = (error: AssetImportError) =>
    formatImportMessage(error, en, (value) => new Intl.NumberFormat('en').format(value))

// The chooser's From a File view (Part 2, 2.6, 2.11): listing, "Also use … from this file", Use.

const setup = () => {
    const store = createMemoryStore()
    const applied: Partial<Record<AssetType, AssetChoice>>[] = []
    const deps: ChooserDeps = {
        store,
        maxTextureSide: () => 4096,
        decodeAudio: async () => ({ duration: 1 }) as AudioBuffer,
        apply: (choices) => applied.push(choices),
        describe: importMessage,
    }
    return { store, applied, deps }
}

const named = (name: string, title: string) => ({ name, title })
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

const collection = () =>
    scpMulti([
        ['skin', named('neon', 'Neon Skin')],
        ['particle', named('neon', 'Neon Particle')],
        ['background', named('other', 'Other Background')],
        ['effect', named('neon', 'Neon Sounds')],
    ])

test('the items of the chooser’s type are listed, and a lone one is selected', async () => {
    const { deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    chooser.show()
    assert.equal(chooser.open.value, true)
    assert.equal(chooser.phase.value, 'idle')

    await chooser.pick(blobOf(collection()), 'neon.scp')
    assert.equal(chooser.phase.value, 'listed')
    assert.equal(chooser.fileName.value, 'neon.scp')
    assert.deepEqual(
        chooser.items.value.map((item) => [item.name, item.title, item.author]),
        [['neon', 'Neon Skin', 'Author']],
    )
    assert.equal(chooser.selected.value, 'neon')
})

test('a file with none of the type lists nothing', async () => {
    const { deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    await chooser.pick(blobOf(scp('particle')), 'particles.scp')
    assert.equal(chooser.phase.value, 'listed')
    assert.deepEqual(chooser.items.value, [])
    assert.equal(chooser.selected.value, undefined)
})

test('other types are offered only when an item of the same name is in the file', async () => {
    const { deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    await chooser.pick(blobOf(collection()), 'neon.scp')
    await settle()
    // One checkbox per type, for the particle and the sound effects; the background has another name.
    assert.deepEqual(
        chooser.also.value.map((option) => [option.type, option.title, option.ticked]),
        [
            ['particle', 'Neon Particle', false],
            ['effect', 'Neon Sounds', false],
        ],
    )
})

test('a type whose lookup fails offers no checkbox', async () => {
    const { deps } = setup()
    const entries = scpEntries('skin', named('neon', 'Neon'))
    const particle = scpEntries('particle', named('neon', 'Neon'))
    // The effect's list is not JSON.
    const broken = [{ name: 'sonolus/effects/list', data: utf8('{"items": [') }]
    const chooser = createAssetChooser('skin', deps)
    const merged = new Map([...entries, ...particle, ...broken].map((entry) => [entry.name, entry]))
    await chooser.pick(blobOf(rawZip([...merged.values()])), 'neon.scp')
    await settle()
    assert.deepEqual(
        chooser.also.value.map((option) => option.type),
        ['particle'],
    )
})

test('with several items nothing is selected until one is, and the checkboxes follow it', async () => {
    const { deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    const bytes = scpMulti([
        ['skin', named('a', 'First')],
        [
            'skin',
            {
                ...named('b', 'Second'),
                resources: { data: gz({ width: 8, height: 8, sprites: [] }) },
            },
        ],
        ['particle', named('b', 'Second Particle')],
    ])
    await chooser.pick(blobOf(bytes), 'pack.scp')
    assert.deepEqual(
        chooser.items.value.map((item) => item.name),
        ['a', 'b'],
    )
    assert.equal(chooser.selected.value, undefined)
    const alsoTypes = () => chooser.also.value.map((option) => option.type)
    assert.deepEqual(alsoTypes(), [])

    chooser.select('a')
    await settle()
    assert.deepEqual(alsoTypes(), [])
    chooser.select('b')
    await settle()
    assert.deepEqual(alsoTypes(), ['particle'])
})

test('Use stores the selected item and every ticked one, and applies them together', async () => {
    const { store, applied, deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    await chooser.pick(blobOf(collection()), 'neon.scp')
    await settle()
    chooser.toggle('particle', true)
    await chooser.use()

    const stored = await store.list()
    assert.deepEqual(stored.map((meta) => meta.type).sort(), ['particle', 'skin'])
    assert.equal(applied.length, 1)
    const [choices] = applied
    assert.equal(choices?.skin?.source, 'file')
    assert.equal(choices?.skin?.source === 'file' && choices.skin.title, 'Neon Skin')
    assert.equal(choices?.skin?.source === 'file' && choices.skin.origin, 'neon.scp')
    assert.equal(choices?.particle?.source, 'file')
    assert.equal(choices?.effect, undefined)
    assert.equal(chooser.open.value, false)
})

test('Use with nothing ticked stores only the selected item', async () => {
    const { store, applied, deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    await chooser.pick(blobOf(collection()), 'neon.scp')
    await chooser.use()
    assert.deepEqual(
        (await store.list()).map((meta) => meta.type),
        ['skin'],
    )
    assert.deepEqual(Object.keys(applied[0] ?? {}), ['skin'])
})

test('a ticked item that fails stores nothing, and the chooser says why and stays open', async (t) => {
    t.mock.method(console, 'error', () => {})
    const { store, applied, deps } = setup()
    const chooser = createAssetChooser('skin', {
        ...deps,
        decodeAudio: async (data) => {
            if (new TextDecoder().decode(data).startsWith('bad')) throw new Error('no decode')
            return { duration: 1 } as AudioBuffer
        },
    })
    const bytes = scpMulti([
        ['skin', named('neon', 'Neon')],
        [
            'effect',
            {
                ...named('neon', 'Neon'),
                resources: {
                    data: gz(effectData()),
                    audio: audioZip({ 'perfect.mp3': utf8('bad data') }),
                },
            },
        ],
    ])
    await chooser.pick(blobOf(bytes), 'neon.scp')
    await settle()
    chooser.toggle('effect', true)
    await chooser.use()

    assert.deepEqual(await store.list(), [])
    assert.deepEqual(applied, [])
    assert.equal(chooser.open.value, true)
    assert.equal(chooser.phase.value, 'listed')
    assert.equal(
        chooser.error.value,
        'This file’s sound effects audio has no usable #PERFECT clip.',
    )
})

test('a file that is not a package says so and lists nothing', async () => {
    const { deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    await chooser.pick(blobOf(utf8('this is not a zip file')), 'notes.txt')
    assert.equal(chooser.phase.value, 'idle')
    assert.equal(chooser.error.value, 'This file is damaged or is not a Sonolus package.')
    assert.deepEqual(chooser.items.value, [])
})

test('cancelling while Use is working stores and applies nothing', async () => {
    const { store, applied, deps } = setup()
    const slow = createMemoryStore()
    const chooser = createAssetChooser('skin', {
        ...deps,
        store: {
            ...slow,
            put: async (record) => {
                await new Promise((resolve) => setTimeout(resolve, 30))
                return slow.put(record)
            },
        },
    })
    await chooser.pick(blobOf(collection()), 'neon.scp')
    const using = chooser.use()
    assert.equal(chooser.phase.value, 'working')
    chooser.cancel()
    await using
    assert.equal(chooser.open.value, false)
    assert.deepEqual(applied, [])
    assert.deepEqual(await store.list(), [])
})

test('a store that refuses is reported as a store problem', async (t) => {
    t.mock.method(console, 'error', () => {})
    const { deps } = setup()
    const chooser = createAssetChooser('skin', {
        ...deps,
        store: {
            ...createMemoryStore(),
            put: () => Promise.reject(new Error('Storing is read-only')),
        },
    })
    await chooser.pick(blobOf(collection()), 'neon.scp')
    await chooser.use()
    assert.equal(chooser.error.value, 'This item could not be stored.')
    assert.equal(chooser.phase.value, 'listed')
})
