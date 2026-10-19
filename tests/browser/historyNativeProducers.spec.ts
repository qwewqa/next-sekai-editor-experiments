import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const headOperation = (page: Page) =>
    page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { decodeOperation } = await appImport<typeof import('../../src/history/operations')>(
            '/src/history/operations/index.ts',
        )
        const step = history.headStep.value
        if (!step) throw new Error('Missing emitted step')
        const decoded = decodeOperation(step.operation)
        if (decoded.status !== 'known') throw new Error('Producer emitted an unsupported operation')
        return decoded.operation
    })

const prepareDynamicPaste = (page: Page) =>
    page.evaluate(async () => {
        const { show, fixtures, history, appImport, view } = window.editorTest
        const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
            '/src/editor/commands/copy/index.ts',
        )
        const { createElevationNote } = await appImport<
            typeof import('../../src/editor/elevation/actions')
        >('/src/editor/elevation/actions.ts')
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [[{ ...base, beat: 2 }]],
                cameraEvents: [{ ...fixtures.events.cameraEvents[0]!, beat: 2 }],
            },
            1,
        )
        const source = history.state.value
        history.replaceState({
            ...source,
            selectedEntities: [
                ...[...source.store.slides.note.values()].flat(),
                ...[...source.store.grid.cameraEventJoint.values()].flatMap((bucket) => [
                    ...bucket,
                ]),
            ],
        })
        copy.execute()
        show({ ...fixtures.interaction, slides: [], isDynamicStages: false }, 1)
        view.layout = 'basic'
        // A real edit lets Undo/Redo return to exactly the state captured by the prompt.
        createElevationNote(-4, 0, 0, false)
    })

const currentEffects = (page: Page) =>
    page.evaluate(async () => {
        const { history, view, appImport } = window.editorTest
        const { loadedStates } =
            await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        const { toolName } = await appImport<typeof import('../../src/editor/tools/state')>(
            '/src/editor/tools/state.ts',
        )
        const { notification } = await appImport<typeof import('../../src/editor/notification')>(
            '/src/editor/notification.ts',
        )
        const source = history.state.value
        return {
            dynamic: source.isDynamicStages,
            notes: [...source.store.slides.note.values()]
                .flat()
                .map(({ beat, left, size }) => ({ beat, left, size })),
            events: [...source.store.grid.cameraEventJoint.values()]
                .flatMap((bucket) => [...bucket])
                .map(({ beat }) => beat),
            step: history.headStep.value,
            steps: loadedStates().length,
            tool: toolName.value,
            group: view.groupId,
            stage: view.stageId,
            notification: notification.value.id,
        }
    })

const invalidatePrompt = (page: Page, boundary: 'reset' | 'undoRedo' | 'peek') =>
    page.evaluate((boundary) => {
        const { history, show, fixtures } = window.editorTest
        if (boundary === 'reset')
            show({ ...fixtures.interaction, isDynamicStages: false, slides: [] })
        else if (boundary === 'undoRedo') {
            history.undoState()
            history.redoState()
        } else {
            history.peek.value = { source: 'native-producer-test', state: history.state.value }
            history.peek.value = undefined
        }
    }, boundary)

for (const boundary of ['reset', 'undoRedo', 'peek'] as const)
    test(`Dynamic Stages confirmation is stale after ${boundary} even when answering Cancel`, async ({
        page,
    }) => {
        await prepareDynamicPaste(page)
        const pending = page.evaluate(async () => {
            const { requestDynamicStages } = await window.editorTest.appImport<
                typeof import('../../src/history/dynamicStages')
            >('/src/history/dynamicStages.ts')
            return await requestDynamicStages()
        })
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await invalidatePrompt(page, boundary)
        const before = await currentEffects(page)
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
        expect(await pending).toBe('stale')
        expect(await currentEffects(page)).toEqual(before)
    })

test('another successful enable does not make the older Dynamic Stages request current', async ({
    page,
}) => {
    await prepareDynamicPaste(page)
    const request = () =>
        page.evaluate(async () => {
            const { requestDynamicStages } = await window.editorTest.appImport<
                typeof import('../../src/history/dynamicStages')
            >('/src/history/dynamicStages.ts')
            return await requestDynamicStages()
        })
    const old = request()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    const newer = request()
    await expect(page.locator('[role="dialog"]')).toHaveCount(2)
    await page
        .locator('[role="dialog"]')
        .last()
        .getByRole('button', { name: 'Confirm', exact: true })
        .click()
    expect(await newer).toBe('enabled')
    const before = await currentEffects(page)
    expect(before.dynamic).toBe(true)
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click()
    expect(await old).toBe('stale')
    expect(await currentEffects(page)).toEqual(before)
    const fastPaths = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { checkDynamicStages, requestDynamicStages } = await appImport<
            typeof import('../../src/history/dynamicStages')
        >('/src/history/dynamicStages.ts')
        history.peek.value = { source: 'enabled-read-only-test', state: history.state.value }
        try {
            return {
                enabled: await checkDynamicStages(),
                cancelledOrigin: await requestDynamicStages(() => false),
            }
        } finally {
            history.peek.value = undefined
        }
    })
    expect(fastPaths).toEqual({ enabled: true, cancelledOrigin: 'stale' })
    expect(await currentEffects(page)).toEqual(before)
})

test('the boolean event-tool consumer does not switch tools after its confirmation becomes stale', async ({
    page,
}) => {
    await prepareDynamicPaste(page)
    const pending = page.evaluate(async () => {
        const { cameraEvent } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/events/camera')
        >('/src/editor/commands/events/camera/index.ts')
        await cameraEvent.execute()
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await invalidatePrompt(page, 'peek')
    const before = await currentEffects(page)
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await pending
    expect(await currentEffects(page)).toEqual(before)
})

for (const at of ['position', 'pointer'] as const)
    test(`a stale ${at} Paste stops before chart and history changes`, async ({ page }) => {
        await prepareDynamicPaste(page)
        const pending = page.evaluate(async (at) => {
            const { appImport, point } = window.editorTest
            const { paste, pasteAtPosition } = await appImport<
                typeof import('../../src/editor/tools/paste')
            >('/src/editor/tools/paste/index.ts')
            const modifiers = { ctrl: false, shift: false }
            if (at === 'position')
                return await pasteAtPosition(-1, 2, modifiers, { composed: true })
            const target = point(-1, 4)
            paste.dragStart!(target.x, target.y, modifiers)
            paste.dragUpdate!(target.x, target.y, modifiers)
            return await paste.dragEnd!(target.x, target.y, modifiers)
        }, at)
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await invalidatePrompt(page, at === 'position' ? 'reset' : 'undoRedo')
        const before = await currentEffects(page)
        await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
        expect(await pending).toBeUndefined()
        expect(await currentEffects(page)).toEqual(before)
    })

for (const enable of [false, true])
    test(`a current mixed Paste preserves ordinary ${enable ? 'Enable and Composed placement' : 'Cancel and non-event placement'}`, async ({
        page,
    }) => {
        await prepareDynamicPaste(page)
        const pending = page.evaluate(async (enable) => {
            const { appImport, view } = window.editorTest
            const { pasteAtPosition } = await appImport<
                typeof import('../../src/editor/tools/paste')
            >('/src/editor/tools/paste/index.ts')
            view.layout = enable ? 'composed' : 'basic'
            return await pasteAtPosition(-1, 2, { ctrl: false, shift: false }, { composed: true })
        }, enable)
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        const before = await currentEffects(page)
        await dialog
            .getByRole('button', { name: enable ? 'Confirm' : 'Cancel', exact: true })
            .click()
        expect(await pending).toBe(4)
        const after = await currentEffects(page)
        expect(after.steps - before.steps).toBe(enable ? 2 : 1)
        expect(after.dynamic).toBe(enable)
        expect(after.notes.map(({ beat }) => beat)).toEqual([0, 4])
        expect(after.events).toEqual(enable ? [4] : [])
        expect(await headOperation(page)).toMatchObject({
            id: 'nse.object.paste',
            data: {
                placed: enable ? { note: 1, cameraEvent: 1 } : { note: 1 },
                displaced: {},
                variant: enable ? 'composed' : 'basic',
                flipped: false,
                at: 'position',
            },
        })
    })

test('a cancelled pointer Paste cannot enable stages or consume a replacement drag and its ghost', async ({
    page,
}) => {
    await prepareDynamicPaste(page)
    const old = page.evaluate(async () => {
        const { appImport, point } = window.editorTest
        const { paste } = await appImport<typeof import('../../src/editor/tools/paste')>(
            '/src/editor/tools/paste/index.ts',
        )
        const at = point(-1, 4)
        const modifiers = { ctrl: false, shift: false }
        paste.dragStart!(at.x, at.y, modifiers)
        return await paste.dragEnd!(at.x, at.y, modifiers)
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const replacementGhost = await page.evaluate(async () => {
        const { appImport, point, view } = window.editorTest
        const { paste } = await appImport<typeof import('../../src/editor/tools/paste')>(
            '/src/editor/tools/paste/index.ts',
        )
        paste.dragCancel!()
        const at = point(2, 6)
        const modifiers = { ctrl: false, shift: false }
        paste.dragStart!(at.x, at.y, modifiers)
        paste.dragUpdate!(at.x, at.y, modifiers)
        return view.entities.creating.map(({ type, beat }) => ({ type, beat }))
    })
    expect(replacementGhost.length).toBeGreaterThan(0)
    const before = await currentEffects(page)
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await old
    expect(await currentEffects(page)).toEqual(before)
    expect(
        await page.evaluate(() =>
            window.editorTest.view.entities.creating.map(({ type, beat }) => ({ type, beat })),
        ),
    ).toEqual(replacementGhost)
    const replacement = page.evaluate(async () => {
        const { appImport, point } = window.editorTest
        const { paste } = await appImport<typeof import('../../src/editor/tools/paste')>(
            '/src/editor/tools/paste/index.ts',
        )
        const at = point(2, 6)
        return await paste.dragEnd!(at.x, at.y, { ctrl: false, shift: false })
    })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await replacement
    const after = await currentEffects(page)
    expect(after.steps - before.steps).toBe(1)
    expect(after.dynamic).toBe(false)
    expect(after.notes.map(({ beat }) => beat)).toEqual([0, 6])
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.object.paste',
        data: {
            placed: { note: 1 },
            displaced: {},
            variant: 'basic',
            flipped: false,
            at: 'pointer',
        },
    })
})

test('notes-only elevation Paste skips an unrelated event enable prompt', async ({ page }) => {
    await prepareDynamicPaste(page)
    await page.evaluate(async () => {
        const { pasteElevationNotes } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/actions')
        >('/src/editor/elevation/actions.ts')
        await pasteElevationNotes(-1, 2, 4, { ctrl: false, shift: false })
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const effects = await currentEffects(page)
    expect(effects.dynamic).toBe(false)
    expect(effects.events).toEqual([])
    expect(effects.notes.map(({ beat }) => beat)).toEqual([0, 4])
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.object.paste',
        data: {
            placed: { note: 1 },
            displaced: {},
            variant: 'basic',
            flipped: false,
            at: 'position',
        },
    })
})

test('twelve actual Note, Slide and elevation Adds capture twelve fresh notes', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { show, fixtures, history, point, appImport, view } = window.editorTest
        const { tools } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        const { createElevationNote } = await appImport<
            typeof import('../../src/editor/elevation/actions')
        >('/src/editor/elevation/actions.ts')
        const { loadedStates } =
            await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        show({ ...fixtures.interaction, slides: [] }, 3)
        view.layout = 'basic'
        const operations = []
        for (const tool of ['note', 'slide'] as const) {
            for (let i = 0; i < 4; i++) {
                const at = point(tool === 'note' ? -4 : 2, 1 + i + (tool === 'slide' ? 4 : 0))
                await tools[tool].tap!(at.x, at.y, { ctrl: false, shift: false })
                operations.push(history.headStep.value!.operation)
            }
        }
        for (let i = 0; i < 4; i++) {
            createElevationNote(-2, i, 9 + i, i % 2 === 0)
            operations.push(history.headStep.value!.operation)
        }
        const count = () => [...history.state.value.store.slides.note.values()].flat().length
        const total = count()
        const steps = loadedStates().length - 1
        history.undoState()
        const undone = count()
        history.redoState()
        return { operations, total, steps, undone, redone: count() }
    })
    expect(result).toMatchObject({ total: 12, steps: 12, undone: 11, redone: 12 })
    expect(result.operations).toHaveLength(12)
    for (const operation of result.operations)
        expect(operation).toMatchObject({ id: 'nse.note.add', data: { created: 1 } })
})

test('Generate captures only its three fresh notes and a repeat adds no step', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { show, fixtures, history, view, appImport } = window.editorTest
        const { applyGeneratedSlideNotes } = await appImport<
            typeof import('../../src/editor/tools/generateSlideNotes')
        >('/src/editor/tools/generateSlideNotes/index.ts')
        const base = fixtures.interaction.slides[0]![0]!
        show({
            ...fixtures.interaction,
            slides: [
                [
                    { ...base, beat: 0 },
                    { ...base, beat: 4 },
                ],
            ],
        })
        view.division = 1
        const notes = () => [...history.state.value.store.slides.note.values()].flat()
        applyGeneratedSlideNotes(notes())
        const first = history.headStep.value
        const beats = notes().map(({ beat }) => beat)
        applyGeneratedSlideNotes(notes())
        return { beats, operation: first!.operation, sameStep: history.headStep.value === first }
    })
    expect(result.beats).toEqual([0, 1, 2, 3, 4])
    expect(result.operation).toMatchObject({ id: 'nse.note.generate', data: { created: 3 } })
    expect(result.sameStep).toBe(true)
})

test('BPM producer captures initial anchor and actual first destination replacement, preserving a zero-result edit', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { show, fixtures, history, appImport } = window.editorTest
        const { editBpm } = await appImport<typeof import('../../src/editor/tools/bpm')>(
            '/src/editor/tools/bpm/index.ts',
        )
        const { loadedStates } =
            await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        show({
            ...fixtures.interaction,
            slides: [],
            bpms: [
                { beat: 0, bpm: 120 },
                { beat: 4, bpm: 130 },
                { beat: 4, bpm: 140 },
            ],
        })
        const initial = [...history.state.value.store.grid.bpm.values()]
            .flatMap((bucket) => [...bucket])
            .find(({ beat }) => !beat)!
        editBpm(initial, { beat: 4 })
        const replacement = history.headStep.value!.operation
        const bpms = [...history.state.value.store.grid.bpm.values()]
            .flatMap((bucket) => [...bucket])
            .map(({ beat, bpm }) => [beat, bpm])
            .sort((a, b) => a[0]! - b[0]!)
        const selected = history.state.value.selectedEntities[0]!
        if (selected.type !== 'bpm') throw new Error('Missing moved BPM')
        editBpm(selected, { bpm: selected.bpm })
        return { replacement, bpms, steps: loadedStates().length - 1 }
    })
    expect(result.replacement).toMatchObject({
        id: 'nse.object.replace',
        data: { subject: 'bpm', targets: 1, displaced: { bpm: 1 }, retainedInitialBpm: true },
    })
    expect(result.bpms).toEqual([
        [0, 120],
        [4, 140],
        [4, 120],
    ])
    expect(result.steps).toBe(2)
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.object.edit',
        data: { subject: 'bpm', targets: 0, displaced: {} },
    })
})

test('Time Scale producer captures both actually replaced same-group destination members', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { show, fixtures, history, appImport } = window.editorTest
        const { editTimeScale } = await appImport<
            typeof import('../../src/editor/tools/timeScale')
        >('/src/editor/tools/timeScale/index.ts')
        const base = fixtures.events.timeScales[0]!
        show({
            ...fixtures.interaction,
            slides: [],
            timeScales: [
                {
                    ...base,
                    beat: 2,
                    groupId: fixtures.interaction.groups.keys().next().value!,
                    timeScale: 1,
                },
                {
                    ...base,
                    beat: 4,
                    groupId: fixtures.interaction.groups.keys().next().value!,
                    timeScale: 2,
                },
                {
                    ...base,
                    beat: 4,
                    groupId: fixtures.interaction.groups.keys().next().value!,
                    timeScale: 3,
                },
                {
                    ...base,
                    beat: 4,
                    groupId: [...fixtures.interaction.groups.keys()][1]!,
                    timeScale: 4,
                },
            ],
        })
        const before = [...history.state.value.store.grid.timeScale.values()]
            .flatMap((bucket) => [...bucket])
            .find(({ beat }) => beat === 2)!
        editTimeScale(before, { beat: 4 })
        return [...history.state.value.store.grid.timeScale.values()]
            .flatMap((bucket) => [...bucket])
            .map(({ beat, groupId, timeScale }) => [beat, groupId, timeScale])
    })
    expect(result).toEqual([
        [4, 2, 4],
        [4, 1, 1],
    ])
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.object.replace',
        data: { subject: 'timeScale', targets: 1, displaced: { timeScale: 2 } },
    })
})

test('all five native event tool Adds retain their typed event subjects', async ({ page }) => {
    const operations = await page.evaluate(async () => {
        const { show, fixtures, history, point, appImport, view } = window.editorTest
        const { tools } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        const results = []
        for (const tool of [
            'cameraEvent',
            'stageMaskEvent',
            'stagePivotEvent',
            'stageStyleEvent',
            'stageTransformEvent',
        ] as const) {
            show({ ...fixtures.interaction, slides: [] }, 1)
            view.layout = 'basic'
            const at = point(0, 2)
            await tools[tool].tap!(at.x, at.y, { ctrl: false, shift: false })
            results.push({
                tool,
                operation: history.headStep.value!.operation,
                selected: history.state.value.selectedEntities.map(({ type, beat }) => ({
                    type,
                    beat,
                })),
            })
        }
        return results
    })
    expect(operations).toHaveLength(5)
    for (const { tool, operation, selected } of operations) {
        expect(operation).toMatchObject({
            id: 'nse.object.add',
            data: { subject: tool, created: 1 },
        })
        expect(selected).toEqual([{ type: `${tool}Joint`, beat: 2 }])
    }
})

for (const direction of ['horizontal', 'pinned'] as const)
    test(`Select counts its changed native note with an ${direction === 'pinned' ? 'initial pinned' : 'unchanged'} BPM selected`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (direction) => {
            const { show, fixtures, history, point, appImport, view } = window.editorTest
            const { tools, switchToolTo } = await appImport<
                typeof import('../../src/editor/tools')
            >('/src/editor/tools/index.ts')
            const base = fixtures.interaction.slides[0]![0]!
            show(
                { ...fixtures.interaction, slides: [[{ ...base, beat: 2, left: -2, size: 2 }]] },
                1,
            )
            view.layout = 'basic'
            const state = history.state.value
            const note = [...state.store.slides.note.values()].flat()[0]!
            const bpm = [...state.store.grid.bpm.values()].flatMap((bucket) => [...bucket])[0]!
            history.replaceState({ ...state, selectedEntities: [bpm, note] })
            switchToolTo('select')
            const start = point(-1, 2)
            const end = point(direction === 'horizontal' ? 0 : -1, direction === 'pinned' ? 1 : 2)
            const modifiers = { ctrl: false, shift: false }
            tools.select.dragStart!(start.x, start.y, modifiers)
            tools.select.dragUpdate!(end.x, end.y, modifiers)
            await tools.select.dragEnd!(end.x, end.y, modifiers)
            return {
                note: [...history.state.value.store.slides.note.values()]
                    .flat()
                    .map(({ beat, left }) => ({ beat, left })),
                bpms: [...history.state.value.store.grid.bpm.values()]
                    .flatMap((bucket) => [...bucket])
                    .map(({ beat }) => beat),
            }
        }, direction)
        expect(result.bpms).toEqual([0])
        expect(result.note).toEqual([
            { beat: direction === 'pinned' ? 1 : 2, left: direction === 'horizontal' ? -1 : -2 },
        ])
        expect(await headOperation(page)).toMatchObject({
            id: 'nse.object.move',
            data: { subject: 'note', targets: 1, displaced: {} },
        })
    })

test('Brush captures coupled Note fields, ignores derived connector operands and preserves its no-op gate', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { show, fixtures, history, appImport } = window.editorTest
        const { applyBrushToEntities, brushProperties } = await appImport<
            typeof import('../../src/editor/tools/brush')
        >('/src/editor/tools/brush/index.ts')
        const base = fixtures.interaction.slides[0]![0]!
        show({
            ...fixtures.interaction,
            slides: [
                [
                    { ...base, beat: 0, isFake: true, connectorIsFake: false },
                    { ...base, beat: 2, isAttached: true },
                    { ...base, beat: 4 },
                ],
            ],
        })
        const source = history.state.value
        const notes = [...source.store.slides.note.values()].flat()
        const connector = [...source.store.slides.connector.values()].flat()[0]!
        brushProperties.value = { isFake: true }
        applyBrushToEntities([notes[0]!, connector])
        const coupled = history.headStep.value!.operation
        const head = [...history.state.value.store.slides.note.values()].flat()[0]!
        const tick = [...history.state.value.store.slides.note.values()].flat()[1]!
        const step = history.headStep.value
        brushProperties.value = { size: 999 }
        applyBrushToEntities([tick])
        const unchangedStep = history.headStep.value === step
        const unchangedSize = [...history.state.value.store.slides.note.values()].flat()[1]!.size
        brushProperties.value = { isAttached: false, size: 5 }
        applyBrushToEntities([tick])
        const detached = history.state.value.selectedEntities[0]!
        return {
            coupled,
            connectorFake: head.connectorIsFake,
            unchangedStep,
            unchangedSize,
            originalSize: tick.size,
            detached:
                detached.type === 'note'
                    ? { isAttached: detached.isAttached, size: detached.size }
                    : undefined,
        }
    })
    expect(result).toMatchObject({
        connectorFake: true,
        unchangedStep: true,
        detached: { isAttached: false, size: 5 },
    })
    expect(result.unchangedSize).toBe(result.originalSize)
    expect(result.coupled).toMatchObject({
        id: 'nse.object.brush',
        data: {
            subject: 'note',
            targets: 1,
            assignments: [{ field: 'isFake', value: { mode: 'uniform', value: true } }],
        },
    })
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.object.brush',
        data: {
            subject: 'note',
            targets: 1,
            assignments: [
                { field: 'isAttached', value: { mode: 'uniform', value: false } },
                { field: 'size', value: { mode: 'uniform', value: 5 } },
            ],
        },
    })
})

test('Eraser preserves a connector-only step with zero native removals and Delete excludes initial BPM', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { show, fixtures, history, appImport } = window.editorTest
        const { remove } = await appImport<typeof import('../../src/editor/tools/eraser')>(
            '/src/editor/tools/eraser.ts',
        )
        const { deleteSelection } = await appImport<
            typeof import('../../src/editor/commands/deleteSelection')
        >('/src/editor/commands/deleteSelection/index.ts')
        const { loadedStates } =
            await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        const base = fixtures.interaction.slides[0]![0]!
        show({
            ...fixtures.interaction,
            slides: [
                [
                    { ...base, beat: 0 },
                    { ...base, beat: 4 },
                ],
            ],
        })
        const source = history.state.value
        const connector = [...source.store.slides.connector.values()].flat()[0]!
        remove([connector])
        const zero = history.headStep.value!.operation
        const state = history.state.value
        const note = [...state.store.slides.note.values()].flat()[0]!
        const initial = [...state.store.grid.bpm.values()].flatMap((bucket) => [...bucket])[0]!
        history.replaceState({ ...state, selectedEntities: [note, initial] })
        deleteSelection.execute()
        return {
            zero,
            steps: loadedStates().length - 1,
            notes: [...history.state.value.store.slides.note.values()]
                .flat()
                .map(({ beat }) => beat),
            bpms: [...history.state.value.store.grid.bpm.values()]
                .flatMap((bucket) => [...bucket])
                .map(({ beat }) => beat),
        }
    })
    expect(result).toMatchObject({
        zero: { id: 'nse.object.delete', data: { removed: {} } },
        steps: 2,
        notes: [4],
        bpms: [0],
    })
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.object.delete',
        data: { removed: { note: 1 } },
    })
})

for (const mode of [
    { variant: 'basic', at: 'position', flipped: false },
    { variant: 'basic', at: 'pointer', flipped: true },
    { variant: 'composed', at: 'position', flipped: true },
    { variant: 'composed', at: 'pointer', flipped: false },
] as const)
    test(`Paste ${mode.variant}/${mode.at} captures final placed/replaced counts after repeated previews`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (mode) => {
            const { show, fixtures, history, appImport, view, point } = window.editorTest
            const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
                '/src/editor/commands/copy/index.ts',
            )
            const { paste, pasteAtPosition } = await appImport<
                typeof import('../../src/editor/tools/paste')
            >('/src/editor/tools/paste/index.ts')
            const { loadedStates } =
                await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
            Object.defineProperty(navigator.clipboard, 'writeText', {
                configurable: true,
                value: async () => undefined,
            })
            const base = fixtures.interaction.slides[0]![0]!
            const scale = fixtures.events.timeScales[0]!
            const blank = { ...fixtures.interaction, slides: [], timeScales: [] }
            view.layout = mode.variant
            show(
                {
                    ...blank,
                    slides: [[{ ...base, beat: 2 }]],
                    bpms: [
                        { beat: 0, bpm: 120 },
                        { beat: 2, bpm: 150 },
                    ],
                    timeScales: [
                        {
                            ...scale,
                            beat: 2,
                            groupId: fixtures.interaction.groups.keys().next().value!,
                            timeScale: 2,
                        },
                        {
                            ...scale,
                            beat: 2,
                            groupId: fixtures.interaction.groups.keys().next().value!,
                            timeScale: 3,
                        },
                    ],
                },
                2,
            )
            const source = history.state.value
            history.replaceState({
                ...source,
                selectedEntities: [...source.store.slides.note.values()].flat(),
            })
            history.replaceState({
                ...history.state.value,
                selectedEntities: [
                    ...history.state.value.selectedEntities,
                    ...[...source.store.grid.bpm.values()]
                        .flatMap((bucket) => [...bucket])
                        .filter(({ beat }) => beat === 2),
                    ...[...source.store.grid.timeScale.values()].flatMap((bucket) => [...bucket]),
                ],
            })
            copy.execute()
            show(
                {
                    ...blank,
                    bpms: [
                        { beat: 0, bpm: 120 },
                        { beat: 4, bpm: 130 },
                        { beat: 4, bpm: 140 },
                    ],
                    timeScales: [
                        {
                            ...scale,
                            beat: 4,
                            groupId: fixtures.interaction.groups.keys().next().value!,
                            timeScale: 0.5,
                        },
                        {
                            ...scale,
                            beat: 4,
                            groupId: fixtures.interaction.groups.keys().next().value!,
                            timeScale: 0.75,
                        },
                    ],
                },
                2,
            )
            view.layout = mode.variant
            const at = point(-1, 4)
            const modifiers = { ctrl: false, shift: mode.flipped }
            paste.dragStart!(at.x, at.y, modifiers)
            for (let i = 0; i < 5; i++) paste.dragUpdate!(at.x, at.y, modifiers)
            const stepsBefore = loadedStates().length - 1
            if (mode.at === 'pointer') await paste.dragEnd!(at.x, at.y, modifiers)
            else {
                paste.dragCancel?.()
                await pasteAtPosition(-1, 2, modifiers, { composed: true })
            }
            const state = history.state.value
            return {
                stepsBefore,
                stepsAfter: loadedStates().length - 1,
                selected: state.selectedEntities.map(({ type, beat }) => ({ type, beat })),
                scales: [...state.store.grid.timeScale.values()]
                    .flatMap((bucket) => [...bucket])
                    .map(({ timeScale }) => timeScale),
                bpms: [...state.store.grid.bpm.values()]
                    .flatMap((bucket) => [...bucket])
                    .map(({ beat, bpm }) => [beat, bpm]),
            }
        }, mode)
        expect(result.stepsBefore).toBe(0)
        expect(result.stepsAfter).toBe(1)
        expect(result.selected).toHaveLength(4)
        expect(result.selected.every(({ beat }) => beat === 4)).toBe(true)
        expect(result.scales).toEqual([2, 3])
        expect(result.bpms).toEqual([
            [0, 120],
            [4, 140],
            [4, 150],
        ])
        expect(await headOperation(page)).toMatchObject({
            id: 'nse.object.paste',
            data: {
                placed: { note: 1, bpm: 1, timeScale: 2 },
                displaced: { bpm: 1, timeScale: 2 },
                ...mode,
            },
        })
    })

test('declining Dynamic Stages preserves a zero-output Paste step with factual empty counts', async ({
    page,
}) => {
    const pending = page.evaluate(async () => {
        const { show, fixtures, history, appImport } = window.editorTest
        const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
            '/src/editor/commands/copy/index.ts',
        )
        const { pasteAtPosition } = await appImport<typeof import('../../src/editor/tools/paste')>(
            '/src/editor/tools/paste/index.ts',
        )
        const { loadedStates } =
            await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        show({
            ...fixtures.interaction,
            slides: [],
            cameraEvents: [{ ...fixtures.events.cameraEvents[0]!, beat: 2 }],
        })
        const source = history.state.value
        history.replaceState({
            ...source,
            selectedEntities: [...source.store.grid.cameraEventJoint.values()].flatMap((bucket) => [
                ...bucket,
            ]),
        })
        copy.execute()
        show({ ...fixtures.interaction, slides: [], isDynamicStages: false, cameraEvents: [] })
        await pasteAtPosition(0, 0, { ctrl: false, shift: false })
        return {
            steps: loadedStates().length - 1,
            selected: history.state.value.selectedEntities.length,
            dynamic: history.state.value.isDynamicStages,
            events: [...history.state.value.store.grid.cameraEventJoint.values()].flatMap(
                (bucket) => [...bucket],
            ).length,
        }
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await pending).toEqual({ steps: 1, selected: 0, dynamic: false, events: 0 })
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.object.paste',
        data: { placed: {}, displaced: {}, variant: 'basic', flipped: false, at: 'position' },
    })
})
