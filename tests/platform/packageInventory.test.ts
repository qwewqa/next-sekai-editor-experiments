import assert from 'node:assert/strict'
import test from 'node:test'
import {
    directLevel,
    isEmptyInventory,
    readInventory,
    type Inventory,
} from '../../src/files/package/inventory'
import { AssetImportError } from '../../src/preview/assets/files/errors'
import { levelPackage } from '../browser/levelPackages'
import { entriesOf, pack, rawZip, utf8 } from '../browser/previewAssetsPackages'
import { freshFile } from '../local/nxsp/craft'

// Which items a package offers Open, and whether its one level opens without the list.

const inventoryOf = async (bytes: Uint8Array | Blob) =>
    readInventory(bytes instanceof Blob ? bytes : new Blob([new Uint8Array(bytes)]))

const rows = (inventory: Inventory) => [
    ...inventory.levels.map((level) => `level ${level.name}${level.data ? '' : ' (no data)'}`),
    ...inventory.assets.map((asset) => `${asset.type} ${asset.name}`),
]

test('one level whose data is in the file opens directly, with nothing else listed', async () => {
    const inventory = await inventoryOf(
        await levelPackage('full', [{ name: 'song', title: 'Song', artists: 'A', author: 'B' }]),
    )
    assert.deepEqual(rows(inventory), ['level song'])
    const level = directLevel(inventory)
    assert.equal(level?.title, 'Song')
    assert.equal(level?.artists, 'A')
    assert.equal(level?.author, 'B')
})

test('the app source-only export lists its level without data, whatever its buttons say', async () => {
    const inventory = await inventoryOf(await levelPackage('app', [{ name: 'song' }]))
    // Nine buttons and info sections over lists that hold one level and nothing else.
    assert.deepEqual(rows(inventory), ['level song (no data)'])
    assert.equal(directLevel(inventory), undefined)
    assert.ok(!isEmptyInventory(inventory))
})

test('level-packer output, and a level beside any listed asset, shows the list', async () => {
    const packer = await inventoryOf(
        await levelPackage('packer', [{ name: 'song' }], {
            skin: [{ name: 'next-sekai-skin' }],
            effect: [{ name: 'next-sekai-effect' }],
        }),
    )
    // Listed dependencies count like any asset; the engine list is never shown.
    assert.deepEqual(rows(packer), [
        'level song',
        'skin next-sekai-skin',
        'effect next-sekai-effect',
    ])
    assert.equal(directLevel(packer), undefined)

    const loose = await inventoryOf(
        await levelPackage('full', [{ name: 'song' }], { particle: [{ name: 'spark' }] }),
    )
    assert.equal(directLevel(loose), undefined)
})

test('two levels, or one without data, show the list', async () => {
    const two = await inventoryOf(await levelPackage('full', [{ name: 'a' }, { name: 'b' }]))
    assert.deepEqual(rows(two), ['level a', 'level b'])
    assert.equal(directLevel(two), undefined)

    const missing = await inventoryOf(await levelPackage('full', [{ name: 'a', data: null }]))
    assert.deepEqual(rows(missing), ['level a (no data)'])
    assert.equal(directLevel(missing), undefined)
})

test('assets only, even one, show the list; nothing usable is empty', async () => {
    const one = await inventoryOf(await levelPackage('full', [], { skin: [{ name: 'neon' }] }))
    assert.deepEqual(rows(one), ['skin neon'])
    assert.equal(directLevel(one), undefined)

    const nothing = await inventoryOf(
        pack(
            new Map([
                ['sonolus/info', utf8('{"buttons":[{"type":"engine"}]}')],
                ['sonolus/engines/list', utf8('{"items":[{"name":"e"}]}')],
            ]),
        ),
    )
    assert.ok(isEmptyInventory(nothing))
})

test('an item without a list entry is read from its detail entry', async () => {
    const entries = await entriesOf(await levelPackage('full', [{ name: 'song' }]))
    entries.delete('sonolus/levels/list')
    const inventory = await inventoryOf(pack(entries))
    assert.deepEqual(rows(inventory), ['level song'])
    assert.ok(directLevel(inventory))
})

test('two items of one type with the same name keep the first', async () => {
    const entries = await entriesOf(
        await levelPackage('full', [
            { name: 'song', title: 'First' },
            { name: 'song', title: 'Second' },
        ]),
    )
    const inventory = await inventoryOf(pack(entries))
    assert.deepEqual(
        inventory.levels.map((level) => level.title),
        ['First'],
    )
})

test('data is in the file only when its SRL names an entry the file has', async () => {
    const data = utf8('x')
    const level = (name: string, srl: unknown) => ({ name, data: srl })
    const bytes = rawZip([
        {
            name: 'sonolus/levels/list',
            data: utf8(
                JSON.stringify({
                    items: [
                        level('empty', {}),
                        level('blank', { url: '' }),
                        level('external', { url: 'https://example.com/sonolus/repository/d' }),
                        level('scheme', { url: 'data:application/gzip,x' }),
                        level('absent', { url: '/sonolus/repository/none' }),
                        level('ambiguous', { url: '/sonolus/repository/twice' }),
                        level('present', { url: '/sonolus/repository/d' }),
                        level('noSlash', { url: 'sonolus/repository/d' }),
                    ],
                }),
            ),
        },
        { name: 'sonolus/repository/d', data },
        { name: 'sonolus/repository/twice', data },
        { name: 'sonolus/repository/twice', data },
    ])
    const inventory = await inventoryOf(bytes)
    assert.deepEqual(Object.fromEntries(inventory.levels.map((item) => [item.name, item.data])), {
        empty: undefined,
        blank: undefined,
        external: undefined,
        scheme: undefined,
        absent: undefined,
        // Two entries of one name are damage, not absence: Open then refuses to read it.
        ambiguous: 'sonolus/repository/twice',
        present: 'sonolus/repository/d',
        noSlash: 'sonolus/repository/d',
    })
})

test('a list that is not an object with items refuses the package as damaged', async () => {
    for (const list of ['[]', '{"items":3}', 'not json'])
        await assert.rejects(
            inventoryOf(pack(new Map([['sonolus/levels/list', utf8(list)]]))),
            (error: unknown) => error instanceof AssetImportError && error.code === 'damaged',
            list,
        )
})

test('an .nxsp that lost its project.json is a package whose level opens directly', async () => {
    const entries = await entriesOf(new Uint8Array(await (await freshFile()).arrayBuffer()))
    entries.delete('project.json')
    const inventory = await inventoryOf(pack(entries))
    assert.equal(inventory.levels.length, 1)
    assert.match(inventory.levels[0]!.name, /^nse-/)
    assert.ok(directLevel(inventory))
})
