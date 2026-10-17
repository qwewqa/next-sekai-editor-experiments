export type ImageSize = { format: 'png' | 'jpeg'; width: number; height: number }

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The format and size of a PNG or JPEG from its header alone, before anything decodes it;
 * undefined when the bytes are neither (or the header is cut off).
 */
export const readImageSize = (bytes: Uint8Array): ImageSize | undefined => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length >= 24 && PNG.every((byte, i) => bytes[i] === byte)) {
        // The first chunk is IHDR: length 13, the name, then the width and the height.
        if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return
        const width = view.getUint32(16)
        const height = view.getUint32(20)
        return width > 0 && height > 0 ? { format: 'png', width, height } : undefined
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let at = 2
        while (at + 4 <= bytes.length) {
            if (bytes[at] !== 0xff) return
            const marker = bytes[at + 1] ?? 0
            // Padding, and markers with no length.
            if (marker === 0xff) {
                at++
                continue
            }
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                at += 2
                continue
            }
            const length = view.getUint16(at + 2)
            // Start of frame: every one but DHT (C4), JPG (C8) and DAC (CC).
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                if (at + 9 > bytes.length) return
                const height = view.getUint16(at + 5)
                const width = view.getUint16(at + 7)
                return width > 0 && height > 0 ? { format: 'jpeg', width, height } : undefined
            }
            if (marker === 0xd9 || marker === 0xda || length < 2) return
            at += 2 + length
        }
    }
    return
}
