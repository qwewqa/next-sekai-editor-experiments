import type {
    BackgroundConfiguration,
    BackgroundData,
    BackgroundItem,
    EffectData,
    EffectItem,
    ServerItemDetails,
    ServerItemList,
} from '@sonolus/core'
import { loadParticleFromScp } from '../particle'
import { loadPreviewResource } from '../resource'
import { parseGzippedJson, parseScp } from '../scp'
import { loadSkinFromScp } from '../skin'
import { readItem } from './scpItem'
import { openRangedScp, type RangedScp } from './scpRange'
import {
    AssetError,
    sfxSlots,
    type AssetDefaults,
    type AssetType,
    type LoadContext,
    type LoadedBackground,
    type LoadedEffect,
    type SfxSlot,
} from './types'

export const builtinUrl = (name: string) => `${import.meta.env.BASE_URL}builtin/${name}.scp`

const fetchPackage = async (name: string, signal: AbortSignal) => {
    const isAborted = () => signal.aborted
    const response = await fetch(builtinUrl(name), { signal })
    if (isAborted() || response.status === 404) return
    if (!response.ok)
        throw new AssetError('unavailable', `Built-in ${name}: HTTP ${response.status}`)
    const buffer = await response.arrayBuffer()
    return isAborted() ? undefined : buffer
}

const loadBackground = async ({ signal }: LoadContext): Promise<LoadedBackground | undefined> => {
    const buffer = await fetchPackage('background', signal)
    const read = buffer && readItem<BackgroundItem>(buffer, 'backgrounds')
    if (!read) return
    const { item, getResource } = read

    const dataRaw = getResource(item.data)
    const imageRaw = getResource(item.image)
    const configurationRaw = getResource(item.configuration)
    if (!dataRaw || !imageRaw || !configurationRaw)
        throw new AssetError('corrupt', 'Built-in background is incomplete')

    const data = parseGzippedJson<BackgroundData>(dataRaw)
    const configuration = parseGzippedJson<BackgroundConfiguration>(configurationRaw)
    const url = URL.createObjectURL(new Blob([new Uint8Array(imageRaw)], { type: 'image/png' }))
    return {
        url,
        dispose: () => {
            URL.revokeObjectURL(url)
        },
        aspectRatio: data.aspectRatio ?? 16 / 9,
        fit: data.fit,
        color: data.color,
        blur: configuration.blur,
        mask: /^#[0-9a-f]{6}00$/i.test(configuration.mask) ? undefined : configuration.mask,
    }
}

// The clip of each player slot, then its fallbacks (Part 2, 2.4.3).
const slotClips: Record<SfxSlot, string[]> = {
    normalTap: ['#PERFECT'],
    normalFlick: ['#PERFECT_ALTERNATIVE', '#PERFECT'],
    normalActive: ['#HOLD'],
    normalTick: ['Sekai Tick', '#PERFECT'],
    normalTrace: ['Sekai Trace', '#PERFECT'],
    criticalTap: ['Sekai Critical Tap', '#PERFECT'],
    criticalFlick: ['Sekai Critical Flick', '#PERFECT_ALTERNATIVE'],
    criticalTrace: ['Sekai Critical Trace', '#PERFECT'],
    criticalTick: ['Sekai Critical Tick', '#PERFECT'],
    criticalActive: ['Sekai Critical Hold', '#HOLD'],
}

const loadEffect = async ({
    signal,
    decodeAudio,
}: LoadContext): Promise<LoadedEffect | undefined> => {
    const buffer = await fetchPackage('effect', signal)
    const read = buffer && readItem<EffectItem>(buffer, 'effects')
    if (!read) return
    const { item, getResource } = read

    const dataRaw = getResource(item.data)
    const audioRaw = getResource(item.audio)
    if (!dataRaw || !audioRaw) throw new AssetError('corrupt', 'Built-in effect is incomplete')

    const audio = parseScp(new Uint8Array(audioRaw).buffer)
    const files = new Map(
        parseGzippedJson<EffectData>(dataRaw).clips.map((c) => [c.name, c.filename]),
    )
    const decoded = new Map<string, Promise<AudioBuffer | undefined>>()
    const decode = (clip: string) => {
        let result = decoded.get(clip)
        if (!result) {
            const file = files.get(clip)
            const bytes = file === undefined ? undefined : audio.get(file)
            result = bytes
                ? decodeAudio(new Uint8Array(bytes).buffer).catch(() => undefined)
                : Promise.resolve(undefined)
            decoded.set(clip, result)
        }
        return result
    }

    const buffers = {} as LoadedEffect['buffers']
    for (const slot of sfxSlots) {
        buffers[slot] = undefined
        for (const clip of slotClips[slot]) {
            buffers[slot] = await decode(clip)
            if (buffers[slot]) break
        }
    }
    if (signal.aborted) return
    if (!buffers.normalTap) throw new AssetError('corrupt', 'Built-in effect has no #PERFECT')
    return { title: item.title, buffers }
}

/** The Built-in set: four ordinary static files (Part 2, 2.5.6), read when chosen or needed. */
export const builtinProviders = {
    skin: ({ signal }) => loadPreviewResource(builtinUrl('skin'), loadSkinFromScp, signal),
    particle: ({ signal }) =>
        loadPreviewResource(builtinUrl('particle'), loadParticleFromScp, signal),
    background: loadBackground,
    effect: loadEffect,
} satisfies AssetDefaults

const categories = {
    skin: 'skins',
    particle: 'particles',
    background: 'backgrounds',
    effect: 'effects',
} as const

export type BuiltinInfo = {
    title: string
    author: string
    /** An object URL of the item's small picture, kept for the page. */
    image: string | undefined
}

const infos = new Map<AssetType, Promise<BuiltinInfo | undefined>>()

type ItemInfo = { name: string; title: string; author: string; thumbnail?: { url?: string | null } }

const readJson = async <T>(archive: RangedScp, path: string) => {
    const bytes = await archive.get(path)
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : undefined
}

/**
 * The Built-in item's title, author and picture for the source lists; undefined when it cannot be read.
 * Only the package's list, details and picture are fetched, not the resources the item loads with.
 */
export const loadBuiltinInfo = (type: AssetType): Promise<BuiltinInfo | undefined> => {
    let info = infos.get(type)
    if (!info) {
        info = (async () => {
            const archive = await openRangedScp(builtinUrl(type), new AbortController().signal)
            if (!archive) return
            const category = categories[type]
            const list = await readJson<ServerItemList<ItemInfo>>(
                archive,
                `sonolus/${category}/list`,
            )
            const listed = list?.items[0]
            if (!listed) return
            const details = await readJson<ServerItemDetails<ItemInfo>>(
                archive,
                `sonolus/${category}/${listed.name}`,
            )
            const item = details?.item ?? listed
            const url = item.thumbnail?.url
            const bytes = url ? await archive.get(url) : undefined
            return {
                title: item.title,
                author: item.author,
                image: bytes
                    ? URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
                    : undefined,
            }
        })().catch(() => undefined)
        infos.set(type, info)
        // An unreadable package is tried again at the next request.
        void info.then((value) => {
            if (!value) infos.delete(type)
        })
    }
    return info
}
