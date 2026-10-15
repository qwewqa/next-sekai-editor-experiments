import type { CSSProperties } from 'vue'
import { timeout } from './utils/promise'
import { createSpectrumSampler, FFT_BINS, FFT_ROWS_PER_SECOND } from './waveform/fft'
import { createWaveformTileBlob } from './waveform/png'
import {
    createWaveformTilePixels,
    releaseWaveformTilePixels,
    retainWaveformTilePixels,
} from './waveform/tiles'

export type Waveform = {
    images: string[]
    style: CSSProperties
}

export const waveformDuration = 10

const createdUrls = new Set<string>()
let generation = 0

export const createWaveform = async (
    buffer: AudioBuffer,
    type: 'off' | 'fft' | 'volume',
    signal?: AbortSignal,
): Promise<Waveform | undefined> => {
    const currentGeneration = generation
    const checkCancelled = () => {
        if (signal?.aborted || currentGeneration !== generation) {
            throw new DOMException('Waveform generation cancelled', 'AbortError')
        }
    }
    checkCancelled()
    if (type === 'off') return

    const { pps, w, h, pixels, style } =
        type === 'fft' ? await createPixelsFFT(buffer, checkCancelled) : createPixelsVolume(buffer)
    checkCancelled()

    const images: string[] = []

    const tileHeight = waveformDuration * pps
    const count = Math.ceil(h / tileHeight)
    try {
        for (let i = 0; i < count; i++) {
            checkCancelled()
            const tile = createWaveformTilePixels(pixels, w, tileHeight, i)
            const blob = await createWaveformTileBlob(tile, checkCancelled)
            checkCancelled()
            const url = URL.createObjectURL(blob)
            images.push(url)
            retainWaveformTilePixels(url, tile)
        }
    } catch (error) {
        for (const url of images) {
            URL.revokeObjectURL(url)
            releaseWaveformTilePixels(url)
        }
        throw error
    }

    for (const url of images) createdUrls.add(url)

    return {
        images,
        style,
    }
}

// Only drafts owned by the importing modal are released individually. Committed
// waveforms remain available to undo history until the chart is reset.
export const releaseWaveform = (waveform: Waveform | undefined) => {
    for (const url of waveform?.images ?? []) {
        if (createdUrls.delete(url)) {
            URL.revokeObjectURL(url)
            releaseWaveformTilePixels(url)
        }
    }
}

export const cleanupWaveform = () => {
    generation++
    for (const url of createdUrls) {
        URL.revokeObjectURL(url)
        releaseWaveformTilePixels(url)
    }

    createdUrls.clear()
}

const createPixelsFFT = async (buffer: AudioBuffer, checkCancelled: () => void) => {
    const pps = FFT_ROWS_PER_SECOND
    const w = FFT_BINS
    const h = Math.ceil((buffer.length * pps) / buffer.sampleRate)
    const pixels = new Uint8Array(w * h)
    const sample = createSpectrumSampler(
        Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
        buffer.sampleRate,
    )
    const row = new Uint8Array(w)

    let nextYield = performance.now() + 8
    for (let y = 0; y < h; y++) {
        // Pixel centers represent the centers of their 5 ms audio intervals.
        // Overlapping windows also include transients between adjacent rows.
        sample(((y + 0.5) * buffer.sampleRate) / pps, row)
        pixels.set(row, y * w)
        // Bound foreground work by elapsed time, rather than a fixed number of
        // transforms that can become expensive on slower machines.
        if (y % 16 === 15 && performance.now() >= nextYield) {
            await timeout(0)
            checkCancelled()
            nextYield = performance.now() + 8
        }
    }

    return {
        pps,
        w,
        h,
        pixels,
        style: {
            imageRendering: 'pixelated',
        } satisfies CSSProperties,
    }
}

const createPixelsVolume = (buffer: AudioBuffer) => {
    const pps = 200

    const w = 50
    const h = Math.floor(buffer.duration * pps) + 1

    const pixels = new Uint8Array(w * h)

    let maxValue = 0
    const channels = [...Array(buffer.numberOfChannels).keys()].map((i) => buffer.getChannelData(i))
    const values = [...Array(h).keys()].map((y) => {
        let count = 0
        let sum = 0

        const min = Math.floor((y / pps) * buffer.sampleRate)
        const max = Math.floor(((y + 1) / pps) * buffer.sampleRate)

        for (const channel of channels) {
            for (let i = min; i < max; i++) {
                count++
                sum += Math.abs(channel[i] ?? 0)
            }
        }

        const value = sum / count
        if (value > maxValue) maxValue = value

        return value
    })

    for (const [y, value] of values.entries()) {
        const length = (value / maxValue) * w
        for (let x = 0; x < length; x++) {
            pixels[x + y * w] = 255
        }
    }

    return {
        pps,
        w,
        h,
        pixels,
        style: {
            imageRendering: 'pixelated',
        } satisfies CSSProperties,
    }
}
