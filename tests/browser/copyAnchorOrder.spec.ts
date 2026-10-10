import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// Copy anchors on the note drawn on top under the pointer, as hover and press take it,
// even when an earlier selected note is also within reach.
test('copy anchors on the hit drawn on top, not the earliest hit', async ({ page }) => {
    const target = await page.evaluate(async () => {
        const { appImport, fixtures, show, history, point } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 2, left: 0, size: 2 }],
                    [{ ...base, beat: 2.125, left: 1.5, size: 2 }],
                ],
            },
            1,
        )
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        const notes = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: notes })
        const { hitAllEntitiesAtPoint } = await appImport<
            typeof import('../../src/editor/tools/utils')
        >('/src/editor/tools/utils.ts')
        const [early, late] = [...notes].sort((a, b) => a.beat - b.beat)
        // A point on the later note's artwork that also reaches the earlier note.
        for (let beat = 1.9; beat <= 2.6; beat += 1 / 256) {
            for (let lane = 0; lane <= 4; lane += 1 / 32) {
                const { x, y } = point(lane, beat)
                const hits = hitAllEntitiesAtPoint(x, y)
                if (hits[0] === late && hits.includes(early!)) return { x, y, beat: late!.beat }
            }
        }
    })
    expect(target).toBeDefined()
    await page.mouse.move(target!.x, target!.y)
    await page.keyboard.press('c')
    const copied = await page.evaluate(async () => {
        const { clipboardEntry } =
            await window.editorTest.appImport<typeof import('../../src/clipboard')>(
                '/src/clipboard/index.ts',
            )
        return JSON.parse(clipboardEntry.value!.text) as { beat: number; lane: number }
    })
    expect(copied).toMatchObject({ beat: target!.beat, lane: 2.5 })
})
