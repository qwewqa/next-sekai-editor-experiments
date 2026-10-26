import { expect, test, type Page } from '@playwright/test'
import { SkinSpriteName } from '@sonolus/core'
import { crc32, deflateSync, gzipSync } from 'node:zlib'
import { buildCharts } from './builtinChart'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { archive, resource } from './previewResourceFixture'

// A lane fade is drawn as a pair of translucent sprites. Over an opaque black backdrop, the lane
// halfway from Default to Blue must be the pixel of a constant lane that holds the exact blend of
// the two sprites. An uncompensated crossfade is about 10 levels darker.

// Default is white, Blue is (0, 0, 255) and Green holds their blend, all at alpha 102 (0.4).
const lanes = [
    ['Sekai Lane Background', [255, 255, 255]],
    ['Sekai Lane Background Blue', [0, 0, 255]],
    ['Sekai Lane Background Green', [128, 128, 255]],
] as const
const SPAN = 4

const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
}

// A PNG one row high from RGBA texels.
const png = (texels: number[][]) => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(texels.length, 0)
    header.writeUInt32BE(1, 4)
    header.set([8, 6, 0, 0, 0], 8)
    const row = Buffer.alloc(1 + texels.length * 4)
    texels.forEach((texel, i) => row.set(texel, 1 + i * 4))
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(row)),
        chunk('IEND', Buffer.alloc(0)),
    ])
}

const texture = () =>
    png(lanes.flatMap(([, [r, g, b]]) => Array.from({ length: SPAN }, () => [r, g, b, 102])))

const identity = Object.fromEntries(
    ['x1', 'x2', 'x3', 'x4', 'y1', 'y2', 'y3', 'y4'].map((key) => [key, { [key]: 1 }]),
)

const skin = () =>
    archive({
        'sonolus/skins/list': Buffer.from(
            JSON.stringify({
                items: [
                    {
                        name: 'lanes',
                        title: 'Lanes',
                        data: { url: '/data' },
                        texture: { url: '/texture' },
                    },
                ],
            }),
        ),
        data: gzipSync(
            JSON.stringify({
                width: lanes.length * SPAN,
                height: 1,
                interpolation: true,
                sprites: [
                    // Every other sprite is one texel of Default, so notes and the rest resolve.
                    ...Object.values(SkinSpriteName).map((name) => ({
                        name,
                        x: 0,
                        y: 0,
                        w: 1,
                        h: 1,
                        transform: identity,
                    })),
                    ...lanes.map(([name], lane) => ({
                        name,
                        x: lane * SPAN,
                        y: 0,
                        w: SPAN,
                        h: 1,
                        transform: identity,
                    })),
                ],
            }),
        ),
        texture: texture(),
    })

// A solid black picture for the background, in place of the bundled one.
const black = png([[0, 0, 0, 255]])

const pixelAt = (page: Page, png: Buffer) =>
    page.evaluate(async (base64) => {
        const image = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${base64}`)).blob(),
        )
        const surface = new OffscreenCanvas(image.width, image.height)
        const ctx = surface.getContext('2d')!
        ctx.drawImage(image, 0, 0)
        // The lane, below the middle of the viewport.
        const x = Math.round(image.width / 2)
        const y = Math.round(image.height * 0.8)
        return [...ctx.getImageData(x, y, 1, 1).data]
    }, png.toString('base64'))

const shoot = async (page: Page, laneColors: [string, string]) => {
    await page.evaluate((laneColors) => {
        const charts = (window as unknown as { __charts: Record<string, never> }).__charts
        const chart = structuredClone(charts.colors) as unknown as {
            slides: unknown[]
            stageStyleEvents: Record<string, unknown>[]
        }
        // Two events a second (two beats at 120 BPM) apart, with nothing else on the stage.
        const [first] = chart.stageStyleEvents
        chart.slides = []
        chart.stageStyleEvents = laneColors.map((laneColor, i) => ({
            ...first!,
            beat: i * 2,
            laneColor,
            laneAlpha: 1,
            judgmentLineAlpha: 0,
            divisionLineAlpha: 0,
            leftBorderStyle: 'disabled',
            rightBorderStyle: 'disabled',
        }))
        window.editorTest.show(chart as never, 0)
        // Halfway through the ease of the first event.
        window.editorTest.view.cursorTime = 0.5
    }, laneColors)
    await page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
    await page.waitForTimeout(400)
    return pixelAt(page, await page.locator('.preview-viewport').first().screenshot())
}

test('a lane color fade is the pixel of a lane that holds the exact blend', async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: skin() }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.route('**/bg.png', (route) =>
        route.fulfill({ body: black, contentType: 'image/png' }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(buildCharts)
    await page.evaluate(() => {
        const s = window.editorTest.settings
        s.showPreview = true
        s.previewControls = 'collapsed'
        s.previewShowEffects = false
        s.previewShowTime = false
        s.previewPosition = 'top'
        s.topDockHeight = 720
    })
    await expect(page.locator('.preview-viewport canvas').first()).toBeVisible()

    // Default to Blue, halfway, and a lane that is the blend all along.
    const fading = await shoot(page, ['default', 'blue'])
    const blend = await shoot(page, ['green', 'green'])
    // The backdrop is black, so a lane at alpha 0.4 shows 0.4 of its color: (51, 51, 102).
    for (const [i, channel] of blend.slice(0, 3).entries())
        expect(Math.abs(channel - [51, 51, 102][i]!), `blend ${blend}`).toBeLessThanOrEqual(2)
    for (const [i, channel] of fading.slice(0, 3).entries())
        expect(
            Math.abs(channel - blend[i]!),
            `fading ${fading} against ${blend}`,
        ).toBeLessThanOrEqual(2)
})
