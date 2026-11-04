import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'
import { checkRelease, sha256, writeReleaseManifest } from '../../scripts/release-utils.mjs'
import { parseIndex, prepare, record, seed } from '../../scripts/release/assetStore.mjs'
import { awsStore } from '../../scripts/release/awsStore.mjs'
import { applyTestSite } from '../../scripts/site.mjs'
import { indexPage, metadata, releaseFixture, withPolicy, write } from './releaseFixture.mjs'

const day = 24 * 60 * 60 * 1000
const minute = 60 * 1000
const days = 7
const emptyIndex = Buffer.from('{"version":1,"live":[],"next":null,"assets":{}}')
// Every fixture build has these, unchanged.
const shared = [
    'assets/index-12345678.css',
    'assets/index-12345678.js',
    'assets/lyon-12345678.wasm',
]

// The bucket under one prefix, in memory. `faults` makes single operations fail.
function memoryStore() {
    const objects = new Map()
    const downloads = []
    const faults = { corrupt: new Set(), deleteFails: new Set(), failIndexWrites: 0 }
    let index = null
    let version = 0
    const store = {
        objects,
        downloads,
        faults,
        get index() {
            return index && parseIndex(index.bytes)
        },
        setIndexBytes(bytes) {
            index = { bytes: Buffer.from(bytes), etag: `"${++version}"` }
        },
        async readIndex() {
            return index && { ...index }
        },
        async headIndex() {
            return index?.etag ?? null
        },
        async writeIndex(bytes, condition) {
            if (faults.failIndexWrites) {
                faults.failIndexWrites--
                throw new Error('index write failed')
            }
            if (condition.ifNoneMatch ? index : index?.etag !== condition.ifMatch)
                throw new Error('The asset store index changed since it was read')
            store.setIndexBytes(bytes)
        },
        async download(names, folder) {
            downloads.push(...names)
            for (const name of names)
                if (objects.has(name))
                    await writeFile(
                        join(folder, basename(name)),
                        faults.corrupt.has(name) ? 'corrupt' : objects.get(name),
                    )
        },
        async putNew(name, bytes) {
            if (objects.has(name)) return 'exists'
            objects.set(name, Buffer.from(bytes))
            return 'created'
        },
        async read(name) {
            return objects.get(name)
        },
        async remove(names) {
            const failed = names.filter((name) => faults.deleteFails.has(name))
            for (const name of names) if (!failed.includes(name)) objects.delete(name)
            return failed
        },
    }
    store.setIndexBytes(emptyIndex)
    return store
}

// A test-site release with the shared files and `extra`, built by the real manifest writer.
async function build(t, extra, commit) {
    const { directory, assets } = await releaseFixture(t)
    await write(directory, 'index.html', withPolicy(applyTestSite(indexPage)))
    for (const [file, content] of Object.entries(extra)) await write(directory, file, content)
    const appVersion = `${metadata.version}+${commit.slice(0, 8)}`
    await writeReleaseManifest(directory, { ...metadata, site: 'test', commit, appVersion }, assets)
    return directory
}

const commitOf = (letter) => letter.repeat(40)
const manifestOf = async (dist) =>
    JSON.parse(await readFile(join(dist, 'release-manifest.json'), 'utf8'))

// Prepares a build at `at`, checks it, and records it a minute later unless the publish fails.
async function deploy(t, store, { at, letter, extra, publish = true }) {
    const commit = commitOf(letter)
    const dist = await build(t, extra, commit)
    const { retained } = await prepare({ dist, store, now: new Date(at), commit, days })
    await checkRelease(dist)
    if (publish) await record({ store, now: new Date(at + minute), commit, days })
    return { dist, retained }
}

const a = { 'assets/a-AAAAAAAA.js': 'a' }
const b = { 'assets/b-BBBBBBBB.js': 'b' }
const c = { 'assets/c-CCCCCCCC.js': 'c' }
const d = { 'assets/d-DDDDDDDD.js': 'd' }
const time = (at) => new Date(at).toISOString()

test('three deploys keep the files each one drops, and never download the shared ones', async (t) => {
    const store = memoryStore()
    await deploy(t, store, { at: 0, letter: 'a', extra: a })
    assert.deepEqual([...store.objects.keys()].sort(), ['assets/a-AAAAAAAA.js', ...shared])
    const second = await deploy(t, store, { at: day, letter: 'b', extra: b })
    assert.deepEqual(second.retained, ['assets/a-AAAAAAAA.js'])
    const manifest = await manifestOf(second.dist)
    assert.deepEqual(Object.keys(manifest.retained), ['assets/a-AAAAAAAA.js'])
    for (const file of shared) assert.ok(Object.hasOwn(manifest.files, file))
    const third = await deploy(t, store, { at: 3 * day, letter: 'c', extra: c })
    assert.deepEqual(third.retained, ['assets/a-AAAAAAAA.js', 'assets/b-BBBBBBBB.js'])
    for (const file of shared) assert.ok(!store.downloads.includes(file))
    const index = store.index
    assert.equal(index.assets['assets/a-AAAAAAAA.js'].lastLive, time(day + minute))
    assert.equal(index.assets['assets/b-BBBBBBBB.js'].lastLive, time(3 * day + minute))
    assert.deepEqual(index.live, ['assets/c-CCCCCCCC.js', ...shared].sort())
    assert.equal(index.next, null)
})

test('the live release is kept after a long gap between deploys', async (t) => {
    const store = memoryStore()
    await deploy(t, store, { at: 0, letter: 'a', extra: a })
    const later = await deploy(t, store, { at: 60 * day, letter: 'b', extra: b })
    assert.deepEqual(later.retained, ['assets/a-AAAAAAAA.js'])
})

test('after a failed publish the next deploy keeps both earlier releases', async (t) => {
    const store = memoryStore()
    await deploy(t, store, { at: 0, letter: 'a', extra: a })
    await deploy(t, store, { at: day, letter: 'b', extra: b, publish: false })
    const third = await deploy(t, store, { at: 3 * day, letter: 'c', extra: c })
    assert.deepEqual(third.retained, ['assets/a-AAAAAAAA.js', 'assets/b-BBBBBBBB.js'])
    const index = store.index
    for (const file of ['assets/a-AAAAAAAA.js', 'assets/b-BBBBBBBB.js'])
        assert.equal(index.assets[file].lastLive, time(3 * day + minute))
    assert.deepEqual(index.live, ['assets/c-CCCCCCCC.js', ...shared].sort())
})

test('a name with other bytes fails before anything is written', async (t) => {
    const store = memoryStore()
    await deploy(t, store, { at: 0, letter: 'a', extra: a })
    const before = await store.headIndex()
    const changed = await build(t, { 'assets/a-AAAAAAAA.js': 'z', ...b }, commitOf('b'))
    await assert.rejects(
        prepare({ dist: changed, store, now: new Date(day), commit: commitOf('b'), days }),
        /assets\/a-AAAAAAAA\.js is in the store with different contents/,
    )
    assert.equal(await store.headIndex(), before)
    assert.ok(!store.objects.has('assets/b-BBBBBBBB.js'))

    // An object the index does not list: other bytes fail, the same bytes are adopted.
    store.objects.set('assets/c-CCCCCCCC.js', Buffer.from('other'))
    const stray = await build(t, c, commitOf('c'))
    await assert.rejects(
        prepare({ dist: stray, store, now: new Date(day), commit: commitOf('c'), days }),
        /assets\/c-CCCCCCCC\.js is stored with different contents/,
    )
    store.objects.set('assets/c-CCCCCCCC.js', Buffer.from('c'))
    const again = await build(t, c, commitOf('c'))
    await prepare({ dist: again, store, now: new Date(day), commit: commitOf('c'), days })
    assert.equal(store.index.assets['assets/c-CCCCCCCC.js'].sha256, sha256(Buffer.from('c')))
})

test('a kept file that is corrupt or missing in the store fails the deploy', async (t) => {
    const store = memoryStore()
    await deploy(t, store, { at: 0, letter: 'a', extra: a })
    store.faults.corrupt.add('assets/a-AAAAAAAA.js')
    const dist = await build(t, b, commitOf('b'))
    const run = () => prepare({ dist, store, now: new Date(day), commit: commitOf('b'), days })
    await assert.rejects(run(), /assets\/a-AAAAAAAA\.js in the store does not match/)
    store.faults.corrupt.clear()
    store.objects.delete('assets/a-AAAAAAAA.js')
    await assert.rejects(run(), /assets\/a-AAAAAAAA\.js is missing from the store/)
    assert.equal((await manifestOf(dist)).retained, undefined)
})

test('a dropped file is kept for the window, then deleted at a record', async (t) => {
    const store = memoryStore()
    await deploy(t, store, { at: 0, letter: 'a', extra: a })
    await deploy(t, store, { at: day, letter: 'b', extra: b })
    // a left the site when b was recorded, at day + 1 minute.
    const retired = day + minute
    const kept = await deploy(t, store, { at: retired + 7 * day - 1, letter: 'c', extra: c })
    assert.ok(kept.retained.includes('assets/a-AAAAAAAA.js'))
    assert.ok(!store.objects.has('assets/a-AAAAAAAA.js'), 'deleted when c was recorded')
    assert.ok(!store.index.assets['assets/a-AAAAAAAA.js'])
    const next = await deploy(t, store, { at: retired + 8 * day, letter: 'd', extra: d })
    assert.ok(!next.retained.includes('assets/a-AAAAAAAA.js'))
})

test('a failed delete stays in the index and is tried again at the next record', async (t) => {
    const store = memoryStore()
    await deploy(t, store, { at: 0, letter: 'a', extra: a })
    await deploy(t, store, { at: day, letter: 'b', extra: b })
    store.faults.deleteFails.add('assets/a-AAAAAAAA.js')
    await assert.rejects(
        deploy(t, store, { at: 9 * day, letter: 'c', extra: c }),
        /could not be deleted, and the next record tries again: assets\/a-AAAAAAAA\.js/,
    )
    assert.ok(store.index.assets['assets/a-AAAAAAAA.js'])
    assert.equal(store.index.next, null, 'the index was written')
    store.faults.deleteFails.clear()
    const next = await deploy(t, store, { at: 10 * day, letter: 'd', extra: d })
    assert.ok(!next.retained.includes('assets/a-AAAAAAAA.js'))
    assert.ok(!store.index.assets['assets/a-AAAAAAAA.js'])
    assert.ok(!store.objects.has('assets/a-AAAAAAAA.js'))
})

test('a file deleted by a record whose index write failed is stored again when it returns', async (t) => {
    const store = memoryStore()
    await deploy(t, store, { at: 0, letter: 'a', extra: a })
    await deploy(t, store, { at: day, letter: 'b', extra: b })
    const dist = await build(t, c, commitOf('c'))
    await prepare({ dist, store, now: new Date(9 * day), commit: commitOf('c'), days })
    store.faults.failIndexWrites = 1
    await assert.rejects(
        record({ store, now: new Date(9 * day + minute), commit: commitOf('c'), days }),
        /index write failed/,
    )
    assert.ok(!store.objects.has('assets/a-AAAAAAAA.js'))
    assert.ok(store.index.assets['assets/a-AAAAAAAA.js'], 'still indexed')
    // A build brings a back, and a later one drops it again: it must be in the store to be kept.
    await deploy(t, store, { at: 9 * day + 2 * minute, letter: 'd', extra: { ...a, ...d } })
    assert.ok(store.objects.has('assets/a-AAAAAAAA.js'))
    await deploy(t, store, { at: 9 * day + 4 * minute, letter: 'e', extra: d })
    const later = await deploy(t, store, { at: 9 * day + 6 * minute, letter: 'f', extra: {} })
    assert.ok(later.retained.includes('assets/a-AAAAAAAA.js'))
})

test('the index must exist, be valid, not change while in use, and stage the deployed commit', async (t) => {
    const dist = await build(t, a, commitOf('a'))
    const run = (store) => prepare({ dist, store, now: new Date(0), commit: commitOf('a'), days })
    const missing = memoryStore()
    missing.readIndex = async () => null
    await assert.rejects(run(missing), /no index\. Seed it first/)
    const broken = memoryStore()
    broken.setIndexBytes('{"version":1,')
    await assert.rejects(run(broken), /not valid JSON/)
    broken.setIndexBytes('{"version":1,"live":["assets/x-XXXXXXXX.js"],"next":null,"assets":{}}')
    await assert.rejects(run(broken), /Invalid asset store index: live/)

    const raced = memoryStore()
    const read = raced.readIndex
    raced.readIndex = async () => {
        const stored = await read()
        raced.setIndexBytes(emptyIndex)
        return stored
    }
    await assert.rejects(run(raced), /changed since it was read/)

    const store = memoryStore()
    await run(store)
    await assert.rejects(
        record({ store, now: new Date(minute), commit: commitOf('b'), days }),
        /staged a{40}, not the deployed b{40}/,
    )
})

// The live site: its manifest and files, served by a fake fetch.
function liveSite(t, manifest, files, broken = {}) {
    const fetch = t.mock.fn(async (url) => {
        const path = new URL(url).pathname.slice(1)
        if (path === 'release-manifest.json') return Response.json(manifest)
        if (broken[path] === 404) return new Response('', { status: 404 })
        if (broken[path]) return new Response(broken[path])
        if (Object.hasOwn(files, path)) return new Response(files[path])
        return new Response('', { status: 404 })
    })
    return fetch
}

test('seed builds the index from the live release, so the first deploy keeps it', async (t) => {
    const files = { ...a, ...b, 'index.html': '<html>' }
    const hashes = Object.fromEntries(
        Object.entries(files).map(([file, content]) => [file, sha256(Buffer.from(content))]),
    )
    const manifest = {
        site: 'test',
        commit: commitOf('a'),
        appVersion: '1.0.0-test+aaaaaaaa',
        files: {
            'assets/a-AAAAAAAA.js': hashes['assets/a-AAAAAAAA.js'],
            'index.html': hashes['index.html'],
        },
        retained: { 'assets/b-BBBBBBBB.js': hashes['assets/b-BBBBBBBB.js'] },
    }
    const origin = 'https://test.example'
    const options = { origin, site: 'test', now: new Date(0) }

    const store = memoryStore()
    store.readIndex = async () => null
    store.headIndex = async () => null
    let written
    store.writeIndex = async (bytes, condition) => {
        assert.deepEqual(condition, { ifNoneMatch: true })
        written = parseIndex(bytes)
    }
    await seed({ ...options, store, fetch: liveSite(t, manifest, files) })
    assert.deepEqual(written.live, ['assets/a-AAAAAAAA.js'])
    assert.deepEqual(Object.keys(written.assets), ['assets/a-AAAAAAAA.js', 'assets/b-BBBBBBBB.js'])
    assert.equal(written.assets['assets/b-BBBBBBBB.js'].lastLive, time(0))

    // The first deploy after the seed keeps the release that was live before it.
    const seeded = memoryStore()
    for (const [file, content] of Object.entries({ ...a, ...b }))
        seeded.objects.set(file, Buffer.from(content))
    seeded.setIndexBytes(JSON.stringify(written))
    const first = await deploy(t, seeded, { at: day, letter: 'c', extra: c })
    assert.deepEqual(first.retained, ['assets/a-AAAAAAAA.js', 'assets/b-BBBBBBBB.js'])
})

test('seed fails on a file that does not verify, the wrong site, or the wrong index state', async (t) => {
    const manifest = {
        site: 'test',
        commit: commitOf('a'),
        appVersion: '1.0.0-test+aaaaaaaa',
        files: { 'assets/a-AAAAAAAA.js': sha256(Buffer.from('a')) },
    }
    const options = { origin: 'https://test.example', site: 'test', now: new Date(0) }
    const fresh = () => {
        const store = memoryStore()
        store.readIndex = async () => null
        store.headIndex = async () => null
        return store
    }
    for (const [broken, error] of [
        [{ 'assets/a-AAAAAAAA.js': 'changed' }, /does not match its manifest/],
        [{ 'assets/a-AAAAAAAA.js': 404 }, /returned 404/],
    ]) {
        const store = fresh()
        await assert.rejects(
            seed({ ...options, store, fetch: liveSite(t, manifest, a, broken) }),
            error,
        )
        assert.equal(store.objects.size, 0)
    }
    await assert.rejects(
        seed({ ...options, site: 'production', store: fresh(), fetch: liveSite(t, manifest, a) }),
        /not a production release/,
    )
    await assert.rejects(
        seed({ ...options, replace: true, store: fresh(), fetch: liveSite(t, manifest, a) }),
        /no index to replace\. Run seed without --replace/,
    )
    const existing = memoryStore()
    existing.setIndexBytes('not json')
    await assert.rejects(
        seed({ ...options, store: existing, fetch: liveSite(t, manifest, a) }),
        /already has an index\. Use --replace/,
    )
    await seed({ ...options, replace: true, store: existing, fetch: liveSite(t, manifest, a) })
    assert.deepEqual(existing.index.live, ['assets/a-AAAAAAAA.js'])
})

// The AWS CLI adapter, with a fake `aws` that records each call.
function fakeAws(respond = () => ({})) {
    const calls = []
    const run = async (args) => {
        const file = args.find((arg) => arg.startsWith('file://'))
        const request = file && JSON.parse(await readFile(file.slice('file://'.length), 'utf8'))
        calls.push({ args, request })
        return { code: 0, stdout: '', stderr: '', ...respond(args, request, calls.length) }
    }
    return { calls, run }
}

test('the AWS store downloads by names relative to the assets folder, in batches', async () => {
    const aws = fakeAws()
    const store = awsStore({ bucket: 'nse-assets-1', prefix: 'test', run: aws.run })
    const names = Array.from({ length: 1200 }, (_, i) => `assets/f${i}-AAAAAAAA.js`)
    await store.download(names, 'folder')
    assert.equal(aws.calls.length, 3)
    const [first] = aws.calls
    assert.deepEqual(first.args.slice(0, 4), [
        's3',
        'cp',
        's3://nse-assets-1/test/assets/',
        'folder',
    ])
    assert.deepEqual(first.args.slice(4, 8), [
        '--recursive',
        '--only-show-errors',
        '--exclude',
        '*',
    ])
    assert.equal(first.args[8], '--include')
    assert.equal(first.args[9], 'f0-AAAAAAAA.js')
    const included = aws.calls.flatMap(({ args }) =>
        args.filter((_, i) => args[i - 1] === '--include'),
    )
    assert.deepEqual(
        included,
        names.map((name) => name.slice('assets/'.length)),
    )
})

test('the AWS store deletes in batches of 1,000 and reports each failed name', async () => {
    const names = Array.from({ length: 2500 }, (_, i) => `assets/f${i}-AAAAAAAA.js`)
    const aws = fakeAws((args, request, call) => {
        if (call === 1)
            return { stdout: JSON.stringify({ Errors: [{ Key: 'test/assets/f3-AAAAAAAA.js' }] }) }
        if (call === 2) return { code: 254, stderr: 'An error occurred (InternalError)' }
        return {}
    })
    const store = awsStore({ bucket: 'nse-assets-1', prefix: 'test', run: aws.run })
    const failed = await store.remove(names)
    assert.deepEqual(
        aws.calls.map(({ request }) => request.Objects.length),
        [1000, 1000, 500],
    )
    assert.equal(aws.calls[0].request.Objects[0].Key, 'test/assets/f0-AAAAAAAA.js')
    assert.deepEqual(failed, ['assets/f3-AAAAAAAA.js', ...names.slice(1000, 2000)])
})

test('the AWS store writes conditionally and reads a missing index as missing', async () => {
    const aws = fakeAws((args) => {
        if (args[1] === 'get-object')
            return { code: 254, stderr: 'An error occurred (NoSuchKey) when calling GetObject' }
        if (args[1] === 'head-object')
            return {
                code: 254,
                stderr: 'An error occurred (404) when calling HeadObject: Not Found',
            }
        if (args.includes('--if-none-match') && args.includes('test/assets/a-AAAAAAAA.js'))
            return {
                code: 254,
                stderr: 'An error occurred (PreconditionFailed) when calling PutObject',
            }
        return { stdout: '{}' }
    })
    const store = awsStore({ bucket: 'nse-assets-1', prefix: 'test', run: aws.run })
    assert.equal(await store.readIndex(), null)
    assert.equal(await store.headIndex(), null)
    const hash = sha256(Buffer.from('a'))
    assert.equal(await store.putNew('assets/a-AAAAAAAA.js', Buffer.from('a'), hash), 'exists')
    assert.equal(await store.putNew('assets/b-BBBBBBBB.js', Buffer.from('b'), hash), 'created')
    const put = aws.calls.at(-1).args
    assert.equal(put[put.indexOf('--if-none-match') + 1], '*')
    assert.equal(
        put[put.indexOf('--checksum-sha256') + 1],
        Buffer.from(hash, 'hex').toString('base64'),
    )
    await store.writeIndex(emptyIndex, { ifMatch: '"7"' })
    const write = aws.calls.at(-1).args
    assert.equal(write[write.indexOf('--key') + 1], 'test/index.json')
    assert.equal(write[write.indexOf('--if-match') + 1], '"7"')
})
