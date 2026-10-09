import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// The same stage-1 offset of 6 lanes, authored as a pivot or as an X translation.
const run = (page: import('@playwright/test').Page, offsetBy: 'pivot' | 'translation') =>
    page.evaluate(async (offsetBy) => {
        const { fixtures, show, view, history, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const pivot = fixtures.events.stagePivotEvents[0]!
        const stage1 = base.stageId
        const stage2 = 2 as typeof base.stageId
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                stagePivotEvents: [
                    { ...pivot, stageId: stage1, beat: 0, pivotLane: offsetBy === 'pivot' ? 6 : 0 },
                    { ...pivot, stageId: stage2, beat: 0, pivotLane: -4 },
                ],
                stageTransformEvents:
                    offsetBy === 'translation'
                        ? [
                              {
                                  stageId: stage1,
                                  beat: 0,
                                  rotation: 0,
                                  xTranslation: 6,
                                  yTranslation: 0,
                                  elevation: 0,
                                  anchor: 'default',
                                  eventEase: 'linear',
                              },
                          ]
                        : [],
                slides: [
                    [{ ...base, beat: 4, left: -2, size: 2 }],
                    [{ ...base, stageId: stage2, beat: 4, left: 2, size: 2 }],
                ],
            },
            2,
        )
        view.layout = 'composed'
        const [first] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [first!] })
        const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
            '/src/editor/commands/copy/index.ts',
        )
        copy.execute()
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
            '/src/editor/elevation/scene.ts',
        )
        const actions = await appImport<typeof import('../../src/editor/elevation/actions')>(
            '/src/editor/elevation/actions.ts',
        )
        const { getComposedNoteOffset } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        openElevationEditor(4)
        const lanes = scene.elevationNotes.value.map(({ note, lane }) => ({
            stage: note.stageId,
            lane,
            composed: note.left + note.size / 2 + getComposedNoteOffset(note),
        }))
        view.stageId = stage1
        const added = actions.previewElevationNote(7, 0.5, 4, false)
        const pasted = actions.previewElevationPaste(7, 0.5, 4, { ctrl: false, shift: false })
        return {
            lanes,
            added: { left: added.left, displayed: added.left + getComposedNoteOffset(added) },
            pasted: pasted.map((note) => ({
                left: note.left,
                displayed: note.left + getComposedNoteOffset(note),
            })),
        }
    }, offsetBy)

test('the Elevation Editor places notes on X-translated stages as Composed does', async ({
    page,
}) => {
    const translated = await run(page, 'translation')
    expect(translated.lanes).toEqual([
        { stage: 1, lane: 5, composed: 5 },
        { stage: 2, lane: -1, composed: -1 },
    ])
    expect(translated.added).toEqual({ left: 1, displayed: 7 })
    // A translation lands new and pasted notes where the same pivot offset would.
    const pivoted = await run(page, 'pivot')
    expect(translated.added.displayed).toBe(pivoted.added.displayed)
    expect(translated.pasted.map(({ displayed }) => displayed)).toEqual(
        pivoted.pasted.map(({ displayed }) => displayed),
    )
    expect(pivoted.lanes).toEqual(translated.lanes)
})
