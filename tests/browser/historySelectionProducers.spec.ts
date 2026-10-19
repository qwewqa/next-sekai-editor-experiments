import { expect, test, type Page } from '@playwright/test'
import type { NoteObject } from '../../src/chart/note'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const seed = (page: Page, slides: Partial<NoteObject>[][]) =>
    page.evaluate((slides) => {
        const { fixtures, show, history } = window.editorTest
        const template = fixtures.interaction.slides[0]![0]!
        show({
            ...fixtures.interaction,
            slides: slides.map((notes) =>
                notes.map((note) => ({ ...template, left: -1, size: 2, elevation: 0, ...note })),
            ),
        })
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
        })
    }, slides)

const summary = (page: Page) =>
    page.evaluate(() => {
        const { history } = window.editorTest
        return {
            step: history.headStep.value,
            notes: [...history.state.value.store.slides.note.values()]
                .flat()
                .map(({ beat, elevation, left, size, isAttached, slideId }) => ({
                    beat,
                    elevation,
                    left,
                    size,
                    isAttached,
                    slideId,
                })),
            undo: history.canUndo.value,
        }
    })

test('Cut retains protected BPM and excludes derived connector operands from actual removals', async ({
    page,
}) => {
    await seed(page, [[{ beat: 2 }, { beat: 4 }]])
    await page.evaluate(async () => {
        const { history, store, appImport } = window.editorTest
        const all = [...store.getAllEntities()]
        history.replaceState({
            ...history.state.value,
            selectedEntities: [
                all.find((entity) => entity.type === 'bpm' && entity.beat === 0)!,
                all.find((entity) => entity.type === 'note')!,
                all.find((entity) => entity.type === 'connector')!,
            ],
        })
        const { cut } = await appImport<typeof import('../../src/editor/commands/cut')>(
            '/src/editor/commands/cut/index.ts',
        )
        cut.execute()
    })
    const result = await summary(page)
    expect(result.notes).toHaveLength(1)
    expect(result.step?.operation).toMatchObject({
        id: 'nse.object.cut',
        data: { removed: { note: 1 } },
    })
    expect(
        await page.evaluate(
            () =>
                [...window.editorTest.store.getAllEntities()].filter(
                    (entity) => entity.type === 'bpm' && entity.beat === 0,
                ).length,
        ),
    ).toBe(1)
})

test('unsupported-only Cut preserves its existing zero-result step', async ({ page }) => {
    await seed(page, [[{ beat: 2 }, { beat: 4 }]])
    await page.evaluate(async () => {
        const { history, store, appImport } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) => entity.type === 'connector',
            ),
        })
        const { cut } = await appImport<typeof import('../../src/editor/commands/cut')>(
            '/src/editor/commands/cut/index.ts',
        )
        cut.execute()
    })
    const result = await summary(page)
    expect(result.notes).toHaveLength(2)
    expect(result.undo).toBe(true)
    expect(result.step?.operation).toMatchObject({ id: 'nse.object.cut', data: { removed: {} } })
})

test('horizontal Flip counts only changed operands and a net-zero roundtrip retains two steps', async ({
    page,
}) => {
    await seed(page, [[{ beat: 2 }], [{ beat: 4, left: 2 }]])
    const result = await page.evaluate(async () => {
        const { history, store, appImport } = window.editorTest
        const initial = [...store.getAllEntities()].find((entity) => entity.type === 'bpm')!
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.selectedEntities, initial],
        })
        const { flip } = await appImport<typeof import('../../src/editor/commands/flip')>(
            '/src/editor/commands/flip/index.ts',
        )
        flip.execute()
        const first = history.headStep.value
        flip.execute()
        const second = history.headStep.value
        const lefts = [...history.state.value.store.slides.note.values()]
            .flat()
            .map((note) => note.left)
        const crossed = [history.undoState(), history.undoState(), history.undoState()]
        return { first, second, lefts, crossed }
    })
    expect(result.lefts).toEqual([-1, 2])
    expect(result.first?.operation).toMatchObject({
        id: 'nse.object.flip',
        data: { axis: 'horizontal', subject: 'note', targets: 1 },
    })
    expect(result.second?.operation).toMatchObject({ id: 'nse.object.flip', data: { targets: 1 } })
    expect(result.crossed[0]).toBeDefined()
    expect(result.crossed[1]).toBeDefined()
    expect(result.crossed[2]).toBeUndefined()
})

test('Scale captures uniform accepted parameters before Apply resets the session', async ({
    page,
}) => {
    await seed(page, [[{ beat: 2 }], [{ beat: 4 }]])
    await page.evaluate(async () => {
        const session = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        session.beginScalingSession('beat')
        session.setScalingFactor(3)
        session.setScalingFactor(2)
        session.applyScalingSession()
        if (session.scalingSession.value !== undefined) throw new Error('Session not reset')
    })
    const result = await summary(page)
    expect(result.notes.map((note) => note.beat)).toEqual([2, 6])
    expect(result.step?.operation).toMatchObject({
        id: 'nse.object.scale',
        data: {
            axis: 'beats',
            subject: 'note',
            targets: 1,
            transform: { mode: 'uniform', factor: 2, pivot: 2 },
        },
    })
})

test('Scale records composed accepted adjustments', async ({ page }) => {
    await seed(page, [[{ beat: 2 }], [{ beat: 4 }]])
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const session = await appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        const preview =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        session.beginScalingSession('beat')
        session.setScalingFactor(2)
        const draft = preview.getPreviewState(window.editorTest.history.state.value)
        const last = draft.selectedEntities.find(
            (entity) => entity.type === 'note' && entity.beat === 6,
        )!
        if (last.type !== 'note') throw new Error('Missing draft note')
        session.beginScalingDrag(last, 6)
        session.updateScalingDrag(8)
        session.endScalingDrag()
        session.setScalingFactor(4)
        session.applyScalingSession()
    })
    const result = await summary(page)
    expect(result.notes.map((note) => note.beat)).toEqual([2, 10])
    expect(result.step?.operation).toMatchObject({
        id: 'nse.object.scale',
        data: { targets: 1, transform: { mode: 'composed' } },
    })
})

test('Scale cancellation restores the prior uniform receipt and accepted outcome', async ({
    page,
}) => {
    await seed(page, [[{ beat: 2 }], [{ beat: 4 }]])
    await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const session = await appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        const preview =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        session.beginScalingSession('beat')
        session.setScalingFactor(2)
        const last = preview
            .getPreviewState(history.state.value)
            .selectedEntities.find((entity) => entity.type === 'note' && entity.beat === 6)!
        if (last.type !== 'note') throw new Error('Missing draft note')
        session.beginScalingDrag(last, 6)
        session.updateScalingDrag(8)
        preview.getPreviewState(history.state.value)
        session.cancelScalingDrag()
        session.applyScalingSession()
    })
    const result = await summary(page)
    expect(result.notes.map((note) => note.beat)).toEqual([2, 6])
    expect(result.step?.operation).toMatchObject({
        id: 'nse.object.scale',
        data: { targets: 1, transform: { mode: 'uniform', factor: 2, pivot: 2 } },
    })
})

test('Scale retains displaced principal participation and exact survivor lineage for a later drag', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { fixtures, show, history, appImport, view } = window.editorTest
        view.division = 1
        const template = fixtures.events.timeScales[0]!
        show({
            ...fixtures.events,
            timeScales: [
                { ...template, beat: 48, timeScale: 2 },
                { ...template, beat: 48.000000025, timeScale: 3 },
            ],
        })
        const originals = [...history.state.value.store.grid.timeScale.values()].flatMap(
            (bucket) => [...bucket],
        )
        const initial = [...history.state.value.store.grid.bpm.values()]
            .flatMap((bucket) => [...bucket])
            .find((bpm) => bpm.beat === 0)!
        history.replaceState({ ...history.state.value, selectedEntities: [initial, ...originals] })
        const session = await appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        const preview =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        session.beginScalingSession('beat')
        session.setScalingFactor(2)
        const draft = preview.getPreviewState(history.state.value)
        const survivor = draft.selectedEntities.find((entity) => entity.type === 'timeScale')!
        if (survivor.type !== 'timeScale') throw new Error('Missing survivor')
        const exactBaseline = session.getScalingBaselineEntity(survivor) === originals[1]
        session.beginScalingDrag(survivor, survivor.beat)
        session.updateScalingDrag(144)
        session.endScalingDrag()
        session.applyScalingSession()
        return {
            exactBaseline,
            step: history.headStep.value,
            timeScales: [...history.state.value.store.grid.timeScale.values()]
                .flatMap((bucket) => [...bucket])
                .map(({ beat, timeScale }) => [beat, timeScale]),
        }
    })
    expect(result.exactBaseline).toBe(true)
    expect(result.timeScales).toEqual([[144, 3]])
    expect(result.step?.operation).toMatchObject({
        id: 'nse.object.scale',
        data: { axis: 'beats', subject: 'timeScale', targets: 2, transform: { mode: 'composed' } },
    })
})

test('a Scale roundtrip retains the existing accepted zero-result step', async ({ page }) => {
    await seed(page, [[{ beat: 2 }], [{ beat: 4 }]])
    await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const session = await appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        const preview =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        session.beginScalingSession('beat')
        session.setScalingFactor(2)
        const last = preview
            .getPreviewState(history.state.value)
            .selectedEntities.find((entity) => entity.type === 'note' && entity.beat === 6)!
        if (last.type !== 'note') throw new Error('Missing draft note')
        session.beginScalingDrag(last, 6)
        session.updateScalingDrag(4)
        session.endScalingDrag()
        session.applyScalingSession()
    })
    const result = await summary(page)
    expect(result.notes.map((note) => note.beat)).toEqual([2, 4])
    expect(result.undo).toBe(true)
    expect(result.step?.operation).toMatchObject({
        id: 'nse.object.scale',
        data: { subject: 'objects', targets: 0, transform: { mode: 'composed' } },
    })
})

test('Scale preserves the existing zero-result Apply after a source-equivalent State replacement', async ({
    page,
}) => {
    await seed(page, [[{ beat: 2 }], [{ beat: 4 }]])
    await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const session = await appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        session.beginScalingSession('beat')
        history.replaceState({ ...history.state.value })
        session.applyScalingSession()
    })
    const result = await summary(page)
    expect(result.notes.map((note) => note.beat)).toEqual([2, 4])
    expect(result.undo).toBe(true)
    expect(result.step?.operation).toMatchObject({
        id: 'nse.object.scale',
        data: { subject: 'objects', targets: 0 },
    })
})

for (const route of ['drag', 'promotedNumeric'] as const) {
    test(`Scale retains exact source aliases captured before another replacement: ${route}`, async ({
        page,
    }) => {
        await seed(page, [[{ beat: 2 }], [{ beat: 4 }]])
        await page.evaluate(async (route) => {
            const { appImport, history } = window.editorTest
            const session = await appImport<
                typeof import('../../src/editor/commands/scaleSelection/session')
            >('/src/editor/commands/scaleSelection/session.ts')
            session.beginScalingSession('beat')
            history.replaceState({ ...history.state.value })
            const last = history.state.value.selectedEntities.find(
                (entity) => entity.type === 'note' && entity.beat === 4,
            )!
            if (last.type !== 'note') throw new Error('Missing source note')
            session.beginScalingDrag(last, 4)
            if (route === 'promotedNumeric') session.endScalingDrag()
            history.replaceState({ ...history.state.value })
            if (route === 'promotedNumeric') session.setScalingFactor(2)
            else session.updateScalingDrag(6)
            session.applyScalingSession()
        }, route)
        const result = await summary(page)
        expect(result.notes.map((note) => note.beat)).toEqual([2, 6])
        expect(result.step?.operation).toMatchObject({
            id: 'nse.object.scale',
            data: {
                subject: 'note',
                targets: 1,
                transform: { mode: 'uniform', factor: 2, pivot: 2 },
            },
        })
    })
}

for (const previewKind of ['numeric', 'pointerClamp'] as const) {
    test(`resolving an abandoned Scale preview cannot alter a new session: ${previewKind}`, async ({
        page,
    }) => {
        await seed(page, [[{ beat: 2 }], [{ beat: 4, left: 10 }]])
        const result = await page.evaluate(async (previewKind) => {
            const { appImport, history, settings } = window.editorTest
            const session = await appImport<
                typeof import('../../src/editor/commands/scaleSelection/session')
            >('/src/editor/commands/scaleSelection/session.ts')
            const preview =
                await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
            settings.maxLane = 6
            const original = history.state.value.selectedEntities.find(
                (entity) => entity.type === 'note' && entity.beat === 4,
            )!
            if (original.type !== 'note') throw new Error('Missing source note')
            session.beginScalingSession('beat')
            if (previewKind === 'numeric') session.setScalingFactor(2)
            else {
                session.beginScalingDrag(original, 4)
                session.updateScalingDrag(6)
            }
            const abandoned = preview.previewEdit.value!
            session.cancelScalingSession()
            session.beginScalingSession('beat')
            session.setScalingFactor(3)
            const discarded = abandoned.resolve()
            const current = preview.getPreviewState(history.state.value)
            const last = current.selectedEntities.find(
                (entity) => entity.type === 'note' && entity.beat === 8,
            )!
            if (last.type !== 'note') throw new Error('Missing new draft note')
            const exactBaseline = session.getScalingBaselineEntity(last) === original
            session.applyScalingSession()
            const discardedNote = discarded.selectedEntities.find(
                (entity) => entity.type === 'note' && entity.beat === 6,
            )
            return {
                exactBaseline,
                step: history.headStep.value,
                newLeft: last.left,
                discardedLeft: discardedNote?.type === 'note' ? discardedNote.left : undefined,
            }
        }, previewKind)
        expect(result.exactBaseline).toBe(true)
        expect(result.newLeft).toBe(10)
        expect(result.discardedLeft).toBe(previewKind === 'numeric' ? 10 : 4)
        expect(result.step?.operation).toMatchObject({
            id: 'nse.object.scale',
            data: {
                subject: 'note',
                targets: 1,
                transform: { mode: 'uniform', factor: 3, pivot: 2 },
            },
        })
    })
}

test('Properties emits changed primary fields with effective relative values', async ({ page }) => {
    await seed(page, [[{ beat: 2, size: 2 }], [{ beat: 4, size: 4 }]])
    await page.evaluate(async () => {
        const { editSelectedEditableEntities } = await window.editorTest.appImport<
            typeof import('../../src/editor/sidebars/default')
        >('/src/editor/sidebars/default/index.ts')
        editSelectedEditableEntities({ size: 1 }, undefined, (entity) =>
            entity.type === 'note' ? { size: entity.size + 1 } : {},
        )
    })
    const result = await summary(page)
    expect(result.notes.map((note) => note.size)).toEqual([3, 5])
    expect(result.step?.operation).toMatchObject({
        id: 'nse.property.set',
        data: {
            subject: 'note',
            targets: 2,
            assignments: [{ field: 'size', value: { mode: 'varying' } }],
        },
    })
})

test('Properties records coupled primary flags and preserves no-change gating', async ({
    page,
}) => {
    await seed(page, [[{ beat: 2, isCritical: false, connectorActiveIsCritical: true }]])
    const result = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { editSelectedEditableEntities } = await appImport<
            typeof import('../../src/editor/sidebars/default')
        >('/src/editor/sidebars/default/index.ts')
        editSelectedEditableEntities({ isCritical: false })
        const step = history.headStep.value
        const note = history.state.value.selectedEntities[0]
        editSelectedEditableEntities({ isCritical: false })
        return {
            step,
            sameStep: history.headStep.value === step,
            flags: note?.type === 'note' && [note.isCritical, note.connectorActiveIsCritical],
        }
    })
    expect(result.flags).toEqual([false, false])
    expect(result.sameStep).toBe(true)
    expect(result.step?.operation).toMatchObject({
        id: 'nse.property.set',
        data: {
            subject: 'note',
            targets: 1,
            assignments: [{ field: 'isCritical', value: { mode: 'uniform', value: false } }],
        },
    })
})

test('Make Vertical counts elevation reset and detach effects on actual notes', async ({
    page,
}) => {
    await seed(page, [[{ beat: 2, elevation: 5 }, { beat: 3, isAttached: true }, { beat: 4 }]])
    await page.evaluate(async () => {
        const { makeVertical } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/makeVertical')
        >('/src/editor/commands/makeVertical/index.ts')
        makeVertical.execute()
    })
    const result = await summary(page)
    expect(
        result.notes.map(({ beat, elevation, isAttached }) => [beat, elevation, isAttached]),
    ).toEqual([
        [2, 0, false],
        [2, 1, false],
        [2, 2, false],
    ])
    expect(result.step?.operation).toMatchObject({ id: 'nse.note.vertical', data: { targets: 3 } })
})

test('Combine counts all participating notes and Split counts unique eligible cuts', async ({
    page,
}) => {
    await seed(page, [
        [{ beat: 2 }, { beat: 4 }],
        [{ beat: 6 }, { beat: 8 }],
    ])
    const result = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].map(
                (notes) => notes[0]!,
            ),
        })
        const { combineNotes } = await appImport<
            typeof import('../../src/editor/commands/combineNotes')
        >('/src/editor/commands/combineNotes/index.ts')
        combineNotes.execute()
        const combined = history.headStep.value
        const notes = history.state.value.selectedEntities.filter(
            (entity) => entity.type === 'note',
        )
        history.replaceState({
            ...history.state.value,
            selectedEntities: [notes[0]!, notes[0]!, notes[3]!],
        })
        const { splitHold } = await appImport<typeof import('../../src/editor/commands/splitHold')>(
            '/src/editor/commands/splitHold/index.ts',
        )
        splitHold.execute()
        return {
            combined,
            split: history.headStep.value,
            lengths: [...history.state.value.store.slides.note.values()].map(
                (notes) => notes.length,
            ),
        }
    })
    expect(result.combined?.operation).toMatchObject({ id: 'nse.note.combine', data: { notes: 4 } })
    expect(result.split?.operation).toMatchObject({ id: 'nse.note.split', data: { points: 1 } })
    expect(result.lengths.sort()).toEqual([1, 3])
})
