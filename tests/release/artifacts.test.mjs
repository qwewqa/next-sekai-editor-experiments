import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gateTag } from '../../scripts/analytics.mjs'
import { injectPolicy, webPolicy } from '../../scripts/csp.mjs'
import {
    builtinFiles,
    builtinServerFiles,
    builtinTypes,
    checkRelease,
    lyonNoticeFiles,
    noticeFiles,
    sha256,
    stageReleasePublic,
    staticFiles,
    writeReleaseManifest,
} from '../../scripts/release-utils.mjs'
import { applyTestSite } from '../../scripts/site.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const metadata = {
    version: '1.0.0-test',
    commit: 'a'.repeat(40),
    base: '/',
    appVersion: '1.0.0-test+aaaaaaaa',
    atTag: false,
    site: 'production',
    sourceDirty: false,
    analytics: null,
}
const page = `<!doctype html>
<html>
    <head>
        <title>Editor</title>
        <script>
            document.documentElement.dataset.theme = 'dark'
        </script>
    </head>
    <body><script type="module" src="/assets/index-12345678.js"></script></body>
</html>
`
// The editor's page loads the support gate, a classic script, ahead of the bundle, and links its
// stylesheet.
const indexPage = page
    .replace('<title>', '<script src="/gate.js"></script><title>')
    .replace(
        '</head>',
        '<link rel="stylesheet" crossorigin href="/assets/index-12345678.css"></head>',
    )
const withPolicy = (html) => injectPolicy(html, webPolicy)

async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'sekai-release-test-'))
    t.after(async () => {
        assert.equal(dirname(directory), resolve(tmpdir()))
        assert.ok(directory.startsWith(join(tmpdir(), 'sekai-release-test-')))
        await rm(directory, { recursive: true, force: true })
    })
    return directory
}

async function write(directory, file, content) {
    const target = join(directory, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
}

// The Built-in packages and the server folder the release makes from them.
async function builtinRelease() {
    const packages = new Map()
    const files = new Map()
    for (const [index, file] of builtinFiles.entries()) {
        const bytes = await readFile(join(root, 'public', file))
        packages.set(builtinTypes[index], bytes)
        files.set(file, bytes)
    }
    for (const [file, bytes] of builtinServerFiles(packages)) files.set(file, bytes)
    return files
}

async function releaseFixture(t) {
    const directory = await temporary(t)
    const assets = ['skin', 'particle'].map((name) => {
        const bytes = Buffer.from(`test ${name} package`)
        return {
            file: `resource/${name}.scp`,
            source: `https://example.com/sonolus/${name === 'skin' ? 'skins' : 'particles'}/fixture`,
            bytes: bytes.length,
            sha256: sha256(bytes),
        }
    })
    for (const asset of assets)
        await write(
            directory,
            asset.file,
            `test ${asset.file.includes('skin') ? 'skin' : 'particle'} package`,
        )
    for (const file of [...staticFiles, ...noticeFiles])
        await write(directory, file, `test ${file}`)
    await write(directory, 'index.html', withPolicy(indexPage))
    await write(directory, 'privacy/index.html', withPolicy(page))
    for (const file of lyonNoticeFiles)
        await write(directory, file, await readFile(join(root, 'public', file)))
    for (const [file, bytes] of await builtinRelease()) await write(directory, file, bytes)
    await write(
        directory,
        'assets/lyon-12345678.wasm',
        await readFile(join(root, 'src/rendering/vendor/lyon.wasm')),
    )
    await write(directory, 'assets/index-12345678.js', 'console.log("release")')
    await write(
        directory,
        'assets/index-12345678.css',
        '.absolute{position:absolute}.size-full{width:100%;height:100%}',
    )
    await writeReleaseManifest(directory, metadata, assets)
    return { directory, assets }
}

test('staging includes site notices without reading local preview packages', async (t) => {
    const directory = await temporary(t)
    await stageReleasePublic(root, directory)
    for (const file of lyonNoticeFiles)
        assert.deepEqual(
            await readFile(join(directory, file)),
            await readFile(join(root, 'public', file)),
        )
    await assert.rejects(readFile(join(directory, 'resource/skin.scp')), {
        code: 'ENOENT',
    })
    const notices = await readFile(join(directory, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    assert.match(notices, /@breezystack\/lamejs 1\.2\.7/)
    assert.match(notices, /Corresponding source archive:/)
    assert.match(notices, /pixi\.js 8\.22\.0/)
    assert.match(notices, /PixiJS 8\.22\.0 includes one checked source patch:/)
    assert.ok(
        notices.includes(
            (await readFile(join(root, 'node_modules/pixi.js/LICENSE'), 'utf8')).trim(),
        ),
        'The complete installed Pixi MIT license must be distributed',
    )
    assert.match(notices, /@pixi\/colord 2\.9\.6/)
    assert.match(notices, /Copyright \(c\) 2020 Vlad Shilov/)
    assert.doesNotMatch(notices, /canvaskit-wasm/)
    const tessellatorNotice = await readFile(join(directory, 'notices/libtess.txt'), 'utf8')
    assert.ok(
        tessellatorNotice.includes(
            await readFile(join(root, 'src/rendering/vendor/libtess.LICENSE'), 'utf8'),
        ),
        'The complete vendored SGI license must be distributed',
    )
    assert.match(tessellatorNotice, /Copyright 2015, Google Inc\./)
    const colorNotice = await readFile(join(directory, 'notices/pixi-colord.txt'), 'utf8')
    assert.ok(notices.includes(colorNotice.trim()))
    assert.match(colorNotice, /5344fbf77b736f81cd33c21050021bc09bc9dd1d/)
    assert.match(
        await readFile(join(directory, 'notices/LGPL-3.0.txt'), 'utf8'),
        /GNU LESSER GENERAL PUBLIC LICENSE/,
    )
})

test('artifact verification detects file tampering and unexpected files', async (t) => {
    const { directory } = await releaseFixture(t)
    await checkRelease(directory, metadata)
    await write(directory, 'assets/index-12345678.js', 'changed')
    await assert.rejects(checkRelease(directory), /file integrity failed/)
    await write(directory, 'assets/index-12345678.js', 'console.log("release")')
    await write(directory, 'resource/next-sekai-resources.scp', 'unintended media')
    await assert.rejects(checkRelease(directory), /Unexpected release file/)
})

test('a production bundle names no test key but the three live ones', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    const bundle = 'assets/index-12345678.js'
    const keys = 'get("nse.test.version","nse.test.storage","nse.test.startBlank")'
    await write(directory, bundle, keys)
    await writeReleaseManifest(directory, metadata, assets)
    await checkRelease(directory)
    await write(directory, bundle, `${keys};get("nse.test.platform")`)
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /gated key nse\.test\.platform/)
    await write(directory, 'index.html', withPolicy(applyTestSite(indexPage)))
    await writeReleaseManifest(directory, { ...metadata, site: 'test' }, assets)
    await checkRelease(directory)
})

test('a build with a usage statistics target names it, in its policy and its one client', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    const analytics = {
        origin: 'https://stats.nse-services.qwewqa.dev',
        website: '11111111-2222-3333-4444-555555555555',
    }
    const withTarget = { ...metadata, analytics }
    const policy = (html) => injectPolicy(html, (scripts) => webPolicy(scripts, analytics.origin))
    const client = `fetch("${analytics.origin}/api/batch")`
    const tagged = (tag = gateTag(analytics, 'production')) =>
        indexPage.replace('</head>', `${tag}</head>`)
    const build = async ({ index = client, origin = analytics.origin, pages = true } = {}) => {
        if (pages) {
            await write(directory, 'index.html', policy(tagged()))
            await write(directory, 'privacy/index.html', policy(page))
        }
        await write(directory, 'assets/index-12345678.js', `site("${analytics.website}")`)
        await write(directory, 'assets/client-12345678.js', index.replace(analytics.origin, origin))
        await writeReleaseManifest(directory, withTarget, assets)
    }
    await build()
    await checkRelease(directory, { analytics })
    await assert.rejects(
        checkRelease(directory, { analytics: { ...analytics, website: 'another' } }),
        /metadata mismatch: analytics/,
    )
    await assert.rejects(checkRelease(directory, { analytics: null }), /metadata mismatch/)
    await build({ origin: 'https://elsewhere.example' })
    await assert.rejects(checkRelease(directory), /does not name its analytics target/)
    await build()
    await write(directory, 'index.html', policy(indexPage))
    await assert.rejects(checkRelease(directory), /does not tag the gate/)
    await write(
        directory,
        'index.html',
        policy(tagged(gateTag({ ...analytics, website: 'x' }, 'production'))),
    )
    await assert.rejects(checkRelease(directory), /does not tag the gate/)
    await build({ pages: false })
    await write(directory, 'index.html', withPolicy(indexPage))
    await writeReleaseManifest(directory, withTarget, assets)
    await assert.rejects(checkRelease(directory), /Content Security Policy differs/)
    await build({ index: `${client};${client}` })
    await write(directory, 'assets/second-12345678.js', client)
    await writeReleaseManifest(directory, withTarget, assets)
    await assert.rejects(checkRelease(directory), /exactly one analytics client/)
    await writeReleaseManifest(
        directory,
        { ...withTarget, analytics: { origin: 'http://x' } },
        assets,
    )
    await assert.rejects(checkRelease(directory), /Invalid release metadata/)
})

test('a build without a target has no usage statistics client or gate tag', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await write(
        directory,
        'index.html',
        withPolicy(
            indexPage.replace(
                '</head>',
                `${gateTag({ origin: 'https://x', website: 'w' }, 'production')}</head>`,
            ),
        ),
    )
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /without analytics tags its page/)
    await write(directory, 'index.html', withPolicy(indexPage))
    // The gate names the path in every build, and is not a client.
    await write(directory, 'gate.js', 'sendBeacon(origin + "/api/batch")')
    await writeReleaseManifest(directory, metadata, assets)
    await checkRelease(directory)
    await write(directory, 'assets/client-12345678.js', 'fetch("https://x/api/batch")')
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(
        checkRelease(directory),
        /without analytics contains its client: assets.client-12345678.js/,
    )
})

test('an extra hashed bundle still fails when it was not recorded by the build', async (t) => {
    const { directory } = await releaseFixture(t)
    await write(directory, 'assets/unexpected-12345678.js', 'unrecorded')
    await assert.rejects(checkRelease(directory), /file inventory differs/)
})

test('obsolete WebAssembly renderer assets cannot enter a Pixi release', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    const path = 'assets/canvaskit-12345678.wasm'
    const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
    await write(directory, path, bytes)
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Unexpected release file/,
    )
})

test('package hashes detect replacements even when the file inventory is recomputed', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await write(directory, 'resource/skin.scp', 'replacement package')
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /Preview asset integrity failed/)
})

test('release identity must match the expected checkout and version', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await assert.rejects(
        checkRelease(directory, { commit: 'b'.repeat(40) }),
        /metadata mismatch: commit/,
    )
    await assert.rejects(
        checkRelease(directory, { version: '2.0.0' }),
        /metadata mismatch: version/,
    )
    await writeReleaseManifest(directory, { ...metadata, sourceDirty: true }, assets)
    await assert.rejects(
        checkRelease(directory, { sourceDirty: false }),
        /metadata mismatch: sourceDirty/,
    )
})

test('missing notices or required packages prevent producing a release manifest', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await rm(join(directory, 'notices/LGPL-3.0.txt'))
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Missing release file: notices\/LGPL-3.0.txt/,
    )
})

test('the vendored tessellator notice is required in the release manifest', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await rm(join(directory, 'notices/libtess.txt'))
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Missing release file: notices\/libtess.txt/,
    )
})

test('Lyon notice inventory and exact kernel remain required when hashes are recomputed', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    const file = lyonNoticeFiles[1]
    await write(directory, file, 'replaced notice')
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Lyon release notice differs/,
    )
    await write(directory, file, await readFile(join(root, 'public', file)))
    await write(directory, 'assets/lyon-12345678.wasm', new Uint8Array([0, 97, 115, 109]))
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Lyon release binary differs/,
    )
})

test('the version in the manifest follows the tag rule', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    const check = async (change) => {
        await writeReleaseManifest(directory, { ...metadata, ...change }, assets)
        return checkRelease(directory)
    }
    await check({ atTag: true, appVersion: '1.0.0-test' })
    await check({ appVersion: '1.0.0-test' })
    await assert.rejects(check({ atTag: true }), /Invalid release metadata/)
    await assert.rejects(check({ appVersion: '1.0.0-test+bbbbbbbb' }), /Invalid release metadata/)
    await assert.rejects(check({ atTag: undefined }), /Invalid release metadata/)
    await assert.rejects(check({ site: 'staging' }), /Invalid release metadata/)
})

test('the expected version, tag state and site must match the manifest', async (t) => {
    const { directory } = await releaseFixture(t)
    await checkRelease(directory, {
        appVersion: metadata.appVersion,
        atTag: false,
        site: 'production',
    })
    await assert.rejects(checkRelease(directory, { atTag: true }), /metadata mismatch: atTag/)
    await assert.rejects(
        checkRelease(directory, { appVersion: '1.0.0-test' }),
        /mismatch: appVersion/,
    )
    await assert.rejects(checkRelease(directory, { site: 'test' }), /metadata mismatch: site/)
})

test('every page carries the web policy as its first head child, hashing its inline scripts', async (t) => {
    const policy = withPolicy(page)
    const meta = policy.slice(policy.indexOf('<meta http-equiv'), policy.indexOf('/>') + 2)
    const { directory, assets } = await releaseFixture(t)
    const cases = {
        'an unhashed inline script': policy.replace('<title>', '<script>alert(1)</script><title>'),
        'no policy': page,
        'a policy after other tags': page.replace('</title>', '</title>' + meta),
        'a changed policy': policy.replace("'none'", "'self'"),
    }
    for (const [name, html] of Object.entries(cases))
        await t.test(name, async () => {
            await write(directory, 'index.html', html)
            await writeReleaseManifest(directory, metadata, assets)
            await assert.rejects(checkRelease(directory), /Content Security Policy differs/)
        })
})

test('the privacy page is a required entry with the web policy and its own hashed scripts', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await checkRelease(directory, metadata)
    await rm(join(directory, 'privacy/index.html'))
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Missing release file: privacy\/index\.html/,
    )
    await write(directory, 'privacy/index.html', page)
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /Content Security Policy differs.*privacy/)
    await write(
        directory,
        'privacy/index.html',
        withPolicy(page).replace('<title>', '<script>alert(1)</script><title>'),
    )
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /Content Security Policy differs.*privacy/)
})

test('gate.js is staged as it is in public/, and the release must hold it', async (t) => {
    const staged = await temporary(t)
    await stageReleasePublic(root, staged)
    assert.deepEqual(
        await readFile(join(staged, 'gate.js')),
        await readFile(join(root, 'public/gate.js')),
    )
    assert.ok(staticFiles.includes('gate.js'))
    const { directory, assets } = await releaseFixture(t)
    await rm(join(directory, 'gate.js'))
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Missing release file: gate.js/,
    )
})

test('index.html must load gate.js, a classic script, before the bundle', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    const bundle = '<script type="module" src="/assets/index-12345678.js"></script>'
    const gate = '<script src="/gate.js"></script>'
    const cases = {
        'no gate': indexPage.replace(gate, ''),
        'the gate after the bundle': indexPage
            .replace(gate, '')
            .replace('</body>', gate + '</body>'),
        'a deferred gate': indexPage.replace(gate, '<script defer src="/gate.js"></script>'),
        'no bundle': indexPage.replace(bundle, ''),
    }
    for (const [name, html] of Object.entries(cases))
        await t.test(name, async () => {
            await write(directory, 'index.html', withPolicy(html))
            await writeReleaseManifest(directory, metadata, assets)
            await assert.rejects(checkRelease(directory), /does not load gate.js before the bundle/)
        })
    await write(directory, 'index.html', withPolicy(indexPage))
    await writeReleaseManifest(directory, metadata, assets)
    await checkRelease(directory, metadata)
})

test('a release fails when the editor’s stylesheet lacks the layout utilities', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    // The stylesheet Tailwind generates from the landing pages' content alone.
    await write(directory, 'assets/index-12345678.css', '.flex{display:flex}.fixed{position:fixed}')
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /stylesheet lacks \.absolute and \.size-full$/)
})

test('the test site build must be the one that is marked as such', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    const testMetadata = { ...metadata, site: 'test' }
    await writeReleaseManifest(directory, testMetadata, assets)
    await assert.rejects(checkRelease(directory), /index.html does not match the site: test/)
    await write(directory, 'index.html', withPolicy(applyTestSite(indexPage)))
    await writeReleaseManifest(directory, testMetadata, assets)
    await checkRelease(directory, { site: 'test' })
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /index.html does not match the site: production/)
})

test('the apps’ bridge cannot be in a web release', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await write(directory, 'assets/index-12345678.js', 'window.__TAURI_INTERNALS__.invoke()')
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /__TAURI_INTERNALS__: assets\/index-12345678.js/)
})

test('the dev-only sample seeder cannot be in a web release', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await write(directory, 'assets/index-12345678.js', 'url.searchParams.get("seedSample")')
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /seedSample: assets\/index-12345678.js/)
})

test('the dev-only handle probe cannot be in a web release', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await write(directory, 'assets/index-12345678.js', 'document.title = "nse-handle-probe"')
    await writeReleaseManifest(directory, metadata, assets)
    await assert.rejects(checkRelease(directory), /nse-handle-probe: assets.index-12345678.js/)
})

test('every file in public/ is staged by the release build, except the preview packages', async (t) => {
    const directory = await temporary(t)
    await stageReleasePublic(root, directory)
    const walk = async (folder = '') => {
        const files = []
        for (const entry of await readdir(join(root, 'public', folder), { withFileTypes: true }))
            files.push(
                ...(entry.isDirectory()
                    ? await walk(`${folder}${entry.name}/`)
                    : [folder + entry.name]),
            )
        return files
    }
    for (const file of (await walk()).filter((file) => !file.startsWith('resource/')))
        assert.ok((await readFile(join(directory, file))).length > 0, `${file} must be staged`)
})

test('staging puts the four Built-in packages and their static server in the release', async (t) => {
    const directory = await temporary(t)
    await stageReleasePublic(root, directory)
    for (const file of builtinFiles)
        assert.deepEqual(
            await readFile(join(directory, file)),
            await readFile(join(root, 'public', file)),
        )
    // The server folder is the packages' entries, byte for byte, and one merged sonolus/info.
    for (const [file, bytes] of await builtinRelease())
        assert.deepEqual(await readFile(join(directory, file)), bytes, file)
    const info = JSON.parse(await readFile(join(directory, 'builtin-server/sonolus/info'), 'utf8'))
    assert.equal(info.title, 'Built-in Items')
    assert.deepEqual(
        info.buttons.map((button) => button.type),
        builtinTypes,
    )
    for (const category of ['skins', 'particles', 'backgrounds', 'effects']) {
        const list = JSON.parse(
            await readFile(join(directory, `builtin-server/sonolus/${category}/list`), 'utf8'),
        )
        assert.equal(list.pageCount, 1)
        assert.equal(list.items.length, 1)
        assert.equal(list.items[0].name, 'nse-builtin')
        await readFile(join(directory, `builtin-server/sonolus/${category}/nse-builtin`))
        // Each resource the item names is in the server's repository.
        for (const [key, value] of Object.entries(list.items[0]))
            if (value && typeof value === 'object' && 'url' in value && key !== 'author')
                await readFile(join(directory, 'builtin-server', value.url))
    }
    // Nothing else is written there.
    const walk = async (folder) => {
        const files = []
        for (const entry of await readdir(join(directory, folder), { withFileTypes: true }))
            files.push(
                ...(entry.isDirectory()
                    ? await walk(`${folder}/${entry.name}`)
                    : [`${folder}/${entry.name}`]),
            )
        return files
    }
    assert.deepEqual(
        (await walk('builtin-server')).sort(),
        [...(await builtinRelease()).keys()]
            .filter((file) => file.startsWith('builtin-server/'))
            .sort(),
    )
})

test('the release must hold the locked Built-in packages and exactly their server folder', async (t) => {
    const { directory, assets } = await releaseFixture(t)
    await checkRelease(directory, metadata)

    // A package other than the locked one, even with the manifest recomputed.
    const skin = await readFile(join(directory, 'builtin/skin.scp'))
    await rm(join(directory, 'builtin/skin.scp'))
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Missing release file: builtin\/skin\.scp/,
    )
    await write(directory, 'builtin/skin.scp', skin)
    await write(directory, 'builtin/skin.scp', Buffer.concat([skin, Buffer.from('x')]))
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Built-in package differs from builtin-assets\.lock\.json: builtin\/skin\.scp/,
    )
    await write(directory, 'builtin/skin.scp', skin)

    // A server file that is not what the packages unpack to.
    const list = 'builtin-server/sonolus/skins/list'
    const original = await readFile(join(directory, list))
    await write(directory, list, 'changed')
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Built-in server file differs from the packages: builtin-server\/sonolus\/skins\/list/,
    )
    await write(directory, list, original)

    // A missing one, and an extra one under the allowed pattern.
    await rm(join(directory, 'builtin-server/sonolus/info'))
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Missing release file: builtin-server\/sonolus\/info/,
    )
    await write(
        directory,
        'builtin-server/sonolus/info',
        (await builtinRelease()).get('builtin-server/sonolus/info'),
    )
    await write(directory, `builtin-server/sonolus/repository/${'a'.repeat(40)}`, 'extra')
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Unexpected release file: builtin-server\/sonolus\/repository/,
    )
    await rm(join(directory, `builtin-server/sonolus/repository/${'a'.repeat(40)}`))

    // Anything else in the folders is refused by name.
    await write(directory, 'builtin/extra.scp', 'extra')
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Unexpected release file/,
    )
    await rm(join(directory, 'builtin/extra.scp'))
    await write(directory, 'builtin-server/sonolus/other', 'extra')
    await assert.rejects(
        writeReleaseManifest(directory, metadata, assets),
        /Unexpected release file/,
    )
    await rm(join(directory, 'builtin-server/sonolus/other'))

    await writeReleaseManifest(directory, metadata, assets)
    await checkRelease(directory, metadata)
})
