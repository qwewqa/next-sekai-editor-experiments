import type { EngineItem, LevelItem } from '@sonolus/core'
import { hash16Sync, toHex } from '../hash'
import { toWellFormed } from '../records/wellFormed'
import { isObject } from './json'
import { SCP_BGM, SCP_COVER, SCP_MEDIA_PATHS } from './scpMedia'

type SourceDescriptor<T extends { version: number }> = Required<
    Pick<EngineItem, 'name' | 'source' | 'title' | 'subtitle' | 'author' | 'tags'>
> & { version: T['version']; thumbnail: EmptySrl }
type EmptySrl = Record<string, never>
type EngineSourceDescriptor = SourceDescriptor<EngineItem> & {
    playData: EmptySrl
    watchData: EmptySrl
    previewData: EmptySrl
    tutorialData: EmptySrl
    configuration: EmptySrl
    skin: SourceDescriptor<EngineItem['skin']> & { data: EmptySrl; texture: EmptySrl }
    background: SourceDescriptor<EngineItem['background']> & {
        data: EmptySrl
        image: EmptySrl
        configuration: EmptySrl
    }
    effect: SourceDescriptor<EngineItem['effect']> & { data: EmptySrl; audio: EmptySrl }
    particle: SourceDescriptor<EngineItem['particle']> & { data: EmptySrl; texture: EmptySrl }
}
type PackageLevel = Omit<LevelItem, 'engine' | 'cover' | 'bgm'> & {
    engine: EngineSourceDescriptor
    cover: LevelItem['cover'] | EmptySrl
    bgm: LevelItem['bgm'] | EmptySrl
}

const dependency = (title: string, author = '##:Burrito#1000') => ({
    name: 'coconut-next-sekai-1',
    source: 'https://coconut.sonolus.com/next-sekai',
    title,
    subtitle: 'Next SEKAI',
    author,
    tags: [{ title: '#PINNED' }],
    thumbnail: {},
})

/** Reviewed source descriptors; Save never fetches their metadata or resources. */
const engine = (): EngineSourceDescriptor => ({
    ...dependency('Next SEKAI', '##:qwewqa#590353'),
    version: 13,
    playData: {},
    watchData: {},
    previewData: {},
    tutorialData: {},
    configuration: {},
    skin: { ...dependency('Next SEKAI 01'), version: 4, data: {}, texture: {} },
    background: { ...dependency('Next SEKAI'), version: 2, data: {}, image: {}, configuration: {} },
    effect: { ...dependency('Next SEKAI 01'), version: 5, data: {}, audio: {} },
    particle: { ...dependency('Next SEKAI'), version: 3, data: {}, texture: {} },
})

export const scpLevelName = (id: string) =>
    `nse-${toHex(hash16Sync(new TextEncoder().encode(toWellFormed(id))))}`

export const SCP_FIXED_PATHS = [
    'sonolus/package',
    'sonolus/info',
    'sonolus/levels/info',
    'sonolus/levels/list',
]

export const isScpEntry = (name: string, id?: string) =>
    SCP_FIXED_PATHS.includes(name) ||
    SCP_MEDIA_PATHS.includes(name) ||
    (!!id && name === `sonolus/levels/${scpLevelName(id)}`)

export const scpPaths = (id: string) => [...SCP_FIXED_PATHS, `sonolus/levels/${scpLevelName(id)}`]

/** SHA-1 names only the generated Sonolus resource, never an authoritative NXSP record. */
export const scpHash = async (bytes: Uint8Array) =>
    toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>)))

/** The package projects the saved head with included media or generated fallbacks. */
export const scpEntries = (
    project: Record<string, unknown>,
    hashOf: (file: string) => string,
): Map<string, unknown> => {
    const srl = (file: string) => ({ hash: hashOf(file), url: `/${file}` })
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
    const cover = file(metadata.cover)
    const bgm = file(project.bgm)
    const level: PackageLevel = {
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
        cover: srl(cover ?? SCP_COVER),
        bgm: srl(bgm ?? SCP_BGM),
        data: srl('level.json.gz'),
        ...(preview === undefined ? {} : { preview: srl(preview) }),
    }
    return new Map<string, unknown>([
        ['sonolus/package', { shouldUpdate: true }],
        ['sonolus/info', { title, buttons: [{ type: 'level' }], configuration: { options: [] } }],
        ['sonolus/levels/info', { sections: [{ itemType: 'level', title, items: [level] }] }],
        ['sonolus/levels/list', { pageCount: 1, items: [level] }],
        [
            `sonolus/levels/${name}`,
            {
                item: level,
                description: text(metadata.description),
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            },
        ],
    ])
}
