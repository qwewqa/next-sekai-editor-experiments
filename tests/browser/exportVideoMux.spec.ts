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
        test(`${format} streams a clip from ${start} s with aligned sound and ${format === 'mp4' ? 'no' : 'less than one packet of'} padding`, async ({
            page,
        }, testInfo) => {
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
            await testInfo.attach('media', {
                contentType: 'application/json',
                body: JSON.stringify({ format, start, media, result: result.result }),
            })
            expect(media.frames).toBe(76)
            expect(media.firstVideo).toBe(0)
            expect(media.width).toBe(320)
            expect(media.height).toBe(180)
            expect(Math.abs(media.videoEnd - 76 / 30)).toBeLessThan(0.0011)
            const precision = format === 'webm' ? 0.001 : 1 / 48000
            // AAC decoding can return silent pre-roll before the first presented sample.
            expect(media.firstAudio!).toBeLessThanOrEqual(precision)
            // The fixture's 440 Hz tone has a 5 ms attack.
            const onset = Array.from({ length: 240 }, (_, i) =>
                Math.abs(0.25 * Math.sin((i * 2 * Math.PI * 440) / 48000) * (i / 240)),
            ).findIndex((value) => value > 0.1)
            expect(Math.abs(media.firstSound! - onset / 48000)).toBeLessThan(0.001)
            expect(media.earlyPeak).toBeGreaterThan(0.1)
            const padding = (result.result as { paddingSamples: number }).paddingSamples
            const clipEnd = 121600 / 48000
            if (format === 'mp4') {
                // The edit list ends the audio at the clip's end. The reader still decodes the
                // last packet whole.
                expect(padding).toBe(0)
                expect(Math.abs(media.audioPresentedEnd - clipEnd)).toBeLessThan(1 / 48000)
                expect(media.audioEnd).toBeGreaterThanOrEqual(media.audioPresentedEnd)
                expect(media.audioEnd).toBeLessThan(clipEnd + 1024 / 48000)
                expect(Math.abs(media.duration - media.videoEnd)).toBeLessThan(1 / 48000)
            } else {
                expect(padding).toBeGreaterThanOrEqual(0)
                expect(padding).toBeLessThan(960)
                expect(Math.abs(media.audioEnd - (121600 + padding) / 48000)).toBeLessThan(0.0011)
                expect(
                    Math.abs(media.duration - Math.max(media.videoEnd, media.audioEnd)),
                ).toBeLessThan(0.0011)
            }
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
    for (const cancel of [false, true, 'writing'] as const)
        test(`${format} picked output ${cancel === 'writing' ? 'can be cancelled during a write' : cancel ? 'can be discarded after muxing' : 'preserves colour tags and pixels'}`, async ({
            page,
        }, testInfo) => {
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
            if (cancel) {
                expect(result!.removed).toBe(true)
                expect(result!.writes).toBeGreaterThan(0)
                if (cancel === 'writing') expect(result!.cancelledDuringWrite).toBe(true)
            } else {
                await testInfo.attach('colour', {
                    contentType: 'application/json',
                    body: JSON.stringify(result),
                })
                expect(result!.size).toBeGreaterThan(0)
                expect(result!.expectedColor).toBeDefined()
                expect(result!.actualColor).toEqual(result!.expectedColor)
                expect(result!.muxError).toBe(0)
                expect(result!.directColor).toEqual(result!.expectedColor)
                expect(result!.bitstreamColor?.matrix).toBe(result!.expectedColor?.matrix)
                expect(result!.bitstreamColor?.fullRange).toBe(result!.expectedColor?.fullRange)
                if (format === 'mp4') expect(result!.bitstreamColor).toEqual(result!.expectedColor)
                expect(result!.rawModelError).toBeLessThanOrEqual(2)
                expect(
                    result!.maxError,
                    JSON.stringify({
                        directMaxError: result!.directMaxError,
                        directColor: result!.directColor,
                        expectedColor: result!.expectedColor,
                    }),
                ).toBeLessThanOrEqual(4)
                if (format === 'mp4') expect(result!.indexBeforeMedia).toBe(true)
            }
        })
