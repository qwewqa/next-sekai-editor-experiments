import { expect, test, type Page } from '@playwright/test'
import { confirmWhenReady } from './confirmWhenReady'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// What History records for an edit: collateral removals and additions,
// the one id for one result, the default events Dynamic Stages adds, and where a level came from.

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
        if (decoded.status !== 'known') throw new Error('Unsupported operation')
        return decoded.operation
    })

const showBpms = (page: Page, beats: number[], withNote: number | undefined) =>
    page.evaluate(
        ({ beats, withNote }) => {
            const { show, fixtures, history, view } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show({
                ...fixtures.interaction,
                slides:
                    withNote === undefined
                        ? []
                        : [[{ ...base, beat: withNote, left: -2, size: 2 }]],
                bpms: [{ beat: 0, bpm: 120 }, ...beats.map((beat) => ({ beat, bpm: 100 + beat }))],
            })
            view.layout = 'basic'
            return [...history.state.value.store.grid.bpm.values()]
                .flatMap((bucket) => [...bucket])
                .map(({ beat, bpm }) => [beat, bpm])
                .sort((a, b) => a[0]! - b[0]!)
        },
        { beats, withNote },
    )

test('Flip Vertical records the BPM it replaced at a destination', async ({ page }) => {
    // The BPM at 2 and the note at 6 swap places; the unselected BPM at 6 is in the way.
    await showBpms(page, [2, 6], 6)
    await page.evaluate(async () => {
        const { history, store, appImport } = window.editorTest
        const entities = [...store.getAllEntities()]
        const moving = entities.find((entity) => entity.type === 'bpm' && entity.beat === 2)!
        const note = entities.find((entity) => entity.type === 'note')!
        history.replaceState({ ...history.state.value, selectedEntities: [moving, note] })
        const { flipVertical } = await appImport<
            typeof import('../../src/editor/commands/flipVertical')
        >('/src/editor/commands/flipVertical/index.ts')
        flipVertical.execute()
    })
    const operation = await headOperation(page)
    expect(operation).toMatchObject({
        id: 'nse.object.flip',
        data: {
            axis: 'vertical',
            subject: 'objects',
            changed: { note: 1, bpm: 1 },
            displaced: { bpm: 1 },
        },
    })
    expect(operation.data).not.toHaveProperty('retainedInitialBpm')
    // One BPM left at the beat: the occupant went.
    expect(
        await page.evaluate(
            () =>
                [...window.editorTest.store.getAllEntities()].filter(
                    (entity) => entity.type === 'bpm' && entity.beat === 6,
                ).length,
        ),
    ).toBe(1)
})

test('Flip Vertical of the initial BPM records that it was kept at beat 0', async ({ page }) => {
    await showBpms(page, [], 4)
    await page.evaluate(async () => {
        const { history, store, appImport } = window.editorTest
        const entities = [...store.getAllEntities()]
        history.replaceState({
            ...history.state.value,
            selectedEntities: [
                entities.find((entity) => entity.type === 'bpm' && entity.beat === 0)!,
                entities.find((entity) => entity.type === 'note')!,
            ],
        })
        const { flipVertical } = await appImport<
            typeof import('../../src/editor/commands/flipVertical')
        >('/src/editor/commands/flipVertical/index.ts')
        flipVertical.execute()
    })
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.object.flip',
        data: { axis: 'vertical', subject: 'objects', retainedInitialBpm: true },
    })
})

test('the Select tool records a BPM moved onto an occupied beat as a replacement, as the BPM tool does', async ({
    page,
}) => {
    await showBpms(page, [2, 4], undefined)
    const selectDrag = (page: Page) =>
        page.evaluate(async () => {
            const { history, store, point, appImport } = window.editorTest
            const { tools, switchToolTo } = await appImport<
                typeof import('../../src/editor/tools')
            >('/src/editor/tools/index.ts')
            const moving = [...store.getAllEntities()].find(
                (entity) => entity.type === 'bpm' && entity.beat === 2,
            )!
            history.replaceState({ ...history.state.value, selectedEntities: [moving] })
            switchToolTo('select')
            const modifiers = { ctrl: false, shift: false }
            // The BPM is grabbed on its label, so a drop a quarter beat past 4 lands it on 4.
            const start = point(6, 2)
            const end = point(6, 4.25)
            tools.select.dragStart!(start.x, start.y, modifiers)
            tools.select.dragUpdate!(end.x, end.y, modifiers)
            await tools.select.dragEnd!(end.x, end.y, modifiers)
            return [...store.getAllEntities()]
                .filter((entity) => entity.type === 'bpm')
                .map(({ beat }) => beat)
                .sort((a, b) => a - b)
        })
    expect(await selectDrag(page)).toEqual([0, 4])
    const operation = await headOperation(page)
    expect(operation).toMatchObject({
        id: 'nse.object.replace',
        data: { subject: 'bpm', changed: { bpm: 1 }, displaced: { bpm: 1 } },
    })
})

test('Dynamic Stages records the default events it adds', async ({ page }) => {
    await page.evaluate(async () => {
        const { show, fixtures, appImport } = window.editorTest
        show({ ...fixtures.interaction, slides: [], isDynamicStages: false })
        const { requestDynamicStages } = await appImport<
            typeof import('../../src/history/dynamicStages')
        >('/src/history/dynamicStages.ts')
        ;(window as unknown as { outcome: Promise<string> }).outcome = requestDynamicStages()
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await confirmWhenReady(dialog.getByRole('button', { name: 'Confirm', exact: true }), dialog)
    expect(
        await page.evaluate(() => (window as unknown as { outcome: Promise<string> }).outcome),
    ).toBe('enabled')
    expect(await headOperation(page)).toMatchObject({
        id: 'nse.dynamicStages.enable',
        data: { created: { stageMaskEvent: 1, stagePivotEvent: 1, stageStyleEvent: 1 } },
    })
})

test('a level opened or imported says where it came from, and a recovery says so only for a recovery', async ({
    page,
}) => {
    const origins = await page.evaluate(async () => {
        const { history, fixtures, appImport } = window.editorTest
        const { openState, resetImportedState } =
            await appImport<typeof import('../../src/history')>('/src/history/index.ts')
        const { captureName, decodeOperation } = await appImport<
            typeof import('../../src/history/operations')
        >('/src/history/operations/index.ts')
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const operation = () => {
            const step = history.headStep.value!
            const decoded = decodeOperation(step.operation)
            if (decoded.status !== 'known') throw new Error('Unsupported operation')
            return decoded.operation
        }
        const chart = () => createState(fixtures.interaction, 0)
        resetImportedState(chart(), {}, captureName('song.sus'))
        const imported = operation()
        // A level opened while storage is read-only is an import, not a recovery.
        openState(chart(), {}, { origin: 'import', source: captureName('level.nse') })
        const readOnly = operation()
        // A journal opened from Local Data is a recovery.
        openState(chart(), {})
        const recovered = operation()
        return { imported, readOnly, recovered }
    })
    expect(origins.imported).toMatchObject({
        id: 'nse.origin',
        data: { origin: 'import', source: { text: 'song.sus' } },
    })
    expect(origins.readOnly).toMatchObject({
        id: 'nse.origin',
        data: { origin: 'import', source: { text: 'level.nse' } },
    })
    expect(origins.recovered).toMatchObject({ id: 'nse.origin', data: { origin: 'recovery' } })
    expect(origins.recovered.data).not.toHaveProperty('source')
})
