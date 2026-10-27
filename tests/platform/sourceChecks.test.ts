import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { sourceWithout } from './sourceText'

const root = join(import.meta.dirname, '../..')
const src = join(root, 'src')

const sources = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|vue|js|mjs)$/.test(entry.name))
    .map((entry) => {
        const file = join(entry.parentPath, entry.name)
        const path = relative(root, file).replaceAll('\\', '/')
        const text = readFileSync(file, 'utf8')
        return {
            path,
            code: sourceWithout(path, text, false),
            calls: sourceWithout(path, text, true),
        }
    })

/**
 * The files whose code matches, as paths. Comments never count. A pattern about calls and
 * assignments is matched with the inside of strings blanked too; one about a string's own text
 * (`strings`) is matched with the strings kept.
 */
const matching = (pattern: RegExp, { strings = false } = {}) =>
    sources
        .filter((source) => pattern.test(strings ? source.code : source.calls))
        .map(({ path }) => path)

/** A call to window.open, or to a bare open that starts with a string. */
const windowOpen = /\bwindow\.open\s*\(|(^|[^.\w])open\s*\(\s*['"`]/m

test('the source scan sees the app', () => {
    assert.ok(sources.some(({ path }) => path === 'src/platform/web.ts'))
    assert.ok(sources.length > 100)
})

test('comments and the inside of strings do not read as calls', () => {
    const call = windowOpen
    const cases: [string, string, boolean][] = [
        ['a.ts', 'window.open(url)', true],
        ['a.ts', 'open("x")', true],
        ['a.ts', '// 😀😀\nwindow.open(url)', true],
        ['a.ts', 'const a = "😀"; window.open(url)', true],
        ['a.ts', '// A peek is open (`readOnly`).\nopen("x")', true],
        ['a.ts', '// A peek is open (`readOnly`), not window.open(url).', false],
        ['a.ts', '/* open("x") */ const a = 1', false],
        ['a.ts', "const a = 'window.open(url)'", false],
        ['a.ts', 'const a = `// ${b} window.open(url)`', false],
        ['A.vue', '<!-- window.open(url) -->', false],
        ['A.vue', '<script setup>\nwindow.open(url)\n</script>', true],
        ['A.vue', '<script setup>\n// window.open(url)\n</script>', false],
    ]
    for (const [path, text, matches] of cases) {
        const seen = sourceWithout(path, text, true)
        assert.equal(seen.length, text.length, text)
        assert.equal(call.test(seen), matches, text)
    }
})

test('navigator.share and canShare appear nowhere in src/', () => {
    assert.deepEqual(matching(/navigator\.share|canShare/), [])
})

test('nothing in src/ navigates the app context', () => {
    // Assigning location, or its assign and replace, would navigate the editor's own tab.
    assert.deepEqual(matching(/\blocation\s*=[^=]|\blocation\.href\s*=[^=]/), [])
    // Entering and leaving safe mode (`?safe`, web only) reload the tab on purpose, as the dev-only
    // sample seeder does once it has seeded.
    assert.deepEqual(matching(/\blocation\.(assign|replace)\s*\(/), [
        'src/safe.ts',
        'src/local/seed.ts',
    ])
    // window.open is openExternal's, which refuses Blob and data: URLs, and the hand-over's
    // fallback, which opens a new context.
    assert.deepEqual(matching(windowOpen), ['src/platform/handover.ts', 'src/platform/web.ts'])
    // Downloads never target this context.
    assert.deepEqual(matching(/['"]_self['"]/, { strings: true }), [])
})

test('only src/platform/index.ts imports #platform', () => {
    assert.deepEqual(
        matching(/from\s+['"]#platform['"]|import\s*\(\s*['"]#platform['"]/, { strings: true }),
        ['src/platform/index.ts'],
    )
})

test('downloads, pickers and close handling go through the platform', () => {
    assert.deepEqual(matching(/\.download\s*=/), ['src/platform/handover.ts'])
    assert.deepEqual(matching(/showSaveFilePicker|showOpenFilePicker/), ['src/platform/web.ts'])
    // The hand-over's pagehide only releases download URLs; the usage statistics' pagehide sends
    // the last batch.
    assert.deepEqual(matching(/['"]beforeunload['"]|['"]pagehide['"]/, { strings: true }), [
        'src/analytics/client.ts',
        'src/platform/handover.ts',
        'src/platform/web.ts',
    ])
})
