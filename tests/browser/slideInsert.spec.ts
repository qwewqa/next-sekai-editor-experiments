import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// A Slide add at the one selected note's beat goes right after it in its slide, in both editors.

const errors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

type Note = { beat?: number; left: number; elevation?: number }

/**
 * One slide of four-lane notes in Basic, at beat 3 unless given, with those at these store
 * indexes selected, and the Slide tool; the Elevation Editor open at beat 3 if asked.
 */
const seed = (page: Page, notes: Note[], selected: number[], editor = true) =>
    page.evaluate(
        async ({ notes, selected, editor }) => {
            const { fixtures, show, settings, view, history, appImport, nextTick } =
                window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    slides: [
                        notes.map((note) => ({
                            ...base,
                            beat: 3,
                            size: 4,
                            elevation: 0,
                            noteType: 'forceNonTick' as const,
                            ...note,
                        })),
                    ],
                },
                3,
            )
            view.layout = 'basic'
            view.laneDivision = 1
            settings.showPreview = false
            settings.showSidebar = false
            settings.elevationSnap = 4 as never
            settings.elevationEditorSideBySide = 'disallow'
            const all = [...history.state.value.store.slides.note.values()].flat()
            history.replaceState({
                ...history.state.value,
                selectedEntities: selected.map((index) => all[index]!),
            })
            if (editor) {
                const { openElevationEditor } = await appImport<
                    typeof import('../../src/editor/elevation/state')
                >('/src/editor/elevation/state.ts')
                openElevationEditor(3)
            }
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo('slide')
            await nextTick()
        },
        { notes, selected, editor },
    )

/** A displayed lane and elevation in the Elevation Editor, in client pixels. */
const at = (page: Page, lane: number, elevation: number) =>
    page.evaluate(
        async ({ lane, elevation }) => {
            const scene = await window.editorTest.appImport<
                typeof import('../../src/editor/elevation/scene')
            >('/src/editor/elevation/scene.ts')
            const layout = scene.elevationLayout.value
            const box = document.querySelector('.elevation-canvas')!.getBoundingClientRect()
            return { x: box.x + layout.xAt(lane), y: box.y + layout.yAt(elevation) }
        },
        { lane, elevation },
    )

const tap = async (page: Page, point: { x: number; y: number }) => {
    await page.mouse.move(point.x - 3, point.y)
    await page.mouse.move(point.x, point.y)
    await settle(page)
    await page.mouse.down()
    await page.mouse.up()
    await settle(page)
}

/** The slide's notes in store order, as beat, left and elevation, and its pieces by note index. */
const slide = (page: Page) =>
    page.evaluate(() => {
        const { store } = window.editorTest.history.state.value
        const [id, notes] = [...store.slides.note][0]!
        return {
            notes: notes.map(({ beat, left, elevation }) => [beat, left, elevation]),
            pieces: (store.slides.connector.get(id) ?? []).map(({ head, tail }) => [
                notes.indexOf(head),
                notes.indexOf(tail),
            ]),
        }
    })

test('chained Elevation Editor inserts between two same-beat notes keep their order through undo, redo and level data', async ({
    page,
}) => {
    // A and B at beat 3, then C at beat 6; A selected.
    await seed(
        page,
        [
            { left: -6, elevation: 0 },
            { left: -6, elevation: 4 },
            { beat: 6, left: -6, elevation: 0 },
        ],
        [0],
    )
    await tap(page, await at(page, 4, 3))
    // The added note is selected, so the next goes right after it, out of elevation order.
    await tap(page, await at(page, 4, 1))
    const inserted = {
        notes: [
            [3, -6, 0],
            [3, 4, 3],
            [3, 4, 1],
            [3, -6, 4],
            [6, -6, 0],
        ],
        pieces: [
            [0, 1],
            [1, 2],
            [2, 3],
            [3, 4],
        ],
    }
    expect(await slide(page)).toEqual(inserted)
    // Saved and loaded, the order holds.
    expect(
        await page.evaluate(async () => {
            const { history, appImport } = window.editorTest
            const { serializeToLevelData } = await appImport<
                typeof import('../../src/levelData/serialize')
            >('/src/levelData/serialize.ts')
            const { parseLevelDataChart } = await appImport<
                typeof import('../../src/chart/parse/levelData')
            >('/src/chart/parse/levelData/index.ts')
            const { createState } =
                await appImport<typeof import('../../src/state')>('/src/state/index.ts')
            const s = history.state.value
            const data = serializeToLevelData(
                s.initialLife,
                s.isDynamicStages,
                s.bgm.offset,
                s.store,
                s.groups,
                s.stages,
            )
            const loaded = createState(parseLevelDataChart(data.entities), data.bgmOffset)
            return [...loaded.store.slides.note.values()].map((notes) =>
                notes.map(({ beat, left, elevation }) => [beat, left, elevation]),
            )
        }),
    ).toEqual([inserted.notes])
    await page.keyboard.press('Control+z')
    await settle(page)
    expect(await slide(page)).toEqual({
        notes: [
            [3, -6, 0],
            [3, 4, 3],
            [3, -6, 4],
            [6, -6, 0],
        ],
        pieces: [
            [0, 1],
            [1, 2],
            [2, 3],
        ],
    })
    await page.keyboard.press('Control+y')
    await settle(page)
    expect(await slide(page)).toEqual(inserted)
})

test('an Elevation Editor Slide add appends with more than one note selected, or one at another beat', async ({
    page,
}) => {
    const notes = [
        { left: -6, elevation: 0 },
        { left: -6, elevation: 4 },
        { beat: 6, left: -6, elevation: 0 },
    ]
    await seed(page, notes, [0, 1])
    await tap(page, await at(page, 4, 1))
    expect((await slide(page)).notes).toEqual([
        [3, -6, 0],
        [3, -6, 4],
        [3, 4, 1],
        [6, -6, 0],
    ])
    await seed(page, notes, [2])
    await tap(page, await at(page, 4, 1))
    expect((await slide(page)).notes).toEqual([
        [3, -6, 0],
        [3, -6, 4],
        [3, 4, 1],
        [6, -6, 0],
    ])
})

/** A pending Properties draft of the selected note: raised to an elevation, or gone. */
const draft = (page: Page, elevation?: number) =>
    page.evaluate(async (elevation) => {
        const { history, appImport } = window.editorTest
        const { setPreviewEdit } =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        const { createTransaction } = await appImport<typeof import('../../src/state/transaction')>(
            '/src/state/transaction.ts',
        )
        const { removeNote, replaceNote } = await appImport<
            typeof import('../../src/state/mutations/slides/note')
        >('/src/state/mutations/slides/note.ts')
        const source = history.state.value
        const [note] = source.selectedEntities
        if (note?.type !== 'note') throw new Error('No selected note')
        setPreviewEdit(
            source,
            () => {
                const transaction = createTransaction(source)
                return transaction.commit(
                    elevation === undefined
                        ? (removeNote(transaction, note), [])
                        : replaceNote(transaction, note, { ...note, elevation }),
                )
            },
            undefined,
            { isDraft: true },
        )
    }, elevation)

/** The Slide add ghost's new pieces, as head and tail elevations, or lefts. */
const ghostPieces = (page: Page, key: 'elevation' | 'left' = 'elevation') =>
    page.evaluate(async (key) => {
        const { view, appImport } = window.editorTest
        const { slideAddGhost } = await appImport<
            typeof import('../../src/editor/tools/slide/addPreview')
        >('/src/editor/tools/slide/addPreview.ts')
        return (
            slideAddGhost(view.entities.creating)?.connectors.map(({ head, tail }) => [
                head[key],
                tail[key],
            ]) ?? []
        )
    }, key)

test('an Elevation Editor Slide add under a pending draft goes right after the note as drafted, or appends if the draft drops it', async ({
    page,
}) => {
    const notes = [
        { left: -6, elevation: 0 },
        { left: -6, elevation: 4 },
    ]
    await seed(page, notes, [0])
    await draft(page, 2)
    const target = await at(page, 4, 1)
    await page.mouse.move(target.x - 3, target.y)
    await page.mouse.move(target.x, target.y)
    await settle(page)
    expect(await ghostPieces(page)).toEqual([
        [2, 1],
        [1, 4],
    ])
    await seed(page, notes, [0])
    await draft(page)
    await page.mouse.move(target.x - 3, target.y)
    await page.mouse.move(target.x, target.y)
    await settle(page)
    expect(await ghostPieces(page)).toEqual([[4, 1]])
})

test('an Elevation Editor Slide add under a Properties draft lands as its ghost: committed, right after the drafted note', async ({
    page,
}) => {
    await seed(
        page,
        [
            { left: -6, elevation: 0 },
            { left: -6, elevation: 4 },
        ],
        [0],
    )
    await page.evaluate(() => (window.editorTest.settings.showSidebar = true))
    await page
        .locator('#workspace-panel-properties #properties-section-selection label')
        .filter({ has: page.getByText('Elevation', { exact: true }) })
        .locator('input')
        .fill('2')
    const target = await at(page, 4, 1)
    await page.mouse.move(target.x - 3, target.y)
    await page.mouse.move(target.x, target.y)
    await settle(page)
    const ghost = await page.evaluate(async () => {
        const { view, appImport } = window.editorTest
        const { previewEdit } =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        const { slideAddGhost } = await appImport<
            typeof import('../../src/editor/tools/slide/addPreview')
        >('/src/editor/tools/slide/addPreview.ts')
        const preview = slideAddGhost(view.entities.creating)
        const notes = preview?.result.store.slides.note.get(preview.landed.slideId) ?? []
        return {
            draft: !!previewEdit.value?.isDraft,
            notes: notes.map(({ beat, left, elevation }) => [beat, left, elevation]),
        }
    })
    expect(ghost).toEqual({
        draft: true,
        notes: [
            [3, -6, 2],
            [3, 4, 1],
            [3, -6, 4],
        ],
    })
    // The press commits the draft, then adds.
    await page.mouse.down()
    await page.mouse.up()
    await settle(page)
    expect((await slide(page)).notes).toEqual(ghost.notes)
    await page.keyboard.press('Control+z')
    await settle(page)
    expect((await slide(page)).notes).toEqual([
        [3, -6, 2],
        [3, -6, 4],
    ])
})

test('a chart Slide add goes right after the selected note only at its beat, taking its beat exactly', async ({
    page,
}) => {
    // A and B at beat 2, C at beat 6; A selected.
    const notes = [
        { beat: 2, left: -6 },
        { beat: 2, left: 2 },
        { beat: 6, left: -6 },
    ]
    await seed(page, notes, [0], false)
    const chartPoint = (lane: number, beat: number) =>
        page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })
    // At another beat, beat order places it.
    await tap(page, await chartPoint(4, 4))
    expect((await slide(page)).notes).toEqual([
        [2, -6, 0],
        [2, 2, 0],
        [4, 4, 0],
        [6, -6, 0],
    ])
    // Off the grid by less than the same-beat tolerance.
    await seed(
        page,
        [
            { beat: 2 + 1e-9, left: -6 },
            { beat: 2 + 2e-9, left: 2 },
            { beat: 6, left: -6 },
        ],
        [0],
        false,
    )
    const target = await chartPoint(-1, 2)
    await page.mouse.move(target.x - 3, target.y)
    await page.mouse.move(target.x, target.y)
    await settle(page)
    expect(await ghostPieces(page, 'left')).toEqual([
        [-6, -1],
        [-1, 2],
    ])
    await page.mouse.down()
    await page.mouse.up()
    await settle(page)
    expect((await slide(page)).notes).toEqual([
        [2 + 1e-9, -6, 0],
        [2 + 1e-9, -1, 0],
        [2 + 2e-9, 2, 0],
        [6, -6, 0],
    ])
})

test('a resting Slide hover follows a new anchor at the same placement', async ({ page }) => {
    await seed(
        page,
        [
            { left: -6, elevation: 0 },
            { left: -6, elevation: 4 },
        ],
        [0],
    )
    const target = await at(page, 4, 1)
    await page.mouse.move(target.x - 3, target.y)
    await page.mouse.move(target.x, target.y)
    await settle(page)
    expect(await ghostPieces(page)).toEqual([
        [0, 1],
        [1, 4],
    ])
    await page.evaluate(() => {
        const { history } = window.editorTest
        const [, b] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [b!] })
    })
    await settle(page)
    expect(await ghostPieces(page)).toEqual([[4, 1]])
})

test("a chart Slide insert takes the selected note's properties, not the first at its beat", async ({
    page,
}) => {
    await seed(
        page,
        [
            { beat: 2, left: -6, elevation: 0 },
            { beat: 2, left: 2, elevation: 3 },
        ],
        [1],
        false,
    )
    await tap(page, await page.evaluate(() => window.editorTest.point(-1, 2)))
    expect((await slide(page)).notes).toEqual([
        [2, -6, 0],
        [2, 2, 3],
        [2, -1, 3],
    ])
})

test("an Elevation Editor insert takes the selected note's beat exactly", async ({ page }) => {
    // Off the editor's beat by less than the same-beat tolerance.
    await seed(
        page,
        [
            { beat: 3 + 1e-9, left: -6, elevation: 0 },
            { beat: 3 + 2e-9, left: -6, elevation: 4 },
        ],
        [0],
    )
    await tap(page, await at(page, 4, 1))
    expect((await slide(page)).notes).toEqual([
        [3 + 1e-9, -6, 0],
        [3 + 1e-9, 4, 1],
        [3 + 2e-9, -6, 4],
    ])
})

test('the shared Slide add preview is keyed by the anchor', async ({ page }) => {
    await seed(
        page,
        [
            { left: -6, elevation: 0 },
            { left: -6, elevation: 4 },
        ],
        [],
        false,
    )
    expect(
        await page.evaluate(async () => {
            const { history, appImport } = window.editorTest
            const { previewSlideAdd } = await appImport<
                typeof import('../../src/editor/tools/slide/addPreview')
            >('/src/editor/tools/slide/addPreview.ts')
            const source = history.state.value
            const [a, b] = [...source.store.slides.note.values()][0]!
            const object = { ...a!, elevation: 1 }
            const order = (after: typeof a) =>
                previewSlideAdd(source, a!.slideId, object, after)!
                    .result.store.slides.note.get(a!.slideId)!
                    .map((note) => note.elevation)
            return [order(a), order(b), order(a)]
        }),
    ).toEqual([
        [0, 1, 4],
        [0, 4, 1],
        [0, 1, 4],
    ])
})
