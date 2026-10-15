export type WaveformTilePixels = {
    width: number
    height: number
    alpha: Uint8Array
}

// Keep the original amplitudes alongside their public PNG URLs. Rendering can
// now build its peak-preserving mip levels without decoding the PNG or reading
// pixels back from the GPU. URL lifetime is also the lifetime of these samples.
const tiles = new Map<string, WaveformTilePixels>()

export const getWaveformTilePixels = (url: string) => tiles.get(url)
export const retainWaveformTilePixels = (url: string, pixels: WaveformTilePixels) =>
    tiles.set(url, pixels)
export const releaseWaveformTilePixels = (url: string) => tiles.delete(url)

export const createWaveformTilePixels = (
    pixels: Uint8Array,
    width: number,
    height: number,
    index: number,
): WaveformTilePixels => {
    const alpha = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
        const source = (index * height + y) * width
        alpha.set(pixels.subarray(source, source + width), (height - 1 - y) * width)
    }
    return { width, height, alpha }
}

// White pixels encode volume/spectral power in their alpha channel. Maximum
// reduction preserves 5 ms attacks even when the display samples fewer rows.
export const reduceWaveformTilePixels = ({ width, height, alpha }: WaveformTilePixels) => {
    const reducedHeight = Math.ceil(height / 2)
    const reduced = new Uint8Array(width * reducedHeight)
    for (let y = 0; y < reducedHeight; y++) {
        for (let x = 0; x < width; x++) {
            const first = y * 2 * width + x
            reduced[y * width + x] = Math.max(alpha[first] ?? 0, alpha[first + width] ?? 0)
        }
    }
    return { width, height: reducedHeight, alpha: reduced }
}

export const createWaveformTileImage = ({ width, height, alpha }: WaveformTilePixels) => {
    const image = new ImageData(width, height)
    image.data.fill(255)
    for (let i = 0; i < alpha.length; i++) image.data[i * 4 + 3] = alpha[i] ?? 0
    return image
}
