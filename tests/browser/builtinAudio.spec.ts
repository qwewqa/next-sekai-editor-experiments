import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { readZip } from '../../builtin-assets/zip.mjs'

// Every clip of the Built-in effect decodes in Chromium.
test('the Built-in clips decode with decodeAudioData', async ({ page }) => {
    const entries = readZip(readFileSync('public/builtin/effect.scp'))
    const item = (
        JSON.parse(entries.get('sonolus/effects/nse-builtin')!.toString()) as {
            item: { data: { url: string }; audio: { url: string } }
        }
    ).item
    const data = JSON.parse(gunzipSync(entries.get(item.data.url.slice(1))!).toString()) as {
        clips: { name: string; filename: string }[]
    }
    const files = readZip(entries.get(item.audio.url.slice(1))!)
    expect(data.clips).toHaveLength(15)

    await page.goto('about:blank')
    for (const { name, filename } of data.clips) {
        const bytes = [...files.get(filename)!]
        const result = await page.evaluate(async (wav) => {
            const context = new AudioContext()
            try {
                const buffer = await context.decodeAudioData(new Uint8Array(wav).buffer)
                return {
                    channels: buffer.numberOfChannels,
                    rate: buffer.sampleRate,
                    length: buffer.length,
                }
            } finally {
                await context.close()
            }
        }, bytes)
        expect(result.channels, name).toBe(1)
        expect(result.length, name).toBeGreaterThan(500)
    }
})
