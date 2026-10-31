import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
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
