import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { categories, lockedPackage } from './release-assets.mjs'

const lockFile = 'deployment/preview-assets.lock.json'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function readLock(root) {
    const lock = JSON.parse(await readFile(join(root, lockFile), 'utf8'))
    return Object.keys(categories)
        .filter((name) => lock[name])
        .map((name) => ({ name, category: categories[name], sha256: lock[name].sha256 }))
}

async function matches(file, expected) {
    try {
        return sha256(await readFile(file)) === expected
    } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
    }
}

// A file appears whole or not at all: two dev servers starting together never read a half-written one.
async function writeAtomic(file, write) {
    await mkdir(join(file, '..'), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
        await write(temporary)
        await rename(temporary, file)
    } finally {
        await rm(temporary, { force: true })
    }
}

/**
 * Puts the locked preview packages in public/resource/ for the dev server. A staged package that
 * matches the lock stays. Otherwise the package comes from a cache shared by every checkout of
 * the repository, and otherwise from coconut. A failure is reported in the result.
 */
export async function stageDevPreviewAssets(root, env = process.env, cacheRoot) {
    if (env.NSE_SKIP_PREVIEW_ASSETS === '1') return { skipped: true, failures: [] }
    const cache = cacheRoot ?? join(root, 'node_modules/.cache/nse-preview-assets')
    const failures = []
    let entries
    try {
        entries = await readLock(root)
    } catch (error) {
        return { skipped: false, failures: [`the lock cannot be read: ${error.message}`] }
    }
    for (const { name, category, sha256: expected } of entries) {
        try {
            const target = join(root, 'public/resource', `${name}.scp`)
            if (await matches(target, expected)) continue
            const cached = join(cache, `${expected}.scp`)
            if (!(await matches(cached, expected))) {
                const { bytes } = await lockedPackage(root, name, category)
                await writeAtomic(cached, (file) => writeFile(file, bytes))
            }
            await writeAtomic(target, (file) => copyFile(cached, file))
        } catch (error) {
            failures.push(`${name}: ${error.message}`)
        }
    }
    return { skipped: false, failures }
}

/**
 * Whether the web build has the Next SEKAI assets, decided once when the build or the dev server
 * starts. They are in when every locked package is staged and matches the lock. A release build
 * checks the packages itself and says so with NSE_PREVIEW_ASSETS=release.
 */
export async function previewAssetsMode(root, env = process.env) {
    if (env.NSE_SKIP_PREVIEW_ASSETS === '1')
        return { included: false, reason: 'NSE_SKIP_PREVIEW_ASSETS is set' }
    if (env.NSE_PREVIEW_ASSETS === 'release') return { included: true }
    let entries
    try {
        entries = await readLock(root)
    } catch (error) {
        return { included: false, reason: `the lock cannot be read (${error.message})` }
    }
    const missing = []
    for (const { name, sha256: expected } of entries)
        if (!(await matches(join(root, 'public/resource', `${name}.scp`), expected)))
            missing.push(`${name}.scp`)
    return missing.length
        ? { included: false, reason: `public/resource/ lacks or differs on ${missing.join(', ')}` }
        : { included: true }
}
