import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, waitForStartup } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
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
        const peek =
            await appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
        const selection = await appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        const live = { ...history.liveState.value, initialLife: 1000 }
        history.resetStates({ isDirty: false, state: live, step: historySteps.initialStep() })
        selection.damagedEntries.value = new Set()
        selection.peekedInfo.value = undefined
        peek.setPeekSource({
            load: async (key) => {
                await Promise.resolve()
                if (key === peek.entryKey('session', 99)) throw new peek.PeekError('damaged')
                return { state: { ...live, initialLife: 999 }, time: 1000 }
            },
            sameSnapshot: () => false,
        })
    })
})

test('restoring an entry that cannot be read marks its row damaged', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const peek =
            await appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
        const selection = await appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        await selection.requestRestore(peek.entryKey('session', 99))
        return {
            damaged: [...selection.damagedEntries.value],
            peeking: peek.isPeeking.value,
            key: peek.peekedKey.value,
            life: history.liveState.value.initialLife,
        }
    })
    expect(result).toEqual({ damaged: ['session:99'], peeking: false, key: undefined, life: 1000 })
})

test('a failed Restore of an entry other than the peeked one keeps that peek', async ({ page }) => {
    await page.evaluate(async () => {
        const { appImport, historySteps } = window.editorTest
        const selection = await appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        const { captureOperationRecipe } = await appImport<
            typeof import('../../src/history/operationPresentation')
        >('/src/history/operationPresentation/index.ts')
        selection.requestPeek({
            key: 'session:1',
            time: 1000,
            recipe: captureOperationRecipe([
                {
                    description: {
                        kind: 'edit',
                        step: historySteps.editStep(historySteps.initialLife(1000, 999)),
                    },
                    time: 1000,
                    id: 'session:1',
                },
            ]),
        })
    })
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { appImport, history } = window.editorTest
                const peek =
                    await appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
                return {
                    displayed: peek.displayedPeekKey.value,
                    life: history.state.value.initialLife,
                }
            }),
        )
        .toEqual({ displayed: 'session:1', life: 999 })

    const result = await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const peek =
            await appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
        const selection = await appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        const selectedState = history.state.value
        await selection.requestRestore(peek.entryKey('session', 99))
        return {
            damaged: [...selection.damagedEntries.value],
            peeking: peek.isPeeking.value,
            key: peek.peekedKey.value,
            displayed: peek.displayedPeekKey.value,
            infoKey: selection.peekedInfo.value?.key,
            sameState: history.state.value === selectedState,
            life: history.state.value.initialLife,
            liveLife: history.liveState.value.initialLife,
        }
    })
    expect(result).toEqual({
        damaged: ['session:99'],
        peeking: true,
        key: 'session:1',
        displayed: 'session:1',
        infoKey: 'session:1',
        sameState: true,
        life: 999,
        liveLife: 1000,
    })
})
