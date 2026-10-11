import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Composed draws a pending Properties draft; hits follow what is drawn.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// A slide from beat 4 to 6 with an attached tick at 5, its head selected, typed to lane 0 unsaved.
const showDraft = async (page: Page) => {
    await page.evaluate(async () => {
        const { show, fixtures, view, settings, history, nextTick, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                slides: [
                    [
                        { ...base, beat: 4, left: -4, size: 2 },
                        { ...base, beat: 5, left: -4, size: 2, isAttached: true },
                        { ...base, beat: 6, left: -4, size: 2 },
                    ],
                ],
            },
            2.5,
        )
        view.layout = 'composed'
        settings.pps = 240
        settings.showSidebar = true
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()]
                .flat()
                .filter((note) => note.beat === 4),
        })
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
        await nextTick()
    })
    const lane = page
        .locator('#workspace-panel-properties #properties-section-selection label')
        .filter({ has: page.getByText('Lane', { exact: true }) })
        .locator('input')
    await lane.fill('0')
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { isScenePreview } = await window.editorTest.appImport<
                    typeof import('../../src/editor/sceneState')
                >('/src/editor/sceneState.ts')
                return isScenePreview.value
            }),
        )
        .toBe(true)
    return lane
}

const at = (page: Page, lane: number, beat: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })

const hover = async (page: Page, lane: number, beat: number) => {
    const point = await at(page, lane, beat)
    await page.mouse.move(point.x - 2, point.y)
    await page.mouse.move(point.x, point.y)
    return point
}

const hovered = (page: Page) => page.evaluate(() => window.editorTest.snapshot().hovered)

test('hover and press take the draft where it is drawn, as the committed notes', async ({
    page,
}) => {
    const lane = await showDraft(page)

    // The head is drawn at lanes 0 to 2; it was at -4 to -2.
    await hover(page, 1, 4)
    await expect.poll(() => hovered(page)).toMatchObject([{ beat: 4, left: -4, size: 2 }])
    await hover(page, -3, 4)
    await expect.poll(() => hovered(page)).toEqual([])

    // The attached tick follows the drafted head: its diamond is drawn at lane -1.
    await hover(page, -1, 5)
    await expect.poll(() => hovered(page)).toMatchObject([{ beat: 5, left: -4 }])
    await hover(page, -3, 5)
    await expect.poll(() => hovered(page)).toEqual([])

    // The hover outline is drawn around the drafted head.
    await hover(page, 1, 4)
    expect(
        await page.evaluate(async () => {
            const { appImport, view } = window.editorTest
            const { toSceneEntity } = await appImport<typeof import('../../src/editor/sceneState')>(
                '/src/editor/sceneState.ts',
            )
            return view.entities.hovered.map((entity) => {
                const shown = toSceneEntity(entity)
                return shown.type === 'note' && shown.left
            })
        }),
    ).toEqual([0])

    // A click blurs the field, which commits the draft first, as before; the press then takes the head.
    const head = await at(page, 1, 4)
    await page.mouse.click(head.x, head.y)
    await expect(lane).not.toBeFocused()
    const after = await page.evaluate(async () => {
        const { history, store } = window.editorTest
        const all = store.getAllEntities()
        return {
            selected: history.state.value.selectedEntities.map((entity) => ({
                beat: entity.beat,
                inStore: all.has(entity),
            })),
            canUndo: history.canUndo.value,
            notes: window.editorTest.snapshot().notes.map(({ beat, left }) => [beat, left]),
        }
    })
    expect(after).toEqual({
        selected: [{ beat: 4, inStore: true }],
        canUndo: true,
        notes: [
            [4, 0],
            [5, -2],
            [6, -4],
        ],
    })
})
