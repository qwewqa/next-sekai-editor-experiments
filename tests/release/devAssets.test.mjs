import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { previewAssetsMode, stageDevPreviewAssets } from '../../scripts/preview-assets.mjs'
import { refreshPreviewAssetLock } from '../../scripts/release-assets.mjs'
import { server, temporary } from './assetFixture.mjs'

const names = ['skin', 'skin2', 'particle', 'effect', 'effect2']
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// A checkout with a lock, a separate cache folder, and a server that is counted.
async function checkout(t) {
    const urls = server(t)
    const root = await temporary(t)
    const lock = await refreshPreviewAssetLock(root, {})
    urls.length = 0
    return { root, lock, urls, cache: join(root, 'cache') }
}
const staged = (root, name) => readFile(join(root, `public/resource/${name}.scp`))

test('a miss builds each package from the lock, stages it and caches it', async (t) => {
    const { root, lock, urls, cache } = await checkout(t)
    const result = await stageDevPreviewAssets(root, {}, cache)
    assert.deepEqual(result, { skipped: false, failures: [] })
    assert.ok(urls.length > 0)
    for (const name of names) {
        assert.equal(sha256(await staged(root, name)), lock[name].sha256, name)
        assert.equal(
            sha256(await readFile(join(cache, `${lock[name].sha256}.scp`))),
            lock[name].sha256,
        )
    }
    // Nothing half-written is left behind.
    assert.deepEqual(
        (await readdir(join(root, 'public/resource'))).filter((file) => file.endsWith('.tmp')),
        [],
    )
})

test('a staged package that matches the lock is kept, with no network', async (t) => {
    const { root, urls, cache } = await checkout(t)
    await stageDevPreviewAssets(root, {}, cache)
    const before = await staged(root, 'skin')
    urls.length = 0
    t.mock.method(globalThis, 'fetch', () => assert.fail('a matching package fetched'))
    assert.deepEqual(await stageDevPreviewAssets(root, {}, cache), { skipped: false, failures: [] })
    assert.deepEqual(await staged(root, 'skin'), before)
})

test('a cache hit is copied over a changed package, with no network', async (t) => {
    const { root, lock, cache } = await checkout(t)
    await stageDevPreviewAssets(root, {}, cache)
    await writeFile(join(root, 'public/resource/skin.scp'), 'old package')
    await rm(join(root, 'public/resource/particle.scp'))
    t.mock.method(globalThis, 'fetch', () => assert.fail('a cached package fetched'))
    assert.deepEqual(await stageDevPreviewAssets(root, {}, cache), { skipped: false, failures: [] })
    assert.equal(sha256(await staged(root, 'skin')), lock.skin.sha256)
    assert.equal(sha256(await staged(root, 'particle')), lock.particle.sha256)
})

test('a failure is returned, the other packages are still staged, and nothing throws', async (t) => {
    const { root, lock, cache } = await checkout(t)
    await mkdir(join(root, 'public/resource'), { recursive: true })
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
    const result = await stageDevPreviewAssets(root, {}, cache)
    assert.equal(result.failures.length, names.length)
    assert.match(result.failures[0], /^skin: .*503/)
    // A cache holding one package serves it while the rest fail.
    t.mock.restoreAll()
    server(t)
    await stageDevPreviewAssets(root, {}, cache)
    await rm(join(root, 'public/resource/skin2.scp'))
    await rm(join(cache, `${lock.effect.sha256}.scp`))
    await rm(join(root, 'public/resource/effect.scp'))
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
    const partial = await stageDevPreviewAssets(root, {}, cache)
    assert.equal(partial.failures.length, 1)
    assert.match(partial.failures[0], /^effect:/)
    assert.equal(sha256(await staged(root, 'skin2')), lock.skin2.sha256)
})

test('a missing lock is a failure, not a throw', async (t) => {
    const root = await temporary(t)
    const result = await stageDevPreviewAssets(root, {}, join(root, 'cache'))
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /lock/)
})

test('NSE_SKIP_PREVIEW_ASSETS skips staging and leaves staged packages alone', async (t) => {
    const { root, cache } = await checkout(t)
    t.mock.method(globalThis, 'fetch', () => assert.fail('a skipped step fetched'))
    assert.deepEqual(await stageDevPreviewAssets(root, { NSE_SKIP_PREVIEW_ASSETS: '1' }, cache), {
        skipped: true,
        failures: [],
    })
    await assert.rejects(staged(root, 'skin'), { code: 'ENOENT' })
})

test('the assets are in only when every locked package is staged and matches', async (t) => {
    const { root, cache } = await checkout(t)
    const mode = (env = {}) => previewAssetsMode(root, env)
    assert.equal((await mode()).included, false)
    await stageDevPreviewAssets(root, {}, cache)
    assert.deepEqual(await mode(), { included: true })
    // The switch is the variable first, whatever is staged.
    const skipped = await mode({ NSE_SKIP_PREVIEW_ASSETS: '1' })
    assert.equal(skipped.included, false)
    // One package missing or different turns them all off, and the reason names it.
    await writeFile(join(root, 'public/resource/effect2.scp'), 'changed')
    const changed = await mode()
    assert.equal(changed.included, false)
    assert.match(changed.reason, /effect2\.scp/)
    await rm(join(root, 'public/resource/skin.scp'))
    assert.match((await mode()).reason, /skin\.scp, effect2\.scp/)
    // A release build stages every package itself.
    assert.deepEqual(await mode({ NSE_PREVIEW_ASSETS: 'release' }), { included: true })
})
