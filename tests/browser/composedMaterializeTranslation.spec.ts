import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Split Slide, Combine into Slide and Make Vertical detach a tick of a slide across translated
// stages where gameplay draws it, in both layouts.
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

// Stage 1 translates 0 to 8 over beats 0 to 8; stage 2 sits at pivot 4.5. Slide S's tick at
// beat 4 is drawn at lane 1.25 in Composed; detached on stage 1, it is stored at left -3.75.
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
                    [{ ...base, stageId: stageB!, beat: 5, left: 1, size: 2 }],
                ],
            },
            2,
        )
        view.layout = layout
        settings.mouseSecondaryTool = 'selectContextMenu'
    }, layout)

// Where each layout draws the notes' centres.
const lanes = {
    basic: { head: -3, tick: -3, other: 2 },
    composed: { head: -1, tick: 1.25, other: 6.5 },
}

const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(([lane, beat]) => window.editorTest.point(lane!, beat!), [lane, beat])

const click = async (page: Page, lane: number, beat: number, modifiers: string[] = []) => {
    const target = await point(page, lane, beat)
    for (const key of modifiers) await page.keyboard.down(key)
    await page.mouse.click(target.x, target.y)
    for (const key of modifiers) await page.keyboard.up(key)
}

const menuCommand = async (page: Page, lane: number, beat: number, name: string) => {
    const target = await point(page, lane, beat)
    await page.mouse.click(target.x, target.y, { button: 'right' })
    await page.getByRole('menu').getByRole('menuitem', { name, exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
}

const notes = (page: Page) =>
    page.evaluate(() =>
        [...window.editorTest.history.state.value.store.slides.note.values()]
            .flat()
            .map((note) => ({
                beat: note.beat,
                left: note.left,
                size: note.size,
                elevation: note.elevation ?? 0,
                attached: note.isAttached,
            }))
            .sort((a, b) => a.beat - b.beat || a.elevation - b.elevation),
    )

// The Composed lane of the note at the beat, whichever layout is shown.
const drawn = (page: Page, beat: number) =>
    page.evaluate(async (beat) => {
        const { appImport, history } = window.editorTest
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const source = history.state.value
        const note = [...source.store.slides.note.values()]
            .flat()
            .find((note) => note.beat === beat)!
        const { left, size } = createComposedLayout(source).notePosition(note)
        return left + size / 2
    }, beat)

const selectTool = async (page: Page) => {
    await page.keyboard.press('f')
    await page.mouse.move(10, 10)
}

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: Split Slide detaches a cross-stage tick where it is drawn`, async ({
        page,
    }) => {
        await setup(page, layout)
        expect(await drawn(page, 4)).toBe(1.25)
        await selectTool(page)
        await menuCommand(page, lanes[layout].tick, 4, 'Split Slide')
        await expect
            .poll(async () => (await notes(page)).find((note) => note.beat === 4))
            .toEqual({ beat: 4, left: -3.75, size: 2, elevation: 0, attached: false })
        expect(await drawn(page, 4)).toBe(1.25)
        await page.keyboard.press('z')
        await expect
            .poll(async () => (await notes(page)).find((note) => note.beat === 4)?.attached)
            .toBe(true)
    })

    test(`${layout}: Combine into Slide keeps a cross-stage tick where it is drawn`, async ({
        page,
    }) => {
        await setup(page, layout)
        await selectTool(page)
        await click(page, lanes[layout].tick, 4)
        await click(page, lanes[layout].other, 5, ['Control'])
        await expect
            .poll(() => page.evaluate(() => window.editorTest.snapshot().selected.length))
            .toBe(2)
        await page.keyboard.press('k')
        await expect
            .poll(() =>
                page.evaluate(() => window.editorTest.history.state.value.store.slides.note.size),
            )
            .toBe(1)
        expect((await notes(page)).find((note) => note.beat === 4)).toEqual({
            beat: 4,
            left: -3.75,
            size: 2,
            elevation: 0,
            attached: false,
        })
        expect(await drawn(page, 4)).toBe(1.25)
    })

    test(`${layout}: Make Vertical materializes a cross-stage tick at its gameplay lane`, async ({
        page,
    }) => {
        await setup(page, layout)
        await selectTool(page)
        await click(page, lanes[layout].head, 2)
        await click(page, lanes[layout].tick, 4, ['Control'])
        await expect
            .poll(() => page.evaluate(() => window.editorTest.snapshot().selected.length))
            .toBe(2)
        await menuCommand(page, lanes[layout].tick, 4, 'Make Vertical')
        await expect
            .poll(async () => (await notes(page)).find((note) => note.elevation === 2))
            .toEqual({ beat: 2, left: -3.75, size: 2, elevation: 2, attached: false })
    })
}
