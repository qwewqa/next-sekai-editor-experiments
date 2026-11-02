import { expect, test } from '@playwright/test'
import { bootScaling, errors, factor, open, panel, settle, summary } from './scalingSession'

test.beforeEach(({ page }) => bootScaling(page))
test.afterEach(({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test('live factor leaves chart history untouched until Apply, with one undo', async ({
    page,
}, testInfo) => {
    await page.evaluate(() => {
        window.editorTest.settings.showPreview = true
        window.editorTest.settings.previewPosition = 'left'
        window.editorTest.settings.leftDockWidth = 300
    })
    await expect(page.locator('.preview canvas').first()).toBeVisible()
    await expect
        .poll(() => page.evaluate(() => window.previewTest.vertices.length))
        .toBeGreaterThan(0)
    expect(await page.evaluate(() => window.nsePreviewTest?.host)).toBe(
        testInfo.project.name === 'chromium-worker' ? 'worker' : 'main',
    )
    await open(page)
    await page.evaluate(() => {
        window.editorTest.view.cursorTime = 2.4
    })
    await settle(page)
    await expect(factor(page)).toHaveValue('1')
    await expect(factor(page)).toHaveAttribute('step', '0.1')
    await expect(panel(page).getByText('Earliest Beat', { exact: true })).toHaveCount(0)
    await expect(page.getByTitle('Select', { exact: true })).toHaveCount(0)
    const original = await page.evaluate(() => ({
        chart: document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!.toDataURL(),
        preview: [...window.previewTest.vertices],
    }))
    await factor(page).fill('2')
    await settle(page)
    const live = await summary(page)
    expect(live.sourceUnchanged).toBe(true)
    expect(live.canUndo).toBe(false)
    expect(live.dirty).toBe(false)
    expect(live.draftDifferent).toBe(true)
    expect(live.stored.map((note) => note.beat)).toEqual([3, 5, 8])
    expect(live.draft.map((note) => note.beat)).toEqual([3, 7, 8])
    await expect
        .poll(() =>
            page.evaluate(() =>
                document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!.toDataURL(),
            ),
        )
        .not.toBe(original.chart)
    await expect
        .poll(() => page.evaluate(() => window.previewTest.vertices))
        .not.toEqual(original.preview)
    const scaledPreview = await page.evaluate(() => [...window.previewTest.vertices])
    await page.screenshot({
        path: testInfo.outputPath('main-live-scaling.png'),
        style: '.notification { visibility: hidden }',
    })
    await panel(page).getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    expect((await summary(page)).stored.map((note) => note.beat)).toEqual([3, 7, 8])
    await page.keyboard.press('z')
    expect((await summary(page)).stored.map((note) => note.beat)).toEqual([3, 5, 8])
    expect((await summary(page)).canUndo).toBe(false)
    await settle(page)
    expect(await page.evaluate(() => window.previewTest.vertices)).toEqual(original.preview)
    await page.keyboard.press('y')
    expect((await summary(page)).stored.map((note) => note.beat)).toEqual([3, 7, 8])
    await settle(page)
    expect(await page.evaluate(() => window.previewTest.vertices)).toEqual(scaledPreview)
})
