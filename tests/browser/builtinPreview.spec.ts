import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { buildCharts } from './builtinChart'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The preview with the Built-in skin, particle and background for reference charts:
// every note type, the flick directions, slides and guides, the eight styles and the lane and
// judgment line colors, at a desktop and a phone size in both themes, with the far end of the lane
// in the first shot. With SHOTS_DIR set the shots are saved there; either way each must show
// something other than the empty stage.
const shotsDir = process.env.SHOTS_DIR
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const builtinAll = Object.fromEntries(
    ['skin', 'particle', 'background', 'effect'].map((type) => [type, { source: 'builtin' }]),
)

const sizes = {
    desktop: { width: 1600, height: 1000, scale: 1, dock: 720 },
    phone: { width: 390, height: 844, scale: 3, dock: 330 },
} as const
// A chart's shots: the far end of the lane first, then the notes coming down to the line.
const times: Record<string, number[]> = {
    types: [1.6, 2.95, 4.5],
    slides: [1.6, 3.6, 7.8],
    styles: [1.6, 3.2, 5.5],
    // Halfway to Red, on Red, halfway to Blue and on Blue.
    colors: [1, 2, 3, 4],
}

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

for (const [size, { width, height, scale, dock }] of Object.entries(sizes))
    test.describe(size, () => {
        test.use({ viewport: { width, height }, deviceScaleFactor: scale })

        for (const theme of ['light', 'dark'] as const)
            for (const [chartName, shotTimes] of Object.entries(times))
                test(`${chartName} with Built-in in the ${theme} theme`, async ({ page }) => {
                    const urls: string[] = []
                    page.on('request', (request) => urls.push(new URL(request.url()).pathname))
                    await page.addInitScript((builtin) => {
                        localStorage.setItem(
                            'sonolus-next-sekai-editor.previewAssets',
                            JSON.stringify(builtin),
                        )
                    }, builtinAll)
                    await page.addInitScript(installCanvasCounters)
                    await page.goto('/')
                    await expect(page.locator('canvas.editor-chart')).toBeVisible()
                    await page.evaluate(installEditorFixture)
                    await page.evaluate(buildCharts)
                    await page.evaluate(
                        ([theme, dock]) => {
                            const s = window.editorTest.settings
                            s.theme = theme as 'light' | 'dark'
                            s.showPreview = true
                            s.previewControls = 'collapsed'
                            s.previewShowEffects = false
                            // Only the notes change from one moment to the next.
                            s.previewShowTime = false
                            s.previewPosition = 'top'
                            s.topDockHeight = dock as number
                        },
                        [theme, dock] as const,
                    )
                    const viewport = page.locator('.preview-viewport').first()
                    await expect(viewport.locator('canvas').first()).toBeVisible()
                    await settle(page)

                    const shots: Buffer[] = []
                    for (const [index, time] of shotTimes.entries()) {
                        await page.evaluate(
                            ([chartName, time]) => {
                                const charts = (
                                    window as unknown as { __charts: Record<string, never> }
                                ).__charts
                                window.editorTest.show(charts[chartName as string]!, 0)
                                window.editorTest.view.cursorTime = time as number
                                window.editorTest.settings.previewNoteSpeed = 10
                            },
                            [chartName, time] as const,
                        )
                        await settle(page)
                        await page.waitForTimeout(400)
                        shots.push(
                            await viewport.screenshot({
                                path: shotsDir
                                    ? `${shotsDir}/${chartName}-${size}-${theme}-${index}.png`
                                    : undefined,
                            }),
                        )
                    }

                    // The Built-in set is in use, and Default was never asked for.
                    expect(urls).toEqual(
                        expect.arrayContaining([
                            '/builtin/skin.scp',
                            '/builtin/particle.scp',
                            '/builtin/background.scp',
                        ]),
                    )
                    expect(urls.filter((url) => url.startsWith('/resource/'))).toEqual([])
                    // Each moment differs from the one before: the notes moved.
                    for (let i = 1; i < shots.length; i++)
                        expect(shots[i]!.equals(shots[i - 1]!)).toBe(false)
                })
    })
