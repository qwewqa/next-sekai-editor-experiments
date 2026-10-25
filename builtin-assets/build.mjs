// Builds the Built-in set in memory: the four SCPs, the icon renders and the lock.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzip } from 'pako'
import { color as backgroundColor, renderBackground } from './background.mjs'
import {
    clipFiles,
    itemMeta,
    omittedSprites,
    particleSprites,
    setVersion,
    skinSprites,
} from './manifest.mjs'
import { composeTexture, imageKey, packImages } from './pack.mjs'
import { kinds, particleEffects } from './particles.mjs'
import { encodePng } from './png.mjs'
import { renderWavs } from './sfx.mjs'
import { renderSvg, renderTemplate, template } from './svg.mjs'
import { createZip } from './zip.mjs'

const root = new URL('../', import.meta.url)

const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const text = (value) => Buffer.from(JSON.stringify(value))
const sortedBy = (items, key) => [...items].sort((a, b) => (key(a) < key(b) ? -1 : 1))

/** The engine name fixture (tests/fixtures/next-sekai-names.json). */
export const readFixture = () =>
    JSON.parse(readFileSync(new URL('tests/fixtures/next-sekai-names.json', root), 'utf8'))

/** gzip with no time, name or comment, as Sonolus JSON resources must be. */
export const gzipJson = (value) => Buffer.from(gzip(text(value), { level: 9 }))

const identity = () => ({
    x1: { x1: 1 },
    x2: { x2: 1 },
    x3: { x3: 1 },
    x4: { x4: 1 },
    y1: { y1: 1 },
    y2: { y2: 1 },
    y3: { y3: 1 },
    y4: { y4: 1 },
})

const isOpaque = (data) => {
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false
    return true
}

/** Straight RGBA to a PNG: RGB when every pixel is opaque, RGBA otherwise. */
export function pngOf({ width, height, data }, { forceAlpha = false } = {}) {
    if (!forceAlpha && isOpaque(data)) {
        const rgb = new Uint8Array(width * height * 3)
        for (let i = 0; i < width * height; i++) rgb.set(data.subarray(i * 4, i * 4 + 3), i * 3)
        return encodePng({ width, height, channels: 3, data: rgb })
    }
    return encodePng({ width, height, channels: 4, data })
}

const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** A 4x4 Bayer dither of up to one level, so smooth gradients don't band. */
export function dither({ width, height, data }) {
    const out = new Uint8Array(data)
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const offset = Math.round((bayer[(y & 3) * 4 + (x & 3)] + 0.5) / 8 - 1)
            for (let c = 0; c < 3; c++) {
                const at = (y * width + x) * 4 + c
                out[at] = Math.max(0, Math.min(255, out[at] + offset))
            }
        }
    return { width, height, data: out }
}

const renderCache = new Map()

/** Renders a sprite spec, once per distinct template, variables and width. */
export function renderSpec(spec) {
    const key = JSON.stringify([spec.template, spec.vars, spec.width ?? null])
    let rendered = renderCache.get(key)
    if (!rendered) {
        rendered = renderTemplate(spec.template, spec.vars, spec.width)
        renderCache.set(key, rendered)
    }
    return rendered
}

// Renders every spec, dedupes by pixels, packs, and returns the texture and the placed names.
async function buildAtlas(named, maxSize, label) {
    const images = new Map()
    const byName = new Map()
    for (const [name, spec] of named) {
        const rendered = await renderSpec(spec)
        const image = { ...rendered, stretch: spec.stretch }
        image.key = imageKey(image)
        if (!images.has(image.key)) images.set(image.key, image)
        byName.set(name, image.key)
    }
    const unique = [...images.values()]
    const { size, placements, fill: fillRatio } = packImages(unique, maxSize, label)
    const texture = composeTexture(size, unique, placements)
    const rects = new Map()
    for (const [name, key] of byName) {
        const image = images.get(key)
        const { x, y } = placements.get(key)
        rects.set(name, { x, y, w: image.width, h: image.height, stretch: image.stretch })
    }
    return {
        size,
        fill: fillRatio,
        unique: unique.length,
        rects,
        png: pngOf({ width: size, height: size, data: texture }, { forceAlpha: true }),
    }
}

async function buildSkin(report) {
    const { sprites, groups } = skinSprites()
    const fixture = readFixture()
    const missing = fixture.sprites.filter(
        (name) => !sprites.has(name) && !omittedSprites.includes(name),
    )
    if (missing.length)
        throw new Error(`The skin lacks ${missing.length} engine names, such as ${missing[0]}`)
    const atlas = await buildAtlas(sprites, 2048, 'skin texture')
    const data = {
        width: atlas.size,
        height: atlas.size,
        interpolation: true,
        sprites: sortedBy(atlas.rects.entries(), ([name]) => name).map(([name, r]) => ({
            name,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            transform: sprites.get(name).transform ?? identity(),
        })),
    }
    report.skin = {
        names: sprites.size,
        images: atlas.unique,
        size: atlas.size,
        fill: atlas.fill,
        groups: Object.fromEntries(groups),
        rects: Object.fromEntries(atlas.rects),
    }
    return { data: gzipJson(data), texture: atlas.png }
}

async function buildParticle(report) {
    const effects = particleEffects()
    const fixture = readFixture()
    const names = new Set(effects.map((effect) => effect.name))
    const missing = fixture.particles.filter((name) => !names.has(name))
    if (missing.length)
        throw new Error(`The particle lacks ${missing.length} engine names, such as ${missing[0]}`)
    const atlas = await buildAtlas(
        particleSprites.map(({ name, spec }) => [name, spec]),
        512,
        'particle texture',
    )
    const groupsOf = new Map()
    const data = {
        width: atlas.size,
        height: atlas.size,
        interpolation: true,
        sprites: particleSprites.map(({ name }) => {
            const { x, y, w, h } = atlas.rects.get(name)
            return { x, y, w, h }
        }),
        effects: sortedBy(effects, (effect) => effect.name).map(({ name, kind, color }) => {
            const key = `${kind}|${color}`
            if (!groupsOf.has(key)) groupsOf.set(key, kinds[kind](color))
            return { name, transform: identity(), groups: groupsOf.get(key) }
        }),
    }
    report.particle = {
        effects: effects.length,
        size: atlas.size,
        fill: atlas.fill,
        rects: Object.fromEntries(atlas.rects),
    }
    return { data: gzipJson(data), texture: atlas.png }
}

function buildBackground(report) {
    const image = renderBackground(1080)
    const { width, height } = image
    report.background = { width, height }
    return {
        data: gzipJson({ aspectRatio: width / height, fit: 'cover', color: backgroundColor }),
        image: pngOf(image),
        configuration: gzipJson({ blur: 0, mask: '#00000000' }),
    }
}

function buildEffect(report) {
    const wavs = renderWavs()
    const clips = Object.keys(clipFiles)
    const missing = readFixture().clips.filter((name) => !clips.includes(name))
    if (missing.length) throw new Error(`The effect lacks engine clips: ${missing.join(', ')}`)
    const audio = createZip(
        sortedBy(clips, (name) => clipFiles[name]).map((name) => ({
            name: clipFiles[name],
            data: wavs[name],
            method: 'deflate',
        })),
    )
    report.effect = { clips: clips.length, audioBytes: audio.length }
    return {
        data: gzipJson({ clips: clips.map((name) => ({ name, filename: clipFiles[name] })) }),
        audio,
    }
}

// The background's thumbnail is its middle square.
const thumbnailFor = async (name) => {
    if (name !== 'background') return pngOf(await renderTemplate(`thumb-${name}`, {}, 256))
    const image = renderBackground(256)
    const left = (image.width - 256) >> 1
    const data = new Uint8Array(256 * 256 * 4)
    for (let y = 0; y < 256; y++)
        data.set(
            image.data.subarray((y * image.width + left) * 4, (y * image.width + left + 256) * 4),
            y * 256 * 4,
        )
    return pngOf({ width: 256, height: 256, data })
}

// The standard single-item package of 2.2: info, list, details and the repository.
function createItemScp(type, resources) {
    const category = `${type}s`
    const repository = new Map()
    const locator = (bytes) => {
        const hash = sha('sha1', bytes)
        repository.set(hash, bytes)
        return { hash, url: `/sonolus/repository/${hash}` }
    }
    const fields = Object.fromEntries(
        Object.entries(resources).map(([key, bytes]) => [key, locator(bytes)]),
    )
    const versions = { skin: 4, particle: 3, background: 2, effect: 5 }
    const { name, title, subtitle, author, description } = itemMeta
    const item = { name, version: versions[type], title, subtitle, author, tags: [], ...fields }
    const entries = [
        [
            'sonolus/info',
            text({ title: 'Built-in Items', buttons: [{ type }], configuration: { options: [] } }),
            'deflate',
        ],
        [
            `sonolus/${category}/info`,
            text({ sections: [{ title: '#NEWEST', itemType: type, items: [item] }] }),
            'deflate',
        ],
        [`sonolus/${category}/list`, text({ pageCount: 1, items: [item] }), 'deflate'],
        [
            `sonolus/${category}/${name}`,
            text({
                item,
                description,
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            }),
            'deflate',
        ],
        ...[...repository].map(([hash, bytes]) => [`sonolus/repository/${hash}`, bytes, 'store']),
    ]
    return {
        scp: createZip(
            sortedBy(entries, ([entry]) => entry).map(([entry, data, method]) => ({
                name: entry,
                data,
                method,
            })),
        ),
        resources: Object.fromEntries(
            Object.entries(fields).map(([key, { hash }]) => [
                key,
                {
                    sha1: hash,
                    sha256: sha('sha256', repository.get(hash)),
                    bytes: repository.get(hash).length,
                },
            ]),
        ),
    }
}

/** The icon family and the social card: [file, template, width, dithered]. */
export const iconOutputs = [
    ['app-icon-1024.png', 'app-icon', 1024],
    ['app-icon-macos-1024.png', 'app-icon-macos', 1024],
    ['app-icon-foreground-1024.png', 'app-icon-foreground', 1024],
    ['app-icon-monochrome-1024.png', 'app-icon-monochrome', 1024],
    ['app-icon-16.png', 'app-icon-small', 16],
    ['app-icon-32.png', 'app-icon-small', 32],
    ['app-icon-180.png', 'app-icon', 180],
    ['app-icon-512.png', 'app-icon', 512],
    ['social-card.png', 'social-card', 1200, true],
]

async function buildIcons() {
    const files = new Map()
    for (const [file, name, width, dithered] of iconOutputs) {
        let rendered = await renderSvg(template(name), width)
        if (dithered) rendered = dither(rendered)
        files.set(`builtin-assets/out/icon/${file}`, pngOf(rendered))
    }
    files.set('builtin-assets/out/icon/app-icon-background.txt', Buffer.from('#232539\n'))
    return files
}

/** Builds everything: { files: Map<repo path, Buffer>, report }. The lock is among the files. */
export async function buildAll() {
    const report = {}
    const files = new Map()
    const resources = {
        skin: await buildSkin(report),
        particle: await buildParticle(report),
        background: buildBackground(report),
        effect: buildEffect(report),
    }
    const lock = {
        version: 1,
        set: { name: itemMeta.name, version: setVersion },
        files: {},
        resources: {},
        textures: {
            skin: { width: report.skin.size, height: report.skin.size },
            particle: { width: report.particle.size, height: report.particle.size },
        },
        counts: {
            skinNames: report.skin.names,
            skinImages: report.skin.images,
            particleEffects: report.particle.effects,
            clips: report.effect.clips,
        },
    }
    for (const type of ['skin', 'particle', 'background', 'effect']) {
        const { scp, resources: described } = createItemScp(type, {
            thumbnail: await thumbnailFor(type),
            ...resources[type],
        })
        files.set(`public/builtin/${type}.scp`, scp)
        lock.resources[type] = described
    }
    for (const [path, bytes] of await buildIcons()) files.set(path, bytes)
    for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1)))
        lock.files[path] = { sha256: sha('sha256', bytes), bytes: bytes.length }
    files.set(
        'builtin-assets/builtin-assets.lock.json',
        Buffer.from(JSON.stringify(lock, null, 4) + '\n'),
    )
    return { files, report }
}
