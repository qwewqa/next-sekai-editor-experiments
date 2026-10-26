import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))

// One web build of the editor with the given variables, and everything it emitted as text.
async function web(t, env) {
    const out = await mkdtemp(join(tmpdir(), 'sekai-switch-'))
    t.after(() => rm(out, { recursive: true, force: true }))
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
        await build({
            root,
            logLevel: 'silent',
            publicDir: false,
            build: { outDir: out, emptyOutDir: true },
        })
    } finally {
        for (const key of Object.keys(env))
            if (key in saved) process.env[key] = saved[key]
            else delete process.env[key]
    }
    const files = await readdir(join(out, 'assets'))
    let code = ''
    for (const file of files.filter((name) => name.endsWith('.js')))
        code += await readFile(join(out, 'assets', file), 'utf8')
    return { files, code }
}

test('a web build without the Next SEKAI packages is Built-in only', async (t) => {
    const { files, code } = await web(t, { NSE_SKIP_PREVIEW_ASSETS: '1' })
    assert.equal(
        files.some((name) => /^bg-/.test(name)),
        false,
        'bg.png is not in the bundle',
    )
    assert.equal(code.includes('resource/'), false, 'no package is named')
    assert.ok(code.includes('builtin/'), 'the Built-in defaults are in')
})

test('a web build with them has the packages, the background and no committed clips', async (t) => {
    const { files, code } = await web(t, { NSE_PREVIEW_ASSETS: 'release' })
    assert.ok(
        files.some((name) => /^bg-.*\.png$/.test(name)),
        'bg.png is in the bundle',
    )
    assert.ok(code.includes('resource/'), 'the packages are named')
    assert.equal(
        files.some((name) => /se_live/.test(name)),
        false,
        'no sound effect clip is emitted',
    )
})
