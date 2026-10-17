// Builds the Built-in set into public/builtin/ and builtin-assets/ (Part 2, 2.9), or with --check
// rebuilds in memory and compares the bytes with the committed files. Run through tsx.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAll } from '../builtin-assets/build.mjs'
import { decodePng } from '../builtin-assets/png.mjs'
import { readZip } from '../builtin-assets/zip.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The folders whose files the build owns, so a stray or leftover file is reported too.
const ownedFolders = ['public/builtin', 'builtin-assets/out']

async function listFiles(directory) {
    const files = []
    let entries
    try {
        entries = await readdir(join(root, directory), { withFileTypes: true })
    } catch (error) {
        if (error.code === 'ENOENT') return files
        throw error
    }
    for (const entry of entries) {
        const relative = `${directory}/${entry.name}`
        if (entry.isDirectory()) files.push(...(await listFiles(relative)))
        else files.push(relative)
    }
    return files
}

/** The rectangles of a texture whose pixels differ, named by sprite where the report has names. */
function changedRects(oldPng, newPng, rects) {
    const before = decodePng(oldPng)
    const after = decodePng(newPng)
    if (before.width !== after.width || before.height !== after.height)
        return [`size ${before.width}x${before.height} -> ${after.width}x${after.height}`]
    const changed = []
    for (const [name, { x, y, w, h }] of Object.entries(rects)) {
        let differs = false
        for (let row = 0; row < h && !differs; row++) {
            const at = ((y + row) * after.width + x) * after.channels
            for (let i = 0; i < w * after.channels; i++)
                if (before.data[at + i] !== after.data[at + i]) {
                    differs = true
                    break
                }
        }
        if (differs) changed.push(name)
    }
    return changed
}

/** Lines saying how a changed file differs. */
export function describeDifference(path, committed, built, report) {
    if (!path.endsWith('.scp')) return [`${path}: bytes differ`]
    const lines = [`${path}: bytes differ`]
    let before
    try {
        before = readZip(committed)
    } catch {
        return [...lines, '  the committed file is not a readable ZIP']
    }
    const after = readZip(built)
    for (const name of new Set([...before.keys(), ...after.keys()])) {
        const was = before.get(name)
        const now = after.get(name)
        if (was && now && was.equals(now)) continue
        lines.push(`  ${name}: ${!was ? 'added' : !now ? 'removed' : 'changed'}`)
    }
    const type = path.match(/builtin\/(\w+)\.scp$/)?.[1]
    if ((type === 'skin' || type === 'particle') && report[type]) {
        for (const [name, bytes] of after) {
            const was = before.get(name)
            if (!was || was.equals(bytes) || bytes.subarray(1, 4).toString() !== 'PNG') continue
            lines.push(
                `  changed sprites: ${changedRects(was, bytes, report[type].rects).join(', ')}`,
            )
        }
    }
    return lines
}

export async function run(argv) {
    const check = argv.includes('--check')
    const { files, report } = await buildAll()
    const problems = []
    for (const [path, bytes] of files) {
        let committed
        try {
            committed = await readFile(join(root, path))
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
        }
        if (committed?.equals(bytes)) continue
        if (check)
            problems.push(
                ...(committed
                    ? describeDifference(path, committed, bytes, report)
                    : [`${path}: missing`]),
            )
        else {
            await mkdir(dirname(join(root, path)), { recursive: true })
            await writeFile(join(root, path), bytes)
            console.log(`Wrote ${path}`)
        }
    }
    for (const folder of ownedFolders)
        for (const path of await listFiles(folder)) {
            if (files.has(path)) continue
            if (check) problems.push(`${path}: not produced by the build`)
            else console.log(`Not produced by the build: ${path}`)
        }
    const { skin, particle } = report
    console.log(
        `Skin: ${skin.names} names, ${skin.images} images, ${skin.size}x${skin.size}, fill ${(skin.fill * 100).toFixed(1)}%`,
    )
    for (const [group, count] of Object.entries(skin.groups)) console.log(`  ${group}: ${count}`)
    console.log(
        `Particle: ${particle.effects} effects, ${particle.size}x${particle.size}, fill ${(particle.fill * 100).toFixed(1)}%`,
    )
    console.log(`Effect: ${report.effect.clips} clips`)
    if (problems.length) {
        console.error(`The Built-in assets differ from the build:\n${problems.join('\n')}`)
        console.error('Run npm run build:builtin-assets and commit the result.')
        return 1
    }
    if (check) console.log('The Built-in assets match the build.')
    return 0
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2))
