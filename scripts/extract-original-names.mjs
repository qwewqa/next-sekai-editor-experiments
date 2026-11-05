// Maintainer-only: writes the fixture of the Next SEKAI packages the editor ships as its Default
// (public/resource/, staged by the dev server from deployment/preview-assets.lock.json), so the
// Built-in set can be checked against them where the packages are not available.
// Usage: node scripts/extract-original-names.mjs [--out <file>]
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { decodePng } from '../builtin-assets/png.mjs'
import { readZip } from '../builtin-assets/zip.mjs'

const packages = ['skin', 'skin2', 'particle', 'effect', 'effect2']

/**
 * Sprites drawn as a line or dot at one edge of their quad; the fixture keeps the base's ink box
 * for them.
 */
const edgeSprites = [
    '#STAGE_LEFT_BORDER',
    '#STAGE_RIGHT_BORDER',
    '#STAGE_TOP_BORDER',
    '#STAGE_BOTTOM_BORDER',
    '#STAGE_TOP_LEFT_CORNER',
    '#STAGE_TOP_RIGHT_CORNER',
    '#STAGE_BOTTOM_LEFT_CORNER',
    '#STAGE_BOTTOM_RIGHT_CORNER',
    'Sekai Stage Border Preview',
    'Sekai Lane Divider Preview',
]

/** The least alpha, of 255, that counts as ink. */
const inkAlpha = 64

const sorted = (names) => [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const round = (value) => Math.round(value * 1000) / 1000

const unit = { x1: 0, x2: 0, x3: 1, x4: 1, y1: 0, y2: 1, y3: 1, y4: 0 }

/** A sprite's frame on the unit quad through its transform: [bl, tl, tr, br]. */
const frameOf = (transform) =>
    [1, 2, 3, 4].map((i) =>
        ['x', 'y'].map((axis) =>
            Object.entries(transform[`${axis}${i}`]).reduce(
                (sum, [key, weight]) => sum + weight * unit[key],
                0,
            ),
        ),
    )

const at = ([bl, tl, tr, br], u, v) => {
    const bottom = bl.map((value, k) => value + (br[k] - value) * u)
    const top = tl.map((value, k) => value + (tr[k] - value) * u)
    return bottom.map((value, k) => value + (top[k] - value) * v)
}

/**
 * The box [x0, x1, y0, y1] in the unit quad of a sprite's pixels at inkAlpha or more, through its
 * transform; alpha(column, row) reads the sprite's pixels, row 0 at the top.
 */
export function inkBox({ w, h, transform }, alpha) {
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity]
    for (let row = 0; row < h; row++)
        for (let column = 0; column < w; column++)
            if (alpha(column, row) >= inkAlpha) {
                u0 = Math.min(u0, column / w)
                u1 = Math.max(u1, (column + 1) / w)
                v0 = Math.min(v0, 1 - (row + 1) / h)
                v1 = Math.max(v1, 1 - row / h)
            }
    const frame = frameOf(transform)
    const points = [v0, v1].flatMap((v) => [u0, u1].map((u) => at(frame, u, v)))
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
}

const json = (bytes) => JSON.parse(gunzipSync(bytes).toString('utf8'))

export async function extractOriginals(root = new URL('../', import.meta.url)) {
    const lock = JSON.parse(
        await readFile(new URL('deployment/preview-assets.lock.json', root), 'utf8'),
    )
    const sprites = []
    const particles = []
    const clips = []
    const shared = new Map()
    const sha256 = {}
    let edges
    for (const name of packages) {
        const bytes = await readFile(new URL(`public/resource/${name}.scp`, root))
        const hash = createHash('sha256').update(bytes).digest('hex')
        if (hash !== lock[name].sha256)
            throw new Error(`public/resource/${name}.scp is not the locked package`)
        sha256[name] = hash
        const entries = readZip(bytes)
        const data = json(entries.get('data'))
        if (name.startsWith('skin')) for (const sprite of data.sprites) sprites.push(sprite.name)
        for (const effect of data.effects ?? []) particles.push(effect.name)
        for (const clip of data.clips ?? []) {
            clips.push(clip.name)
            const key = `${name}/${clip.filename}`
            shared.set(key, sorted([...(shared.get(key) ?? []), clip.name]))
        }
        if (name === 'skin') {
            const texture = decodePng(entries.get('texture'))
            const byName = new Map(data.sprites.map((sprite) => [sprite.name, sprite]))
            edges = Object.fromEntries(
                edgeSprites.map((sprite) => {
                    const { x, y, ...rest } = byName.get(sprite)
                    const alpha = (column, row) =>
                        texture.channels === 4
                            ? texture.data[((y + row) * texture.width + x + column) * 4 + 3]
                            : 255
                    return [sprite, inkBox(rest, alpha).map(round)]
                }),
            )
        }
    }
    const sharedFiles = sorted(
        [...shared.values()].filter((group) => group.length > 1).map((group) => group.join('|')),
    ).map((group) => group.split('|'))
    return {
        packages: sha256,
        counts: {
            sprites: sorted(sprites).length,
            particles: sorted(particles).length,
            clips: sorted(clips).length,
        },
        sprites: sorted(sprites),
        particles: sorted(particles),
        clips: sorted(clips),
        sharedFiles,
        edges,
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2)
    const out = args.includes('--out')
        ? args[args.indexOf('--out') + 1]
        : 'tests/fixtures/next-sekai-originals.json'
    const fixture = await extractOriginals()
    await writeFile(out, JSON.stringify(fixture, null, 4) + '\n')
    console.log(`Wrote ${out}: ${JSON.stringify(fixture.counts)}`)
}
