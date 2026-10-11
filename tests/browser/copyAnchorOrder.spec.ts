import { expect, test, type Page } from '@playwright/test'
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
        const { pointHitsAt } = await appImport<typeof import('../../src/editor/tools/utils')>(
            '/src/editor/tools/utils.ts',
        )
        const [early, late] = [...notes].sort((a, b) => a.beat - b.beat)
        // A point on the later note's artwork that also reaches the earlier note.
        for (let beat = 1.9; beat <= 2.6; beat += 1 / 256) {
            for (let lane = 0; lane <= 4; lane += 1 / 32) {
                const { x, y } = point(lane, beat)
                const hits = pointHitsAt(x, y).hits
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

// An unselected note wins the point; of the selected notes in reach, one reaches it only
// through its side slack, ranked before one whose own span holds it.
const showSlackStack = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, fixtures, show, history, point, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 2, left: 0, size: 2 }],
                    [{ ...base, beat: 2, left: 2.05, size: 2 }],
                    [{ ...base, beat: 2.5, left: 0, size: 2 }],
                ],
            },
            1,
        )
        settings.mouseSecondaryTool = 'selectContextMenu'
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        const notes = [...history.state.value.store.slides.note.values()].flat()
        // In beat then lane order: the winner, the slack one at lane 2.05, the span one at beat 2.5.
        const [winner, slack, span] = notes.sort((a, b) => a.beat - b.beat || a.left - b.left)
        history.replaceState({ ...history.state.value, selectedEntities: [slack!, span!] })
        const { pointHitsAt } = await appImport<typeof import('../../src/editor/tools/utils')>(
            '/src/editor/tools/utils.ts',
        )
        for (let beat = 1.9; beat <= 2.2; beat += 1 / 256) {
            for (let lane = 1.9; lane <= 2.05; lane += 1 / 128) {
                // Whole pixels, as the mouse lands.
                const shown = point(lane, beat)
                const [x, y] = [Math.round(shown.x), Math.round(shown.y)]
                const { hits, set } = pointHitsAt(x, y)
                if (
                    hits[0] === winner &&
                    hits.includes(slack!) &&
                    hits.includes(span!) &&
                    hits.indexOf(slack!) < hits.indexOf(span!) &&
                    !set.includes(slack!) &&
                    set.includes(span!)
                )
                    return { x, y }
            }
        }
    })

test('copy anchors on a selected note in reach as a press finds it, not on one reached only through its side', async ({
    page,
}) => {
    const target = await showSlackStack(page)
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
    expect(copied).toMatchObject({ beat: 2.5, lane: 1 })
})

test('Edit Elevations opens at a selected note in reach as a press finds it, not at one reached only through its side', async ({
    page,
}) => {
    const target = await showSlackStack(page)
    expect(target).toBeDefined()
    await page.mouse.move(target!.x, target!.y)
    await page.mouse.click(target!.x, target!.y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit Elevations', exact: true }).click()
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    expect(
        await page.evaluate(async () => {
            const { elevationBeat } = await window.editorTest.appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            return elevationBeat.value
        }),
    ).toBe(2.5)
})
