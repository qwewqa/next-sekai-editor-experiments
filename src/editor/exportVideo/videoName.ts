// The video's suggested file name: pure.

import type { ClipRange } from './clipRange'

const pad = (value: number) => `${value}`.padStart(2, '0')

/** `1m23s`, or `0m05.5s` with tenths. */
const stamp = (time: number, tenths: boolean) => {
    const minutes = Math.floor(time / 60 + 1e-9)
    const seconds = time - minutes * 60
    return tenths
        ? `${minutes}m${seconds.toFixed(1).padStart(4, '0')}s`
        : `${minutes}m${pad(Math.round(seconds))}s`
}

/**
 * `coconut.mp4` for the whole chart, `coconut 1m23s-1m45s.mp4` for a clip: In rounded down and Out
 * up to whole seconds, or to tenths under 10 s. `Video.mp4` with no usable stem.
 */
export const videoFileName = (
    stem: string,
    range: ClipRange | undefined,
    extension: 'mp4' | 'webm',
) => {
    const base = stem.trim() || 'Video'
    if (!range) return `${base}.${extension}`
    const tenths = range.out - range.in < 10
    const scale = tenths ? 10 : 1
    const from = Math.floor(range.in * scale + 1e-6) / scale
    const to = Math.ceil(range.out * scale - 1e-6) / scale
    return `${base} ${stamp(from, tenths)}-${stamp(to, tenths)}.${extension}`
}
