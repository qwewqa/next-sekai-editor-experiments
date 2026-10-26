import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// An edit that would leave a chart the editor refuses to reopen does not happen.

const maxBeat = 100000

const noteBeats = (page: Page) =>
    page.evaluate(() => window.editorTest.snapshot().notes.map((note) => note.beat))

const placeAt = async (page: Page, beat: number) => {
    await page.evaluate((beat) => {
        window.editorTest.view.time = beat / 2
    }, beat)
    const { x, y } = await page.evaluate((beat) => window.editorTest.point(0, beat), beat)
    await page.mouse.move(x, y, { steps: 3 })
    await page.mouse.click(x, y)
}

test('a note placed past the largest beat is not added, and one before it is', async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    const before = (await noteBeats(page)).length
    // The Note tool.
    await page.keyboard.press('a')

    await placeAt(page, maxBeat + 20)
    await page.waitForTimeout(300)
    expect(await noteBeats(page)).toHaveLength(before)

    await placeAt(page, maxBeat - 20)
    await expect.poll(async () => (await noteBeats(page)).length).toBe(before + 1)
    expect(Math.max(...(await noteBeats(page)))).toBeLessThanOrEqual(maxBeat)
})
