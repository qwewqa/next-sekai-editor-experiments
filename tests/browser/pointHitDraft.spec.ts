import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Every layout draws a pending Properties draft; hits follow what is drawn.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// A slide from beat 4 to 6 with an attached tick at 5, its head selected, typed to lane 0 unsaved.
type Layout = { layout: 'basic' | 'composed'; dynamic: boolean }

const showDraft = async (page: Page, { layout, dynamic }: Layout) => {
    await page.evaluate(
        async ({ layout, dynamic }) => {
            const { show, fixtures, view, settings, history, nextTick, appImport } =
                window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: dynamic,
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
            view.layout = layout
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
        },
        { layout, dynamic },
    )
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

for (const layout of [
    { layout: 'composed', dynamic: true },
    { layout: 'basic', dynamic: true },
    { layout: 'basic', dynamic: false },
] as const)
    test(`${layout.layout}${layout.dynamic ? '' : ', static stages'}: hover and press take the draft where it is drawn, as the committed notes`, async ({
        page,
    }) => {
        const lane = await showDraft(page, layout)

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
                const { toSceneEntity } = await appImport<
                    typeof import('../../src/editor/sceneState')
                >('/src/editor/sceneState.ts')
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

test('a right-click on a drafted note commits the draft, then opens the menu on the note', async ({
    page,
}) => {
    await showDraft(page, { layout: 'basic', dynamic: false })
    const head = await at(page, 1, 4)
    await page.mouse.move(head.x - 2, head.y)
    await page.mouse.click(head.x, head.y, { button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    expect(
        await page.evaluate(() => ({
            canUndo: window.editorTest.history.canUndo.value,
            selected: window.editorTest.snapshot().selected.map(({ beat, left }) => [beat, left]),
        })),
    ).toEqual({ canUndo: true, selected: [[4, 0]] })
})

test('Elevation Editor: a pending draft is hovered as the committed note, and a press commits it', async ({
    page,
}) => {
    const lane = await showDraft(page, { layout: 'basic', dynamic: false })
    await page.evaluate(async () => {
        const { settings, appImport } = window.editorTest
        settings.elevationEditorSideBySide = 'allow'
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(4)
    })
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await expect(lane).toHaveValue('0')
    const row = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { elevationBounds } = await appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        const head = elevationLayout.value.rows.find((row) => row.note.beat === 4)!
        return { x: elevationBounds.x + head.x, y: elevationBounds.y + head.y }
    })
    await page.mouse.move(row.x - 2, row.y)
    await page.mouse.move(row.x, row.y)
    // The committed note, which the store holds.
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { view, store } = window.editorTest
                const all = store.getAllEntities()
                return view.entities.hovered.map((entity) => all.has(entity))
            }),
        )
        .toEqual([true])
    await page.mouse.down()
    await page.mouse.up()
    expect(
        await page.evaluate(() => ({
            canUndo: window.editorTest.history.canUndo.value,
            notes: window.editorTest.snapshot().notes.map(({ beat, left }) => [beat, left]),
        })),
    ).toEqual({
        canUndo: true,
        notes: [
            [4, 0],
            [5, -2],
            [6, -4],
        ],
    })
})

const scene = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const { sceneState } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        const { previewEdit } =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        return {
            draft: !!previewEdit.value?.draft,
            committed: sceneState.value === history.state.value,
        }
    })

test('Basic: with a draft pending, the Note tool still shows its add ghost', async ({ page }) => {
    await showDraft(page, { layout: 'basic', dynamic: false })
    await page.evaluate(async () => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo('note')
    })
    await hover(page, -4, 5.5)
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.entities.creating.length))
        .toBe(1)
    expect(await scene(page)).toEqual({ draft: true, committed: false })
})

test("a tempo draft in a tool's dialog is not drawn retimed", async ({ page }) => {
    await page.evaluate(() => {
        const { show, fixtures } = window.editorTest
        show(fixtures.interaction, 1.5)
    })
    await page.keyboard.press('q')
    const below = await at(page, -4, -1)
    const to = await at(page, -4, 1)
    await page.mouse.move(below.x, below.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
    const dialog = page.getByRole('dialog', { name: 'BPM Properties' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('spinbutton', { name: 'BPM' }).fill('240')
    await expect.poll(() => scene(page)).toEqual({ draft: true, committed: true })
})

test('after a cycle, a draft and its committing click: the hover showed what the click selects', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { show, fixtures, view, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 4, left: -2, size: 3 }],
                    [{ ...base, beat: 4, left: -1, size: 3 }],
                    [{ ...base, beat: 4, left: 0, size: 3 }],
                ],
            },
            2.5,
        )
        view.layout = 'basic'
        settings.pps = 240
        settings.showSidebar = true
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
    })
    const point = await hover(page, 0.5, 4)
    await page.mouse.click(point.x, point.y)
    await page.mouse.click(point.x, point.y)
    const elevation = page
        .locator('#workspace-panel-properties #properties-section-selection label')
        .filter({ has: page.getByText('Elevation', { exact: true }) })
        .locator('input')
    await elevation.fill('1')
    await expect.poll(() => scene(page)).toEqual({ draft: true, committed: false })
    await hover(page, 0.5, 4)
    const shown = await page.evaluate(() =>
        window.editorTest.view.entities.hovered.map((note) => (note as { left: number }).left),
    )
    await page.mouse.click(point.x, point.y)
    expect(
        await page.evaluate(() =>
            window.editorTest.history.state.value.selectedEntities.map(
                (note) => (note as { left: number }).left,
            ),
        ),
    ).toEqual(shown)
})
