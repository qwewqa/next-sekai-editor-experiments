import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// With the Slide preset Attached on, the Elevation Editor's add ghost shows where the note lands.
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
type Point = { beat: number; stage: 1 | 2; left: number; size: number; elevation: number }

// Stage 1 translates 0 to 8 over beats 0 to 8; stage 2 sits at pivot 4.5, raised 0.5.
const setup = (page: Page, layout: Layout, slide: Point[]) =>
    page.evaluate(
        async ({ layout, slide }) => {
            const { fixtures, show, view, settings, history, appImport, nextTick } =
                window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const pivot = fixtures.events.stagePivotEvents[0]!
            const stage1 = base.stageId
            const stage2 = 2 as typeof base.stageId
            const transform = {
                rotation: 0,
                yTranslation: 0,
                elevation: 0,
                anchor: 'default' as const,
                eventEase: 'linear' as const,
            }
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    stagePivotEvents: [
                        { ...pivot, stageId: stage1, beat: 0, pivotLane: 0 },
                        { ...pivot, stageId: stage2, beat: 0, pivotLane: 4.5 },
                    ],
                    stageTransformEvents: [
                        { ...transform, stageId: stage1, beat: 0, xTranslation: 0 },
                        { ...transform, stageId: stage1, beat: 8, xTranslation: 8 },
                        {
                            ...transform,
                            stageId: stage2,
                            beat: 0,
                            xTranslation: 0,
                            elevation: 0.5,
                        },
                    ],
                    slides: [
                        slide.map(({ stage, ...point }) => ({
                            ...base,
                            ...point,
                            stageId: stage === 1 ? stage1 : stage2,
                            connectorEase: 'outQuad' as const,
                        })),
                    ],
                },
                1.5,
            )
            view.layout = layout
            settings.width = 28
            settings.maxScrollX = 0
            settings.elevationEditorSideBySide = 'allow'
            settings.defaultSlidePropertiesPresets = settings.defaultSlidePropertiesPresets.map(
                (preset, i) =>
                    i === 0 ? { ...preset, isAttached: true, copyProperties: true } : preset,
            )
            const [head] = [...history.state.value.store.slides.note.values()].flat()
            history.replaceState({ ...history.state.value, selectedEntities: [head!] })
            const { openElevationEditor } = await appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            openElevationEditor(3)
            await nextTick()
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo('slide')
        },
        { layout, slide },
    )

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

const row = ({ lane, size, elevation, attached }: Record<string, unknown>) =>
    [lane, size, elevation, attached]
        .map((value) => (typeof value === 'number' ? value.toFixed(9) : value))
        .join(' ')

/** The Elevation Editor's ghost row, and where the chart draws the shared ghost note. */
const ghost = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, history, view } = window.editorTest
        const { getComposedLayout } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        // The rows the Elevation Editor draws, read from its dev-mode instance.
        const editor = (
            document.querySelector('.elevation-canvas') as unknown as {
                __vueParentComponent: {
                    setupState: {
                        creating: import('../../src/editor/elevation/layout').ElevationNote[]
                    }
                }
            }
        ).__vueParentComponent
        const [row] = editor.setupState.creating
        const [note] = view.entities.creating
        if (!row || note?.type !== 'note') return
        const { left, size } = getComposedLayout(history.state.value)?.notePosition(note) ?? note
        return { row: { ...row, note: undefined }, chart: { left, size } }
    })

/** The added note's row and its chart position. */
const landed = (page: Page, count: number) =>
    page.evaluate(async (count) => {
        const { appImport, history } = window.editorTest
        const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
            '/src/editor/elevation/scene.ts',
        )
        const { getComposedLayout } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        const notes = [...history.state.value.store.slides.note.values()].flat()
        if (notes.length !== count) return
        const note = notes.find((note) => note.isAttached)!
        const row = scene.elevationNotes.value.find((row) => row.note === note)!
        const { left, size } = getComposedLayout(history.state.value)?.notePosition(note) ?? note
        return { row: { ...row, note: undefined }, chart: { left, size } }
    }, count)

const expectSame = (
    a: NonNullable<Awaited<ReturnType<typeof ghost>>>,
    b: NonNullable<Awaited<ReturnType<typeof landed>>>,
) => {
    expect(row(a.row)).toBe(row(b.row))
    expect(a.chart.left).toBeCloseTo(b.chart.left, 9)
    expect(a.chart.size).toBeCloseTo(b.chart.size, 9)
}

// Head on stage 1 at beat 2, tail on stage 2 at beat 6: the tick lands on their path.
const across: Point[] = [
    { beat: 2, stage: 1, left: -4, size: 2, elevation: 1 },
    { beat: 6, stage: 2, left: 2, size: 3, elevation: 3 },
]

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: the attached add ghost in the Elevation Editor shows where the note lands`, async ({
        page,
    }) => {
        await setup(page, layout, across)
        const target = await at(page, -9, 0)
        await page.mouse.move(target.x - 2, target.y)
        await page.mouse.move(target.x, target.y)
        await expect.poll(() => ghost(page)).toBeDefined()
        const shown = (await ghost(page))!
        // On the path, not at the pointer.
        expect(shown.row.attached).toBe(true)
        expect(shown.row.lane).toBeGreaterThan(-6)
        expect(shown.row.elevation).toBeGreaterThan(1)
        await page.mouse.click(target.x, target.y)
        await expect.poll(() => landed(page, 3)).toBeDefined()
        expectSame(shown, (await landed(page, 3))!)
    })

    test(`${layout}: the attached drag-add ghost in the Elevation Editor shows where the note lands`, async ({
        page,
    }) => {
        await setup(page, layout, across)
        const start = await at(page, -9, 0)
        const end = await at(page, -12, 0.5)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(end.x, end.y, { steps: 4 })
        await expect.poll(() => ghost(page)).toBeDefined()
        const shown = (await ghost(page))!
        expect(shown.row.attached).toBe(true)
        await page.mouse.up()
        await expect.poll(() => landed(page, 3)).toBeDefined()
        expectSame(shown, (await landed(page, 3))!)
    })

    test(`${layout}: an attached add at a same-beat slide's beat shows where it lands`, async ({
        page,
    }) => {
        // Head and tail both at beat 3, on different stages: the added note ends the slide.
        await setup(page, layout, [
            { beat: 3, stage: 1, left: -4, size: 2, elevation: 0 },
            { beat: 3, stage: 2, left: 2, size: 3, elevation: 2 },
        ])
        const target = await at(page, -9, 1)
        await page.mouse.move(target.x - 2, target.y)
        await page.mouse.move(target.x, target.y)
        await expect.poll(() => ghost(page)).toBeDefined()
        const shown = (await ghost(page))!
        await page.mouse.click(target.x, target.y)
        await expect.poll(() => landed(page, 3)).toBeDefined()
        expectSame(shown, (await landed(page, 3))!)
    })
}
