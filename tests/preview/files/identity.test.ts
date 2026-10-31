import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { builtinResources } from '../../../src/preview/assets/builtinResources'
import { builtinChoice, choiceKey, choiceRow } from '../../../src/preview/assets/choice'
import { identifyAssets, type IdentityContext } from '../../../src/preview/assets/files/identity'
import { importAndUse, storedChoice } from '../../../src/preview/assets/files/importStore'
import { fields } from '../../../src/preview/assets/files/item'
import { categoryOf, openSourcePackage } from '../../../src/preview/assets/files/package'
import { createMemoryStore, type UserAssetStore } from '../../../src/preview/assets/files/store'
import type { AssetChoice, AssetType } from '../../../src/preview/assets/types'
import { ZipReader } from '../../../src/zip'
import { patched, variants } from '../../browser/previewAssetsPackages'
import {
    blobOf,
    decodeTestAudio,
    decodeTestImage,
    png,
    rawZip,
    scp,
    scpEntries,
    scpMulti,
    type ScpOptions,
} from './fixtures'

// Whether Open's package list shows an asset as in Preview Assets: the exact record Import would
// store, or a built-in item's resources.

const context = (
    store: UserAssetStore,
    overrides: Partial<IdentityContext> = {},
): IdentityContext => ({
    store,
    hasDefault: true,
    bundled: new Set(['skin2', 'effect2']),
    ...overrides,
})

const identify = async (
    bytes: Uint8Array,
    ctx: IdentityContext,
    type: AssetType = 'skin',
    name = 'fixture',
) => (await identifyAssets(await openSourcePackage(blobOf(bytes)), [{ type, name }], ctx))[0]

/** Imports a package's only item into the store, as the chooser and the list do. */
const imported = async (store: UserAssetStore, bytes: Uint8Array, origin = 'a.scp') => {
    const applied: Partial<Record<AssetType, AssetChoice>>[] = []
    const metas = await importAndUse(
        await openSourcePackage(blobOf(bytes)),
        [{ type: 'skin', name: 'fixture' }],
        {
            origin,
            signal: new AbortController().signal,
            isCurrent: () => true,
        },
        {
            store,
            maxTextureSide: () => 4096,
            decodeAudio: decodeTestAudio,
            decodeImage: decodeTestImage,
            apply: (choices) => applied.push(choices),
            now: () => 1000,
        },
    )
    assert.ok(metas?.[0])
    // Import makes the item the one in use.
    assert.deepEqual(applied, [{ skin: storedChoice(metas[0]) }])
    return metas[0]
}

test('an imported item reads as stored, from this file or another; any change reads as new', async () => {
    const store = createMemoryStore()
    const meta = await imported(store, scp('skin'))
    const stored = await identify(scp('skin'), context(store))
    assert.equal(stored?.kind, 'stored')
    assert.ok(stored?.kind === 'stored' && choiceKey(stored.choice) === `file:${meta.key}`)
    // The same item from another file name has the same key.
    await imported(store, scp('skin'), 'b.scp')
    assert.equal((await identify(scp('skin'), context(store)))?.kind, 'stored')

    const changes: [string, ScpOptions][] = [
        ['title', { title: 'Other' }],
        ['version', { item: { version: 2 } }],
        ['a resource', { resources: { texture: png(32, 64) } }],
    ]
    for (const [label, options] of changes)
        assert.equal((await identify(scp('skin', options), context(store)))?.kind, 'new', label)
    // Same content under another name: another record.
    assert.equal(
        (await identify(scp('skin', { name: 'other' }), context(store), 'skin', 'other'))?.kind,
        'new',
    )
})

test('hashes are compared lowercased, and missing ones are computed from the bytes', async () => {
    const store = createMemoryStore()
    await imported(store, scp('skin'))
    const entries = scpEntries('skin').map((entry) =>
        entry.name.endsWith('/list') || entry.name.endsWith('/fixture')
            ? {
                  ...entry,
                  data: new TextEncoder().encode(
                      new TextDecoder()
                          .decode(entry.data)
                          .replace(
                              /"hash":"([0-9a-f]{40})"/g,
                              (_, hash: string) => `"hash":"${hash.toUpperCase()}"`,
                          ),
                  ),
              }
            : entry,
    )
    assert.equal((await identify(rawZip(entries), context(store)))?.kind, 'stored')
    assert.equal((await identify(scp('skin', { hashes: 'omit' }), context(store)))?.kind, 'stored')
})

test('a thumbnail named but not in the file matches a stored item without one', async () => {
    const store = createMemoryStore()
    const thumbnail = png(32, 32)
    const withoutThumbnail = () =>
        rawZip(
            scpEntries('skin', { resources: { thumbnail } }).filter(
                (entry) =>
                    entry.name !==
                    `sonolus/repository/${createHash('sha1').update(thumbnail).digest('hex')}`,
            ),
        )
    await imported(store, withoutThumbnail())
    assert.equal((await identify(withoutThumbnail(), context(store)))?.kind, 'stored')
    // With the thumbnail there, Import would store another record.
    assert.equal(
        (await identify(scp('skin', { resources: { thumbnail } }), context(store)))?.kind,
        'new',
    )
})

test('a stored record that cannot be read, or storage that is slow, reads as new', async () => {
    const store = createMemoryStore()
    const meta = await imported(store, scp('skin'))
    const record = await store.get(meta.key)
    assert.ok(record)
    await store.put({ ...record, bytes: new Blob(['not a zip']) })
    assert.equal((await identify(scp('skin'), context(store)))?.kind, 'new')

    const slow: UserAssetStore = { ...createMemoryStore(), list: () => new Promise(() => {}) }
    assert.equal((await identify(scp('skin'), context(slow, { storeWaitMs: 20 })))?.kind, 'new')
    const failing: UserAssetStore = {
        ...createMemoryStore(),
        list: () => Promise.reject(new Error('x')),
    }
    assert.equal((await identify(scp('skin'), context(failing)))?.kind, 'new')
})

const shipped = (path: string) => new Uint8Array(readFileSync(`public/${path}.scp`))
const itemName = async (bytes: Uint8Array, type: AssetType) =>
    (await (await openSourcePackage(blobOf(bytes))).list(type))[0]!.name

test('the Built-in items match by resources, with the choice the chooser stores for Built-in', async () => {
    const store = createMemoryStore()
    const name0 = await itemName(shipped('builtin/skin'), 'skin')
    for (const type of ['skin', 'particle', 'background', 'effect'] as const) {
        const bytes = shipped(`builtin/${type}`)
        const name = await itemName(bytes, type)
        const web = await identify(bytes, context(store), type, name)
        assert.deepEqual(
            web,
            { kind: 'builtin', source: 'builtin', choice: { source: 'builtin' } },
            type,
        )
        // Without Default, Built-in is stored as Default, so the setting's initial value is it.
        const apps = await identify(
            bytes,
            context(store, { hasDefault: false, bundled: new Set() }),
            type,
            name,
        )
        assert.deepEqual(
            apps,
            { kind: 'builtin', source: 'builtin', choice: { source: 'default' } },
            type,
        )
        assert.equal(choiceRow({ source: 'default' }, type, false), 'builtin')
        assert.equal(choiceRow(builtinChoice(false), type, false), 'builtin')
    }
    // Another name, title or thumbnail does not matter; another resource does.
    const renamed = await variants('skin', [{ name: 'renamed', title: 'Other', picture: false }])
    assert.equal((await identify(renamed, context(store), 'skin', 'renamed'))?.kind, 'builtin')
    const changed = await patched('skin', { resources: { texture: png(64, 64) } })
    assert.equal((await identify(changed, context(store), 'skin', name0))?.kind, 'new')
})

test(
    'Default and Next SEKAI 02 match only where this platform offers them',
    { skip: !hasShipped() },
    async () => {
        const store = createMemoryStore()
        const skin = shipped('resource/skin')
        const name = await itemName(skin, 'skin')
        assert.deepEqual(await identify(skin, context(store), 'skin', name), {
            kind: 'builtin',
            source: 'default',
            choice: { source: 'default' },
        })
        assert.equal(
            (await identify(skin, context(store, { hasDefault: false }), 'skin', name))?.kind,
            'new',
        )
        const skin2 = shipped('resource/skin2')
        const name2 = await itemName(skin2, 'skin')
        assert.deepEqual(await identify(skin2, context(store), 'skin', name2), {
            kind: 'builtin',
            source: 'nextSekai02',
            choice: { source: 'bundled', id: 'skin2' },
        })
        assert.equal(
            (await identify(skin2, context(store, { bundled: new Set() }), 'skin', name2))?.kind,
            'new',
        )
    },
)

const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex')

/** The table's row of a package, computed from its bytes. */
const rowOf = async (bytes: Uint8Array, type: AssetType) => {
    const reader = await ZipReader.open(blobOf(bytes))
    const read = (name: string) => reader.read(reader.get(name)!, { maxSize: 1 << 28 })
    const list = JSON.parse(
        new TextDecoder().decode(await read(`sonolus/${categoryOf[type]}/list`)),
    ) as {
        items: Record<string, { url: string }>[]
    }
    const item = list.items[0]!
    return Object.fromEntries(
        await Promise.all(
            fields[type].map(
                async (field) => [field, sha1(await read(item[field]!.url.slice(1)))] as const,
            ),
        ),
    )
}

test('the built-in table is what the shipped packages hold (scripts/builtin-resources.mjs)', async () => {
    const paths = { builtin: 'builtin', default: 'resource', nextSekai02: 'resource' } as const
    for (const row of builtinResources) {
        if (row.source !== 'builtin' && !hasShipped()) continue
        const file = row.source === 'nextSekai02' ? `${row.type}2` : row.type
        assert.deepEqual(
            row.hashes,
            await rowOf(shipped(`${paths[row.source]}/${file}`), row.type),
            `${row.source} ${row.type}`,
        )
    }
    assert.ok(builtinResources.some((row) => row.source === 'builtin' && row.type === 'background'))
})

// The locked resource packs only: nativeBundle.test.mjs plants a stand-in while it builds.
function hasShipped() {
    const lock = JSON.parse(readFileSync('deployment/preview-assets.lock.json', 'utf8')) as Record<
        string,
        { sha256: string }
    >
    return ['skin', 'skin2', 'particle', 'effect', 'effect2'].every((name) => {
        try {
            const bytes = readFileSync(`public/resource/${name}.scp`)
            return createHash('sha256').update(bytes).digest('hex') === lock[name]?.sha256
        } catch {
            return false
        }
    })
}

/** Counts the entries read, by name, while `run` runs. */
const countingReads = async <T>(run: () => Promise<T>) => {
    const read = ZipReader.prototype.read
    const counts = new Map<string, number>()
    ZipReader.prototype.read = function (this: ZipReader, entry, options) {
        counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
        return read.call(this, entry, options)
    }
    try {
        return { result: await run(), counts }
    } finally {
        ZipReader.prototype.read = read
    }
}

const tenSkins = (noDetails: boolean) =>
    scpMulti(
        Array.from({ length: 10 }, (_, i): [AssetType, ScpOptions] => [
            'skin',
            { name: `skin${i}`, noDetails },
        ]),
    )

test('a list is read once, however many of its items have no detail entry', async () => {
    const { counts } = await countingReads(async () => {
        const pkg = await openSourcePackage(blobOf(tenSkins(true)))
        const listed = await pkg.list('skin')
        assert.equal(listed.length, 10)
        await identifyAssets(
            pkg,
            listed.map(({ name }) => ({ type: 'skin', name })),
            context(createMemoryStore()),
        )
    })
    assert.equal(counts.get('sonolus/skins/list'), 1)
})

test('Cancel stops the identity reads between items', async () => {
    const controller = new AbortController()
    const { counts } = await countingReads(async () => {
        const pkg = await openSourcePackage(blobOf(tenSkins(false)))
        const listed = await pkg.list('skin')
        const read = ZipReader.prototype.read
        // The first detail entry read cancels.
        ZipReader.prototype.read = function (this: ZipReader, entry, options) {
            if (entry.key.startsWith('sonolus/skins/skin')) controller.abort()
            return read.call(this, entry, options)
        }
        await assert.rejects(
            identifyAssets(
                pkg,
                listed.map(({ name }) => ({ type: 'skin', name })),
                context(createMemoryStore()),
                controller.signal,
            ),
            (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
        )
    })
    const details = [...counts].filter(([key]) => key.startsWith('sonolus/skins/skin'))
    assert.equal(details.length, 1)
})
