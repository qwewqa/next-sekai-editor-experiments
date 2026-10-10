import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// With the Slide preset Attached on, the add ghost is drawn where the tick lands on the path.
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

// Stage 1 translates 0 to 8 over beats 0 to 8; stage 2 sits at pivot 4.5. Slide S runs from
// stage 1 at beat 2 to stage 2 at beat 6 with an Out Quad connector.
const setup = (page: Page, layout: Layout, isAttached: boolean) =>
    page.evaluate(
        ({ layout, isAttached }) => {
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
                        {
                            ...pivot,
                            stageId: stageB!,
                            beat: 0,
                            pivotLane: 4.5,
                            eventEase: 'linear',
                        },
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
                            {
                                ...base,
                                stageId: stageA!,
                                beat: 2,
                                left: -4,
                                size: 2,
                                connectorEase: 'outQuad',
                            },
                            { ...base, stageId: stageB!, beat: 6, left: -4, size: 3 },
                        ],
                    ],
                },
                2,
            )
            view.layout = layout
            settings.defaultSlidePropertiesPresets = settings.defaultSlidePropertiesPresets.map(
                (preset, i) => (i === 0 ? { ...preset, isAttached, copyProperties: true } : preset),
            )
        },
        { layout, isAttached },
    )

const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(([lane, beat]) => window.editorTest.point(lane!, beat!), [lane, beat])

/** Where the layout draws the add ghost, and where it draws the note at the beat. */
const drawn = (page: Page, beat: number) =>
    page.evaluate(async (beat) => {
        const { appImport, history, view } = window.editorTest
        const { getComposedLayout } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        const source = history.state.value
        const layout = getComposedLayout(source)
        const at = (note: (typeof view.entities.creating)[number] | undefined) => {
            if (note?.type !== 'note') return
            const { left, size } = layout?.notePosition(note) ?? note
            return { left, size }
        }
        return {
            ghost: at(view.entities.creating[0]),
            note: at(
                [...source.store.slides.note.values()].flat().find((note) => note.beat === beat),
            ),
        }
    }, beat)

const heads = { basic: -3, composed: -1 }

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: the attached add ghost shows where the tick lands`, async ({ page }) => {
        await setup(page, layout, true)
        await page.keyboard.press('f')
        const head = await point(page, heads[layout], 2)
        await page.mouse.click(head.x, head.y)
        await page.keyboard.press('s')
        // Away from the path, which runs right of lane -3 at beat 3.
        const target = await point(page, -6, 3)
        await page.mouse.move(target.x, target.y)
        await expect.poll(async () => (await drawn(page, 3)).ghost).toBeDefined()
        const { ghost } = await drawn(page, 3)
        await page.mouse.click(target.x, target.y)
        await expect.poll(async () => (await drawn(page, 3)).note).toBeDefined()
        const { note } = await drawn(page, 3)
        expect(ghost!.left).toBeCloseTo(note!.left, 9)
        expect(ghost!.size).toBeCloseTo(note!.size, 9)
        // The tick is on the path, not at the pointer.
        expect(note!.left + note!.size / 2).toBeGreaterThan(-5)
    })

    test(`${layout}: a free add ghost stays at the pointer`, async ({ page }) => {
        await setup(page, layout, false)
        await page.keyboard.press('f')
        const head = await point(page, heads[layout], 2)
        await page.mouse.click(head.x, head.y)
        await page.keyboard.press('s')
        const target = await point(page, -6, 3)
        await page.mouse.move(target.x, target.y)
        await expect.poll(async () => (await drawn(page, 3)).ghost).toBeDefined()
        const { ghost } = await drawn(page, 3)
        expect(ghost!.left).toBe(-6)
        await page.mouse.click(target.x, target.y)
        await expect.poll(async () => (await drawn(page, 3)).note).toEqual(ghost)
    })
}
