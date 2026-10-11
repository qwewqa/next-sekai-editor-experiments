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

test("Basic: the cursor over a drafted note reads the drafted place's move or resize", async ({
    page,
}) => {
    await showDraft(page, { layout: 'basic', dynamic: false })
    // The head is drawn at 0 to 2; its middle there moves it.
    await hover(page, 1, 4)
    await expect(page.locator('.editor-chart').locator('..')).toHaveCSS('cursor', 'move')
    await hover(page, 0.1, 4)
    await expect(page.locator('.editor-chart').locator('..')).toHaveCSS('cursor', 'ew-resize')
})

test("Composed: with a stage's move drafted, a Note tool ghost lands where the click adds", async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { show, fixtures, view, settings, history, nextTick, appImport } = window.editorTest
        const events = fixtures.events
        show(
            {
                ...events,
                isDynamicStages: true,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                stageMaskEvents: [],
                stagePivotEvents: [],
                stageStyleEvents: [],
                timeScales: [],
                stageTransformEvents: [
                    { ...events.stageTransformEvents[0]!, beat: 2, xTranslation: 0 },
                ],
                slides: [],
            },
            2,
        )
        view.layout = 'composed'
        settings.pps = 240
        settings.showSidebar = true
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.grid.stageTransformEventJoint.values()]
                .flatMap((set) => [...set])
                .slice(0, 1),
        })
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
        await nextTick()
    })
    await page
        .locator('#workspace-panel-properties #properties-section-selection label')
        .filter({ has: page.getByText('X Translation', { exact: true }) })
        .locator('input')
        .fill('3')
    await expect.poll(() => scene(page)).toEqual({ draft: true, committed: false })
    await page.evaluate(async () => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo('note')
    })
    const shownLeft = (which: 'ghost' | 'added') =>
        page.evaluate(async (which) => {
            const { appImport, view, history } = window.editorTest
            const { sceneState } = await appImport<typeof import('../../src/editor/sceneState')>(
                '/src/editor/sceneState.ts',
            )
            const { createComposedLayout } =
                await appImport<typeof import('../../src/editor/composed')>(
                    '/src/editor/composed.ts',
                )
            const note =
                which === 'ghost'
                    ? view.entities.creating.find((entity) => entity.type === 'note')
                    : [...history.state.value.store.slides.note.values()].flat()[0]
            if (note?.type !== 'note') return undefined
            return createComposedLayout(sceneState.value).notePosition(note).left
        }, which)
    const point = await hover(page, 1, 4)
    await expect.poll(() => shownLeft('ghost')).toBeDefined()
    const ghost = await shownLeft('ghost')
    await page.mouse.click(point.x, point.y)
    await expect.poll(() => shownLeft('added')).toBe(ghost)
})

const useTool = (page: Page, name: string, properties?: { isAttached: boolean }) =>
    page.evaluate(
        async ({ name, properties }) => {
            const { appImport } = window.editorTest
            if (properties) {
                const slide = await appImport<typeof import('../../src/editor/tools/slide')>(
                    '/src/editor/tools/slide/index.ts',
                )
                slide.defaultSlideProperties.value = properties
            }
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo(name as never)
        },
        { name, properties },
    )

const ghost = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.view.entities.creating.flatMap((entity) =>
            entity.type === 'note' ? [{ left: entity.left, size: entity.size }] : [],
        ),
    )

test('Basic: a draft of the copied note sets the Note ghost, as the click copies it', async ({
    page,
}) => {
    await showDraft(page, { layout: 'basic', dynamic: false })
    await page
        .locator('#workspace-panel-properties #properties-section-selection label')
        .filter({ has: page.getByText('Size', { exact: true }) })
        .locator('input')
        .fill('6')
    await useTool(page, 'note')
    await hover(page, 2, 7)
    await expect.poll(() => ghost(page)).toMatchObject([{ size: 6 }])
})

test("Basic: an attached Slide ghost lands on the drafted slide's path, as the click does", async ({
    page,
}) => {
    await showDraft(page, { layout: 'basic', dynamic: false })
    await useTool(page, 'slide', { isAttached: true })
    // Halfway from the head, drafted to 0, to the tick at 5 (-2 once the head moves).
    const point = await hover(page, -3, 4.5)
    await expect.poll(() => ghost(page)).toHaveLength(1)
    const [shown] = await ghost(page)
    await page.mouse.click(point.x, point.y)
    const landed = await page.evaluate(() =>
        window.editorTest.snapshot().notes.filter((note) => note.beat === 4.5),
    )
    expect(landed).toMatchObject([{ left: shown!.left, size: shown!.size }])
})
