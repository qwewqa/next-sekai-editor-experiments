import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildNative, stageNativePublic } from '../../scripts/build-native.mjs'
import {
    checkNativeBundle,
    localReferences,
    mentionsCrate,
} from '../../scripts/check-native-bundle.mjs'
import { nativeIndexHtml, productName } from '../../scripts/native.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const planted = join(root, 'public/resource/skin.scp')

let scratch
let dist
let createdDir // the first folder the test created, if any

const copyDist = async (name) => {
    const target = join(scratch, name)
    await cp(dist, target, { recursive: true })
    return target
}

const problemsOf = (directory, options) => checkNativeBundle(directory, { root, ...options })

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'sekai-native-test-'))
    // A local public/resource/ must not reach the build; plant one when the checkout has none.
    if (!existsSync(planted)) {
        createdDir = await mkdir(dirname(planted), { recursive: true })
        await writeFile(planted, 'planted')
    }
    dist = await buildNative({ root, outDir: join(scratch, 'dist-native') })
})

after(async () => {
    // Remove only what the test made: the planted file, and the folders it created.
    if (existsSync(planted) && readFileSync(planted, 'utf8') === 'planted') {
        await rm(planted, { force: true })
        if (createdDir) await rm(createdDir, { recursive: true, force: true })
    }
    await rm(scratch, { recursive: true, force: true })
})

test('a native build passes the bundle check, with a planted public/resource/ left out', async () => {
    assert.deepEqual(await problemsOf(dist), [])
    assert.equal(existsSync(join(dist, 'resource')), false)
    assert.equal(existsSync(join(dist, 'favicon.ico')), false)
    assert.equal(existsSync(join(dist, 'thumbnail.png')), false)
})

test('the staged public folder holds only the allowlist', async () => {
    const staged = join(scratch, 'staged')
    await stageNativePublic(root, staged)
    const top = (await readdir(staged)).sort()
    assert.deepEqual(
        top.filter((name) => name !== 'theme.js'),
        ['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'builtin', 'notices', 'third-party'],
    )
    assert.deepEqual((await readdir(join(staged, 'builtin'))).sort(), [
        'background.scp',
        'effect.scp',
        'particle.scp',
        'skin.scp',
    ])
    assert.ok(existsSync(join(staged, 'notices/builtin-assets-CC0.txt')))
})

test('a native build resolves #platform and #asset-defaults to their native targets', async () => {
    const assets = join(dist, 'assets')
    let all = ''
    for (const file of (await readdir(assets)).filter((name) => name.endsWith('.js')))
        all += await readFile(join(assets, file), 'utf8')
    assert.ok(all.includes('Not implemented in this build.'), 'the platform stub is in')
    assert.ok(all.includes('builtin/'), 'the Built-in defaults are in')
    assert.equal(/se_live|resource\/|bg-[\w-]{8}\.png/.test(all), false)
})

test('the web build keeps the default targets', async () => {
    const imports = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).imports
    assert.deepEqual(Object.keys(imports['#platform']), ['native', 'default'])
    assert.deepEqual(Object.keys(imports['#asset-defaults']), ['native', 'default'])
    assert.ok(import.meta.resolve('#platform').endsWith('/src/platform/web.ts'))
    assert.ok(
        import.meta.resolve('#asset-defaults').endsWith('/src/preview/assets/defaults.web.ts'),
    )
})

test('the native page has no og tags or icon link and keeps its theme script', async () => {
    const html = await readFile(join(dist, 'index.html'), 'utf8')
    assert.equal(/og:|rel="icon"/.test(html), false)
    assert.ok(html.includes(`<title>${productName}</title>`))
    assert.ok(html.includes('dataset.theme'))
    assert.ok(html.includes('name="description"'))
    assert.ok(html.includes('name="viewport"'))
    const source = await readFile(join(root, 'index.html'), 'utf8')
    assert.ok(source.includes('og:image'), 'the web page is unchanged')
    assert.throws(() => nativeIndexHtml('<html><head></head></html>'), /title/)
})

test('a page’s local references are found', () => {
    assert.deepEqual(
        localReferences(
            '<script src="/theme.js"></script><link href="/assets/a.css?x=1" rel="stylesheet"><img src="https://x/y.png"><script src="//cdn/z.js"></script>',
        ),
        ['theme.js', 'assets/a.css'],
    )
})

test('the bundle check fails on each kind of web-only content', async () => {
    const tamper = async (name, change, expected, options) => {
        const directory = await copyDist(name)
        await change(directory)
        const problems = await problemsOf(directory, options)
        assert.ok(
            problems.some((problem) => expected.test(problem)),
            `${name}: ${problems.join('; ') || 'no problem'}`,
        )
    }
    const index = (directory) => join(directory, 'index.html')
    const addToIndex = async (directory, text) =>
        writeFile(
            index(directory),
            (await readFile(index(directory), 'utf8')).replace('</head>', `${text}</head>`),
        )

    await tamper('sw', (d) => writeFile(join(d, 'sw.js'), '//'), /service worker/)
    await tamper('manifest', (d) => writeFile(join(d, 'app.webmanifest'), '{}'), /manifest/)
    await tamper('link', (d) => addToIndex(d, '<link rel="manifest" href="/m.json">'), /manifest/)
    await tamper(
        'register',
        (d) => writeFile(join(d, 'assets/sw-register.js'), 'navigator.serviceWorker.register("x")'),
        /service worker/,
    )
    await tamper(
        'resource',
        (d) => mkdir(join(d, 'resource')).then(() => writeFile(join(d, 'resource/a'), 'x')),
        /resource\/ exists/,
    )
    await tamper(
        'hash',
        (d) =>
            cp(join(root, 'src/assets/se_live_perfect.mp3'), join(d, 'assets/clip-abcdefgh.mp3')),
        /web-only file se_live_perfect\.mp3/,
    )
    await tamper(
        'reference',
        (d) => writeFile(join(d, 'assets/x.js'), 'fetch("https://coconut.sonolus.com")'),
        /reference coconut/,
    )
    await tamper('og', (d) => addToIndex(d, '<meta property="og:image" content="x">'), /og:image/)
    await tamper(
        'theme',
        (d) => addToIndex(d, '<script src="/theme.js"></script>'),
        /theme\.js, which is missing/,
    )
    await tamper('missing', (d) => rm(join(d, 'builtin/skin.scp')), /builtin\/skin\.scp is missing/)
    await tamper(
        'lock',
        async (d) => writeFile(join(d, 'builtin/skin.scp'), 'changed'),
        /does not match builtin-assets\.lock\.json/,
    )
    await tamper('cc0', (d) => rm(join(d, 'notices/builtin-assets-CC0.txt')), /CC0/)
    await tamper(
        'credit',
        (d) => writeFile(join(d, 'THIRD_PARTY_NOTICES.txt'), 'nothing'),
        /Font Awesome credit/,
    )
    if (!existsSync(join(root, 'src-tauri/Cargo.lock')))
        await tamper('full', async () => undefined, /Cargo\.lock is missing/, { full: true })
})

test('a crate counts as named only by its whole name', () => {
    const notices = 'catalog 1.0\nserde_json 1.0.1\nlog-surgeon\nurl 2.5.0\n'
    assert.equal(mentionsCrate(notices, 'log'), false)
    assert.equal(mentionsCrate(notices, 'serde'), false)
    assert.equal(mentionsCrate(notices, 'cat'), false)
    assert.equal(mentionsCrate(notices, 'serde_json'), true)
    assert.equal(mentionsCrate(notices, 'url'), true)
    assert.equal(mentionsCrate('a.b 1', 'a.b'), true)
    assert.equal(mentionsCrate('axb 1', 'a.b'), false)
})
