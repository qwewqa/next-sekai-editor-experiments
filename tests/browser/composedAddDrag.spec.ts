import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

type Drag = {
    tool: 'note' | 'slide'
    layout: 'basic' | 'composed'
    // Stage pivot at beat 8; it moves linearly from 0 at beat 0.
    pivot: number
    from: [lane: number, beat: number]
    to: [lane: number, beat: number]
}

const drag = (page: import('@playwright/test').Page, input: Drag) =>
    page.evaluate(async ({ tool, layout, pivot, from, to }) => {
        const { fixtures, show, view, point, history, appImport } = window.editorTest
        const event = fixtures.events.stagePivotEvents[0]!
        const stageId = fixtures.interaction.slides[0]![0]!.stageId
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                stagePivotEvents: [0, 8].map((beat) => ({
                    ...event,
                    stageId,
                    beat,
                    pivotLane: beat ? pivot : 0,
                    divisionSize: 2,
                    divisionParity: 'even' as const,
                    eventEase: 'linear' as const,
                })),
                slides: [],
            },
            3,
        )
        history.replaceState({ ...history.state.value, selectedEntities: [] })
        view.layout = layout
        view.stageId = stageId
        view.division = 1
        view.laneDivision = 1
        view.laneSnapping = 'absolute'
        const { tools } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        const { getComposedNoteOffset } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        const modifiers = { ctrl: false, shift: false }
        const start = point(...from)
        const end = point(...to)
        tools[tool].dragStart!(start.x, start.y, modifiers)
        tools[tool].dragUpdate!(end.x, end.y, modifiers)
        const [ghost] = view.entities.creating.filter((entity) => entity.type === 'note')
        await tools[tool].dragEnd!(end.x, end.y, modifiers)
        const [note] = history.state.value.selectedEntities.filter(
            (entity) => entity.type === 'note',
        )
        const offset = getComposedNoteOffset(note!)
        return {
            ghost: ghost && { left: ghost.left, size: ghost.size },
            beat: note!.beat,
            left: note!.left,
            size: note!.size,
            displayed: [note!.left + offset, note!.left + note!.size + offset],
        }
    }, input)

for (const tool of ['note', 'slide'] as const) {
    test(`composed ${tool} add-drag keeps the pressed edge where it was pressed`, async ({
        page,
    }) => {
        // The stage moves 1 lane per beat: press lane 4 at beat 5, release lane 9 at beat 7.
        expect(
            await drag(page, { tool, layout: 'composed', pivot: 8, from: [4, 5], to: [9, 7] }),
        ).toEqual({
            ghost: { left: -3, size: 5 },
            beat: 7,
            left: -3,
            size: 5,
            displayed: [4, 9],
        })
        // Across a fractional offset, the edge snaps to the release beat's grid nearest the press.
        const fractional = await drag(page, {
            tool,
            layout: 'composed',
            pivot: 3,
            from: [4, 2],
            to: [9, 6],
        })
        expect(fractional.left % 1).toBe(0)
        expect(Math.abs(fractional.displayed[0]! - 3.75)).toBeLessThanOrEqual(0.5)
        // A drag within one beat is unchanged.
        expect(
            await drag(page, { tool, layout: 'composed', pivot: 8, from: [4, 5], to: [9, 5] }),
        ).toEqual({
            ghost: { left: -1, size: 5 },
            beat: 5,
            left: -1,
            size: 5,
            displayed: [4, 9],
        })
    })

    test(`basic ${tool} add-drag across beats keeps the authored edge`, async ({ page }) => {
        expect(
            await drag(page, { tool, layout: 'basic', pivot: 8, from: [4, 5], to: [9, 7] }),
        ).toEqual({
            ghost: { left: 4, size: 5 },
            beat: 7,
            left: 4,
            size: 5,
            displayed: [4, 9],
        })
    })
}
