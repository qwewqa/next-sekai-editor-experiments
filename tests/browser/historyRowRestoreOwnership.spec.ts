import { expect, test, type Page } from '@playwright/test'
import { installEditorFixture, waitForStartup } from './editorFixture'

type RestoreProbe = {
    reads: string[]
    resolves: Record<string, () => void>
    rejects: Record<string, () => void>
    restoring?: Promise<void>
    restoredLives: number[]
    buffer: AudioBuffer
}

const inspect = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const [peek, selection] = await Promise.all([
            appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
            appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
        ])
        const probe = (window as unknown as { restoreProbe: RestoreProbe }).restoreProbe
        return {
            requested: peek.peekedKey.value,
            displayed: peek.displayedPeekKey.value,
            info: selection.peekedInfo.value?.key,
            life: history.state.value.initialLife,
            liveLife: history.liveState.value.initialLife,
            damaged: [...selection.damagedEntries.value],
            restoredLives: probe.restoredLives,
            reads: probe.reads,
            currentAudio: history.liveState.value.bgm.buffer === probe.buffer,
        }
    })

const select = (page: Page, seq: number) =>
    page.evaluate(async (seq) => {
        const { appImport, historySteps } = window.editorTest
        const [selection, presentation] = await Promise.all([
            appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
            appImport<typeof import('../../src/history/operationPresentation')>(
                '/src/history/operationPresentation/index.ts',
            ),
        ])
        selection.requestPeek({
            key: `row:${seq}`,
            previous: { key: 'row:0' },
            time: seq,
            recipe: presentation.captureOperationRecipe([
                {
                    id: `row:${seq}`,
                    time: seq,
                    description: {
                        kind: 'edit',
                        step: historySteps.editStep(
                            historySteps.initialLife(1000, seq === 2 ? 2000 : 111),
                        ),
                    },
                },
            ]),
        })
    }, seq)

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        localStorage.setItem('nse.test.storage', '{}')
    })
    await page.goto('/')
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
    await page.evaluate(async () => {
        const { appImport, history, historySteps } = window.editorTest
        const [peek, selection, stack, actions] = await Promise.all([
            appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
            appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
            appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts'),
            appImport<typeof import('../../src/history/actions')>('/src/history/actions.ts'),
        ])
        const probe: RestoreProbe = {
            reads: [],
            resolves: {},
            rejects: {},
            restoredLives: [],
            buffer: new AudioBuffer({ length: 8, sampleRate: 48000 }),
        }
        ;(window as unknown as { restoreProbe: RestoreProbe }).restoreProbe = probe
        selection.backToNow()
        selection.damagedEntries.value = new Set()
        const live = {
            ...history.liveState.value,
            initialLife: 1000,
            bgm: { ...history.liveState.value.bgm, buffer: probe.buffer },
        }
        stack.resetStates({ isDirty: false, state: live, step: historySteps.initialStep() })
        peek.setPeekSource({
            load: (key) => {
                probe.reads.push(key)
                if (key === 'row:1' || key === 'row:3')
                    return new Promise((resolve, reject) => {
                        probe.resolves[key] = () =>
                            resolve({
                                state: { ...live, initialLife: 111, bgm: { offset: 3 } },
                                time: 1,
                            })
                        probe.rejects[key] = () => reject(new peek.PeekError('damaged'))
                    })
                return Promise.resolve({
                    state: { ...live, initialLife: key === 'row:2' ? 2000 : 1000 },
                    time: 2,
                })
            },
            sameSnapshot: () => false,
        })
        actions.onHistoryAction((action) => {
            if (action.kind === 'restore') probe.restoredLives.push(action.state.initialLife)
        })
    })
})

test('same-session stale rejection preserves a newer peek, while a current failure still marks damage', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const selection = await window.editorTest.appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        const probe = (window as unknown as { restoreProbe: RestoreProbe }).restoreProbe
        probe.restoring = selection.requestRestore('row:1')
    })
    expect((await inspect(page)).reads.filter((key) => key === 'row:1')).toHaveLength(1)
    await select(page, 2)
    await expect.poll(async () => (await inspect(page)).displayed).toBe('row:2')
    const before = await inspect(page)
    await page.evaluate(async () => {
        const probe = (window as unknown as { restoreProbe: RestoreProbe }).restoreProbe
        probe.rejects['row:1']!()
        await probe.restoring
    })
    expect(await inspect(page)).toEqual(before)

    await page.evaluate(async () => {
        const selection = await window.editorTest.appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        const probe = (window as unknown as { restoreProbe: RestoreProbe }).restoreProbe
        probe.restoring = selection.requestRestore('row:3')
    })
    expect((await inspect(page)).reads.filter((key) => key === 'row:3')).toHaveLength(1)
    await page.evaluate(async () => {
        window.editorTest.settings.locale = 'fr'
        await window.nseFlushTest!.flusher.flush({ strict: true })
        const probe = (window as unknown as { restoreProbe: RestoreProbe }).restoreProbe
        probe.rejects['row:3']!()
        await probe.restoring
    })
    expect(await inspect(page)).toMatchObject({
        requested: 'row:2',
        displayed: 'row:2',
        info: 'row:2',
        liveLife: 1000,
        life: 2000,
        damaged: ['row:3'],
        restoredLives: [],
    })
})

test('a later Restore owns the real UI request and stays undoable after the older read finishes', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const selection = await window.editorTest.appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        const probe = (window as unknown as { restoreProbe: RestoreProbe }).restoreProbe
        probe.restoring = selection.requestRestore('row:1')
    })
    expect((await inspect(page)).reads.filter((key) => key === 'row:1')).toHaveLength(1)
    await page.evaluate(async () => {
        const selection = await window.editorTest.appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        await selection.requestRestore('row:2')
        const probe = (window as unknown as { restoreProbe: RestoreProbe }).restoreProbe
        probe.resolves['row:1']!()
        await probe.restoring
    })
    expect(await inspect(page)).toMatchObject({
        liveLife: 2000,
        restoredLives: [2000],
        damaged: [],
    })
    await page.evaluate(() => {
        window.editorTest.history.undoState()
    })
    expect((await inspect(page)).liveLife).toBe(1000)
})

test('the actual PeekBar Restore button accepts its initiating load and keeps current audio', async ({
    page,
}) => {
    await select(page, 1)
    await expect(page.locator('[data-peek-restore]')).toBeVisible()
    expect((await inspect(page)).reads.filter((key) => key === 'row:1')).toHaveLength(1)
    await page.locator('[data-peek-restore]').click()
    await page.evaluate(() => {
        const probe = (window as unknown as { restoreProbe: RestoreProbe }).restoreProbe
        probe.resolves['row:1']!()
    })
    await expect.poll(async () => (await inspect(page)).restoredLives).toEqual([111])
    await expect(page.locator('[data-peek-restore]')).toHaveCount(0)
    expect(await inspect(page)).toMatchObject({
        liveLife: 111,
        life: 111,
        currentAudio: true,
        damaged: [],
        restoredLives: [111],
    })
    expect((await inspect(page)).reads.filter((key) => key === 'row:1')).toHaveLength(1)
})
