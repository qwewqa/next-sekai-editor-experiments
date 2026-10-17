// Maintainer-only: writes the engine name fixture from a built engine's EngineData (Part 2, 2.11).
// Usage: node scripts/extract-engine-names.mjs <engine build output> --commit <engine commit> [--out <file>]
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const sorted = (names) => [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** The sorted union of the names in the engine's Play, Watch, Preview and Tutorial data. */
export function collectNames(datas) {
    const sprites = []
    const particles = []
    const clips = []
    for (const data of datas) {
        for (const { name } of data.skin?.sprites ?? []) sprites.push(name)
        for (const { name } of data.particle?.effects ?? []) particles.push(name)
        for (const { name } of data.effect?.clips ?? []) clips.push(name)
    }
    return { sprites: sorted(sprites), particles: sorted(particles), clips: sorted(clips) }
}

export const nameListHash = ({ sprites, particles, clips }) =>
    createHash('sha256').update(JSON.stringify({ sprites, particles, clips })).digest('hex')

export async function extractNames(directory, commit) {
    const datas = []
    for (const mode of ['Play', 'Watch', 'Preview', 'Tutorial']) {
        const bytes = await readFile(join(directory, `Engine${mode}Data`))
        datas.push(JSON.parse(gunzipSync(bytes).toString('utf8')))
    }
    const names = collectNames(datas)
    const declared = datas[0].skin.sprites.length
    return {
        engine: { repository: 'sonolus-next-sekai-engine', commit },
        counts: {
            spritesDeclared: declared,
            sprites: names.sprites.length,
            particles: names.particles.length,
            clips: names.clips.length,
        },
        sha256: nameListHash(names),
        ...names,
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2)
    const option = (name) => {
        const at = args.indexOf(name)
        return at < 0 ? undefined : args[at + 1]
    }
    const directory = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'))
    const commit = option('--commit')
    if (!directory || !commit) {
        console.error(
            'Usage: node scripts/extract-engine-names.mjs <engine build output> --commit <engine commit> [--out <file>]',
        )
        process.exit(1)
    }
    const out = option('--out') ?? 'tests/fixtures/next-sekai-names.json'
    const fixture = await extractNames(directory, commit)
    await writeFile(out, JSON.stringify(fixture, null, 4) + '\n')
    console.log(`Wrote ${out}: ${JSON.stringify(fixture.counts)}`)
}
