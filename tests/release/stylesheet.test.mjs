import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { preprocessCSS, resolveConfig } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// A build transforms both pages' stylesheets at once, in no fixed order.
test('the editor’s stylesheet keeps its utilities when the landing stylesheet goes first', async () => {
    const config = await resolveConfig({ root, logLevel: 'silent' }, 'build')
    const css = async (file) =>
        (await preprocessCSS(await readFile(resolve(root, file), 'utf8'), resolve(root, file), config))
            .code
    const landing = await css('src/landing/landing.css')
    const editor = await css('src/index.css')
    for (const utility of ['.absolute', '.size-full', '.grid'])
        assert.ok(editor.includes(`${utility} {`), `src/index.css lacks ${utility}`)
    assert.ok(!landing.includes('.size-full {'), 'landing.css uses its own config')
})
