// The quality presets' bitrates and the size estimate: pure.

export const RESOLUTIONS = [720, 1080, 1440, 2160] as const
export type Resolution = (typeof RESOLUTIONS)[number]
export const QUALITIES = ['low', 'standard', 'high'] as const
export type Quality = (typeof QUALITIES)[number]
export const AUDIO_BITRATES = [128_000, 192_000, 256_000] as const
export type AudioBitrate = (typeof AUDIO_BITRATES)[number]

// Standard at 30 fps, 16:9: YouTube's recommended SDR uploads. 2160p is 2.25 times 1440p.
const STANDARD_30: Record<Resolution, number> = {
    720: 5e6,
    1080: 8e6,
    1440: 16e6,
    2160: 36e6,
}
const QUALITY_FACTOR: Record<Quality, number> = { low: 0.5, standard: 1, high: 1.5 }

/** A preset's video bitrate, scaled by the frame's pixels against 16:9 at the same height. */
export const presetBitrate = (
    quality: Quality,
    resolution: Resolution,
    frameRate: 30 | 60,
    width: number,
) =>
    Math.round(
        STANDARD_30[resolution] *
            QUALITY_FACTOR[quality] *
            (frameRate === 60 ? 1.5 : 1) *
            (width / ((resolution * 16) / 9)),
    )

/** The preset whose bitrate this is, or `custom`. */
export const qualityOf = (
    bitrate: number,
    resolution: Resolution,
    frameRate: 30 | 60,
    width: number,
): Quality | 'custom' =>
    QUALITIES.find(
        (quality) =>
            Math.abs(presetBitrate(quality, resolution, frameRate, width) - bitrate) < 1000,
    ) ?? 'custom'

/** The container's share: its index and headers. */
const CONTAINER_FACTOR = 1.02
const CONTAINER_BYTES = 64_000

/** About how large the file is: an average, not a bound. No audio bitrate without sound. */
export const estimateBytes = (seconds: number, videoBitrate: number, audioBitrate: number) =>
    ((seconds * (videoBitrate + audioBitrate)) / 8) * CONTAINER_FACTOR + CONTAINER_BYTES
