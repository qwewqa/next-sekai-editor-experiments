// The preview frame's JavaScript cost in Node, with the real skin and particles, and a digest of
// every draw to check that a change draws exactly the same (docs/performance-testing.md).
//   npm run perf:preview -- <level.json> [--start 0] [--seconds 10] [--fps 240] [--digest]
//     [--src <dir>]
// --src renders with another copy of src/, such as `git archive <commit> src` unpacked under
// perf-results/, so two commits can be compared on the same chart.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const args = { positional: [] }
for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === '--digest') args.digest = true
    else if (arg.startsWith('--')) args[arg.slice(2)] = process.argv[++i]
    else args.positional.push(arg)
}
const [levelPath] = args.positional
if (!levelPath) throw new Error('Usage: npm run perf:preview -- <level.json> [--digest]')
const src = resolve(args.src ?? join(root, 'src'))
const start = Number(args.start ?? 0)
const seconds = Number(args.seconds ?? 10)
const fps = Number(args.fps ?? 240)

const load = (path) => import(pathToFileURL(join(src, path)).href)
const { parseLevelDataChart } = await load('chart/parse/levelData/index.ts')
const { parseLevelData } = await load('levelData/parse.ts')
const { buildPreviewChart } = await load('preview/engine/chart.ts')
const { getFrameIndex } = await load('preview/engine/frameIndex.ts')
const { renderPreviewFrame } = await load('preview/engine/render.ts')
const { loadParticleFromScp } = await load('preview/particle.ts')
const { loadSkinFromScp } = await load('preview/skin.ts')
const { createState } = await load('state/index.ts')

// The skin and particle loaders decode their atlases; the bench needs only their layout.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
const buffer = (path) => {
    const bytes = readFileSync(join(root, path))
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}
const { skin } = await loadSkinFromScp(buffer('public/resource/skin.scp'))
const { particle } = await loadParticleFromScp(buffer('public/resource/particle.scp'))

const level = parseLevelData(JSON.parse(readFileSync(resolve(levelPath), 'utf8')))
const state = createState(parseLevelDataChart(level.entities), 0)
const chart = buildPreviewChart(state, 10)
getFrameIndex(chart)
console.log(
    `notes ${chart.notes.length}, connectors ${chart.connectors.length}, sim lines ${chart.simLines.length}, stages ${chart.stages.length}, groups ${chart.groups.length}`,
)

const hash = args.digest ? createHash('sha1') : undefined
const quadText = (q) =>
    `${q.bl.x},${q.bl.y},${q.tl.x},${q.tl.y},${q.tr.x},${q.tr.y},${q.br.x},${q.br.y}`

// The real renderer's CPU work: each quad's vertices into a Float32Array, the layer sort and
// the pack.
const pool = []
let entries = []
let packed = new Float32Array(0)
const renderer = {
    maxViewportSize: { width: 4096, height: 4096 },
    setTexture() {},
    begin() {
        entries = []
    },
    draw(sprite, quad, z, a, tint, blend) {
        if (!sprite || a <= 0) return
        const order = entries.length
        let entry = pool[order]
        if (!entry) pool.push((entry = { z, order, data: new Float32Array(60) }))
        entry.z = z
        const d = entry.data
        d[0] = quad.bl.x
        d[1] = quad.bl.y
        d[10] = quad.tl.x
        d[11] = quad.tl.y
        d[20] = quad.tr.x
        d[21] = quad.tr.y
        d[50] = quad.br.x
        d[51] = quad.br.y
        d[9] = a
        entries.push(entry)
        hash?.update(
            `${quadText(quad)},${z.join(',')},${a},${sprite.u0},${sprite.v0},${tint ? `${tint.r},${tint.g},${tint.b}` : ''},${blend ?? ''};`,
        )
    },
    flush() {
        entries.sort((a, b) => {
            const length = Math.max(a.z.length, b.z.length)
            for (let i = 0; i < length; i++) {
                const diff = (a.z[i] ?? 0) - (b.z[i] ?? 0)
                if (diff) return diff
            }
            return a.order - b.order
        })
        if (packed.length < entries.length * 60) packed = new Float32Array(entries.length * 120)
        for (let i = 0; i < entries.length; i++) packed.set(entries[i].data, i * 60)
    },
    isContextLost: () => false,
    dispose() {},
}

// The digest also covers paused frames with everything selected: their outlines and lines.
const objects = new Set()
for (const item of [...chart.notes, ...chart.connectors]) if (item.source) objects.add(item.source)
const selection = {
    objects,
    outline: (quad) => hash?.update(`o${quadText(quad)};`),
    line: (a, b) => hash?.update(`l${a.x},${a.y},${b.x},${b.y};`),
}

const w = 384
const h = 216
const frames = Math.round(seconds * fps)
const times = []
let quads = 0
// The first pass warms up over the same span; the second is measured.
for (let pass = 0; pass < 2; pass++) {
    times.length = 0
    quads = 0
    for (let i = 0; i < frames; i++) {
        const now = start + i / fps
        const before = performance.now()
        renderPreviewFrame(renderer, skin, chart, now, w, h, w, h, 10, true, particle)
        times.push(performance.now() - before)
        quads += entries.length
        if (hash && pass === 1 && i % 8 === 0) {
            hash.update('|paused|')
            renderPreviewFrame(
                renderer,
                skin,
                chart,
                now,
                w,
                h,
                w,
                h,
                10,
                true,
                particle,
                selection,
                true,
            )
        }
    }
}
const sorted = [...times].sort((a, b) => a - b)
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
const mean = times.reduce((a, b) => a + b, 0) / times.length
console.log(
    `${frames} frames: mean ${mean.toFixed(3)}, p50 ${pct(50).toFixed(3)}, p95 ${pct(95).toFixed(3)}, p99 ${pct(99).toFixed(3)}, max ${sorted.at(-1).toFixed(3)} ms; ${(quads / frames).toFixed(0)} quads a frame`,
)
if (hash) console.log(`digest ${hash.digest('hex')}`)
