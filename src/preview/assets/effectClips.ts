import { AssetError, sfxSlots, type LoadedEffect, type SfxSlot } from './types'

// The clip of each player slot, then its fallbacks.
export const slotClips: Record<SfxSlot, string[]> = {
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

/** The decoded clips are longer in all than the cap allows. */
export class ClipsTooLong extends Error {
    override name = 'ClipsTooLong'
}

/**
 * Decodes only the clips the ten slots use, each once, down their fallback chains; a clip that
 * fails to decode counts as absent. Without a decodable `#PERFECT` the effect is invalid. With
 * `maxSeconds`, clips decoded longer in all than that are refused (untrusted packages).
 */
export const decodeEffectClips = async (options: {
    title: string
    /** The file name of each clip, by clip name. */
    files: Map<string, string>
    getFile: (filename: string) => Promise<Uint8Array | undefined>
    decodeAudio: (data: ArrayBuffer) => Promise<AudioBuffer>
    signal: AbortSignal
    maxSeconds?: number
}): Promise<LoadedEffect | undefined> => {
    const { title, files, getFile, decodeAudio, signal, maxSeconds } = options
    const decoded = new Map<string, Promise<AudioBuffer | undefined>>()
    const decode = (clip: string) => {
        let result = decoded.get(clip)
        if (!result) {
            const file = files.get(clip)
            result =
                file === undefined
                    ? Promise.resolve(undefined)
                    : getFile(file).then((bytes) =>
                          // A clip that does not decode counts as absent; one that cannot be read throws.
                          bytes
                              ? decodeAudio(new Uint8Array(bytes).buffer).catch(() => undefined)
                              : undefined,
                      )
            decoded.set(clip, result)
        }
        return result
    }

    const buffers = {} as LoadedEffect['buffers']
    let seconds = 0
    const counted = new Set<AudioBuffer>()
    for (const slot of sfxSlots) {
        buffers[slot] = undefined
        for (const clip of slotClips[slot]) {
            buffers[slot] = await decode(clip)
            if (buffers[slot]) break
        }
        const buffer = buffers[slot]
        if (buffer && !counted.has(buffer)) {
            counted.add(buffer)
            seconds += buffer.duration
            if (maxSeconds !== undefined && seconds > maxSeconds) throw new ClipsTooLong()
        }
    }
    if (signal.aborted) return
    if (!buffers.normalTap) throw new AssetError('corrupt', 'The effect has no #PERFECT')
    return { title, buffers }
}
