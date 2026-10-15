import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    checkRelease,
    lyonNoticeFiles,
    noticeFiles,
    sha256,
    stageReleasePublic,
    staticFiles,
    writeReleaseManifest,
} from '../../scripts/release-utils.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const metadata = {
    version: '1.0.0-test',
    commit: 'a'.repeat(40),
    base: '/',
    appVersion: '1.0.0-test+aaaaaaaa',
    sourceDirty: false,
}

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
    for (const file of ['index.html', ...staticFiles, ...noticeFiles])
        await write(directory, file, `test ${file}`)
    for (const file of lyonNoticeFiles)
        await write(directory, file, await readFile(join(root, 'public', file)))
    await write(
        directory,
        'assets/lyon-12345678.wasm',
        await readFile(join(root, 'src/rendering/vendor/lyon.wasm')),
    )
    await write(directory, 'assets/index-12345678.js', 'console.log("release")')
    await write(directory, 'assets/index-12345678.css', 'body { color: red }')
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
