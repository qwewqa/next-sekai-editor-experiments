import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const errors = new WeakMap<Page, string[]>()
const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
const elevation = (page: Page) =>
    page.evaluate(async () => {
        const { appImport } = window.editorTest
        const [viewport, scene] = await Promise.all([
            appImport<typeof import('../../src/editor/elevation/viewport')>(
                '/src/editor/elevation/viewport.ts',
            ),
            appImport<typeof import('../../src/editor/elevation/scene')>(
                '/src/editor/elevation/scene.ts',
            ),
        ])
        const { center, scale } = viewport.elevationViewport
        const { laneScale, height, yAt } = scene.elevationLayout.value
        return { center, scale, laneScale, height, top: yAt(20) }
    })
const viewport = async (page: Page) => {
    const { center, scale } = await elevation(page)
    return { center, scale }
}
// Notes from beat 6, two beats apart, each at an elevation and optionally a lane.
const showChart = (page: Page, notes: (number | [elevation: number, left: number])[]) =>
    page.evaluate((notes) => {
        const { fixtures, show, view } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: notes.map((note, i) => {
                    const [elevation, left] = typeof note === 'number' ? [note, 0] : note
                    return [{ ...base, beat: 6 + 2 * i, left, size: 2, elevation }]
                }),
            },
            3,
        )
        view.cursorTime = 3
    }, notes)
const open = async (page: Page) => {
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await settle(page)
}
const close = async (page: Page) => {
    await page.getByRole('button', { name: 'Close Elevation Editor', exact: true }).click()
    await expect(page.locator('.elevation-editor')).toHaveCount(0)
}
// Scrolls and zooms the view away from its fit.
const moveView = async (page: Page) => {
    const box = (await page.locator('.elevation-canvas').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 120)
    await page.keyboard.press('=')
    await settle(page)
}

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    // At beat 8, a note past the lanes on the right.
    await showChart(page, [2, [3, 30]])
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
    })
    await settle(page)
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test.describe('the view', () => {
    test('is kept across beat changes, with badges for notes outside it', async ({ page }) => {
        await open(page)
        await moveView(page)
        const moved = await viewport(page)
        const beat = page.getByRole('spinbutton', { name: 'Beat', exact: true })
        await page.getByRole('button', { name: 'Next Beat', exact: true }).click()
        await expect(beat).toHaveValue('7.25')
        expect(await viewport(page)).toEqual(moved)
        const badges = page.locator('.elevation-editor .offscreen-note-indicator')
        await expect(badges).toHaveCount(0)
        await beat.fill('9')
        await beat.press('Enter')
        await settle(page)
        expect(await viewport(page)).toEqual(moved)
        // The new beat's note past the lanes has a badge.
        await expect(badges).toHaveCount(1)
    })

    test('is kept when the editor closes and reopens', async ({ page }) => {
        await open(page)
        await moveView(page)
        const moved = await viewport(page)
        await close(page)
        await open(page)
        expect(await viewport(page)).toEqual(moved)
        // Side by side too.
        await close(page)
        await page.evaluate(() => {
            window.editorTest.settings.elevationEditorSideBySide = 'allow'
        })
        await open(page)
        expect(await viewport(page)).toEqual(moved)
    })

    test('is fitted on the first open after a chart load', async ({ page }) => {
        await open(page)
        const fitted = await viewport(page)
        await moveView(page)
        await close(page)
        await showChart(page, [2, [3, 30]])
        await open(page)
        expect(await viewport(page)).toEqual(fitted)
        // Another chart fits its own notes.
        await close(page)
        await showChart(page, [20])
        await open(page)
        const { top, height } = await elevation(page)
        expect(top).toBeGreaterThan(0)
        expect(top).toBeLessThan(height)
    })

    test('is fitted on a chart load while open side by side', async ({ page }) => {
        await page.evaluate(() => {
            window.editorTest.settings.elevationEditorSideBySide = 'allow'
        })
        await open(page)
        await moveView(page)
        await showChart(page, [20])
        await settle(page)
        await expect(page.locator('.elevation-editor')).toBeVisible()
        const { top, height } = await elevation(page)
        expect(top).toBeGreaterThan(0)
        expect(top).toBeLessThan(height)
    })
})
