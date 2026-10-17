import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '../..')
const src = join(root, 'src')

const sources = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|vue|js|mjs)$/.test(entry.name))
    .map((entry) => {
        const path = join(entry.parentPath, entry.name)
        return {
            path: relative(root, path).replaceAll('\\', '/'),
            text: readFileSync(path, 'utf8'),
        }
    })

/** The files whose text matches, as paths. */
const matching = (pattern: RegExp) =>
    sources.filter(({ text }) => pattern.test(text)).map(({ path }) => path)

test('the source scan sees the app', () => {
    assert.ok(sources.some(({ path }) => path === 'src/platform/web.ts'))
    assert.ok(sources.length > 100)
})

test('navigator.share and canShare appear nowhere in src/', () => {
    assert.deepEqual(matching(/navigator\.share|canShare/), [])
})

test('nothing in src/ navigates the app context', () => {
    // Assigning location, or its assign and replace, would navigate the editor's own tab.
    assert.deepEqual(matching(/\blocation\s*=[^=]|\blocation\.href\s*=[^=]/), [])
    assert.deepEqual(matching(/\blocation\.(assign|replace)\s*\(/), [])
    // window.open is only openExternal's, which refuses Blob and data: URLs.
    assert.deepEqual(matching(/\bwindow\.open\s*\(|(^|[^.\w])open\s*\(\s*['"`]/m), [
        'src/platform/web.ts',
    ])
})

test('only src/platform/index.ts imports #platform', () => {
    assert.deepEqual(matching(/from\s+['"]#platform['"]|import\s*\(\s*['"]#platform['"]/), [
        'src/platform/index.ts',
    ])
})

test('downloads, pickers and close handling go through the platform', () => {
    assert.deepEqual(matching(/['"]file-saver['"]/), ['src/platform/web.ts'])
    assert.deepEqual(matching(/showSaveFilePicker|showOpenFilePicker/), ['src/platform/web.ts'])
    assert.deepEqual(matching(/['"]beforeunload['"]|['"]pagehide['"]/), ['src/platform/web.ts'])
})
