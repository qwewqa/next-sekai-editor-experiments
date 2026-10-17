import { sfxSlots, type LoadContext, type LoadedEffect, type SfxSlot } from './types'

/** A synthetic effect over one audio URL per slot; a slot that fails stays undefined. */
export const loadEffectFromUrls = async (
    title: string,
    urls: Record<SfxSlot, string>,
    { signal, decodeAudio }: LoadContext,
): Promise<LoadedEffect | undefined> => {
    const buffers: LoadedEffect['buffers'] = {
        normalTap: undefined,
        criticalTap: undefined,
        normalFlick: undefined,
        criticalFlick: undefined,
        normalTrace: undefined,
        criticalTrace: undefined,
        normalTick: undefined,
        criticalTick: undefined,
        normalActive: undefined,
        criticalActive: undefined,
    }

    await Promise.allSettled(
        sfxSlots.map(async (slot) => {
            const response = await fetch(urls[slot], { signal })
            const data = await response.arrayBuffer()
            buffers[slot] = await decodeAudio(data)
        }),
    )
    if (signal.aborted) return

    return { title, buffers }
}
