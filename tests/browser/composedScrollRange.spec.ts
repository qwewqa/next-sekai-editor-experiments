import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const scroll = (page: import('@playwright/test').Page, layout: 'basic' | 'composed') =>
    page.evaluate(async (layout) => {
        const { fixtures, show, view, settings, appImport, nextTick } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        // The stage moves from lane 0 to 24 over 8 beats; it and its notes leave Basic's range.
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                stageTransformEvents: [0, 8].map((beat) => ({
                    stageId: base.stageId,
                    beat,
                    rotation: 0,
                    xTranslation: beat * 3,
                    yTranslation: 0,
                    elevation: 0,
                    anchor: 'default' as const,
                    eventEase: 'linear' as const,
                })),
                stageMaskEvents: [
                    {
                        stageId: base.stageId,
                        beat: 0,
                        maskLeft: -2,
                        maskSize: 4,
                        isMaskNotes: false,
                        eventEase: 'linear',
                    },
                ],
                slides: [[{ ...base, beat: 4, left: -1, size: 2 }]],
            },
            2,
        )
        settings.width = 16
        settings.maxScrollX = 0
        view.layout = layout
        await nextTick()
        const { scrollViewXBy, scrollViewYBy } =
            await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        const lanes = (dx: number) => {
            for (let i = 0; i < 40; i++) scrollViewXBy(dx)
            return view.lane + 0
        }
        const right = lanes(100)
        // Vertical scrolling leaves the reach unchanged.
        scrollViewYBy(400)
        const stillRight = lanes(100)
        const left = lanes(-100)
        lanes(100)
        // Zooming out shrinks the reach below the view; it eases back instead of jumping.
        settings.width = 40
        const before = view.lane
        scrollViewXBy(1)
        const outward = view.lane - before + 0
        scrollViewXBy(-1)
        const inward = view.lane - before + 0
        settings.width = 16
        view.layout = 'basic'
        await nextTick()
        return { right, stillRight, left, outward, inward, afterBasic: view.lane + 0 }
    }, layout)

test('composed scrolls sideways to stages and notes moved past Max Scroll X', async ({ page }) => {
    const result = await scroll(page, 'composed')
    // The stage reaches 24 + 2 lanes at beat 8; the view's right edge stops there.
    expect(result.right).toBeCloseTo(26 - 8, 6)
    expect(result.stillRight).toBeCloseTo(26 - 8, 6)
    // The left reach stays Basic's, since the chart starts inside the view.
    expect(result.left).toBe(0)
    expect(result.outward).toBe(0)
    expect(result.inward).toBeLessThan(0)
    expect(result.inward).toBeGreaterThan(-1)
    // Back in Basic, the view returns to its own range.
    expect(result.afterBasic).toBe(0)
})

test('basic keeps Max Scroll X for the same chart', async ({ page }) => {
    expect(await scroll(page, 'basic')).toEqual({
        right: 0,
        stillRight: 0,
        left: 0,
        outward: 0,
        inward: 0,
        afterBasic: 0,
    })
})
