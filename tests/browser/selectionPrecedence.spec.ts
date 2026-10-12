import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const point = (page: Page) => page.evaluate(() => window.editorTest.point(0, 4))
const selected = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.history.state.value.selectedEntities.map((entity) =>
            entity.type === 'note' ? `note:${entity.noteStyle}` : entity.type,
        ),
    )
const click = async (page: Page) => {
    const at = await point(page)
    await page.mouse.click(at.x, at.y)
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(async () => {
        const { fixtures, show, settings, view, appImport } = window.editorTest
        const events = fixtures.events
        const note = { ...fixtures.interaction.slides[0]![0]!, beat: 4, left: -1, size: 2 }
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                bpms: [
                    { beat: 0, bpm: 120 },
                    { beat: 4, bpm: 120 },
                ],
                cameraEvents: [
                    { ...events.cameraEvents[0]!, beat: 4, cameraLeft: -2, cameraSize: 4 },
                ],
                stageMaskEvents: [
                    { ...events.stageMaskEvents[0]!, beat: 4, maskLeft: -2, maskSize: 4 },
                ],
                stagePivotEvents: [
                    { ...events.stagePivotEvents[0]!, beat: 4, pivotLane: 0, yOffset: 0 },
                ],
                stageStyleEvents: [{ ...events.stageStyleEvents[0]!, beat: 4, editorLane: 0 }],
                stageTransformEvents: [
                    { ...events.stageTransformEvents[0]!, beat: 4, xTranslation: 0 },
                ],
                timeScales: [{ ...events.timeScales[0]!, beat: 4, editorLane: 0, timeScale: 1 }],
                slides: [
                    [{ ...note, noteStyle: 'red' }],
                    [{ ...note, noteStyle: 'blue', groupId: 2 as typeof note.groupId }],
                    [
                        { ...note, beat: 2 },
                        { ...note, beat: 6 },
                    ],
                ],
            },
            2,
        )
        settings.showPreview = false
        settings.showSidebar = false
        settings.mouseSecondaryTool = 'selectContextMenu'
        view.layout = 'basic'
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
    })
})

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout} clicks cycle what is drawn, top first, then events in reach by category`, async ({
        page,
    }) => {
        await page.evaluate((layout) => {
            window.editorTest.view.layout = layout
        }, layout)
        // The time scale's marker is drawn over everything; of the same-beat notes, blue is on
        // top; the joint markers at lane 0 are drawn under the notes; camera and mask are in reach.
        const expected = [
            'timeScale',
            'note:blue',
            'note:red',
            'stageTransformEventJoint',
            'stageStyleEventJoint',
            'stagePivotEventJoint',
            'stageMaskEventJoint',
            'cameraEventJoint',
            'timeScale',
        ]
        for (const entity of expected) {
            await click(page)
            expect(await selected(page)).toEqual([entity])
        }
        expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
    })
}

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout} fixed BPM lane cycles the time-scale marker, notes, then BPM`, async ({
        page,
    }) => {
        await page.evaluate((layout) => {
            const { fixtures, show, view } = window.editorTest
            const note = { ...fixtures.interaction.slides[0]![0]!, beat: 4, left: 5.5, size: 2 }
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    bpms: [
                        { beat: 0, bpm: 120 },
                        { beat: 4, bpm: 120 },
                    ],
                    timeScales: [
                        {
                            ...fixtures.events.timeScales[0]!,
                            beat: 4,
                            editorLane: 6.5,
                            timeScale: 1,
                        },
                    ],
                    slides: [[{ ...note, noteStyle: 'red' }], [{ ...note, noteStyle: 'blue' }]],
                },
                2,
            )
            view.layout = layout
        }, layout)
        const at = await page.evaluate(() => window.editorTest.point(6.5, 4))
        for (const entity of ['timeScale', 'note:blue', 'note:red', 'bpm', 'timeScale']) {
            await page.mouse.click(at.x, at.y)
            expect(await selected(page)).toEqual([entity])
        }
        expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
    })
}

test('category sorting preserves typed-note and box hit order and excludes connector bodies', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const hits = await appImport<typeof import('../../src/editor/tools/utils')>(
            '/src/editor/tools/utils.ts',
        )
        const at = window.editorTest.point(0, 4)
        const all = hits.pointHitsAt(at.x, at.y).hits
        const typed = hits.pointHitsOfType('note', at.x, at.y).hits
        const box = hits.hitAllEntitiesInSelection({
            laneMin: -0.1,
            laneMax: 0.1,
            timeMin: 1.99,
            timeMax: 2.01,
        })
        return {
            pointNotes: all
                .filter((entity) => entity.type === 'note')
                .map((note) => note.noteStyle),
            typedNotes: typed.map((note) => note.noteStyle),
            boxTypes: box.map((entity) => entity.type),
            pointTypes: all.map((entity) => entity.type),
        }
    })
    expect(result.pointNotes).toEqual(['blue', 'red'])
    expect(result.pointNotes).toEqual(result.typedNotes)
    expect(result.pointTypes).not.toContain('connector')
    expect(result.boxTypes).not.toEqual(result.pointTypes)
    expect([...result.boxTypes].sort()).toEqual([...result.pointTypes].sort())
})

test('hidden and dimmed notes are excluded before the drawn order applies', async ({ page }) => {
    await page.evaluate(() => {
        const { view } = window.editorTest
        view.groupVisibility = new Map([[2 as NonNullable<typeof view.groupId>, 'hidden']])
    })
    await click(page)
    expect(await selected(page)).toEqual(['timeScale'])
    await click(page)
    expect(await selected(page)).toEqual(['note:red'])
    await click(page)
    expect(await selected(page)).toEqual(['stageTransformEventJoint'])
    await page.evaluate(() => {
        const { view, history } = window.editorTest
        view.groupVisibility = new Map()
        view.groupId = 1 as NonNullable<typeof view.groupId>
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    await click(page)
    expect(await selected(page)).toEqual(['timeScale'])
    await click(page)
    expect(await selected(page)).toEqual(['note:red'])
    await click(page)
    expect(await selected(page)).toEqual(['stageTransformEventJoint'])
    await page.evaluate(() => {
        const { view, history } = window.editorTest
        view.visibilities = { ...view.visibilities, note: false }
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    await click(page)
    expect(await selected(page)).toEqual(['timeScale'])
    await click(page)
    expect(await selected(page)).toEqual(['stageTransformEventJoint'])
})

test('an already selected event keeps context-menu and drag ownership over notes', async ({
    page,
}) => {
    for (let i = 0; i < 4; i++) await click(page)
    expect(await selected(page)).toEqual(['stageTransformEventJoint'])
    const at = await point(page)
    await page.mouse.click(at.x, at.y, { button: 'right' })
    expect(await selected(page)).toEqual(['stageTransformEventJoint'])
    await page.keyboard.press('Escape')
    const delta = await page.evaluate(
        () => window.editorTest.view.w / window.editorTest.settings.width,
    )
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + delta, at.y, { steps: 5 })
    await page.mouse.up()
    expect(await selected(page)).toEqual(['stageTransformEventJoint'])
    expect(
        await page.evaluate(() =>
            [...window.editorTest.store.getAllEntities()]
                .filter((entity) => entity.type === 'stageTransformEventJoint')
                .map((entity) => entity.xTranslation),
        ),
    ).toEqual([1])
    expect(
        await page.evaluate(() =>
            [...window.editorTest.history.state.value.store.slides.note.values()]
                .flat()
                .every((note) => note.left === -1),
        ),
    ).toBe(true)
    await page.evaluate(() => window.editorTest.history.undoState())
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
})

test('Eraser removes the top drawn object: the time-scale marker, then the top note', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo('eraser')
    })
    await click(page)
    expect(
        await page.evaluate(
            () =>
                [...window.editorTest.store.getAllEntities()].filter(
                    (entity) => entity.type === 'timeScale',
                ).length,
        ),
    ).toBe(0)
    await click(page)
    expect(
        await page.evaluate(() =>
            [...window.editorTest.history.state.value.store.slides.note.values()]
                .flat()
                .filter((note) => note.beat === 4)
                .map((note) => note.noteStyle),
        ),
    ).toEqual(['red'])
    expect(
        await page.evaluate(
            () =>
                [...window.editorTest.store.getAllEntities()].filter(
                    (entity) => entity.type === 'stageTransformEventJoint',
                ).length,
        ),
    ).toBe(1)
    await page.evaluate(() => {
        window.editorTest.history.undoState()
        window.editorTest.history.undoState()
    })
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
})

// Pivots at lane 0 at beats 4 and 8, and a note across them at 4; selects those named by beat.
const showChain = (page: Page, selection: ('pivot:4' | 'pivot:8' | 'note')[]) =>
    page.evaluate((selection) => {
        const { fixtures, show, history, store } = window.editorTest
        const events = fixtures.events
        const pivot = { ...events.stagePivotEvents[0]!, pivotLane: 0 }
        show(
            {
                ...events,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                stageMaskEvents: [],
                stagePivotEvents: [
                    { ...pivot, beat: 4 },
                    { ...pivot, beat: 8 },
                ],
                stageStyleEvents: [],
                stageTransformEvents: [],
                timeScales: [],
                slides: [[{ ...fixtures.interaction.slides[0]![0]!, beat: 4, left: -1, size: 2 }]],
            },
            2,
        )
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter((entity) =>
                (selection as string[]).includes(
                    entity.type === 'stagePivotEventJoint' ? `pivot:${entity.beat}` : entity.type,
                ),
            ),
        })
    }, selection)

const chainState = (page: Page) =>
    page.evaluate(() => ({
        pivots: [...window.editorTest.store.getAllEntities()]
            .filter((entity) => entity.type === 'stagePivotEventJoint')
            .map((entity) => [entity.beat, entity.pivotLane]),
        notes: [...window.editorTest.history.state.value.store.slides.note.values()]
            .flat()
            .map((note) => [note.beat, note.left]),
    }))

test("with a joint selected, a press on a chain-mate's marker over a note takes the marker", async ({
    page,
}) => {
    await showChain(page, ['pivot:8'])
    const at = await point(page)
    const delta = await page.evaluate(
        () => window.editorTest.view.w / window.editorTest.settings.width,
    )
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + delta, at.y, { steps: 5 })
    await page.mouse.up()
    expect(await chainState(page)).toEqual({
        pivots: [
            [4, 1],
            [8, 0],
        ],
        notes: [[4, -1]],
    })
})

test('with a raised joint and the note over it selected, a press focuses the note', async ({
    page,
}) => {
    await showChain(page, ['pivot:4', 'note'])
    const focus = await page.evaluate(async () => {
        const { pointHitsAt, pressTarget } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools/utils')
        >('/src/editor/tools/utils.ts')
        const at = window.editorTest.point(0, 4)
        return pressTarget(pointHitsAt(at.x, at.y))?.type
    })
    expect(focus).toBe('note')
})

test("with a joint selected, the Eraser removes a chain-mate's marker over a note", async ({
    page,
}) => {
    await showChain(page, ['pivot:8'])
    await page.evaluate(async () => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo('eraser')
    })
    await click(page)
    expect(await chainState(page)).toEqual({ pivots: [[8, 0]], notes: [[4, -1]] })
})
