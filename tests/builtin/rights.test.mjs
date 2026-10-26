import { ESLint } from 'eslint'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { productName as manifestName } from '../../builtin-assets/manifest.mjs'
import {
    arrowColors,
    bodyColors,
    diamondColors,
    traceColors,
} from '../../builtin-assets/palette.mjs'
import { readZip } from '../../builtin-assets/zip.mjs'
import config from '../../eslint.config.js'
import { productName } from '../../scripts/native.mjs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('the native defaults module imports neither bg.png nor the clips', () => {
    const source = read('src/preview/assets/defaults.native.ts').toString('utf8')
    assert.equal(/bg\.png|se_live|\.mp3|defaults\.web|resource\//.test(source), false)
})

test('the web-only list matches the files and locks it names', () => {
    const list = JSON.parse(read('deployment/web-only-assets.json'))
    const lock = JSON.parse(read('deployment/preview-assets.lock.json'))
    const names = list.files.map((file) => file.name)
    for (const name of [
        ...readdirSync(new URL('../../src/assets/', import.meta.url)).filter((f) =>
            f.startsWith('se_live_'),
        ),
        'bg.png',
        'thumbnail.png',
        'favicon.ico',
        'skin.scp',
        'skin2.scp',
        'particle.scp',
        'skin texture',
        'skin thumbnail',
        'skin2 texture',
        'skin2 thumbnail',
        'effect2.scp',
        'effect2 audio',
        'particle texture',
    ])
        assert.ok(names.includes(name), name)
    for (const file of list.files) {
        if (/^src\/|^public\/(?:thumbnail|favicon)/.test(file.source) && !file.source.includes(':'))
            assert.equal(sha256(read(file.source)), file.sha256, file.source)
        else if (file.source.startsWith('deployment/')) {
            const type = file.source.split('#')[1]
            assert.equal(lock[type].sha256, file.sha256, file.source)
        } else {
            // Only the locked package: nativeBundle.test.mjs plants a stand-in while it builds.
            const [path, part] = file.source.split(':')
            const type = path.match(/(\w+)\.scp$/)[1]
            const bytes = existsSync(new URL(`../../${path}`, import.meta.url)) && read(path)
            if (bytes && sha256(bytes) === lock[type].sha256)
                assert.equal(sha256(readZip(bytes).get(part)), file.sha256, file.source)
        }
    }
    const patterns = list.references.map((r) => r.text ?? r.regex)
    for (const reference of [
        'thumbnail.png',
        'favicon.ico',
        'se_live',
        'resource/',
        'coconut',
        'og:image',
        'og:site_name',
    ])
        assert.ok(patterns.includes(reference), reference)
    assert.ok(list.references.some((r) => r.regex && new RegExp(r.regex).test('bg-aB3_-xyZ.png')))
})

test('the franchise pictures stay out of the packages the lock names', () => {
    const lock = JSON.parse(read('deployment/preview-assets.lock.json'))
    for (const name of ['particle', 'effect2']) {
        assert.equal(lock[name].thumbnail, false, name)
        assert.equal('thumbnail' in lock[name].item, false, name)
    }
    const names = JSON.parse(read('deployment/web-only-assets.json')).files.map((file) => file.name)
    assert.equal(names.includes('particle thumbnail'), false)
    assert.equal(names.includes('effect2 thumbnail'), false)
})

test('coconut appears in no locale file', () => {
    for (const locale of readdirSync(new URL('../../src/i18n/', import.meta.url), {
        withFileTypes: true,
    }))
        if (locale.isDirectory())
            assert.equal(
                /coconut/i.test(read(`src/i18n/${locale.name}/index.json`).toString('utf8')),
                false,
                locale.name,
            )
})

test('the palette copies match the editor’s note constants', () => {
    const notes = read('src/editor/canvas/notes.ts').toString('utf8')
    const colors = [
        ...Object.values(bodyColors).flat(),
        ...Object.values(traceColors),
        ...Object.values(diamondColors),
        ...Object.values(arrowColors),
        '#a50acc',
    ]
    for (const color of colors) assert.ok(notes.includes(color), color)
    assert.equal(productName, manifestName)
})

// The boundary rules of the real config, applied to small sources at src/ paths.
const lint = async (filePath, code) => {
    const boundary = config.filter(
        (entry) => entry.rules?.['no-restricted-syntax'] || entry.rules?.['no-restricted-imports'],
    )
    const eslint = new ESLint({
        overrideConfigFile: true,
        overrideConfig: boundary,
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
    })
    const [result] = await eslint.lintText(code, { filePath })
    return result.messages.map((message) => message.ruleId).filter(Boolean)
}

test('the boundary rules stop native names in shared code', async () => {
    const shared = 'src/editor/example.ts'
    for (const code of [
        "import { invoke } from '@tauri-apps/api/core'\n",
        "import { platform } from '../platform/native'\n",
        "import { home } from '../library/home'\n",
        'export const native = __NATIVE__\n',
        'export const tauri = isTauri()\n',
        'export const kind = platform.kind\n',
        'export const os = platform.os\n',
        'const { kind } = platform\n',
        'export const k = this.platform.kind\n',
        "export const k = platform['kind']\n",
        'const { os } = deps.platform\n',
        "export const lazy = () => import('../platform/native')\n",
        "export const lazy = () => import('../library/home')\n",
        "export const lazy = () => import('@tauri-apps/api/core')\n",
    ])
        assert.ok((await lint(shared, code)).length > 0, code)
    assert.deepEqual(
        await lint(
            shared,
            "import { platform } from '../platform'\nexport const w = platform.capabilities\n",
        ),
        [],
    )
})

test('the boundary rules allow native names where they belong', async () => {
    assert.deepEqual(
        await lint(
            'src/platform/native/example.ts',
            "import { invoke } from '@tauri-apps/api/core'\nexport const t = isTauri()\n",
        ),
        [],
    )
    assert.deepEqual(await lint('src/library/example.ts', 'export const n = __NATIVE__\n'), [])
    assert.deepEqual(await lint('src/platform/example.ts', 'export const k = platform.kind\n'), [])
    assert.deepEqual(
        await lint('src/nativeLoader.ts', "export const l = () => import('./library/home')\n"),
        [],
    )
})
