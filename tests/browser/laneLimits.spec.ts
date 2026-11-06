import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.use({ hasTouch: true })

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
const point = (page: Page, lane: number, beat = 4) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })
const notes = (page: Page) =>
    page.evaluate(() =>
        [...window.editorTest.history.state.value.store.slides.note.values()]
            .flat()
            .map(({ left, size, beat }) => ({ left, size, beat })),
    )
const seed = (page: Page, selected = false) =>
    page.evaluate((selected) => {
        const { settings, fixtures, show, history } = window.editorTest
        settings.maxLane = 6
        const base = fixtures.interaction
        const note = base.slides[0]![0]!
        show(
            {
                ...base,
                slides: selected
                    ? [
                          [{ ...note, beat: 4, left: 0, size: 2 }],
                          [{ ...note, beat: 8, left: 5, size: 2 }],
                      ]
                    : [],
            },
            3,
        )
        if (selected)
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
            })
    }, selected)

test.beforeEach(async ({ page }) => {
    page.on('pageerror', (error) => {
        throw error
    })
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const elevationPoint = (page: Page, lane: number, elevation: number) =>
    page.evaluate(
        async ({ lane, elevation }) => {
            const { elevationLayout } = await import('/src/editor/elevation/scene.ts')
            const { elevationBounds } = await import('/src/editor/elevation/viewport.ts')
            return {
                x: elevationBounds.x + elevationLayout.value.xAt(lane),
                y: elevationBounds.y + elevationLayout.value.yAt(elevation),
            }
        },
        { lane, elevation },
    )

const drag = async (page: Page, start: { x: number; y: number }, end: { x: number; y: number }) => {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    await page.mouse.up()
}

test('lane commands have their own default group, persist and accept a custom range', async ({
    page,
}) => {
    const layout = await page.evaluate(() => {
        const { settings } = window.editorTest
        return { groups: settings.toolbar, limit: settings.maxLane }
    })
    expect(layout.limit).toBe(0)
    const index = layout.groups.findIndex((group) => group.includes('laneLimitNone'))
    expect(layout.groups[index]).toEqual(['laneLimitCustom', 'laneLimitSix', 'laneLimitNone'])
    expect(layout.groups[index - 1]).toContain('laneDivisionCustom')
    expect(layout.groups.find((group) => group.includes('select'))).not.toContain('elevation')
    expect(layout.groups.find((group) => group.includes('zoomYOut'))).not.toContain('elevation')
    expect(layout.groups.find((group) => group.includes('scaleWidth'))).toContain('elevation')
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        void commands.laneLimitCustom.execute()
    })
    await page.getByRole('spinbutton', { name: 'Maximum Lane (±)' }).fill('2.5')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect(await page.evaluate(() => window.editorTest.settings.maxLane)).toBe(2.5)
    await page.reload()
    expect(
        await page.evaluate(async () => (await import('/src/settings.ts')).settings.maxLane),
    ).toBe(2.5)
})

for (const tool of [
    'note',
    'slide',
    'cameraEvent',
    'stageMaskEvent',
    'stagePivotEvent',
    'stageStyleEvent',
    'stageTransformEvent',
    'timeScale',
] as const) {
    test(`${tool} hover and placement agree at both lane boundaries`, async ({ page }) => {
        for (const lane of [-9, 9]) {
            await seed(page)
            await page.evaluate(async (name) => {
                const { switchToolTo } = await import('/src/editor/tools/index.ts')
                switchToolTo(name)
            }, tool)
            const target = await point(page, lane)
            await page.mouse.move(target.x, target.y)
            await settle(page)
            const ghost = await page.evaluate(() => {
                const entity = window.editorTest.view.entities.creating[0]!
                return {
                    type: entity.type,
                    min:
                        entity.hitbox!.lane -
                        (entity.hitbox!.w - (entity.type === 'note' ? 0 : 0.2)),
                    max:
                        entity.hitbox!.lane +
                        (entity.hitbox!.w - (entity.type === 'note' ? 0 : 0.2)),
                }
            })
            expect(ghost.min).toBeGreaterThanOrEqual(-6)
            expect(ghost.max).toBeLessThanOrEqual(6)
            await page.mouse.click(target.x, target.y)
            const placed = await page.evaluate(() => {
                const entity = window.editorTest.history.state.value.selectedEntities[0]!
                return {
                    type: entity.type,
                    min:
                        entity.hitbox!.lane -
                        (entity.hitbox!.w - (entity.type === 'note' ? 0 : 0.2)),
                    max:
                        entity.hitbox!.lane +
                        (entity.hitbox!.w - (entity.type === 'note' ? 0 : 0.2)),
                }
            })
            expect(placed).toEqual(ghost)
            await page.keyboard.press('Escape')
        }
    })
}

test('a selection drag brings a group past the limit within it whole, with matching preview and undo', async ({
    page,
}) => {
    await seed(page, true)
    await page.keyboard.press('f')
    const start = await point(page, 1)
    const end = await point(page, 9)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    const draft = await page.evaluate(async () => {
        const { getPreviewState } = await import('/src/preview/edit.ts')
        return getPreviewState(window.editorTest.history.state.value)
            .selectedEntities.filter((entity) => entity.type === 'note')
            .map(({ left, size }) => ({ left, size }))
    })
    // From 0 to 7, it shifts one lane back in rather than further out.
    expect(draft).toEqual([
        { left: -1, size: 2 },
        { left: 4, size: 2 },
    ])
    await page.mouse.up()
    expect((await notes(page)).map(({ left, size }) => ({ left, size }))).toEqual(draft)
    await page.keyboard.press('z')
    expect((await notes(page)).map(({ left }) => left)).toEqual([0, 5])
})

type Seeded = { beat: number; left: number; size: number; isAttached?: boolean }

/** Shows slides with every note selected, at a lane limit of 6. */
const seedSlides = (page: Page, slides: Seeded[][]) =>
    page.evaluate((slides) => {
        const { settings, fixtures, show, history } = window.editorTest
        settings.maxLane = 6
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: slides.map((slide) =>
                    slide.map((note) => ({ ...base, ...note, isAttached: !!note.isAttached })),
                ),
            },
            3,
        )
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
        })
    }, slides)

const placed = async (page: Page) =>
    (await notes(page))
        .map(({ left, size, beat }) => ({ beat, left, size }))
        .sort((a, b) => a.beat - b.beat)

const previewed = (page: Page) =>
    page.evaluate(async () => {
        const { getPreviewState } = await import('/src/preview/edit.ts')
        return getPreviewState(window.editorTest.history.state.value)
            .selectedEntities.filter((entity) => entity.type === 'note')
            .map(({ beat, left, size }) => ({ beat, left, size }))
            .sort((a, b) => a.beat - b.beat)
    })

/** Drags in the chart and reads the preview before the drop. */
const dragChart = async (
    page: Page,
    from: [lane: number, beat: number],
    to: [lane: number, beat: number],
) => {
    const start = await point(page, ...from)
    const end = await point(page, ...to)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    const preview = await previewed(page)
    await page.mouse.up()
    return preview
}

test('a selection drag moves notes of different widths as one, stopping at the limit', async ({
    page,
}) => {
    await seedSlides(page, [[{ beat: 4, left: -2, size: 1 }], [{ beat: 8, left: 1, size: 3 }]])
    await page.keyboard.press('f')
    const preview = await dragChart(page, [-1.5, 4], [9, 4])
    // The wider note's right edge meets 6, so both move two lanes.
    expect(preview).toEqual([
        { beat: 4, left: 0, size: 1 },
        { beat: 8, left: 3, size: 3 },
    ])
    expect(await placed(page)).toEqual(preview)
    await page.keyboard.press('z')
    expect((await placed(page)).map(({ left }) => left)).toEqual([-2, 1])
})

test('a selection drag keeps the shape of a slide at the limit, with or without a beat change', async ({
    page,
}) => {
    await seedSlides(page, [
        [
            { beat: 2, left: -1, size: 1 },
            { beat: 4, left: 2, size: 1 },
            { beat: 6, left: 4, size: 1 },
        ],
    ])
    await page.keyboard.press('f')
    const left = await dragChart(page, [-0.5, 2], [-12, 2])
    expect(left.map(({ left }) => left)).toEqual([-6, -3, -1])
    expect(await placed(page)).toEqual(left)
    await page.keyboard.press('z')
    const later = await dragChart(page, [-0.5, 2], [12, 3])
    expect(later).toEqual([
        { beat: 3, left: 0, size: 1 },
        { beat: 5, left: 3, size: 1 },
        { beat: 7, left: 5, size: 1 },
    ])
    expect(await placed(page)).toEqual(later)
})

test('a selection drag by an attached tick keeps the shape of its slide at the limit', async ({
    page,
}) => {
    await seedSlides(page, [
        [
            { beat: 2, left: 0, size: 2 },
            { beat: 4, left: 0, size: 2, isAttached: true },
            { beat: 6, left: 3, size: 2 },
        ],
    ])
    await page.keyboard.press('f')
    // The tick sits halfway, from 1.5 to 3.5.
    await dragChart(page, [2.5, 4], [12, 4])
    expect(await placed(page)).toEqual([
        { beat: 2, left: 1, size: 2 },
        { beat: 4, left: 2.5, size: 2 },
        { beat: 6, left: 4, size: 2 },
    ])
})

test('a selection drag moves notes and events as one group', async ({ page }) => {
    const moved = await page.evaluate(async () => {
        const { show, fixtures, history, store, settings, appImport } = window.editorTest
        const select = await appImport<typeof import('../../src/editor/tools/select')>(
            '/src/editor/tools/select.ts',
        )
        settings.maxLane = 6
        const note = fixtures.interaction.slides[0]![0]!
        show({
            ...fixtures.events,
            isDynamicStages: true,
            cameraEvents: [
                { ...fixtures.events.cameraEvents[0]!, beat: 4, cameraLeft: -3, cameraSize: 6 },
            ],
            stageMaskEvents: [],
            stagePivotEvents: [{ ...fixtures.events.stagePivotEvents[0]!, beat: 4, pivotLane: 5 }],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
            slides: [[{ ...note, beat: 4, left: -1, size: 2 }]],
        })
        const source = history.state.value
        const entities = [...store.getAllEntities()].filter(
            (entity) =>
                entity.type === 'note' ||
                entity.type === 'cameraEventJoint' ||
                entity.type === 'stagePivotEventJoint',
        )
        const focus = entities.find((entity) => entity.type === 'note')!
        const active = {
            type: 'move' as const,
            lane: 0,
            focus,
            entities,
            onlyType: undefined,
            pressBeat: focus.beat,
        }
        const { plan, rawMove } = select.planMove(source, active, 10, 0)
        return select
            .moveEntities(source, active, 10, 0, plan, rawMove)
            .state.selectedEntities.map((entity) =>
                entity.type === 'note'
                    ? entity.left
                    : entity.type === 'cameraEventJoint'
                      ? entity.cameraLeft
                      : entity.type === 'stagePivotEventJoint'
                        ? entity.pivotLane
                        : NaN,
            )
            .sort((a, b) => a - b)
    })
    // The pivot at 5 stops the group one lane on.
    expect(moved).toEqual([-2, 0, 6])
})

test('clicks and sub-threshold pointer movement leave existing out-of-range notes unchanged', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, settings } = window.editorTest
        const note = fixtures.interaction.slides[0]![0]!
        show({ ...fixtures.interaction, slides: [[{ ...note, beat: 4, left: 7, size: 2 }]] }, 3)
        settings.maxLane = 6
    })
    await page.keyboard.press('f')
    const target = await point(page, 8)
    await page.mouse.move(target.x, target.y)
    await page.mouse.down()
    await page.mouse.move(target.x - 10, target.y)
    await page.mouse.up()
    expect((await notes(page))[0]!.left).toBe(7)
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
})

test('switching limits refreshes a stationary hover ghost without changing the chart', async ({
    page,
}) => {
    await seed(page)
    await page.evaluate(() => {
        window.editorTest.settings.maxLane = 0
        window.editorTest.settings.keyboardShortcuts = {
            ...window.editorTest.settings.keyboardShortcuts,
            laneLimitSix: 'L',
        }
    })
    await page.keyboard.press('a')
    const target = await point(page, 9)
    await page.mouse.move(target.x, target.y)
    expect(
        await page.evaluate(() => window.editorTest.view.entities.creating[0]!.hitbox!.lane),
    ).toBeGreaterThan(6)
    await page.keyboard.press('Shift+L')
    expect(
        await page.evaluate(() => {
            const ghost = window.editorTest.view.entities.creating[0]!
            return ghost.hitbox!.lane + ghost.hitbox!.w
        }),
    ).toBe(6)
    expect(await notes(page)).toEqual([])
})

for (const tool of ['select', 'note', 'slide'] as const) {
    test(`${tool} resize stops at the boundary and preserves the opposite edge`, async ({
        page,
    }) => {
        await seed(page, true)
        await page.evaluate(async (name) => {
            const { switchToolTo } = await import('/src/editor/tools/index.ts')
            switchToolTo(name)
        }, tool)
        await drag(page, await point(page, 1.95), await point(page, 9))
        const first = (await notes(page))[0]!
        expect(first.left).toBe(0)
        expect(first.size).toBe(6)
    })
}

test('a narrow custom limit keeps camera events valid and centered', async ({ page }) => {
    await seed(page)
    await page.evaluate(async () => {
        window.editorTest.settings.maxLane = 2
        const { switchToolTo } = await import('/src/editor/tools/index.ts')
        switchToolTo('cameraEvent')
    })
    const target = await point(page, 9)
    await page.mouse.move(target.x, target.y)
    await page.mouse.click(target.x, target.y)
    expect(
        await page.evaluate(() => {
            const camera = window.editorTest.history.state.value.selectedEntities[0]!
            return camera.type === 'cameraEventJoint'
                ? [camera.cameraLeft, camera.cameraSize]
                : undefined
        }),
    ).toEqual([-3, 6])
})

test('paste hover and placement both clamp copied notes', async ({ page }) => {
    await seed(page, true)
    await page.keyboard.press('c')
    await page.keyboard.press('v')
    const target = await point(page, 9, 12)
    await page.mouse.move(target.x, target.y)
    await settle(page)
    const ghost = await page.evaluate(() =>
        window.editorTest.view.entities.creating
            .filter((entity) => entity.type === 'note')
            .map(({ left, size }) => ({ left, size })),
    )
    expect(ghost.length).toBe(2)
    expect(ghost.every(({ left, size }) => left >= -6 && left + size <= 6)).toBe(true)
    await page.mouse.click(target.x, target.y)
    expect(
        await page.evaluate(() =>
            window.editorTest.history.state.value.selectedEntities
                .filter((entity) => entity.type === 'note')
                .map(({ left, size }) => ({ left, size })),
        ),
    ).toEqual(ghost)
})

test('a pasted group keeps its shape against the limit', async ({ page }) => {
    await seedSlides(page, [[{ beat: 4, left: -2, size: 1 }], [{ beat: 8, left: 1, size: 3 }]])
    await page.keyboard.press('c')
    await page.keyboard.press('v')
    const target = await point(page, 9, 12)
    await page.mouse.move(target.x, target.y)
    await settle(page)
    const ghost = await page.evaluate(() =>
        window.editorTest.view.entities.creating
            .filter((entity) => entity.type === 'note')
            .map(({ left, size }) => ({ left, size }))
            .sort((a, b) => a.left - b.left),
    )
    expect(ghost).toEqual([
        { left: 0, size: 1 },
        { left: 3, size: 3 },
    ])
    await page.mouse.click(target.x, target.y)
    expect(
        await page.evaluate(() =>
            window.editorTest.history.state.value.selectedEntities
                .filter((entity) => entity.type === 'note')
                .map(({ left, size }) => ({ left, size }))
                .sort((a, b) => a.left - b.left),
        ),
    ).toEqual(ghost)
})

test('elevation placement and selection movement honor limits in preview and on commit', async ({
    page,
}) => {
    await seed(page)
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
        window.editorTest.view.cursorTime = 2
    })
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await page.keyboard.press('a')
    const target = await elevationPoint(page, 9, 1)
    await page.mouse.move(target.x, target.y)
    await settle(page)
    const ghost = await page.evaluate(() => {
        const note = window.editorTest.view.entities.creating[0]!
        return note.type === 'note' ? { left: note.left, size: note.size } : undefined
    })
    expect(ghost!.left + ghost!.size).toBe(6)
    await page.mouse.click(target.x, target.y)
    expect((await notes(page)).map(({ left, size }) => ({ left, size }))).toEqual([ghost])
    await page.keyboard.press('f')
    await drag(
        page,
        await elevationPoint(page, ghost!.left + ghost!.size / 2, 1),
        await elevationPoint(page, -9, 2),
    )
    expect((await notes(page))[0]!.left).toBe(-6)
    await page.keyboard.press('z')
    expect((await notes(page))[0]!.left).toBe(ghost!.left)
})

test('width scaling clamps the dragged edge, preserves cancellation and permits other selected notes outside', async ({
    page,
}) => {
    await seed(page, true)
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        void commands.scaleWidth.execute()
    })
    await expect(page.locator('.scaling-panel')).toBeVisible()
    await drag(page, await point(page, 1), await point(page, 9))
    const draft = await page.evaluate(async () => {
        const { getPreviewState } = await import('/src/preview/edit.ts')
        return getPreviewState(window.editorTest.history.state.value)
            .selectedEntities.filter((entity) => entity.type === 'note')
            .map(({ left, size }) => ({ left, size }))
    })
    expect(draft).toEqual([
        { left: 4, size: 2 },
        { left: 13, size: 2 },
    ])
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await notes(page)).map(({ left }) => left)).toEqual([0, 5])
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        void commands.scaleWidth.execute()
    })
    await drag(page, await point(page, 1.95), await point(page, 9))
    expect(await page.getByRole('spinbutton', { name: 'Scale Factor' }).inputValue()).toBe('3')
    await page.keyboard.press('Enter')
    const result = await notes(page)
    expect(result[0]!.left).toBe(0)
    expect(result[0]!.size).toBe(6)
    expect(result[1]!.left).toBe(15)
})

test('all three lane limit commands remain accessible on a phone', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await page.getByTitle('No Lane Limit', { exact: true }).tap()
    for (const title of ['No Lane Limit', 'Limit to ±6 Lanes', 'Custom Lane Limit…']) {
        const command = page.getByTitle(title, { exact: true }).filter({ hasText: title })
        await command.scrollIntoViewIfNeeded()
        await expect(command).toBeInViewport()
    }
    await page.screenshot({ path: testInfo.outputPath('phone-lane-limits.png') })
})

test('each event tool clamps its live drag preview and committed horizontal coordinate', async ({
    page,
}) => {
    for (const tool of [
        'cameraEvent',
        'stageMaskEvent',
        'stagePivotEvent',
        'stageStyleEvent',
        'stageTransformEvent',
        'timeScale',
    ] as const) {
        await page.evaluate(async (tool) => {
            const { settings, fixtures, show } = window.editorTest
            settings.maxLane = 6
            const chart = {
                ...fixtures.events,
                slides: [],
                cameraEvents: [],
                stageMaskEvents: [],
                stagePivotEvents: [],
                stageStyleEvents: [],
                stageTransformEvents: [],
                timeScales: [],
            }
            const destination = {
                cameraEvent: 'cameraEvents',
                stageMaskEvent: 'stageMaskEvents',
                stagePivotEvent: 'stagePivotEvents',
                stageStyleEvent: 'stageStyleEvents',
                stageTransformEvent: 'stageTransformEvents',
                timeScale: 'timeScales',
            } as const
            const key = destination[tool]
            const source = fixtures.events[key][0]!
            Object.assign(chart, {
                [key]: [
                    {
                        ...source,
                        beat: 4,
                        cameraLeft: 0,
                        cameraSize: 6,
                        maskLeft: 0,
                        maskSize: 2,
                        pivotLane: 0,
                        editorLane: 0,
                        xTranslation: 0,
                    },
                ],
            })
            show(chart, 3)
            const { switchToolTo } = await import('/src/editor/tools/index.ts')
            switchToolTo(tool)
        }, tool)
        const start = await point(
            page,
            tool === 'cameraEvent' ? 3 : tool === 'stageMaskEvent' ? 1 : 0,
        )
        const end = await point(page, 9)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(end.x, end.y, { steps: 5 })
        await settle(page)
        const draft = await page.evaluate(async () => {
            const { getPreviewState } = await import('/src/preview/edit.ts')
            const entity = getPreviewState(window.editorTest.history.state.value)
                .selectedEntities[0]!
            return {
                min: entity.hitbox!.lane - entity.hitbox!.w + 0.2,
                max: entity.hitbox!.lane + entity.hitbox!.w - 0.2,
            }
        })
        expect(draft.min).toBeGreaterThanOrEqual(-6)
        expect(draft.max).toBeLessThanOrEqual(6)
        await page.mouse.up()
        expect(
            await page.evaluate(() => {
                const entity = window.editorTest.history.state.value.selectedEntities[0]!
                return {
                    min: entity.hitbox!.lane - entity.hitbox!.w + 0.2,
                    max: entity.hitbox!.lane + entity.hitbox!.w - 0.2,
                }
            }),
        ).toEqual(draft)
    }
})

test('an elevation multi-selection drag moves the notes as one, stopping at the limit', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { show, fixtures, settings, history } = window.editorTest
        const chart = fixtures.interaction
        const note = chart.slides[0]![0]!
        settings.maxLane = 6
        settings.elevationEditorSideBySide = 'disallow'
        show(
            {
                ...chart,
                slides: [
                    [{ ...note, beat: 4, left: 0, size: 2, elevation: 1 }],
                    [{ ...note, beat: 4, left: 3, size: 2, elevation: 3 }],
                ],
            },
            3,
        )
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
        })
    })
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await drag(page, await elevationPoint(page, 1, 1), await elevationPoint(page, 9, 1))
    expect((await notes(page)).map(({ left }) => left)).toEqual([1, 4])
})
