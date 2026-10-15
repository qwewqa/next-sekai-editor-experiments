import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        attachedPreviewNames: string[]
        attachedPreviewTrustedMoves: number
    }
}

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
    test(`${layout}: attached-slide previews preserve scoped names and decluttering through drop, undo and cancel`, async ({
        page,
    }) => {
        await page.evaluate(async (layout) => {
            const { fixtures, show, settings, view, appImport } = window.editorTest
            const { WebGLDrawContext } = window.editorRendering
            window.attachedPreviewNames = []
            window.attachedPreviewTrustedMoves = 0
            document.addEventListener('pointermove', (event) => {
                if (event.isTrusted) window.attachedPreviewTrustedMoves++
            })
            const isChart = (canvas: object) =>
                canvas instanceof HTMLCanvasElement && canvas.classList.contains('editor-chart')
            const record = (canvas: object, text: string | undefined) => {
                if (isChart(canvas) && text && ['MG', 'MS', 'RG', 'RS'].includes(text))
                    window.attachedPreviewNames.push(text)
            }
            const proto = WebGLDrawContext.prototype
            const { clear, drawNameSprite, drawEditorLabel } = proto
            proto.clear = function () {
                if (isChart(this.canvas)) window.attachedPreviewNames = []
                return clear.call(this)
            }
            proto.drawNameSprite = function (source, x, y) {
                record(this.canvas, window.editorLabels.get(source)?.text)
                return drawNameSprite.call(this, source, x, y)
            }
            proto.drawEditorLabel = function (text, ...args) {
                record(this.canvas, text)
                return drawEditorLabel.call(this, text, ...args)
            }
            const note = fixtures.interaction.slides[0]![0]!
            const groupId = 2 as typeof note.groupId
            const otherGroupId = 3 as typeof note.groupId
            const stageId = 1 as typeof note.stageId
            const otherStageId = 2 as typeof note.stageId
            const stage = fixtures.interaction.stages.get(stageId)!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    groups: new Map([
                        [note.groupId, { name: 'Default' }],
                        [groupId, { name: 'MG' }],
                        [otherGroupId, { name: 'RG' }],
                    ]),
                    stages: new Map([
                        [stageId, { ...stage, name: 'MS' }],
                        [otherStageId, { ...stage, name: 'RS' }],
                    ]),
                    slides: [
                        [
                            { ...note, groupId, beat: 2, left: -4 },
                            { ...note, groupId, beat: 4, left: 0, isAttached: true },
                            { ...note, groupId, beat: 6, left: 2 },
                        ],
                        // Unchanged overlapping slides exercise retained connectors and
                        // ordinary name decluttering while the selected slide stays live.
                        ...[0, 1].map(() =>
                            [3, 5].map((beat) => ({
                                ...note,
                                groupId: otherGroupId,
                                stageId: otherStageId,
                                beat,
                                left: -7,
                            })),
                        ),
                    ],
                },
                2,
            )
            view.layout = layout
            view.groupId = groupId
            view.stageId = stageId
            settings.nameContrast = false
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo('select')
        }, layout)

        const configureNames = async (hideGroup: boolean, hideStage: boolean) => {
            await page.evaluate(
                async ({ hideGroup, hideStage }) => {
                    const { settings, view, nextTick } = window.editorTest
                    settings.hideGroupNameWhenFocusingGroup = hideGroup
                    settings.hideStageNameWhenFocusingStage = hideStage
                    // Keep the ordinary, unselected names visible during these semantic checks.
                    view.lastActive = Infinity
                    await nextTick()
                    await new Promise<void>((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    )
                },
                { hideGroup, hideStage },
            )
            const expected = [
                ...(!hideGroup ? ['MG', 'RG'] : []),
                ...(!hideStage ? ['MS', 'RS'] : []),
            ].sort()
            await expect
                .poll(() => page.evaluate(() => [...new Set(window.attachedPreviewNames)].sort()))
                .toEqual(expected)
            const names = await page.evaluate(() => window.attachedPreviewNames)
            // Two identical slides request four labels of each role, but only
            // one per beat should survive ordinary-name collision placement.
            for (const text of ['RG', 'RS'])
                expect(names.filter((name) => name === text)).toHaveLength(
                    (text === 'RG' ? hideGroup : hideStage) ? 0 : 2,
                )
        }
        const read = () =>
            page.evaluate(async () => {
                const { history, view, appImport } = window.editorTest
                const { previewSlides, sceneState, isScenePreview } = await appImport<
                    typeof import('../../src/editor/sceneState')
                >('/src/editor/sceneState.ts')
                const { createComposedLayout } =
                    await appImport<typeof import('../../src/editor/composed')>(
                        '/src/editor/composed.ts',
                    )
                const shown = previewSlides.value?.state ?? sceneState.value
                const composed = createComposedLayout(shown)
                const notes = [...shown.store.slides.note.values()].flat()
                return {
                    committed: [...history.state.value.store.slides.note.values()].flat(),
                    shown: notes,
                    positions: notes.map(
                        (note) =>
                            composed?.notePosition(note) ?? {
                                left: note.left,
                                size: note.size,
                            },
                    ),
                    ghosts: view.entities.creating,
                    preview: !!previewSlides.value,
                    scenePreview: isScenePreview.value,
                }
            })
        const drag = async () => {
            const { start, lane } = await page.evaluate(() => {
                const { point, view, settings } = window.editorTest
                return { start: point(3, 6), lane: view.w / settings.width }
            })
            await page.mouse.move(start.x, start.y)
            await page.mouse.down()
            await page.mouse.move(start.x + lane * 1.4, start.y, { steps: 6 })
        }

        await configureNames(false, false)
        const before = await read()
        await drag()
        const held = await read()
        expect(held.committed).toEqual(before.committed)
        expect(held.shown).not.toEqual(before.shown)
        expect(held.preview).toBe(layout === 'basic')
        expect(held.scenePreview).toBe(layout === 'composed')
        expect(held.ghosts).toHaveLength(1)
        for (const [hideGroup, hideStage] of [
            [true, true],
            [false, true],
            [true, false],
            [false, false],
        ] as const) {
            await configureNames(hideGroup, hideStage)
            expect(await read()).toEqual(held)
        }
        await page.mouse.up()
        await configureNames(false, false)
        const dropped = await read()
        expect(dropped.committed).toEqual(held.shown)
        expect(dropped.shown).toEqual(held.shown)
        expect(dropped.positions).toEqual(held.positions)
        expect(dropped.ghosts).toEqual([])
        expect(dropped.preview || dropped.scenePreview).toBe(false)
        await page.keyboard.press('Control+z')
        await configureNames(false, false)
        expect(await read()).toEqual(before)

        await drag()
        expect((await read()).shown).toEqual(held.shown)
        await configureNames(true, false)
        await page.keyboard.press('Escape')
        await page.mouse.up()
        expect(await read()).toEqual(before)
        await configureNames(true, false)
        await configureNames(false, false)
        expect(await page.evaluate(() => window.attachedPreviewTrustedMoves)).toBeGreaterThan(0)
    })
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
