import { createHash } from 'node:crypto'
import { deflateSync, gzipSync } from 'node:zlib'
import { crc32 } from '../../src/zip'
import { minimalLevel } from '../editor/levelDataSynthetic'
import { collection, entriesOf, pack, utf8, type Type, type Variant } from './previewAssetsPackages'

// Sonolus packages holding levels, in the three shapes real files take: the Sonolus app's
// source-only export (lists beside info sections and buttons, `{}` SRLs), a Full-mode-like export
// (repository SRLs with hashes) and sonolus-level-packer output (asset and engine lists filled).

export type LevelSpec = {
    name: string
    title?: string
    artists?: string
    author?: string
    description?: string
    rating?: number
    tags?: string[]
    /** The level data's bytes; gzipped level data with one note by default. `null` leaves it out. */
    data?: Uint8Array | null
    /** An SRL URL for the data in place of the repository's, such as an external one. */
    dataUrl?: string
    cover?: Uint8Array
    bgm?: Uint8Array
    preview?: Uint8Array
    /** SRLs carry their SHA-1 (the default), a wrong one, or none. */
    hashes?: 'real' | 'bad' | 'none'
}

export type Shape = 'app' | 'full' | 'packer'

const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex')

/** Level data as Sonolus serves it: gzipped JSON. */
export const levelData = (entities = minimalLevel(), bgmOffset = 0) =>
    new Uint8Array(gzipSync(JSON.stringify({ bgmOffset, entities })))

const engine = {
    name: 'next-sekai',
    version: 13,
    title: 'Next SEKAI',
    subtitle: '',
    author: 'Sonolus',
    tags: [],
    skin: { name: 'next-sekai-skin', title: 'Next SEKAI', tags: [] },
    background: { name: 'next-sekai-background', title: 'Next SEKAI', tags: [] },
    effect: { name: 'next-sekai-effect', title: 'Next SEKAI', tags: [] },
    particle: { name: 'next-sekai-particle', title: 'Next SEKAI', tags: [] },
    thumbnail: {},
    playData: {},
    watchData: {},
    previewData: {},
    tutorialData: {},
    configuration: {},
}

const categories = [
    'levels',
    'skins',
    'backgrounds',
    'effects',
    'particles',
    'engines',
    'replays',
    'posts',
    'playlists',
] as const

/** A package of levels in one of the three shapes, with assets from the Built-in set. */
export const levelPackage = async (
    shape: Shape,
    levels: LevelSpec[],
    assets: Partial<Record<Type, Variant[]>> = {},
): Promise<Uint8Array> => {
    const entries =
        Object.keys(assets).length > 0
            ? await entriesOf(await collection(assets))
            : new Map<string, Uint8Array>()
    const resource = (bytes: Uint8Array | undefined, hashes: LevelSpec['hashes']) => {
        // The app's source-only export names nothing.
        if (!bytes || shape === 'app') return {}
        const hash = sha1(bytes)
        entries.set(`sonolus/repository/${hash}`, bytes)
        const url = `/sonolus/repository/${hash}`
        if (hashes === 'none') return { url }
        return { hash: hashes === 'bad' ? 'f'.repeat(40) : hash, url }
    }
    const items = levels.map((spec) => {
        const data = spec.data === null ? undefined : (spec.data ?? levelData())
        const srl = resource(data, spec.hashes)
        return {
            name: spec.name,
            version: 1,
            rating: spec.rating ?? 30,
            title: spec.title ?? spec.name,
            artists: spec.artists ?? '',
            author: spec.author ?? '',
            tags: (spec.tags ?? []).map((title) => ({ title })),
            engine,
            useSkin: { useDefault: true },
            useBackground: { useDefault: true },
            useEffect: { useDefault: true },
            useParticle: { useDefault: true },
            cover: resource(spec.cover, spec.hashes),
            bgm: resource(spec.bgm, spec.hashes),
            preview: resource(spec.preview, spec.hashes),
            data: spec.dataUrl ? { url: spec.dataUrl } : srl,
        }
    })
    entries.set('sonolus/levels/list', utf8(JSON.stringify({ pageCount: 1, items })))
    for (const [i, item] of items.entries())
        entries.set(
            `sonolus/levels/${item.name}`,
            utf8(
                JSON.stringify({
                    item,
                    description: levels[i]?.description ?? '',
                    actions: [],
                    hasCommunity: false,
                    leaderboards: [],
                    sections: [],
                }),
            ),
        )
    const empty = utf8(JSON.stringify({ pageCount: 0, items: [] }))
    if (shape === 'app') {
        // Buttons for every category over lists that are mostly empty.
        entries.set(
            'sonolus/info',
            utf8(
                JSON.stringify({ title: 'Export', buttons: categories.map((type) => ({ type })) }),
            ),
        )
        for (const category of categories) {
            if (!entries.has(`sonolus/${category}/list`))
                entries.set(`sonolus/${category}/list`, empty)
            entries.set(
                `sonolus/${category}/info`,
                utf8(JSON.stringify({ sections: [{ title: '#NEWEST', items: [] }] })),
            )
        }
    }
    if (shape === 'packer') {
        // Every list filled, sections empty, no buttons.
        entries.set('sonolus/engines/list', utf8(JSON.stringify({ pageCount: 1, items: [engine] })))
        for (const category of categories)
            entries.set(`sonolus/${category}/info`, utf8(JSON.stringify({ sections: [] })))
    }
    return pack(entries)
}

/** A solid PNG of the given size, which the browser decodes. */
export const png = (width = 2, height = 2) => {
    const chunk = (type: string, data: Uint8Array) => {
        const out = new Uint8Array(12 + data.length)
        const view = new DataView(out.buffer)
        view.setUint32(0, data.length)
        out.set(utf8(type), 4)
        out.set(data, 8)
        view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
        return out
    }
    const header = new Uint8Array(13)
    const view = new DataView(header.buffer)
    view.setUint32(0, width)
    view.setUint32(4, height)
    header.set([8, 2, 0, 0, 0], 8)
    // Each row: filter 0, then red pixels.
    const rows = new Uint8Array(height * (1 + width * 3))
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) rows[y * (1 + width * 3) + 1 + x * 3] = 0xff
    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', new Uint8Array(deflateSync(rows))),
        chunk('IEND', new Uint8Array()),
    ]
    return new Uint8Array(parts.flatMap((part) => [...part]))
}

/** A 1x1 GIF and a 1x1 lossless WebP: covers the asset reader would refuse. */
export const gif = () =>
    new Uint8Array(
        Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'),
    )
export const webp = () =>
    new Uint8Array(Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'))

/** A short 16-bit mono WAV tone. */
export const wav = (seconds = 0.5, rate = 8000) => {
    const samples = Math.round(seconds * rate)
    const out = new Uint8Array(44 + samples * 2)
    const view = new DataView(out.buffer)
    out.set(utf8('RIFF'), 0)
    view.setUint32(4, 36 + samples * 2, true)
    out.set(utf8('WAVEfmt '), 8)
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    out.set(utf8('data'), 36)
    view.setUint32(40, samples * 2, true)
    for (let i = 0; i < samples; i++)
        view.setInt16(44 + i * 2, Math.round(8000 * Math.sin((i / rate) * 2 * Math.PI * 440)), true)
    return out
}
