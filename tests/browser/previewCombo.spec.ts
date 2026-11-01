import { expect, test, type Page } from '@playwright/test'
import { installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

// Show Combo in the frame, in each host (the `chromium` and `chromium-worker` projects): its
// quads copy the text texture one to one, and a frame is the same whether playback reached its
// time or started there.

declare global {
    interface Window {
        comboTest: { freezeAudio: (time?: number) => void }
    }
}

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        await window.nsePreviewTest?.settled()
    })

// One note every beat at BPM 120 from 0.5 s: the count reaches n at n / 2 s.
const NOTES = 120
// A top dock 657 pixels high on a wide page: the field is 657 pixels high and the figure 59.
test.use({ viewport: { width: 2400, height: 1400 } })

const open = async (page: Page) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(() => {
        // A page without focus draws nothing, as when the app is in the background.
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
        // A frozen audio clock holds playback at one time.
        const time = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime')!
        let frozen: number | undefined
        Object.defineProperty(BaseAudioContext.prototype, 'currentTime', {
            configurable: true,
            get(this: BaseAudioContext) {
                return frozen ?? (time.get!.call(this) as number)
            },
        })
        window.comboTest = {
            freezeAudio: (value) => {
                frozen = value
            },
        }
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate((count) => {
        const { fixtures, show, settings, view } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: Array.from({ length: count }, (_, i) => [
                    { ...base, beat: i + 1, left: -1, size: 2 },
                ]),
            },
            3,
        )
        view.cursorTime = 0
        Object.assign(settings, {
            showPreview: true,
            previewShowCombo: true,
            previewAntialias: false,
            previewRenderScale: 1,
            previewShowEffects: false,
            previewHighlightSelection: false,
            previewShowTime: false,
            previewAspectRatio: 16 / 9,
            previewPosition: 'top',
            playStartPosition: 'cursor',
            topDockHeight: 657,
        })
    }, NOTES)
    await expect(page.locator('.preview-viewport canvas').first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.nsePreviewTest !== undefined)).toBe(true)
    await settle(page)
}

const comboPixels = async (page: Page) => {
    await settle(page)
    return page.evaluate(async () => {
        const pixels = await window.nsePreviewTest!.comboPixels()
        if (!pixels) return
        const plain = ({ rect, frame, texture }: (typeof pixels)['label']) => ({
            rect,
            frame: Array.from(frame),
            texture: Array.from(texture),
        })
        return {
            label: plain(pixels.label),
            number: plain(pixels.number),
            time: pixels.time,
            scale: pixels.scale,
        }
    })
}

const seek = async (page: Page, time: number) => {
    await page.evaluate((time) => (window.editorTest.view.cursorTime = time), time)
    await settle(page)
}

const isPlaying = (page: Page) =>
    page.evaluate(async () => {
        const { isPlaying } =
            await window.editorTest.appImport<typeof import('../../src/player')>('/src/player.ts')
        return isPlaying.value
    })

/**
 * Starts playback at `time` with the audio clock held within the startup delay, so the frame
 * stays at `time`. With `to`, the clock then runs on and holds at about `to`.
 */
const play = async (page: Page, time: number, to?: number) => {
    await seek(page, time)
    await page.evaluate(async () => {
        const { startOrStopPlayer } =
            await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                '/src/editor/player.ts',
            )
        window.comboTest.freezeAudio(1)
        startOrStopPlayer()
        // A clock that never moves stops playback. This one moves but stays within the
        // startup delay.
        window.comboTest.freezeAudio(1.1)
    })
    await expect.poll(() => isPlaying(page)).toBe(true)
    if (to === undefined) {
        await expect.poll(() => page.evaluate(() => window.editorTest.view.cursorTime)).toBe(time)
        return
    }
    const delay = await page.evaluate(async () => {
        const { startupDelay } =
            await window.editorTest.appImport<typeof import('../../src/player')>('/src/player.ts')
        return startupDelay
    })
    // The display clock runs up to 25 ms ahead of a held audio clock.
    await page.evaluate(
        (value) => window.comboTest.freezeAudio(value),
        1 + delay + (to - time) - 0.025,
    )
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
        .toBeGreaterThan(to - 0.03)
}

const stop = (page: Page) =>
    page.evaluate(async () => {
        const { startOrStopPlayer } =
            await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                '/src/editor/player.ts',
            )
        startOrStopPlayer()
    })

test('the combo quads copy the text texture one to one at rest', async ({ page }) => {
    await open(page)
    expect(await comboPixels(page)).toBeUndefined()
    for (const time of [4.75, 5.25, 50.25]) {
        await seek(page, time)
        const pixels = await comboPixels(page)
        expect(pixels, `${time}`).toBeDefined()
        for (const part of [pixels!.label, pixels!.number]) {
            expect(part.frame.some((value, i) => i % 4 === 3 && value > 0)).toBe(true)
            expect(part.frame).toEqual(part.texture)
            for (const value of Object.values(part.rect)) expect(Number.isInteger(value)).toBe(true)
        }
    }
})

type Pixels = Awaited<ReturnType<typeof comboPixels>>

/** Where two readbacks differ: how many bytes, and by how much at most, in each part. */
const differences = (a: Pixels, b: Pixels) => [
    ...(a?.time === b?.time && a?.scale === b?.scale
        ? []
        : [{ time: [a?.time, b?.time], scale: [a?.scale, b?.scale] }]),
    ...(['label', 'number'] as const).flatMap((part) =>
        (['frame', 'texture'] as const).flatMap((kind) => {
            const x = a?.[part][kind] ?? []
            const y = b?.[part][kind] ?? []
            let bytes = Math.abs(x.length - y.length)
            let level = 0
            for (let i = 0; i < Math.min(x.length, y.length); i++)
                if (x[i] !== y[i]) {
                    bytes++
                    level = Math.max(level, Math.abs(x[i]! - y[i]!))
                }
            return bytes ? [{ part, kind, bytes, level }] : []
        }),
    ),
]

for (const [label, boundary] of [
    ['9 to 10', 5],
    ['99 to 100', 50],
] as const) {
    test(`a frame after ${label} is the same played through or started there`, async ({
        page,
        browser,
    }) => {
        test.slow()
        await open(page)
        await play(page, boundary - 0.25, boundary + 0.05)
        // `comboPixels` draws the last frame again before it reads.
        const played = await comboPixels(page)
        const time = played!.time
        expect(time).toBeGreaterThan(boundary)
        expect(time).toBeLessThan(boundary + 0.14)
        expect(played!.scale).toBeGreaterThan(1)
        // The number's image is the figure height of 59 and its outline margins.
        expect(played!.number.rect.height).toBe(69)

        // Started at that time, after the cursor was elsewhere.
        await stop(page)
        await seek(page, 1)
        await play(page, time)
        expect(differences(await comboPixels(page), played)).toEqual([])

        // A new page that has not drawn this count seeks there.
        const context = await browser.newContext({ viewport: page.viewportSize()! })
        const fresh = await context.newPage()
        await open(fresh)
        await play(fresh, time)
        expect(differences(await comboPixels(fresh), played)).toEqual([])
        await context.close()

        // Paused by stopping, or by setting the cursor.
        await stop(page)
        const stopped = await comboPixels(page)
        expect(stopped!.scale).toBe(1)
        await seek(page, 1)
        await seek(page, stopped!.time)
        expect(differences(await comboPixels(page), stopped)).toEqual([])
    })
}
