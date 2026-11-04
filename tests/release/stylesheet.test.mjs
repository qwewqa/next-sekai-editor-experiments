import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Each stylesheet as the build's Tailwind plugin compiles it: its own sources, scanned for classes.
const css = async (file) => {
    const path = resolve(root, file)
    const compiler = await compile(await readFile(path, 'utf8'), {
        base: dirname(path),
        onDependency: () => {},
    })
    return compiler.build(new Scanner({ sources: compiler.sources }).scan())
}

test("the editor's stylesheet has its layout utilities, and the landing pages' reads only theirs", async () => {
    const editor = await css('src/index.css')
    const landing = await css('src/landing/landing.css')
    for (const utility of ['.absolute', '.size-full', '.grid'])
        assert.ok(editor.includes(`${utility} {`), `src/index.css lacks ${utility}`)
    assert.ok(!landing.includes('.size-full {'), "landing.css was built from the editor's sources")
})
