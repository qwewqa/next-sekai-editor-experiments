import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    createAssetChooser,
    storedChoice,
    type ChooserDeps,
} from '../../../src/preview/assets/files/chooser'
import type { AssetImportError } from '../../../src/preview/assets/files/errors'
import {
    formatImportMessage,
    type ImportStrings,
} from '../../../src/preview/assets/files/importMessage'
import { importItem } from '../../../src/preview/assets/files/importer'
import { openSourcePackage } from '../../../src/preview/assets/files/package'
import { createMemoryStore } from '../../../src/preview/assets/files/store'
import type { AssetChoice, AssetType } from '../../../src/preview/assets/types'
import {
    audioZip,
    blobOf,
    decodeTestAudio,
    decodeTestImage,
    effectData,
    gz,
    rawZip,
    scp,
    scpEntries,
    scpMulti,
    sizeEn,
    utf8,
    wav,
} from './fixtures'

const en = (
    JSON.parse(readFileSync('src/i18n/en/index.json', 'utf8')) as {
        commands: { previewAssets: ImportStrings }
    }
).commands.previewAssets
const importMessage = (error: AssetImportError) =>
    formatImportMessage(error, en, (value) => new Intl.NumberFormat('en').format(value), sizeEn)

// The chooser's From a File view (Part 2, 2.6, 2.11): listing, "Also use … from this file", Use.

const setup = () => {
    const store = createMemoryStore()
    const applied: Partial<Record<AssetType, AssetChoice>>[] = []
    const deps: ChooserDeps = {
        store,
        maxTextureSide: () => 4096,
        decodeAudio: decodeTestAudio,
        decodeImage: decodeTestImage,
        apply: (choices) => applied.push(choices),
        describe: importMessage,
    }
    return { store, applied, deps }
}

const named = (name: string, title: string) => ({ name, title })

/** The record an import of a package's item makes. */
const recordOf = async (bytes: Uint8Array) =>
    importItem(await openSourcePackage(blobOf(bytes)), 'background', 'fixture', {
        maxTextureSide: 4096,
        decodeAudio: decodeTestAudio,
        decodeImage: decodeTestImage,
        signal: new AbortController().signal,
        origin: 'before.scp',
        now: () => 1,
    })
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    return { promise, resolve }
}

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
    let refreshed = 0
    const chooser = createAssetChooser('skin', {
        ...deps,
        onStorageChanged: () => refreshed++,
    })
    const bytes = scpMulti([
        ['skin', named('neon', 'Neon')],
        [
            'effect',
            {
                ...named('neon', 'Neon'),
                resources: {
                    data: gz(effectData()),
                    audio: audioZip({ 'perfect.mp3': wav(1, true) }),
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
        chooser.useError.value,
        'This file’s sound effects audio has no usable #PERFECT clip.',
    )
    assert.equal(chooser.error.value, undefined)
    assert.equal(refreshed, 0)
})

test('a file that is not a package says so and lists nothing', async () => {
    const { deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    await chooser.pick(blobOf(utf8('this is not a zip file')), 'notes.txt')
    assert.equal(chooser.phase.value, 'idle')
    assert.equal(chooser.error.value, 'This file is damaged or is not a Sonolus package.')
    assert.deepEqual(chooser.items.value, [])
})

test('cancelling after a storage attempt retains its complete package and refreshes after settlement', async () => {
    const { store, applied, deps } = setup()
    const started = deferred()
    const release = deferred()
    let refreshed = 0
    const chooser = createAssetChooser('skin', {
        ...deps,
        onStorageChanged: () => refreshed++,
        store: {
            ...store,
            putMany: async (records) => {
                started.resolve()
                await release.promise
                return store.putMany(records)
            },
        },
    })
    await chooser.pick(blobOf(scp('skin')), 'skin.scp')
    const using = chooser.use()
    await started.promise
    chooser.cancel()
    assert.equal(refreshed, 0)
    release.resolve()
    await using
    assert.equal(chooser.open.value, false)
    assert.deepEqual(applied, [])
    const [meta] = await store.list()
    assert.ok(meta)
    assert.equal((await store.get(meta.key))?.bytes.size, meta.size)
    assert.equal(refreshed, 1)
})

test('Use stores the ticked items in one write, so a failure stores none of them', async (t) => {
    t.mock.method(console, 'error', () => {})
    const { applied, deps } = setup()
    const memory = createMemoryStore()
    let writes = 0
    let refreshed = 0
    const chooser = createAssetChooser('skin', {
        ...deps,
        onStorageChanged: () => refreshed++,
        store: {
            ...memory,
            put: () => Promise.reject(new Error('one at a time is not all or nothing')),
            putMany: (records) => {
                writes++
                assert.equal(records.length, 2)
                return Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'))
            },
        },
    })
    await chooser.pick(blobOf(collection()), 'neon.scp')
    await settle()
    chooser.toggle('particle', true)
    await chooser.use()
    assert.equal(writes, 1)
    assert.deepEqual(await memory.list(), [])
    assert.deepEqual(applied, [])
    assert.equal(chooser.useError.value, 'This item could not be stored.')
    assert.equal(refreshed, 1)
})

test('a package that does not read back is not used, and refreshes retained uncertain rows', async (t) => {
    t.mock.method(console, 'error', () => {})
    const { applied, deps } = setup()
    const memory = createMemoryStore()
    let refreshed = 0
    // A store that loses the end of what it writes.
    const chooser = createAssetChooser('skin', {
        ...deps,
        onStorageChanged: () => refreshed++,
        store: {
            ...memory,
            putMany: (records) =>
                memory.putMany(
                    records.map((record) => ({ ...record, bytes: record.bytes.slice(0, 10) })),
                ),
        },
    })
    // A package already stored before this Use stays.
    const before = await recordOf(scp('background'))
    await memory.putMany([before])
    await chooser.pick(blobOf(collection()), 'neon.scp')
    await settle()
    chooser.toggle('particle', true)
    await chooser.use()
    assert.deepEqual(applied, [])
    assert.equal(chooser.useError.value, 'This item could not be stored.')
    const stored = await memory.list()
    assert.equal(stored.length, 3)
    assert.ok(stored.some((meta) => meta.key === before.key))
    assert.equal((await memory.get(before.key))?.bytes.size, before.size)
    assert.equal(refreshed, 1)
})

test('a file that cannot be read says so, not that storing failed', async (t) => {
    t.mock.method(console, 'error', () => {})
    const { deps } = setup()
    const chooser = createAssetChooser('skin', deps)
    const bytes = collection()
    // A file moved or rewritten after it was picked.
    const unreadable = {
        size: bytes.length,
        slice: () => ({
            arrayBuffer: () =>
                Promise.reject(new DOMException('The file could not be read', 'NotReadableError')),
        }),
    } as unknown as Blob
    await chooser.pick(unreadable, 'neon.scp')
    assert.equal(chooser.error.value, 'This file could not be read.')

    // And at Use, once it was listed.
    let readable = true
    const changing = blobOf(bytes)
    const flaky = {
        size: changing.size,
        slice: (start?: number, end?: number) =>
            readable
                ? changing.slice(start, end)
                : {
                      arrayBuffer: () =>
                          Promise.reject(new DOMException('Changed', 'NotReadableError')),
                  },
    } as unknown as Blob
    await chooser.pick(flaky, 'neon.scp')
    readable = false
    await chooser.use()
    assert.equal(chooser.useError.value, 'This file could not be read.')
})

test('listing a package without a list stops at a budget, and when the chooser closes', async () => {
    const { deps } = setup()
    // 40 items whose details entries are 1 MB each: more than the 16 MB read to list them.
    const padding = 'x'.repeat(1_000_000)
    const entries = Array.from({ length: 40 }, (_, i) => ({
        name: `sonolus/skins/item${i}`,
        data: utf8(JSON.stringify({ item: { name: `item${i}`, title: `Item ${i}` }, padding })),
    }))
    const bytes = rawZip(entries)
    const chooser = createAssetChooser('skin', deps)
    await chooser.pick(blobOf(bytes), 'big.scp')
    assert.ok(chooser.items.value.length < 20, `${chooser.items.value.length} listed`)

    // Closing stops the read between entries.
    const pkg = await openSourcePackage(blobOf(bytes))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(pkg.list('skin', controller.signal), { name: 'AbortError' })
})

test('a store that refuses is reported as a store problem', async (t) => {
    t.mock.method(console, 'error', () => {})
    const { deps } = setup()
    const chooser = createAssetChooser('skin', {
        ...deps,
        store: {
            ...createMemoryStore(),
            putMany: () => Promise.reject(new Error('Storing is read-only')),
        },
    })
    await chooser.pick(blobOf(collection()), 'neon.scp')
    await chooser.use()
    assert.equal(chooser.useError.value, 'This item could not be stored.')
    assert.equal(chooser.phase.value, 'listed')
})

test('cancelling during validation makes no storage attempt or refresh', async () => {
    const { deps, store, applied } = setup()
    const decoding = deferred()
    const release = deferred()
    let writes = 0
    let refreshed = 0
    const chooser = createAssetChooser('skin', {
        ...deps,
        decodeImage: async (bytes) => {
            decoding.resolve()
            await release.promise
            return decodeTestImage(bytes)
        },
        store: {
            ...store,
            putMany: (records) => {
                writes++
                return store.putMany(records)
            },
        },
        onStorageChanged: () => refreshed++,
    })
    await chooser.pick(blobOf(scp('skin')), 'skin.scp')
    const using = chooser.use()
    await decoding.promise
    chooser.cancel()
    release.resolve()
    await using
    assert.equal(writes, 0)
    assert.equal(refreshed, 0)
    assert.deepEqual(applied, [])
    assert.deepEqual(await store.list(), [])
})

test('late cancellation preserves a second caller’s verified choice and a newer chooser generation', async (t) => {
    const { deps, store, applied } = setup()
    const reading = deferred()
    const release = deferred()
    const remove = t.mock.fn(store.remove)
    const shared = { ...store, remove }
    let refreshed = 0
    const first = createAssetChooser('skin', {
        ...deps,
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
    const second = createAssetChooser('skin', { ...deps, store: shared })
    await first.pick(blobOf(scp('skin')), 'first.scp')
    const using = first.use()
    await reading.promise
    await second.pick(blobOf(scp('skin')), 'second.scp')
    await second.use()
    const choice = applied[0]?.skin
    assert.ok(choice?.source === 'file')
    first.cancel()
    await first.pick(blobOf(scp('skin', named('new', 'New'))), 'new.scp')
    release.resolve()
    await using
    assert.equal(applied.length, 1)
    assert.equal(first.open.value, true)
    assert.equal(first.phase.value, 'listed')
    assert.equal(first.selected.value, 'new')
    assert.equal(refreshed, 1)
    assert.equal(remove.mock.callCount(), 0)
    const record = await store.get(choice.key)
    assert.ok(record)
    assert.equal(record.bytes.size, record.size)
    assert.equal(applied[0]?.skin, choice)
})

test('Stored adoption survives late cancellation before its delayed touch', async (t) => {
    const { deps, store, applied } = setup()
    const reading = deferred()
    const release = deferred()
    const touchRelease = deferred()
    const remove = t.mock.fn(store.remove)
    const chooser = createAssetChooser('skin', {
        ...deps,
        store: {
            ...store,
            remove,
            get: async (key) => {
                const record = await store.get(key)
                reading.resolve()
                await release.promise
                return record
            },
        },
    })
    await chooser.pick(blobOf(scp('skin')), 'skin.scp')
    const using = chooser.use()
    await reading.promise
    const [meta] = await store.list()
    assert.ok(meta)
    const adopted = storedChoice(meta)
    const touching = (async () => {
        await touchRelease.promise
        await store.touch(meta.key)
    })()
    chooser.cancel()
    release.resolve()
    await using
    assert.deepEqual(applied, [])
    assert.equal(adopted.source === 'file' && adopted.key, meta.key)
    assert.ok(await store.get(meta.key))
    touchRelease.resolve()
    await touching
    assert.ok(await store.get(meta.key))
    assert.equal(remove.mock.callCount(), 0)
    await store.remove(meta.key)
    assert.equal(await store.get(meta.key), undefined)
})

test('an apply failure retains the checked package and refreshes Stored', async (t) => {
    t.mock.method(console, 'error', () => {})
    const { deps, store } = setup()
    let refreshed = 0
    const chooser = createAssetChooser('skin', {
        ...deps,
        apply: () => {
            throw new Error('Apply failed')
        },
        onStorageChanged: () => refreshed++,
    })
    await chooser.pick(blobOf(scp('skin')), 'skin.scp')
    await chooser.use()
    assert.equal((await store.list()).length, 1)
    assert.equal(refreshed, 1)
    assert.ok(chooser.useError.value)
})

test('a new file chooser opened by apply stays open after the old Use finishes', async () => {
    const { deps } = setup()
    let refreshed = 0
    const chooser = createAssetChooser('skin', {
        ...deps,
        apply: () => chooser.show(),
        onStorageChanged: () => refreshed++,
    })
    await chooser.pick(blobOf(scp('skin')), 'skin.scp')
    await chooser.use()
    assert.equal(chooser.open.value, true)
    assert.equal(chooser.phase.value, 'idle')
    assert.equal(refreshed, 1)
})
