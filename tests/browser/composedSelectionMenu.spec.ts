import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The Open Context Menu command opens at the selected note where it is drawn, so its
// Paste lands on the note in both layouts.
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

type Layout = 'basic' | 'composed'

// Stage 1 translates 0 to 8 over beats 0 to 8; stage 2 sits at pivot 4.5. Note A is drawn
// at lane 4 in Composed; slide S's tick at beat 4 is drawn at lane 1.25.
const setup = (page: Page, layout: Layout) =>
    page.evaluate((layout) => {
        const { fixtures, show, view, settings } = window.editorTest
        const chart = fixtures.interaction
        const base = chart.slides[0]![0]!
        const [stageA, stageB] = [...fixtures.events.stages.keys()]
        const pivot = fixtures.events.stagePivotEvents[0]!
        const transform = fixtures.events.stageTransformEvents[0]!
        show(
            {
                ...fixtures.events,
                bpms: chart.bpms,
                cameraEvents: [],
                stageMaskEvents: [],
                stageStyleEvents: [],
                timeScales: [],
                stagePivotEvents: [
                    { ...pivot, stageId: stageA!, beat: 0, pivotLane: 0, eventEase: 'linear' },
                    { ...pivot, stageId: stageB!, beat: 0, pivotLane: 4.5, eventEase: 'linear' },
                ],
                stageTransformEvents: [
                    {
                        ...transform,
                        stageId: stageA!,
                        beat: 0,
                        xTranslation: 0,
                        eventEase: 'linear',
                    },
                    {
                        ...transform,
                        stageId: stageA!,
                        beat: 8,
                        xTranslation: 8,
                        eventEase: 'linear',
                    },
                ],
                slides: [
                    [{ ...base, stageId: stageA!, beat: 4, left: -1, size: 2 }],
                    [
                        { ...base, stageId: stageA!, beat: 2, left: -4, size: 2 },
                        {
                            ...base,
                            stageId: stageA!,
                            beat: 4,
                            left: -4,
                            size: 2,
                            isAttached: true,
                        },
                        { ...base, stageId: stageB!, beat: 6, left: -4, size: 2 },
                    ],
                ],
            },
            2,
        )
        view.layout = layout
        settings.keyboardShortcuts = { ...settings.keyboardShortcuts, openContextMenu: 'F9' }
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        Object.defineProperty(navigator.clipboard, 'readText', {
            configurable: true,
            value: async () => {
                throw new DOMException('Clipboard denied', 'NotAllowedError')
            },
        })
    }, layout)

const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(([lane, beat]) => window.editorTest.point(lane!, beat!), [lane, beat])

const menu = (page: Page) => page.getByRole('menu')

// The menu opens at its point unless a screen edge pushes it in.
const expectMenuAt = async (page: Page, x: number) => {
    await expect(menu(page)).toBeVisible()
    const box = await menu(page).boundingBox()
    expect(box!.x).toBeCloseTo(x, 0)
}

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: Open Context Menu opens at the selected note and pastes onto it`, async ({
        page,
    }) => {
        await setup(page, layout)
        const drawn = layout === 'composed' ? 4 : 0
        const target = await point(page, drawn, 4)
        await page.keyboard.press('f')
        await page.mouse.click(target.x, target.y)
        await expect
            .poll(() => page.evaluate(() => window.editorTest.snapshot().selected))
            .toEqual([{ type: 'note', beat: 4, left: -1, size: 2 }])
        await page.keyboard.press('c')
        await page.keyboard.press('F9')
        await expectMenuAt(page, target.x)
        await menu(page).getByRole('menuitem', { name: 'Paste', exact: true }).click()
        await expect(menu(page)).toHaveCount(0)
        await expect
            .poll(() => page.evaluate(() => window.editorTest.snapshot().notes.length))
            .toBe(5)
        expect(await page.evaluate(() => window.editorTest.snapshot().selected)).toEqual([
            { type: 'note', beat: 4, left: -1, size: 2 },
        ])
    })

    test(`${layout}: Open Context Menu opens at a selected attached tick where it is drawn`, async ({
        page,
    }) => {
        await setup(page, layout)
        // Basic draws the tick at its stored lane.
        const drawn = layout === 'composed' ? 1.25 : -3
        const target = await point(page, drawn, 4)
        await page.keyboard.press('f')
        await page.mouse.click(target.x, target.y)
        await expect
            .poll(() =>
                page.evaluate(() =>
                    window.editorTest.history.state.value.selectedEntities.map(
                        (entity) => entity.type === 'note' && entity.isAttached,
                    ),
                ),
            )
            .toEqual([true])
        await page.keyboard.press('F9')
        await expectMenuAt(page, target.x)
        await page.keyboard.press('Escape')
        await expect(menu(page)).toHaveCount(0)
    })
}

// Real levels from the engine's resource cache: SEKAI_LEVELS=<...>/resources/levels.
const levels = process.env.SEKAI_LEVELS
for (const id of ['16471', '21888']) {
    for (const layout of ['basic', 'composed'] as const) {
        test(`${layout}: level ${id} pastes onto a note on an offset stage`, async ({ page }) => {
            const file = levels && join(levels, `coconut-next-sekai-${id}`, 'data')
            test.skip(!file || !existsSync(file), 'Set SEKAI_LEVELS to the engine level cache')
            const data = JSON.parse(gunzipSync(readFileSync(file!)).toString()) as {
                entities: unknown[]
            }
            const picked = await page.evaluate(
                async ({ data, layout }) => {
                    const { appImport, show, view, history, settings } = window.editorTest
                    const { parseLevelDataChart } = await appImport<
                        typeof import('../../src/chart/parse/levelData')
                    >('/src/chart/parse/levelData/index.ts')
                    const { createComposedLayout } =
                        await appImport<typeof import('../../src/editor/composed')>(
                            '/src/editor/composed.ts',
                        )
                    const { beatToTime } = await appImport<
                        typeof import('../../src/state/integrals/bpms')
                    >('/src/state/integrals/bpms.ts')
                    show(
                        parseLevelDataChart(
                            data.entities as Parameters<typeof parseLevelDataChart>[0],
                        ),
                    )
                    const source = history.state.value
                    const composed = createComposedLayout(source)
                    const notes = [...source.store.slides.note.values()].flat()
                    // Composed paste snaps the note to its stage's lattice, so take one on it.
                    const onLattice = (note: (typeof notes)[number]) => {
                        const lane =
                            (note.left - composed.gridOffset(note.stageId, note.beat)) *
                            view.laneDivision
                        return Math.abs(lane - Math.round(lane)) < 1e-9
                    }
                    // The first such note on a stage drawn over a lane from its authored place.
                    const note = notes
                        .filter((note) => !note.isAttached && onLattice(note))
                        .sort((a, b) => a.beat - b.beat)
                        .find((note) => Math.abs(composed.offset(note.stageId, note.beat)) > 1)!
                    const offset = composed.offset(note.stageId, note.beat)
                    view.layout = layout
                    view.time = beatToTime(source.bpms, note.beat)
                    view.lane = note.left + note.size / 2 + (layout === 'composed' ? offset : 0)
                    history.replaceState({ ...source, selectedEntities: [note] })
                    settings.keyboardShortcuts = {
                        ...settings.keyboardShortcuts,
                        openContextMenu: 'F9',
                    }
                    Object.defineProperty(navigator.clipboard, 'writeText', {
                        configurable: true,
                        value: async () => undefined,
                    })
                    Object.defineProperty(navigator.clipboard, 'readText', {
                        configurable: true,
                        value: async () => {
                            throw new DOMException('Clipboard denied', 'NotAllowedError')
                        },
                    })
                    return {
                        beat: note.beat,
                        left: note.left,
                        size: note.size,
                        offset,
                        count: notes.length,
                        x: view.x + view.w / 2,
                    }
                },
                { data, layout },
            )
            expect(Math.abs(picked.offset)).toBeGreaterThan(1)
            await page.keyboard.press('c')
            await page.keyboard.press('F9')
            await expectMenuAt(page, picked.x)
            await menu(page).getByRole('menuitem', { name: 'Paste', exact: true }).click()
            await expect
                .poll(() => page.evaluate(() => window.editorTest.snapshot().notes.length))
                .toBe(picked.count + 1)
            await expect
                .poll(() => page.evaluate(() => window.editorTest.snapshot().selected))
                .toEqual([
                    { type: 'note', beat: picked.beat, left: picked.left, size: picked.size },
                ])
        })
    }
}
