import type {
    BackgroundConfiguration,
    BackgroundData,
    BackgroundItem,
    EffectData,
    EffectItem,
} from '@sonolus/core'
import { loadParticleFromScp } from '../particle'
import { loadPreviewResource } from '../resource'
import { parseGzippedJson, parseScp } from '../scp'
import { loadSkinFromScp } from '../skin'
import { readItem } from './scpItem'
import {
    AssetError,
    sfxSlots,
    type AssetDefaults,
    type LoadContext,
    type LoadedBackground,
    type LoadedEffect,
    type SfxSlot,
} from './types'

const builtinUrl = (name: string) => `${import.meta.env.BASE_URL}builtin/${name}.scp`

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
    return {
        url: URL.createObjectURL(new Blob([new Uint8Array(imageRaw)], { type: 'image/png' })),
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

/** The apps' Default is Built-in: the four SCPs staged by build-native.mjs (Part 2, 2.4.1). */
export default {
    skin: ({ signal }) => loadPreviewResource(builtinUrl('skin'), loadSkinFromScp, signal),
    particle: ({ signal }) =>
        loadPreviewResource(builtinUrl('particle'), loadParticleFromScp, signal),
    background: loadBackground,
    effect: loadEffect,
} satisfies AssetDefaults
