import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { readZip } from '../../builtin-assets/zip.mjs'
import {
    createScp,
    downloadPackage,
    itemDetailsUrl,
    refreshPreviewAssetLock,
    stagePreviewAssets,
} from '../../scripts/release-assets.mjs'
import { audio, data, hash, server, temporary, thumbnail } from './assetFixture.mjs'

test('public and API links resolve to the same item endpoint', () => {
    const expected = 'https://example.com/server/sonolus/skins/test?localization=en'
    assert.equal(
        itemDetailsUrl('https://example.com/server/skins/test?localization=en', 'skins'),
        expected,
    )
    assert.equal(itemDetailsUrl(expected, 'skins'), expected)
    assert.throws(() => itemDetailsUrl('https://example.com/particles/test', 'skins'), /Expected/)
    assert.throws(() => itemDetailsUrl('file:///skins/test', 'skins'), /HTTP/)
})

test('downloads resolve relative resources and preserve attribution', async (t) => {
    const urls = server(t)
    const result = await downloadPackage('https://example.com/server/skins/test', 'skins')
    assert.equal(result.title, 'Fixture skin')
    assert.equal(result.author, 'Fixture author')
    assert.equal(result.bytes.readUInt32LE(0), 0x04034b50)
    assert.deepEqual(urls, [
        'https://example.com/server/sonolus/skins/test',
        'https://example.com/data',
        'https://cdn.example/texture',
        'https://cdn.example/thumbnail',
    ])
})

test('a package carries the item picture, and one without a picture has none', async (t) => {
    const options = {}
    server(t, options)
    const zip = readZip((await downloadPackage('https://example.com/skins/test', 'skins')).bytes)
    assert.deepEqual(zip.get('thumbnail'), thumbnail)
    const item = JSON.parse(zip.get('sonolus/skins/fixture')).item
    assert.equal(item.thumbnail.url, '/thumbnail')
    assert.equal(item.thumbnail.hash, hash(thumbnail))
    options.noThumbnail = true
    const bare = readZip((await downloadPackage('https://example.com/skins/test', 'skins')).bytes)
    assert.equal(bare.has('thumbnail'), false)
    assert.equal('thumbnail' in JSON.parse(bare.get('sonolus/skins/fixture')).item, false)
})

test('a picture hash mismatch fails instead of packaging a modified picture', async (t) => {
    server(t, { badThumbnail: true })
    await assert.rejects(
        downloadPackage('https://example.com/skins/test', 'skins'),
        /hash mismatch/,
    )
})

test('an effect package holds its audio in place of a texture', async (t) => {
    server(t)
    const zip = readZip(
        (await downloadPackage('https://example.com/effects/test', 'effects')).bytes,
    )
    assert.deepEqual(zip.get('audio'), audio)
    assert.equal(zip.has('texture'), false)
    const item = JSON.parse(zip.get('sonolus/effects/fixture')).item
    assert.equal(item.audio.url, '/audio')
})

test('a server hash mismatch fails instead of packaging modified resources', async (t) => {
    server(t, { badHash: true })
    await assert.rejects(
        downloadPackage('https://example.com/skins/test', 'skins'),
        /hash mismatch/,
    )
})

test('failed item and resource requests fail the build', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
    await assert.rejects(downloadPackage('https://example.com/skins/test', 'skins'), /503/)
})

test('refresh pins Coconut resources and default staging uses the lock without item requests', async (t) => {
    const urls = server(t)
    const directory = await temporary(t)
    const lock = await refreshPreviewAssetLock(directory, {})
    assert.equal(lock.version, 1)
    assert.ok(
        urls.includes('https://coconut.sonolus.com/next-sekai/sonolus/skins/coconut-next-sekai-1'),
    )
    assert.ok(
        urls.includes(
            'https://coconut.sonolus.com/next-sekai/sonolus/particles/coconut-next-sekai-1',
        ),
    )
    assert.ok(
        urls.includes('https://coconut.sonolus.com/next-sekai/sonolus/skins/coconut-next-sekai-2'),
    )
    assert.ok(
        urls.includes(
            'https://coconut.sonolus.com/next-sekai/sonolus/effects/coconut-next-sekai-2',
        ),
    )
    assert.ok(
        urls.includes(
            'https://coconut.sonolus.com/next-sekai/sonolus/effects/coconut-next-sekai-1',
        ),
    )
    assert.equal(lock.particle.thumbnail, false)
    assert.equal(lock.effect.thumbnail, false)
    assert.equal(lock.effect2.thumbnail, false)
    assert.equal('thumbnail' in lock.particle.item, false)
    assert.equal('thumbnail' in lock.skin, false)
    assert.equal(lock.skin2.item.thumbnail.hash, hash(thumbnail))
    assert.equal(lock.skin.item.data.url, 'https://coconut.sonolus.com/data')
    assert.equal(lock.skin.item.data.hash, hash(data))
    urls.length = 0
    const assets = await stagePreviewAssets(directory, directory, {})
    assert.deepEqual(
        assets.map((asset) => asset.file),
        [
            'resource/skin.scp',
            'resource/skin2.scp',
            'resource/particle.scp',
            'resource/effect.scp',
            'resource/effect2.scp',
        ],
    )
    assert.deepEqual(urls, [
        'https://coconut.sonolus.com/data',
        'https://cdn.example/texture',
        'https://cdn.example/thumbnail',
        'https://coconut.sonolus.com/data',
        'https://cdn.example/texture',
        'https://cdn.example/thumbnail',
        'https://coconut.sonolus.com/data',
        'https://cdn.example/texture',
        'https://coconut.sonolus.com/data',
        'https://cdn.example/audio',
        'https://coconut.sonolus.com/data',
        'https://cdn.example/audio',
    ])
    const parts = (asset) => readZip(readFileSync(join(directory, asset.file)))
    assert.equal(parts(assets[0]).has('thumbnail'), true)
    assert.equal(parts(assets[1]).has('thumbnail'), true)
    assert.equal(parts(assets[2]).has('thumbnail'), false)
    assert.equal(parts(assets[3]).has('thumbnail'), false)
    assert.equal(parts(assets[4]).has('thumbnail'), false)
    for (const asset of assets) {
        const bytes = await readFile(join(directory, asset.file))
        assert.equal(bytes.length, asset.bytes)
        assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
    }
    assert.equal(assets[0].sha256, lock.skin.sha256)
    assert.equal(assets[1].sha256, lock.skin2.sha256)
    assert.equal(assets[2].sha256, lock.particle.sha256)
    assert.equal(assets[3].sha256, lock.effect.sha256)
    assert.equal(assets[4].sha256, lock.effect2.sha256)
})

test('refresh keeps a left-out picture, and an override cannot bring it back', async (t) => {
    server(t)
    const directory = await temporary(t)
    await refreshPreviewAssetLock(directory, {})
    const lockPath = join(directory, 'deployment/preview-assets.lock.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    lock.skin.thumbnail = false
    await writeFile(lockPath, JSON.stringify(lock))
    const refreshed = await refreshPreviewAssetLock(directory, {})
    assert.equal(refreshed.skin.thumbnail, false)
    assert.equal('thumbnail' in refreshed.skin.item, false)
    assert.equal(refreshed.skin2.thumbnail, undefined)
    const staged = await stagePreviewAssets(directory, directory, {
        PREVIEW_SKIN_URL: 'https://example.com/skins/custom',
        PREVIEW_SKIN2_URL: 'https://example.com/skins/custom2',
        PREVIEW_PARTICLE_URL: 'https://example.com/particles/custom',
    })
    const picture = (file) => readZip(readFileSync(join(directory, file))).has('thumbnail')
    assert.equal(picture(staged[0].file), false)
    assert.equal(picture(staged[1].file), true)
    assert.equal(picture(staged[2].file), false)
    // The item holds no locator for the left-out picture, though the server offered one.
    const item = (file, category, name) =>
        JSON.parse(readZip(readFileSync(join(directory, file))).get(`sonolus/${category}/${name}`))
            .item
    assert.equal('thumbnail' in item(staged[2].file, 'particles', 'fixture'), false)
    assert.equal('thumbnail' in item(staged[1].file, 'skins', 'fixture'), true)
})

test('the left-out pictures are pinned by the script, not only by the lock', async (t) => {
    server(t)
    const directory = await temporary(t)
    await refreshPreviewAssetLock(directory, {})
    const lockPath = join(directory, 'deployment/preview-assets.lock.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    for (const name of ['particle', 'effect', 'effect2']) {
        delete lock[name].thumbnail
        lock[name].item.thumbnail = { url: 'https://cdn.example/thumbnail', hash: hash(thumbnail) }
    }
    await writeFile(lockPath, JSON.stringify(lock))
    const staged = await stagePreviewAssets(directory, directory, {})
    for (const asset of staged.filter((asset) => /particle|effect/.test(asset.file)))
        assert.equal(readZip(readFileSync(join(directory, asset.file))).has('thumbnail'), false)
    const refreshed = await refreshPreviewAssetLock(directory, {})
    for (const name of ['particle', 'effect', 'effect2'])
        assert.equal(refreshed[name].thumbnail, false)
})

test('a locked item without a picture packages none', async (t) => {
    server(t, { noThumbnail: true })
    const directory = await temporary(t)
    await refreshPreviewAssetLock(directory, {})
    const assets = await stagePreviewAssets(directory, directory, {})
    assert.equal(assets.length, 5)
    assert.equal(readZip(readFileSync(join(directory, assets[0].file))).has('thumbnail'), false)
})

test('upstream item metadata only changes packaged assets after an explicit refresh', async (t) => {
    const options = {}
    const urls = server(t, options)
    const directory = await temporary(t)
    await refreshPreviewAssetLock(directory, {})
    const before = await stagePreviewAssets(directory, directory, {})
    options.title = 'Updated skin'
    urls.length = 0
    const after = await stagePreviewAssets(directory, directory, {})
    assert.deepEqual(after, before)
    assert.ok(urls.every((url) => !url.includes('/sonolus/')))
    await refreshPreviewAssetLock(directory, {})
    const refreshed = await stagePreviewAssets(directory, directory, {})
    assert.equal(refreshed[0].title, 'Updated skin')
    assert.notEqual(refreshed[0].sha256, before[0].sha256)
})

test('social metadata changes leave refreshed lock files and packages unchanged', async (t) => {
    const options = {}
    server(t, options)
    const directory = await temporary(t)
    await refreshPreviewAssetLock(directory, {})
    const lockPath = join(directory, 'deployment/preview-assets.lock.json')
    const before = await readFile(lockPath, 'utf8')
    const beforeAssets = await stagePreviewAssets(directory, directory, {})
    options.likes = '200'
    options.authorTag = '#NEW'
    const refreshed = await refreshPreviewAssetLock(directory, {})
    assert.equal('tags' in refreshed.skin.item, false)
    assert.equal('authorUser' in refreshed.skin.item, false)
    assert.equal(await readFile(lockPath, 'utf8'), before)
    assert.deepEqual(await stagePreviewAssets(directory, directory, {}), beforeAssets)
})

test('locked resource and package hashes reject remote and metadata changes', async (t) => {
    server(t)
    const directory = await temporary(t)
    const lock = await refreshPreviewAssetLock(directory, {})
    const lockPath = join(directory, 'deployment/preview-assets.lock.json')
    lock.skin.item.data.hash = '0'.repeat(40)
    await writeFile(lockPath, JSON.stringify(lock))
    await assert.rejects(stagePreviewAssets(directory, directory, {}), /resource hash mismatch/)
    lock.skin.item.data.hash = hash(data)
    lock.skin.item.title = 'Unrefreshed metadata'
    await writeFile(lockPath, JSON.stringify(lock))
    await assert.rejects(stagePreviewAssets(directory, directory, {}), /package hash mismatch/)
})

test('refresh requires resource hashes and leaves the previous lock on failure', async (t) => {
    const options = {}
    server(t, options)
    const directory = await temporary(t)
    await refreshPreviewAssetLock(directory, {})
    const lockPath = join(directory, 'deployment/preview-assets.lock.json')
    const before = await readFile(lockPath, 'utf8')
    options.missingHash = true
    await assert.rejects(refreshPreviewAssetLock(directory, {}), /must have a SHA-1 hash/)
    assert.equal(await readFile(lockPath, 'utf8'), before)
})

test('default staging fails for missing or unsupported locks without requesting item details', async (t) => {
    const urls = server(t)
    const directory = await temporary(t)
    await assert.rejects(stagePreviewAssets(directory, directory, {}), { code: 'ENOENT' })
    await mkdir(join(directory, 'deployment'))
    await writeFile(join(directory, 'deployment/preview-assets.lock.json'), '{"version":2}')
    await assert.rejects(stagePreviewAssets(directory, directory, {}), /Unsupported/)
    assert.deepEqual(urls, [])
})

test('configured servers replace the defaults', async (t) => {
    const urls = server(t)
    const directory = await temporary(t)
    await stagePreviewAssets(directory, directory, {
        PREVIEW_SKIN_URL: 'https://example.com/skins/custom',
        PREVIEW_SKIN2_URL: 'https://example.com/skins/custom2',
        PREVIEW_PARTICLE_URL: 'https://example.com/particles/custom',
        PREVIEW_EFFECT_URL: 'https://example.com/effects/custom',
        PREVIEW_EFFECT2_URL: 'https://example.com/effects/custom2',
    })
    assert.ok(urls.includes('https://example.com/sonolus/skins/custom'))
    assert.ok(urls.includes('https://example.com/sonolus/particles/custom'))
    assert.ok(urls.every((url) => !url.includes('coconut')))
})

test('one configured server preserves the other locked asset', async (t) => {
    const urls = server(t)
    const directory = await temporary(t)
    await refreshPreviewAssetLock(directory, {})
    urls.length = 0
    const assets = await stagePreviewAssets(directory, directory, {
        PREVIEW_SKIN_URL: 'https://example.com/skins/custom',
    })
    assert.equal(assets[0].source, 'https://example.com/sonolus/skins/custom')
    assert.equal(
        assets[2].source,
        'https://coconut.sonolus.com/next-sekai/sonolus/particles/coconut-next-sekai-1',
    )
    assert.deepEqual(
        urls.filter((url) => url.includes('/sonolus/')),
        ['https://example.com/sonolus/skins/custom'],
    )
})

test('local staging requires all five packages and never fetches', async (t) => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('local build fetched from a server'))
    const directory = await temporary(t)
    const output = join(directory, 'output')
    const env = { PREVIEW_ASSET_SOURCE: 'local' }
    await assert.rejects(stagePreviewAssets(directory, output, env), { code: 'ENOENT' })
    await mkdir(join(directory, 'public/resource'), { recursive: true })
    await writeFile(join(directory, 'public/resource/skin.scp'), 'local skin')
    await assert.rejects(stagePreviewAssets(directory, output, env), { code: 'ENOENT' })
    const local = (name, category, extra = {}, item = {}) =>
        createScp({
            [`sonolus/${category}/list`]: Buffer.from(
                JSON.stringify({ items: [{ name: 'x', ...item }] }),
            ),
            data,
            ...extra,
        })
    const put = (name, bytes) => writeFile(join(directory, `public/resource/${name}.scp`), bytes)
    await put('particle', local('particle', 'particles'))
    await assert.rejects(stagePreviewAssets(directory, output, env), { code: 'ENOENT' })
    await put('skin2', 'local skin 2')
    await put('effect', local('effect', 'effects'))
    await put('effect2', local('effect2', 'effects'))
    assert.deepEqual(
        (await stagePreviewAssets(directory, output, env)).map((asset) => asset.file),
        [
            'resource/skin.scp',
            'resource/skin2.scp',
            'resource/particle.scp',
            'resource/effect.scp',
            'resource/effect2.scp',
        ],
    )
    // A package whose item leaves its picture out may carry neither the entry nor a locator.
    for (const name of ['particle', 'effect', 'effect2']) {
        const category = name === 'particle' ? 'particles' : 'effects'
        for (const bad of [
            local(name, category, { thumbnail: thumbnail }),
            local(name, category, {}, { thumbnail: { url: '/thumbnail' } }),
        ]) {
            await put(name, bad)
            await assert.rejects(stagePreviewAssets(directory, output, env), /leaves out/)
        }
        await put(name, local(name, category))
    }
    await assert.rejects(
        stagePreviewAssets(directory, output, { PREVIEW_ASSET_SOURCE: 'typo' }),
        /must be/,
    )
})
