// The native frontend: a Vite build in native mode into dist-native/, from a
// staged public folder that holds only an allowlist, so a local public/resource/ can never leak in.
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageNotices } from './release-utils.mjs'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Stages the allowlisted public folder: Built-in, the notices, the CC0 text and theme.js if there is one. */
export async function stageNativePublic(root, destination) {
    await mkdir(destination, { recursive: true })
    // The licence texts of public/third-party/ are staged by stageNotices.
    await stageNotices(root, destination, 'native')
    await mkdir(join(destination, 'builtin'), { recursive: true })
    for (const file of (await readdir(join(root, 'public/builtin'))).filter((f) =>
        f.endsWith('.scp'),
    ))
        await cp(join(root, 'public/builtin', file), join(destination, 'builtin', file))
    await cp(
        join(root, 'builtin-assets/LICENSE.txt'),
        join(destination, 'notices/builtin-assets-CC0.txt'),
    )
    if (existsSync(join(root, 'public/theme.js')))
        await cp(join(root, 'public/theme.js'), join(destination, 'theme.js'))
}

/** Builds dist-native/ (or outDir) from the checkout at root. */
export async function buildNative({ root = defaultRoot, outDir = join(root, 'dist-native') } = {}) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'sekai-native-'))
    try {
        const publicDir = join(temporaryRoot, 'public')
        await stageNativePublic(root, publicDir)
        const { build } = await import('vite')
        await build({
            root,
            base: '/',
            mode: 'native',
            publicDir,
            logLevel: 'warn',
            build: { outDir, emptyOutDir: true },
        })
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true })
    }
    return outDir
}

if (import.meta.main) {
    const outDir = await buildNative()
    console.log(`Built ${outDir}`)
}
