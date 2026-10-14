import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

test.beforeEach(async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test('opening elevation during a previewed move preserves committed ghosts and undo', async ({
    page,
}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const result = await page.evaluate(async () => {
        const { history, fixtures, show, settings, view, appImport, nextTick } = window.editorTest
        const [charts, edits, transactions, notes, elevation, scene] = await Promise.all([
            appImport<typeof import('../../src/preview/engine/chart')>(
                '/src/preview/engine/chart.ts',
            ),
            appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts'),
            appImport<typeof import('../../src/state/transaction')>('/src/state/transaction.ts'),
            appImport<typeof import('../../src/state/operations/note')>(
                '/src/state/operations/note.ts',
            ),
            appImport<typeof import('../../src/editor/elevation/state')>(
                '/src/editor/elevation/state.ts',
            ),
            appImport<typeof import('../../src/editor/elevation/scene')>(
                '/src/editor/elevation/scene.ts',
            ),
        ])
        const base = fixtures.interaction.slides[0]![0]!
        show({ ...fixtures.interaction, slides: [[{ ...base, beat: 3, elevation: 1 }]] }, 1.5)
        view.layout = 'basic'
        view.cursorTime = 1.5
        settings.showPreview = true
        settings.elevationEditorSideBySide = 'allow'
        const settle = async () => {
            await nextTick()
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            )
        }
        await settle()
        const source = history.state.value
        const entity = source.store.slides.note.values().next().value![0]!
        const before = charts.getPreviewChart(source, settings.previewNoteSpeed)
        const transaction = transactions.createTransaction(source)
        const draft = transaction.commit(
            notes.editSelectedNote(transaction, entity, { elevation: 2 }),
        )
        edits.setPreviewEdit(source, () => draft, undefined, { isDrag: true })
        const preview = charts.getPreviewChart(draft, settings.previewNoteSpeed)
        elevation.openElevationEditor(3)
        await settle()
        const during = {
            sourceUnchanged: history.state.value === source,
            shown: scene.elevationNotes.value.map((note) => note.elevation),
            committed: scene.committedElevationLayout.value.rows.map((row) => row.elevation),
            ghosts: scene.elevationDragRows.value?.ghosts.map((row) => row.elevation),
            shared: charts.getPreviewChart(draft, settings.previewNoteSpeed) === preview,
            original: before.notes[0]!.elevation,
        }
        edits.clearPreviewEdit()
        history.pushState(() => 'Move note', draft)
        await settle()
        const committed = scene.elevationNotes.value.map((note) => note.elevation)
        history.undoState()
        await settle()
        return {
            during,
            committed,
            restored: scene.elevationNotes.value.map((note) => note.elevation),
            original: before.notes[0]!.elevation,
            originalSourceRestored: history.state.value === source,
        }
    })
    expect(result).toEqual({
        during: {
            sourceUnchanged: true,
            shown: [2],
            committed: [1],
            ghosts: [2],
            shared: true,
            original: 1,
        },
        committed: [2],
        restored: [1],
        original: 1,
        originalSourceRestored: true,
    })
    await expect(page.locator('.preview canvas').first()).toBeVisible()
    await expect(page.locator('canvas.elevation-canvas')).toBeVisible()
    expect(errors).toEqual([])
})

for (const name of ['select', 'note', 'slide'] as const) {
    test(`${name} drafts and commits reuse groups and cached unchanged notes in the populated final group`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (name) => {
            const { tools } =
                (await import('/src/editor/tools/index.ts')) as typeof import('../../src/editor/tools')
            const { getPreviewState, previewEdit } =
                (await import('/src/preview/edit.ts')) as typeof import('../../src/preview/edit')
            const { createPreviewChartBuilder } =
                (await import('/src/preview/engine/chart.ts')) as typeof import('../../src/preview/engine/chart')
            const { history, view, fixtures, show, point } = window.editorTest
            const first = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    groups: new Map([[first.groupId, { name: 'Populated last group' }]]),
                },
                3,
            )
            view.cursorTime = 2.25
            const tool = tools[name]
            const modifiers = { ctrl: false, shift: false }
            const start = point(-3, 3)
            const end = point(-2, 4)
            tool.dragStart!(start.x, start.y, modifiers)
            const source = history.state.value
            const build = createPreviewChartBuilder()
            const before = build(source, 10)
            tool.dragUpdate!(end.x, end.y, modifiers)
            const token = previewEdit.value
            const draft = getPreviewState(source)
            const compiled = build(draft, 10)
            tool.dragUpdate!(end.x + 2, end.y + 1, modifiers)
            const repeated = getPreviewState(source)
            const during = {
                sameToken: token === previewEdit.value,
                sameDraft: repeated === draft,
                sameCompiledChart: build(repeated, 10) === compiled,
                sameGroups: draft.groups === source.groups,
                unchangedNoteReused: before.notes.at(-1) === compiled.notes.at(-1),
                changedNoteRebuilt: before.notes[0] !== compiled.notes[0],
                sourceGroupCount: source.groups.size,
                cursor: view.cursorTime,
            }
            await tool.dragEnd!(end.x, end.y, modifiers)
            return {
                during,
                committedGroupCount: history.state.value.groups.size,
                committedGroupsShared: history.state.value.groups === source.groups,
                draftCleared: previewEdit.value === undefined,
            }
        }, name)

        expect(result.during).toEqual({
            sameToken: true,
            sameDraft: true,
            sameCompiledChart: true,
            sameGroups: true,
            unchangedNoteReused: true,
            changedNoteRebuilt: true,
            sourceGroupCount: 1,
            cursor: 2.25,
        })
        expect(result.committedGroupCount).toBe(1)
        expect(result.committedGroupsShared).toBe(true)
        expect(result.draftCleared).toBe(true)
    })
}

test('property draft and committed edits preserve the populated final group and its identity', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { planEdit } =
            (await import('/src/state/operations/properties/plan.ts')) as typeof import('../../src/state/operations/properties/plan')
        const { history, fixtures, show } = window.editorTest
        const first = fixtures.interaction.slides[0]![0]!
        show({
            ...fixtures.interaction,
            groups: new Map([[first.groupId, { name: 'Populated last group' }]]),
        })
        const source = history.state.value
        const entity = source.store.slides.note.values().next().value![0]!
        const draft = planEdit(source, [entity], { left: -3 }).state
        const committed = planEdit(source, [entity], { left: -3 }).state
        return {
            draftGroupsShared: draft.groups === source.groups,
            sourceGroupCount: source.groups.size,
            committedGroupCount: committed.groups.size,
            committedGroupsShared: committed.groups === source.groups,
            draftLeft: draft.selectedEntities[0]?.type === 'note' && draft.selectedEntities[0].left,
            committedLeft:
                committed.selectedEntities[0]?.type === 'note' &&
                committed.selectedEntities[0].left,
            historyUnchanged: history.state.value === source,
        }
    })
    expect(result).toEqual({
        draftGroupsShared: true,
        sourceGroupCount: 1,
        committedGroupCount: 1,
        committedGroupsShared: true,
        draftLeft: -3,
        committedLeft: -3,
        historyUnchanged: true,
    })
})
