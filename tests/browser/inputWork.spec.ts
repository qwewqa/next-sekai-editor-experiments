import { expect, test, type Page } from '@playwright/test'
import type { Entity } from '../../src/state/entities'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise((resolve) => requestAnimationFrame(resolve))
    })

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test('hit queries keep full-grid results and order in Basic and Composed', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { appImport, fixtures, show, history, view, settings, store } = window.editorTest
        const { getComposedLayout } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        const { beatToTime, timeToBeat } = await appImport<
            typeof import('../../src/state/integrals/bpms')
        >('/src/state/integrals/bpms.ts')
        show({ ...fixtures.events, slides: fixtures.connectors.slides, isDynamicStages: true })
        const source = history.state.value
        const all = [...store.getAllEntities()]
        const types = new Set(all.filter((entity) => entity.hitbox).map((entity) => entity.type))
        let queries = 0
        let seed = 4231
        const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
        for (const layout of ['basic', 'composed'] as const) {
            view.layout = layout
            const composed = getComposedLayout(source)
            for (const pps of [120, 1000]) {
                settings.pps = pps
                const spu = view.w / settings.width / settings.pps
                for (let i = 0; i < 400; i++) {
                    const laneMin = random() * 24 - 12
                    const laneMax = laneMin + random() * 20
                    const timeMin = random() * 8 - 1
                    const timeMax = timeMin + random() * 8
                    const minimumWidth = random() * 2
                    const minKey = Math.floor(
                        timeToBeat(source.bpms, Math.max(0, timeMin - 0.4 * spu)),
                    )
                    const maxKey = Math.floor(
                        timeToBeat(source.bpms, Math.max(0, timeMax + 0.4 * spu)),
                    )
                    // The original query visits every grid, including drawn connections.
                    const expected = [
                        ...store.cullAllEntities(minKey, maxKey, source.store),
                    ].filter((entity) => {
                        const hitbox = composed?.hitbox(entity) ?? entity.hitbox
                        if (!hitbox) return false
                        const width =
                            entity.type === 'note' ? Math.max(hitbox.w, minimumWidth / 2) : hitbox.w
                        const time = beatToTime(source.bpms, hitbox.beat)
                        return (
                            laneMax > hitbox.lane - width &&
                            laneMin < hitbox.lane + width &&
                            timeMax > time - hitbox.h * spu &&
                            timeMin < time + hitbox.h * spu
                        )
                    })
                    const actual = store.hitAllEntities(
                        laneMin,
                        laneMax,
                        timeMin,
                        timeMax,
                        minimumWidth,
                        source,
                    )
                    if (
                        actual.length !== expected.length ||
                        actual.some((entity, index) => entity !== expected[index])
                    )
                        return { queries, equivalent: false, types: [...types] }
                    queries++
                }
            }
        }
        return { queries, equivalent: true, types: [...types] }
    })
    expect(result.equivalent).toBe(true)
    expect(result.queries).toBe(1600)
    expect(result.types.sort()).toEqual([
        'bpm',
        'cameraEventJoint',
        'note',
        'stageMaskEventJoint',
        'stagePivotEventJoint',
        'stageStyleEventJoint',
        'stageTransformEventJoint',
        'timeScale',
    ])
})

test('selected outlines project only selected entities whose scope is shown', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { appImport, fixtures, show, history, view, store } = window.editorTest
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const { visibleSelectedEntities } = await appImport<
            typeof import('../../src/editor/entities/visible')
        >('/src/editor/entities/visible.ts')
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                slides: [
                    [{ ...base, beat: 5, left: -2 }],
                    [{ ...base, beat: 5, left: 1, groupId: 2 as typeof base.groupId }],
                    ...Array.from({ length: 40 }, (_, i) => [{ ...base, beat: 5, left: i % 4 }]),
                ],
            },
            2.5,
        )
        view.layout = 'composed'
        const notes = [...store.getAllEntities()].filter((entity) => entity.type === 'note')
        const selected = notes.slice(0, 2)
        view.groupVisibility = new Map([[selected[1]!.groupId, 'hidden']])
        history.replaceState({ ...history.state.value, selectedEntities: selected })
        const layout = createComposedLayout(history.state.value)
        const hitbox = layout.hitbox
        const projected: Entity[] = []
        layout.hitbox = (entity, options) => {
            projected.push(entity)
            return hitbox(entity, options)
        }
        try {
            return {
                visible: visibleSelectedEntities.value.map((entity) =>
                    notes.indexOf(entity as (typeof notes)[number]),
                ),
                projected: projected.map((entity) =>
                    notes.indexOf(entity as (typeof notes)[number]),
                ),
            }
        } finally {
            layout.hitbox = hitbox
        }
    })
    expect(result).toEqual({ visible: [0], projected: [0] })
})

test('rectangle movement keeps identical selection state and updates entered and exited notes', async ({
    page,
}) => {
    await useTool(page, 'select')
    await page.evaluate(() => {
        window.editorTest.settings.dragToPanX = false
        window.editorTest.settings.dragToPanY = false
    })
    const move = async (lane: number, beat: number) => {
        const point = await page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), {
            lane,
            beat,
        })
        await page.mouse.move(point.x, point.y)
        await settle(page)
    }
    const selection = () =>
        page.evaluate(() => window.editorTest.snapshot().selected.map((entity) => entity.beat))
    await move(-6, 2)
    await page.mouse.down()
    await move(-2, 4)
    expect(await selection()).toEqual([3])
    const first = await page.evaluateHandle(() => window.editorTest.history.state.value)
    const box = await page.evaluate(() => window.editorTest.view.selection)
    await move(-1.8, 4.2)
    expect(
        await page.evaluate(
            (previous) => window.editorTest.history.state.value === previous,
            first,
        ),
    ).toBe(true)
    expect(await page.evaluate(() => window.editorTest.view.selection)).not.toEqual(box)
    await move(2, 6)
    expect(await selection()).toEqual([3, 5])
    expect(
        await page.evaluate(
            (previous) => window.editorTest.history.state.value === previous,
            first,
        ),
    ).toBe(false)
    await move(-5, 2.3)
    expect(await selection()).toEqual([])
    await move(-2, 4)
    await page.mouse.up()
    await settle(page)
    expect(await selection()).toEqual([3])
    expect(await page.evaluate(() => window.editorTest.view.selection)).toBeUndefined()
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
    const restored = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { editSelectedEditableEntities } = await appImport<
            typeof import('../../src/editor/sidebars/default')
        >('/src/editor/sidebars/default/index.ts')
        const before = history.state.value
        editSelectedEditableEntities({ isCritical: true })
        const edited = history.state.value !== before && history.canUndo.value
        history.undoState()
        return { edited, restored: history.state.value === before }
    })
    expect(restored).toEqual({ edited: true, restored: true })
})
