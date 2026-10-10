import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

for (const layout of ['basic', 'composed'] as const) {
    for (const tool of ['select', 'slide', 'note'] as const) {
        test(`${layout} ${tool}: an attached tick's move preview shows where it drops`, async ({
            page,
        }) => {
            for (const beats of [0, 1]) {
                await page.evaluate(
                    async ({ layout, tool }) => {
                        const { show, fixtures, view, appImport } = window.editorTest
                        const base = fixtures.interaction.slides[0]![0]!
                        const pivot = fixtures.events.stagePivotEvents[0]!
                        show(
                            {
                                ...fixtures.interaction,
                                isDynamicStages: layout === 'composed',
                                stagePivotEvents:
                                    layout === 'composed'
                                        ? [0, 8].map((beat) => ({
                                              ...pivot,
                                              beat,
                                              pivotLane: 0.2 + beat / 4,
                                              eventEase: 'linear' as const,
                                          }))
                                        : [],
                                slides: [
                                    [
                                        { ...base, beat: 2, left: -4, size: 2 },
                                        { ...base, beat: 4, left: 0, size: 2, isAttached: true },
                                        { ...base, beat: 6, left: 2, size: 2 },
                                    ],
                                ],
                            },
                            3,
                        )
                        view.layout = layout
                        const { switchToolTo } = await appImport<
                            typeof import('../../src/editor/tools')
                        >('/src/editor/tools/index.ts')
                        switchToolTo(tool)
                    },
                    { layout, tool },
                )
                // The tick's displayed place, in the scene the canvas draws.
                const shown = (ghost: boolean) =>
                    page.evaluate(async (ghost) => {
                        const { view, history, appImport } = window.editorTest
                        const { sceneState } = await appImport<
                            typeof import('../../src/editor/sceneState')
                        >('/src/editor/sceneState.ts')
                        const { createComposedLayout } =
                            await appImport<typeof import('../../src/editor/composed')>(
                                '/src/editor/composed.ts',
                            )
                        const layout = createComposedLayout(sceneState.value)
                        const notes = ghost
                            ? view.entities.creating
                            : [...history.state.value.store.slides.note.values()].flat()
                        return notes.flatMap((note) =>
                            note.type === 'note' && note.isAttached
                                ? [
                                      {
                                          beat: note.beat,
                                          left: layout?.notePosition(note).left ?? note.left,
                                      },
                                  ]
                                : [],
                        )
                    }, ghost)
                const [tick] = await shown(false)
                const { start, end, lane } = await page.evaluate(
                    ({ tick, beats }) => {
                        const { point, view, settings } = window.editorTest
                        return {
                            start: point(tick!.left + 1, tick!.beat),
                            end: point(tick!.left + 1, tick!.beat + beats),
                            lane: view.w / settings.width,
                        }
                    },
                    { tick, beats },
                )
                await page.mouse.move(start.x, start.y)
                await page.mouse.down()
                await page.mouse.move(start.x + lane * 1.4, end.y, { steps: 6 })
                const preview = await shown(true)
                await page.mouse.up()
                const dropped = await shown(false)
                expect(preview).toHaveLength(1)
                expect(preview[0]!.beat).toBe(dropped[0]!.beat)
                expect(preview[0]!.left).toBeCloseTo(dropped[0]!.left, 9)
                expect(dropped[0]!.beat).toBe(4 + beats)
            }
        })
    }
}

for (const layout of ['basic', 'composed'] as const) {
    for (const tool of ['select', 'slide', 'note'] as const) {
        test(`${layout} ${tool}: an attached tick's resize preview shows where it drops`, async ({
            page,
        }) => {
            await page.evaluate(
                async ({ layout, tool }) => {
                    const { show, fixtures, view, appImport } = window.editorTest
                    const base = fixtures.interaction.slides[0]![0]!
                    const pivot = fixtures.events.stagePivotEvents[0]!
                    show(
                        {
                            ...fixtures.interaction,
                            isDynamicStages: layout === 'composed',
                            stagePivotEvents:
                                layout === 'composed'
                                    ? [0, 8].map((beat) => ({
                                          ...pivot,
                                          beat,
                                          pivotLane: 0.2 + beat / 4,
                                          eventEase: 'linear' as const,
                                      }))
                                    : [],
                            slides: [
                                [
                                    { ...base, beat: 2, left: -4, size: 2 },
                                    { ...base, beat: 4, left: 0, size: 2, isAttached: true },
                                    { ...base, beat: 6, left: 2, size: 2 },
                                ],
                            ],
                        },
                        3,
                    )
                    view.layout = layout
                    const { switchToolTo } = await appImport<
                        typeof import('../../src/editor/tools')
                    >('/src/editor/tools/index.ts')
                    switchToolTo(tool)
                },
                { layout, tool },
            )
            // The tick's displayed place and width, in the scene the canvas draws.
            const shown = (ghost: boolean) =>
                page.evaluate(async (ghost) => {
                    const { view, history, appImport } = window.editorTest
                    const { sceneState } = await appImport<
                        typeof import('../../src/editor/sceneState')
                    >('/src/editor/sceneState.ts')
                    const { createComposedLayout } =
                        await appImport<typeof import('../../src/editor/composed')>(
                            '/src/editor/composed.ts',
                        )
                    const layout = createComposedLayout(sceneState.value)
                    const notes = ghost
                        ? view.entities.creating
                        : [...history.state.value.store.slides.note.values()].flat()
                    return notes.flatMap((note) =>
                        note.type === 'note' && note.isAttached
                            ? [layout?.notePosition(note) ?? { left: note.left, size: note.size }]
                            : [],
                    )
                }, ghost)
            const [tick] = await shown(false)
            // Its right edge, away from the diamond at its centre.
            const { start, lane } = await page.evaluate((tick) => {
                const { point, view, settings } = window.editorTest
                return {
                    start: point(tick!.left + tick!.size - 0.2, 4),
                    lane: view.w / settings.width,
                }
            }, tick)
            await page.mouse.move(start.x, start.y)
            await expect(page.locator('.editor-chart').locator('..')).toHaveCSS(
                'cursor',
                'ew-resize',
            )
            await page.mouse.down()
            await page.mouse.move(start.x + lane * 1.4, start.y, { steps: 6 })
            const preview = await shown(true)
            await page.mouse.up()
            const dropped = await shown(false)
            expect(preview).toHaveLength(1)
            expect(preview[0]!.left).toBeCloseTo(dropped[0]!.left, 9)
            expect(preview[0]!.size).toBeCloseTo(dropped[0]!.size, 9)
        })
    }
}
