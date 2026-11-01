export const AUDIO_RATE = 48000
export const AUDIO_CHANNELS = 2
export const AUDIO_UNIT = AUDIO_RATE / 10
export const AUDIO_BLOCK = AUDIO_RATE * 10
export const AUDIO_GUARD = AUDIO_RATE * 0.128
export const AUDIO_PAD = 1024

export const sampleTimestamp = (sample: number) => Math.round((sample * 1e6) / AUDIO_RATE)
export const frameTimestamp = (frame: number, fps: 30 | 60) => Math.round((frame * 1e6) / fps)
export const clipSamples = (frames: number, fps: 30 | 60) => {
    if (!Number.isSafeInteger(frames) || frames <= 0) throw new Error('Invalid video length')
    const samples = frames * (AUDIO_RATE / fps)
    if (!Number.isSafeInteger(samples)) throw new Error('Invalid audio length')
    return samples
}

export type AudioBlock = {
    startSample: number
    planes: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>]
}
export function* audioUnits(block: AudioBlock): Generator<AudioBlock> {
    const length = block.planes[0].length
    if (block.planes[1].length !== length) throw new Error('Audio channel lengths differ')
    for (let offset = 0; offset < length; offset += AUDIO_UNIT) {
        yield {
            startSample: block.startSample + offset,
            planes: [
                block.planes[0].subarray(offset, offset + AUDIO_UNIT),
                block.planes[1].subarray(offset, offset + AUDIO_UNIT),
            ],
        }
    }
}
