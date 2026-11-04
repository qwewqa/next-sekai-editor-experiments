// A small release that passes checkRelease: shared by the release checker's and the asset store's tests.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectPolicy, webPolicy } from '../../scripts/csp.mjs'
import {
    builtinFiles,
    builtinServerFiles,
    builtinTypes,
    lyonNoticeFiles,
    noticeFiles,
    sha256,
    staticFiles,
    writeReleaseManifest,
} from '../../scripts/release-utils.mjs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const metadata = {
    version: '1.0.0-test',
    commit: 'a'.repeat(40),
    base: '/',
    appVersion: '1.0.0-test+aaaaaaaa',
    atTag: false,
    site: 'production',
    sourceDirty: false,
    analytics: null,
}
export const page = `<!doctype html>
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
// The editor's page loads gate.js, a classic script, before the bundle, and links its stylesheet.
export const indexPage = page
    .replace('<title>', '<script src="/gate.js"></script><title>')
    .replace(
        '</head>',
        '<link rel="stylesheet" crossorigin href="/assets/index-12345678.css"></head>',
    )
export const withPolicy = (html) => injectPolicy(html, webPolicy)

export async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'sekai-release-test-'))
    t.after(async () => {
        assert.equal(dirname(directory), resolve(tmpdir()))
        assert.ok(directory.startsWith(join(tmpdir(), 'sekai-release-test-')))
        await rm(directory, { recursive: true, force: true })
    })
    return directory
}

export async function write(directory, file, content) {
    const target = join(directory, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
}

// The Built-in packages and the server folder the release makes from them.
export async function builtinRelease() {
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

export async function releaseFixture(t) {
    const directory = await temporary(t)
    const assets = ['skin', 'skin2', 'particle', 'effect', 'effect2'].map((name) => {
        const bytes = Buffer.from(`test ${name} package`)
        return {
            file: `resource/${name}.scp`,
            source: `https://example.com/sonolus/${name.startsWith('skin') ? 'skins' : name.startsWith('effect') ? 'effects' : 'particles'}/fixture`,
            bytes: bytes.length,
            sha256: sha256(bytes),
        }
    })
    for (const asset of assets)
        await write(
            directory,
            asset.file,
            `test ${asset.file.slice('resource/'.length, -'.scp'.length)} package`,
        )
    for (const file of [...staticFiles, ...noticeFiles])
        await write(directory, file, `test ${file}`)
    await write(directory, 'index.html', withPolicy(indexPage))
    await write(directory, 'privacy/index.html', withPolicy(page))
    await write(directory, 'terms/index.html', withPolicy(page))
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
