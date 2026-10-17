import { ZipError, ZipReader } from '../../../zip'
import { ClipsTooLong, decodeEffectClips } from '../effectClips'
import { AssetError, type LoadContext, type LoadedEffect } from '../types'
import { AssetImportError } from './errors'
import type { CheckedParts } from './item'
import { LIMITS } from './limits'

/**
 * A sound-effect item's clips, read from its audio package (a ZIP inside the item) and decoded:
 * at most 64 entries, each under 8 MB, all decoded clips together under 120 s. Import runs it to
 * find a clip that will not decode or an effect without `#PERFECT`; load runs it to use the clips.
 */
export const loadEffectFromParts = async (
    title: string,
    parts: CheckedParts['effect'],
    { signal, decodeAudio }: LoadContext,
): Promise<LoadedEffect | undefined> => {
    const unreadable = (cause?: unknown) =>
        new AssetImportError('unreadable', { type: 'effect', part: 'audio' }, { cause })

    let reader: ZipReader
    try {
        reader = await ZipReader.open(new Blob([new Uint8Array(parts.audio)]))
    } catch (error) {
        throw unreadable(error)
    }
    if (reader.recovered || reader.entries.length > LIMITS.effectEntries) throw unreadable()

    try {
        return await decodeEffectClips({
            title,
            files: new Map(parts.data.clips.map((clip) => [clip.name, clip.filename])),
            getFile: async (filename) => {
                const entry = reader.get(filename)
                if (!entry || reader.ambiguous.has(entry.key)) return
                if (
                    entry.method !== 0 &&
                    entry.size > LIMITS.ratioFloor &&
                    entry.size > LIMITS.ratio * Math.max(entry.compressedSize, 1)
                )
                    throw new AssetImportError('ratio', { type: 'effect', part: 'audio' })
                return reader.read(entry, { maxSize: LIMITS.clip })
            },
            decodeAudio,
            signal,
            maxSeconds: LIMITS.decodedSeconds,
        })
    } catch (error) {
        if (error instanceof ClipsTooLong)
            throw new AssetImportError('audioLength', {
                type: 'effect',
                limit: LIMITS.decodedSeconds,
            })
        // The one error decodeEffectClips raises itself.
        if (error instanceof AssetError) throw new AssetImportError('noPerfect', { type: 'effect' })
        if (error instanceof ZipError) throw unreadable(error)
        throw error
    }
}
