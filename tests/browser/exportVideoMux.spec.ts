import { expect, test } from '@playwright/test'
import { installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

test.beforeEach(async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.goto('/')
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
})

for (const format of ['webm', 'mp4'] as const)
    for (const start of [0, 83])
        test(`${format} streams a clip from ${start} s with aligned sound and less than one packet of padding`, async ({
            page,
        }) => {
            const supported = await page.evaluate(async (format) => {
                const { createCodecProbes } = await import('/src/exportVideo/codecs.ts')
                return createCodecProbes().resolve({
                    format,
                    width: 320,
                    height: 180,
                    frameRate: 30,
                    videoBitrate: 1_000_000,
                    audioBitrate: 128_000,
                    bgm: true,
                    sfx: false,
                })
            }, format)
            if (format === 'mp4')
                test.skip(!supported.supported, 'This browser does not encode H.264 and AAC')
            else expect(supported.supported).toBe(true)
            const result = await page.evaluate(
                async ({ format, start }) => {
                    const result = await window.editorTest.exportVideo({
                        mux: true,
                        settings: { format, in: start, frames: 76 },
                    })
                    const { readVideo } = await import('/tests/helpers/readVideo.ts')
                    return {
                        ...result,
                        bytes: undefined,
                        media: result.bytes ? await readVideo(result.bytes) : undefined,
                    }
                },
                { format, start },
            )
            expect(result.error).toBeUndefined()
            expect(result.phase).toBe('ready')
            expect(result.retained).toBe(false)
            const media = result.media!
            expect(media.frames).toBe(76)
            expect(media.firstVideo).toBe(0)
            expect(media.width).toBe(320)
            expect(media.height).toBe(180)
            expect(Math.abs(media.videoEnd - 76 / 30)).toBeLessThan(0.0011)
            expect(Math.abs(media.firstSound!)).toBeLessThan(0.002)
            expect(media.earlyPeak).toBeGreaterThan(0.1)
            const packetSamples = format === 'mp4' ? 1024 : 960
            const padding = (result.result as { paddingSamples: number }).paddingSamples
            expect(padding).toBeGreaterThanOrEqual(0)
            expect(padding).toBeLessThan(packetSamples)
            expect(Math.abs(media.audioEnd - (121600 + padding) / 48000)).toBeLessThan(0.0011)
            expect(media.duration).toBeGreaterThan(0)
            expect(media.colorSpace).toBeDefined()
        })

test('cancel before finalising a real mux removes the staged file', async ({ page }) => {
    const result = await page.evaluate(() =>
        window.editorTest.exportVideo({ mux: true, cancelAt: 'finalize' }),
    )
    expect(result.error).toBeUndefined()
    expect(result.phase).toBe('cancelled')
    expect(result.retained).toBe(false)
})

for (const format of ['webm', 'mp4'] as const)
    for (const cancel of [false, true])
        test(`${format} picked output ${cancel ? 'can be discarded after muxing' : 'preserves colour tags and pixels'}`, async ({
            page,
        }) => {
            const result = await page.evaluate(
                async ({ format, cancel }) => {
                    const { muxPickedVideo } = await import('/tests/helpers/muxPickedVideo.ts')
                    return muxPickedVideo(format, cancel)
                },
                { format, cancel },
            )
            if (format === 'mp4') test.skip(!result, 'This browser does not encode H.264')
            expect(result).toBeDefined()
            expect(result!.beforeCommit).toBe(0)
            if (cancel) expect(result!.removed).toBe(true)
            else {
                expect(result!.size).toBeGreaterThan(0)
                expect(result!.expectedColor).toBeDefined()
                expect(result!.actualColor).toEqual(result!.expectedColor)
                expect(result!.maxError).toBeLessThanOrEqual(4)
                if (format === 'mp4') expect(result!.indexBeforeMedia).toBe(true)
            }
        })
