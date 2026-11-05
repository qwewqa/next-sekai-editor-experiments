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

// A connector has no remover, so a connector-only Cut removes nothing: it copies, as Cut of the
// protected initial BPM does, and pushes no step.
test('connector-only Cut copies and leaves no step', async ({ page }) => {
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
    expect(result.undo).toBe(false)
    expect(result.step?.operation).toMatchObject({ id: 'nse.origin' })
    await expect(page.locator('.notification')).toHaveText('Copied 1 object')
})

test('Cut of only the protected initial BPM copies it and leaves no step', async ({ page }) => {
    await seed(page, [[{ beat: 2 }, { beat: 4 }]])
    await page.evaluate(async () => {
        const { history, store, appImport } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [
                [...store.getAllEntities()].find(
                    (entity) => entity.type === 'bpm' && entity.beat === 0,
                )!,
            ],
        })
        const { cut } = await appImport<typeof import('../../src/editor/commands/cut')>(
            '/src/editor/commands/cut/index.ts',
        )
        cut.execute()
    })
    const result = await summary(page)
    expect(result.notes).toHaveLength(2)
    // Before this, a dummy "Cut 0 objects" step was pushed only to carry its notice.
    expect(result.undo).toBe(false)
    expect(result.step?.operation).toMatchObject({ id: 'nse.origin' })
    await expect(page.locator('.notification')).toHaveText('Copied 1 object')
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
        data: { axis: 'horizontal', subject: 'note', changed: { note: 1 } },
    })
    expect(result.second?.operation).toMatchObject({
        id: 'nse.object.flip',
        data: { changed: { note: 1 } },
    })
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
            changed: { note: 1 },
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
        data: { changed: { note: 1 }, transform: { mode: 'composed' } },
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
        data: { changed: { note: 1 }, transform: { mode: 'uniform', factor: 2, pivot: 2 } },
    })
})

test('Scale keeps converging twins and their lineage for a later drag', async ({ page }) => {
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
        const twins = draft.selectedEntities.filter((entity) => entity.type === 'timeScale')
        const twin = twins[0]!
        if (twin.type !== 'timeScale') throw new Error('Missing twin')
        const exactBaseline = session.getScalingBaselineEntity(twin) === originals[0]
        session.beginScalingDrag(twin, twin.beat)
        session.updateScalingDrag(144)
        session.endScalingDrag()
        session.applyScalingSession()
        return {
            exactBaseline,
            draft: twins.map((entity) => [
                entity.beat,
                entity.type === 'timeScale' && entity.timeScale,
            ]),
            step: history.headStep.value,
            timeScales: [...history.state.value.store.grid.timeScale.values()]
                .flatMap((bucket) => [...bucket])
                .map(({ beat, timeScale }) => [beat, timeScale]),
        }
    })
    expect(result.draft).toEqual([
        [96, 2],
        [96, 3],
    ])
    expect(result.exactBaseline).toBe(true)
    expect(result.timeScales).toEqual([
        [144, 2],
        [144, 3],
    ])
    expect(result.step?.operation).toMatchObject({
        id: 'nse.object.scale',
        data: {
            axis: 'beats',
            subject: 'timeScale',
            changed: { timeScale: 2 },
            transform: { mode: 'composed' },
        },
    })
})

test('a scale session stacks moved events after those at their destination and counts only the BPM change it replaced', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { fixtures, show, history, appImport, view } = window.editorTest
        view.division = 1
        const camera = fixtures.events.cameraEvents[0]!
        show({
            ...fixtures.events,
            bpms: [
                { beat: 0, bpm: 120 },
                { beat: 8, bpm: 150 },
                { beat: 12, bpm: 200 },
            ],
            cameraEvents: [
                { ...camera, beat: 4, cameraZoom: 1 },
                { ...camera, beat: 6, cameraZoom: 3 },
                { ...camera, beat: 8, cameraZoom: 2 },
                { ...camera, beat: 12, cameraZoom: 9 },
            ],
        })
        type State = typeof history.state.value
        type Entity = State['selectedEntities'][number]
        const entities = (state: State): Entity[] =>
            [
                ...state.store.grid.cameraEventJoint.values(),
                ...state.store.grid.bpm.values(),
            ].flatMap((bucket) => [...bucket])
        // Each object as its beat and value.
        const tag = (entity: Entity) => [
            entity.beat,
            entity.type === 'cameraEventJoint'
                ? entity.cameraZoom
                : entity.type === 'bpm'
                  ? entity.bpm
                  : NaN,
        ]
        // The chart's objects by beat, camera events first at a beat, each kind in playing order.
        const chart = (state: State) =>
            entities(state)
                .sort((a, b) => a.beat - b.beat)
                .map((entity) => [entity.type === 'bpm' ? 'bpm' : 'camera', ...tag(entity)])
        const selected = (state: State) =>
            state.selectedEntities.map(tag).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
        const source = history.state.value
        history.replaceState({
            ...source,
            selectedEntities: entities(source).filter(
                (entity) =>
                    (entity.type === 'cameraEventJoint' && entity.cameraZoom !== 9) ||
                    (entity.type === 'bpm' && entity.beat === 8),
            ),
        })
        const before = history.state.value
        const session = await appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        const preview =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        // Cancel leaves the chart as it was.
        session.beginScalingSession('beat')
        session.setScalingFactor(2)
        session.cancelScalingSession()
        const cancelled = history.state.value === before && !history.canUndo.value
        // x2 from beat 4, then a drag of the middle event 4 beats later.
        session.beginScalingSession('beat')
        session.setScalingFactor(2)
        const scaled = preview.getPreviewState(history.state.value)
        const middle = scaled.selectedEntities.find(
            (entity) => entity.type === 'cameraEventJoint' && entity.cameraZoom === 3,
        )!
        if (middle.type !== 'cameraEventJoint') throw new Error('Missing middle event')
        session.beginScalingDrag(middle, middle.beat)
        session.updateScalingDrag(middle.beat + 4)
        session.endScalingDrag()
        const draft = preview.getPreviewState(history.state.value)
        session.applyScalingSession()
        const applied = history.state.value
        const step = history.headStep.value?.operation
        history.undoState()
        const undone = chart(history.state.value)
        history.redoState()
        return {
            cancelled,
            scaled: chart(scaled),
            scaledSelection: selected(scaled),
            draft: chart(draft),
            applied: chart(applied),
            selection: selected(applied),
            step,
            undone,
            redone: chart(history.state.value),
            original: chart(before),
        }
    })
    expect(result.cancelled).toBe(true)
    // The unselected 9 stays first at its beat and never joins the selection.
    expect(result.scaled).toEqual([
        ['bpm', 0, 120],
        ['camera', 4, 1],
        ['camera', 8, 3],
        ['camera', 12, 9],
        ['camera', 12, 2],
        ['bpm', 12, 150],
    ])
    expect(result.scaledSelection).toEqual([
        [4, 1],
        [8, 3],
        [12, 2],
        [12, 150],
    ])
    expect(result.draft).toEqual([
        ['bpm', 0, 120],
        ['camera', 8, 1],
        ['camera', 12, 9],
        ['camera', 12, 3],
        ['camera', 16, 2],
        ['bpm', 16, 150],
    ])
    expect(result.applied).toEqual(result.draft)
    expect(result.selection).toEqual([
        [8, 1],
        [12, 3],
        [16, 2],
        [16, 150],
    ])
    expect(result.step).toMatchObject({
        id: 'nse.object.scale',
        data: {
            axis: 'beats',
            subject: 'objects',
            changed: { bpm: 1, cameraEvent: 3 },
            displaced: { bpm: 1 },
        },
    })
    expect(result.undone).toEqual(result.original)
    expect(result.redone).toEqual(result.draft)
})

test('Flip Vertical stacks a moved event after those at its destination and records nothing displaced', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { fixtures, show, history, appImport } = window.editorTest
        const camera = fixtures.events.cameraEvents[0]!
        show({
            ...fixtures.events,
            cameraEvents: [
                { ...camera, beat: 2, cameraZoom: 1 },
                { ...camera, beat: 6, cameraZoom: 2 },
                { ...camera, beat: 6, cameraZoom: 9 },
            ],
        })
        type State = typeof history.state.value
        const cameras = (state: State) =>
            [...state.store.grid.cameraEventJoint.values()]
                .flatMap((bucket) => [...bucket])
                .sort((a, b) => a.beat - b.beat)
        const chart = (state: State) =>
            cameras(state).map((entity) => [entity.beat, entity.cameraZoom])
        const source = history.state.value
        history.replaceState({
            ...source,
            selectedEntities: cameras(source).filter((entity) => entity.cameraZoom !== 9),
        })
        const before = chart(history.state.value)
        const { flipVertical } = await appImport<
            typeof import('../../src/editor/commands/flipVertical')
        >('/src/editor/commands/flipVertical/index.ts')
        flipVertical.execute()
        const flipped = history.state.value
        const step = history.headStep.value?.operation
        history.undoState()
        const undone = chart(history.state.value)
        history.redoState()
        return {
            before,
            flipped: chart(flipped),
            selection: flipped.selectedEntities
                .map((entity) =>
                    entity.type === 'cameraEventJoint' ? [entity.beat, entity.cameraZoom] : [],
                )
                .sort((a, b) => a[0]! - b[0]!),
            step,
            undone,
            redone: chart(history.state.value),
        }
    })
    expect(result.flipped).toEqual([
        [2, 2],
        [6, 9],
        [6, 1],
    ])
    expect(result.selection).toEqual([
        [2, 2],
        [6, 1],
    ])
    expect(result.step).toMatchObject({
        id: 'nse.object.flip',
        data: { axis: 'vertical', subject: 'cameraEvent', changed: { cameraEvent: 2 } },
    })
    expect(result.step).not.toHaveProperty('data.displaced')
    expect(result.undone).toEqual(result.before)
    expect(result.redone).toEqual(result.flipped)
})

// Dragging the factor back to where it started leaves the chart as it was: no step.
// The session ends and the selection is as the session left it.
test('a net-zero Scale Apply pushes no step', async ({ page }) => {
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
    expect(result.undo).toBe(false)
    expect(result.step?.operation).toMatchObject({ id: 'nse.origin' })
})

test('Scale Apply after a source-equivalent State replacement pushes no step', async ({ page }) => {
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
    expect(result.undo).toBe(false)
    expect(result.step?.operation).toMatchObject({ id: 'nse.origin' })
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
                changed: { note: 1 },
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
                changed: { note: 1 },
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
            changed: { note: 2 },
            assignments: [
                { field: 'size', before: { mode: 'varying' }, after: { mode: 'varying' } },
            ],
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
            changed: { note: 1 },
            assignments: [
                {
                    field: 'isCritical',
                    before: { mode: 'uniform', value: false },
                    after: { mode: 'uniform', value: false },
                },
            ],
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
    expect(result.combined?.operation).toMatchObject({
        id: 'nse.note.combine',
        data: { targets: 4 },
    })
    expect(result.split?.operation).toMatchObject({ id: 'nse.note.split', data: { targets: 1 } })
    expect(result.lengths.sort()).toEqual([1, 3])
})

test('Scale Apply after dragging part of a stack away and back keeps the chart and adds no step', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { appImport, fixtures, history, show, store } = window.editorTest
        const session = await appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        const preview =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        const camera = fixtures.events.cameraEvents[0]!
        // S (1) and P (2) share beat 4; P stays unselected.
        show({
            ...fixtures.events,
            isDynamicStages: true,
            cameraEvents: [
                [0, 0],
                [4, 1],
                [4, 2],
                [12, 3],
            ].map(([beat, cameraLeft]) => ({ ...camera, beat: beat!, cameraLeft: cameraLeft! })),
        })
        const cameraAt = (state: typeof history.state.value) =>
            [...new Set([...state.store.grid.cameraEventJoint.values()].flatMap((b) => [...b]))]
                .filter((entity) => entity.beat === 4)
                .map((entity) => entity.cameraLeft)
        const events = [...store.getAllEntities()].filter(
            (entity) => entity.type === 'cameraEventJoint',
        )
        const s = events.find((entity) => entity.cameraLeft === 1)!
        if (s.type !== 'cameraEventJoint') throw new Error('Missing S')
        history.replaceState({
            ...history.state.value,
            selectedEntities: events.filter((entity) => entity.cameraLeft !== 2),
        })
        const before = history.state.value
        const head = history.headStep.value
        const opened = session.beginScalingSession('beat')
        const drags = [
            session.beginScalingDrag(s, 4),
            session.updateScalingDrag(8),
            (session.endScalingDrag(), true),
            session.beginScalingDrag(s, 8),
            session.updateScalingDrag(4),
            (session.endScalingDrag(), true),
        ]
        const draft = cameraAt(preview.getPreviewState(history.state.value))
        session.applyScalingSession()
        return {
            opened: !!opened,
            drags,
            draft,
            after: cameraAt(history.state.value),
            unchanged: history.state.value.store === before.store,
            sameHead: history.headStep.value === head,
            undo: history.canUndo.value,
        }
    })
    expect(result).toMatchObject({
        opened: true,
        drags: [true, true, true, true, true, true],
        draft: [2, 1],
        after: [1, 2],
        unchanged: true,
        sameHead: true,
        undo: false,
    })
})
