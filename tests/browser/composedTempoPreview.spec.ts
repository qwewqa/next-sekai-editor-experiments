import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: a BPM drag keeps the chart under the pointer until it drops`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (layout) => {
            const { fixtures, show, view, point, history, appImport } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const pivot = fixtures.events.stagePivotEvents[0]!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    bpms: [
                        { beat: 0, bpm: 120 },
                        { beat: 4, bpm: 240 },
                    ],
                    stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 2 }],
                    slides: [[{ ...base, beat: 12, left: 0, size: 2 }]],
                },
                3,
            )
            view.layout = layout
            view.division = 1
            const { tools } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            const { sceneState, isScenePreview } = await appImport<
                typeof import('../../src/editor/sceneState')
            >('/src/editor/sceneState.ts')
            const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
                '/src/state/integrals/bpms.ts',
            )
            const { previewEdit } =
                await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
            const modifiers = { ctrl: false, shift: false }
            // The fixture's point() assumes 120 BPM: beat 6 is the pointer at 3 s, beat 8 of the chart.
            const start = point(0, 4)
            const end = point(0, 6)
            tools.bpm.dragStart!(start.x, start.y, modifiers)
            tools.bpm.dragUpdate!(end.x, end.y, modifiers)
            const during = {
                preview: isScenePreview.value,
                sceneIsCommitted: sceneState.value === history.state.value,
                previewPanel: !!previewEdit.value,
                noteTime: beatToTime(sceneState.value.bpms, 12),
                ghost: view.entities.creating.map((entity) => entity.beat),
            }
            await tools.bpm.dragEnd!(end.x, end.y, modifiers)
            const dropped = history.state.value.bpms.map(({ x }) => x)
            return { during, dropped }
        }, layout)
        expect(result).toEqual({
            during: {
                preview: false,
                sceneIsCommitted: true,
                previewPanel: true,
                noteTime: 4,
                ghost: [8],
            },
            dropped: [0, 8],
        })
    })
}

test('composed: note drags still draw the live preview', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { fixtures, show, view, point, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const pivot = fixtures.events.stagePivotEvents[0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 2 }],
                slides: [[{ ...base, beat: 4, left: 0, size: 2 }]],
            },
            3,
        )
        view.layout = 'composed'
        view.division = 1
        const { tools } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        const { isScenePreview } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        const modifiers = { ctrl: false, shift: false }
        const start = point(3, 4)
        const end = point(5, 5)
        tools.note.dragStart!(start.x, start.y, modifiers)
        tools.note.dragUpdate!(end.x, end.y, modifiers)
        const preview = isScenePreview.value
        tools.note.dragCancel!()
        return preview
    })
    expect(result).toBe(true)
})
