import { ZipError, ZipReader } from '../../../zip'
import { ClipsTooLong, decodeEffectClips } from '../effectClips'
import { AssetError, type LoadContext, type LoadedEffect } from '../types'
import { measureClip, type ClipLength } from './audioLength'
import { AssetImportError } from './errors'
import type { CheckedParts } from './item'
import { LIMITS } from './limits'

/**
 * A sound-effect item's clips, read from its audio package (a ZIP inside the item) and decoded:
 * at most 64 entries, each under 8 MB, all clips together under 120 s. Each clip's length is
 * read from its container before it decodes, and a clip whose length cannot be read counts as
 * absent; the decoded samples are counted again after. Import runs it to find a clip that will
 * not decode or an effect without `#PERFECT`; load runs it to use the clips.
 */
export const loadEffectFromParts = async (
    title: string,
    parts: CheckedParts['effect'],
    context: LoadContext,
): Promise<LoadedEffect | undefined> => {
    const unreadable = (cause?: unknown) =>
        new AssetImportError('unreadable', { type: 'effect', part: 'audio' }, { cause })

    const { signal } = context
    let reader: ZipReader
    try {
        reader = await ZipReader.open(new Blob([new Uint8Array(parts.audio)]))
    } catch (error) {
        throw unreadable(error)
    }
    if (reader.recovered || reader.entries.length > LIMITS.effectEntries) throw unreadable()

    // What the clips read so far may decode to: their seconds, and their bytes as 32-bit samples
    // at 48 kHz, the highest rate a playback context usually runs at.
    const lengths = new Map<string, ClipLength | undefined>()
    let seconds = 0
    let bytes = 0
    const tooLong = (moreSeconds: number, moreBytes: number) => {
        seconds += moreSeconds
        bytes += moreBytes
        return seconds > LIMITS.decodedSeconds || bytes > LIMITS.decodedBytes
    }
    // And what they did decode to, should a container understate it.
    let decoded = 0
    const over = { decoded: false }
    const decodeAudio = async (data: ArrayBuffer) => {
        const buffer = await context.decodeAudio(data)
        const size = buffer.length * buffer.numberOfChannels * 4
        decoded += Number.isFinite(size) ? size : 0
        if (decoded > LIMITS.decodedBytes) {
            over.decoded = true
            throw new ClipsTooLong()
        }
        return buffer
    }

    try {
        const effect = await decodeEffectClips({
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
                const clip = await reader.read(entry, { maxSize: LIMITS.clip })
                if (!lengths.has(entry.key)) {
                    const length = measureClip(clip)
                    lengths.set(entry.key, length)
                    if (
                        length &&
                        tooLong(length.seconds, length.seconds * 48000 * length.channels * 4)
                    )
                        throw new ClipsTooLong()
                }
                return lengths.get(entry.key) ? clip : undefined
            },
            decodeAudio,
            signal,
            maxSeconds: LIMITS.decodedSeconds,
        })
        if (over.decoded) throw new ClipsTooLong()
        return effect
    } catch (error) {
        // A clip refused after decoding counts as absent there, so #PERFECT may look missing.
        if (error instanceof ClipsTooLong || over.decoded)
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
