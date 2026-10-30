import type { EngineItem, LevelItem } from '@sonolus/core'
import { hash16Sync, toHex } from '../hash'
import { toWellFormed } from '../records/wellFormed'
import { isObject } from './json'

const categories = [
    'posts',
    'playlists',
    'levels',
    'skins',
    'backgrounds',
    'effects',
    'particles',
    'engines',
    'replays',
] as const

const srl = (file?: string) => ({ hash: '', url: file === undefined ? '' : `/${file}` })
const dependency = (title: string, author = '##:Burrito#1000') => ({
    name: 'coconut-next-sekai-1',
    source: 'https://coconut.sonolus.com/next-sekai',
    title,
    subtitle: 'Next SEKAI',
    author,
    tags: [{ title: '#PINNED' }],
    thumbnail: srl(),
})

/** Reviewed source descriptors; Save never fetches their metadata or resources. */
const engine = (): EngineItem => ({
    ...dependency('Next SEKAI', '##:qwewqa#590353'),
    version: 13,
    skin: { ...dependency('Next SEKAI 01'), version: 4, data: srl(), texture: srl() },
    background: {
        ...dependency('Next SEKAI'),
        version: 2,
        data: srl(),
        image: srl(),
        configuration: srl(),
    },
    effect: { ...dependency('Next SEKAI 01'), version: 5, data: srl(), audio: srl() },
    particle: { ...dependency('Next SEKAI'), version: 3, data: srl(), texture: srl() },
    playData: srl(),
    watchData: srl(),
    previewData: srl(),
    tutorialData: srl(),
    rom: srl(),
    configuration: srl(),
})

export const scpLevelName = (id: string) =>
    `nse-${toHex(hash16Sync(new TextEncoder().encode(toWellFormed(id))))}`

export const SCP_FIXED_PATHS = [
    'sonolus/package',
    'sonolus/info',
    ...categories.flatMap((category) => [`sonolus/${category}/info`, `sonolus/${category}/list`]),
]

export const isScpEntry = (name: string, id?: string) =>
    SCP_FIXED_PATHS.includes(name) || (!!id && name === `sonolus/levels/${scpLevelName(id)}`)

export const scpPaths = (id: string) => [
    ...SCP_FIXED_PATHS.slice(0, 8),
    `sonolus/levels/${scpLevelName(id)}`,
    ...SCP_FIXED_PATHS.slice(8),
]

/** The package projects the saved head and only the media the project includes. */
export const scpEntries = (project: Record<string, unknown>): Map<string, unknown> => {
    const metadata = isObject(project.metadata) ? project.metadata : {}
    const revision = isObject(project.revision) ? project.revision : {}
    const name = scpLevelName(typeof project.id === 'string' ? project.id : '')
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    const file = (value: unknown) =>
        isObject(value) && typeof value.file === 'string' ? value.file : undefined
    const title =
        text(metadata.title) ||
        text(revision.fileName).replace(/\.nxsp$/i, '') ||
        text(project.name) ||
        name
    const preview = file(metadata.preview)
    const level: LevelItem = {
        name,
        version: 1,
        rating:
            typeof metadata.rating === 'number' && Number.isFinite(metadata.rating)
                ? metadata.rating
                : 0,
        title,
        artists: text(metadata.artists),
        author: text(metadata.author),
        tags: Array.isArray(metadata.tags)
            ? metadata.tags.map((tag: unknown) => ({ title: isObject(tag) ? text(tag.title) : '' }))
            : [],
        engine: engine(),
        useSkin: { useDefault: true },
        useBackground: { useDefault: true },
        useEffect: { useDefault: true },
        useParticle: { useDefault: true },
        cover: srl(file(metadata.cover)),
        bgm: srl(file(project.bgm)),
        data: srl('level.json.gz'),
        ...(preview === undefined ? {} : { preview: srl(preview) }),
    }
    const out = new Map<string, unknown>([
        ['sonolus/package', { shouldUpdate: true }],
        ['sonolus/info', { title, buttons: [{ type: 'level' }], configuration: { options: [] } }],
    ])
    for (const category of categories) {
        out.set(`sonolus/${category}/info`, {
            sections: category === 'levels' ? [{ itemType: 'level', title, items: [level] }] : [],
        })
        out.set(`sonolus/${category}/list`, {
            pageCount: 1,
            items: category === 'levels' ? [level] : [],
        })
        if (category === 'levels')
            out.set(`sonolus/levels/${name}`, {
                item: level,
                description: text(metadata.description),
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
    }
    return out
}
