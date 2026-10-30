import { expect, test } from '@playwright/test'

test('package fallback media decode as opaque black and silence through the requested end', async ({
    page,
}) => {
    await page.goto('/')
    const pixel = await page.evaluate(async () => {
        const path = '/src/local/nxsp/scpMedia.ts'
        const { scpBlackPng } = await import(/* @vite-ignore */ path)
        const bytes = scpBlackPng()
        const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        )
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        return {
            width: bitmap.width,
            height: bitmap.height,
            rgba: [...context.getImageData(0, 0, 1, 1).data],
        }
    })
    expect(pixel).toEqual({ width: 1, height: 1, rgba: [0, 0, 0, 255] })
    for (const seconds of [1, 7, 121]) {
        const result = await page.evaluate(async (seconds) => {
            const path = '/src/local/nxsp/scpMedia.ts'
            const { scpSilentMp3 } = await import(/* @vite-ignore */ path)
            const bytes = scpSilentMp3(seconds, 1024 * 1024)
            const context = new AudioContext({ sampleRate: 32000 })
            try {
                const buffer = await context.decodeAudioData(new Uint8Array(bytes).buffer)
                let peak = 0
                for (let channel = 0; channel < buffer.numberOfChannels; channel++)
                    for (const sample of buffer.getChannelData(channel))
                        peak = Math.max(peak, Math.abs(sample))
                return { channels: buffer.numberOfChannels, duration: buffer.duration, peak }
            } finally {
                await context.close()
            }
        }, seconds)
        expect(result.channels).toBe(1)
        expect(result.peak).toBe(0)
        expect(result.duration).toBeGreaterThanOrEqual(seconds)
        expect(result.duration).toBeLessThan(seconds + 0.0361)
    }
})
