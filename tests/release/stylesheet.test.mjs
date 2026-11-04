import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { preprocessCSS, resolveConfig } from 'vite'
import {
    entryStylesheetFirst,
    entryStylesheetPlugin,
    entryStylesheetProblem,
} from '../../scripts/stylesheets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// A build transforms both stylesheets in no fixed order, so the landing one can come first.
test("the editor's stylesheet keeps its utilities when the landing stylesheet goes first", async () => {
    const config = await resolveConfig({ root, logLevel: 'silent' }, 'build')
    const css = async (file) => {
        const path = resolve(root, file)
        return (await preprocessCSS(await readFile(path, 'utf8'), path, config)).code
    }
    const landing = await css('src/landing/landing.css')
    const editor = await css('src/index.css')
    for (const utility of ['.absolute', '.size-full', '.grid'])
        assert.ok(editor.includes(`${utility} {`), `src/index.css lacks ${utility}`)
    assert.ok(!landing.includes('.size-full {'), "landing.css was built with the editor's config")
})

// A built page as Vite writes it: the policy first, the bundle, its preloads, then the shared
// chunks' stylesheets ahead of the entry's own.
const built = `<!doctype html>
<html>
    <head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'self'" />
        <script src="/gate.js"></script>
      <script type="module" crossorigin src="/assets/index-DWZCY1wJ.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/contextMenu-B3zl7dqV.js">
      <link rel="stylesheet" crossorigin href="/assets/ToggleVolumeIcon-Dq9fAF0D.css">
      <link rel="stylesheet" crossorigin href="/assets/contextMenu-BIskzE0C.css">
      <link rel="stylesheet" crossorigin media="all" href="/assets/index-BhLTRPPx.css">
    </head>
    <body></body>
</html>
`
const entryCss = ['assets/index-BhLTRPPx.css']
const tags = (html) => html.match(/<[a-z][^>]*>/g)

test("the editor's page links its own stylesheet first, and every other tag keeps its place", () => {
    const html = entryStylesheetFirst(built, entryCss)
    assert.equal(
        entryStylesheetProblem(built),
        '/assets/ToggleVolumeIcon-Dq9fAF0D.css comes before /assets/index-BhLTRPPx.css',
    )
    assert.equal(entryStylesheetProblem(html), undefined)
    const entry =
        '<link rel="stylesheet" crossorigin media="all" href="/assets/index-BhLTRPPx.css">'
    assert.deepEqual(
        tags(html),
        tags(built)
            .filter((tag) => tag !== entry)
            .toSpliced(6, 0, entry),
    )
    assert.ok(
        html.includes(
            `      ${entry}\n      <link rel="stylesheet" crossorigin href="/assets/ToggleVolumeIcon`,
        ),
    )
    assert.equal(entryStylesheetFirst(html, entryCss), html)
})

test("the build step changes the editor's page only", () => {
    const { handler } = entryStylesheetPlugin().transformIndexHtml
    const chunk = { viteMetadata: { importedCss: new Set(entryCss) } }
    assert.equal(entryStylesheetProblem(handler(built, { path: '/index.html', chunk })), undefined)
    for (const path of ['/privacy/index.html', '/terms/index.html'])
        assert.equal(handler(built, { path, chunk }), built)
    assert.equal(handler(built, { path: '/index.html' }), built)
})

test('the release check wants exactly one stylesheet named after the module script', () => {
    const entry =
        '<link rel="stylesheet" crossorigin media="all" href="/assets/index-BhLTRPPx.css">'
    assert.equal(
        entryStylesheetProblem(built.replace(entry, '')),
        'it links 0 stylesheets named after its module script',
    )
    assert.equal(
        entryStylesheetProblem(
            entryStylesheetFirst(built, entryCss).replace('</head>', `${entry}</head>`),
        ),
        'it links 2 stylesheets named after its module script',
    )
})
