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
        const { resetStates } =
            await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        const live = { ...history.liveState.value, initialLife: 1000 }
        resetStates({ isDirty: false, state: live, step: historySteps.initialStep() })
        selection.damagedEntries.value = new Set()
        selection.removedEntries.value = new Set()
        selection.peekedInfo.value = undefined
        peek.setPeekSource({
            load: async (key) => {
                await Promise.resolve()
                if (key === peek.entryKey('session', 99)) throw new peek.PeekError('damaged')
                if (key === peek.entryKey('session', 97)) throw new peek.PeekError('removed')
                if (key === peek.entryKey('session', 96)) throw new peek.PeekError('missing')
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

/** A source whose read of `session:98` fails the way a storage worker's timeout does. */
const failingRead = () =>
    window.editorTest
        .appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
        .then((peek) =>
            peek.setPeekSource({
                load: async (key) => {
                    await Promise.resolve()
                    if (key === peek.entryKey('session', 98)) throw new Error('storage timed out')
                    return {
                        state: { ...window.editorTest.history.liveState.value, initialLife: 999 },
                        time: 1000,
                    }
                },
                sameSnapshot: () => false,
            }),
        )

const diagnosed = (page: import('@playwright/test').Page) =>
    page.evaluate(async () => {
        const { ringEntries } =
            await window.editorTest.appImport<typeof import('../../src/diagnostics')>(
                '/src/diagnostics.ts',
            )
        return ringEntries().some((entry) => entry.text.includes('storage timed out'))
    })

test('a Restore that fails for a reason other than the entry records it and says so', async ({
    page,
}) => {
    await page.evaluate(failingRead)
    const result = await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const peek =
            await appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
        const selection = await appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        await selection.requestRestore(peek.entryKey('session', 98))
        return {
            damaged: [...selection.damagedEntries.value],
            peeking: peek.isPeeking.value,
            life: history.liveState.value.initialLife,
        }
    })
    // Not the entry's fault: it is not marked damaged, and the chart is untouched.
    expect(result).toEqual({ damaged: [], peeking: false, life: 1000 })
    // A failure of what the user asked for is a card with the error glyph, not a quick toast that
    // fades before it is read.
    const card = page.locator('[data-notice-card]')
    await expect(card).toContainText('Could not restore')
    await expect(card.locator('[data-severity="error"]')).toBeVisible()
    expect(await diagnosed(page)).toBe(true)
})

test('a Peek that fails for a reason other than the entry records it and says so', async ({
    page,
}) => {
    await page.evaluate(failingRead)
    await page.evaluate(async () => {
        const { appImport, historySteps } = window.editorTest
        const selection = await appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        const { captureOperationRecipe } = await appImport<
            typeof import('../../src/history/operationPresentation')
        >('/src/history/operationPresentation/index.ts')
        selection.requestPeek({
            key: 'session:98',
            time: 1000,
            recipe: captureOperationRecipe([
                {
                    description: {
                        kind: 'edit',
                        step: historySteps.editStep(historySteps.initialLife(1000, 999)),
                    },
                    time: 1000,
                    id: 'session:98',
                },
            ]),
        })
    })
    await expect(page.getByText('Could not view this step', { exact: true }).first()).toBeVisible()
    expect(await diagnosed(page)).toBe(true)
    expect(
        await page.evaluate(async () => {
            const peek =
                await window.editorTest.appImport<typeof import('../../src/history/peek')>(
                    '/src/history/peek.ts',
                )
            return peek.isPeeking.value
        }),
    ).toBe(false)
})

const peekRequest = (key: string) =>
    window.editorTest
        .appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        .then(async (selection) => {
            const { historySteps } = window.editorTest
            const { captureOperationRecipe } = await window.editorTest.appImport<
                typeof import('../../src/history/operationPresentation')
            >('/src/history/operationPresentation/index.ts')
            selection.requestPeek({
                key: key as `${string}:${number}`,
                time: 1000,
                recipe: captureOperationRecipe([
                    {
                        description: {
                            kind: 'edit',
                            step: historySteps.editStep(historySteps.initialLife(1000, 999)),
                        },
                        time: 1000,
                        id: key,
                    },
                ]),
            })
        })

test('a Restore of an entry found removed marks its row removed and says so', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const peek =
            await appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
        const selection = await appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        await selection.requestRestore(peek.entryKey('session', 97))
        return {
            removed: [...selection.removedEntries.value],
            damaged: [...selection.damagedEntries.value],
            peeking: peek.isPeeking.value,
            life: history.liveState.value.initialLife,
        }
    })
    expect(result).toEqual({ removed: ['session:97'], damaged: [], peeking: false, life: 1000 })
    await expect(page.getByText('Could not restore', { exact: true }).first()).toBeVisible()
})

test('a peek of an entry found removed marks its row removed and says so', async ({ page }) => {
    await page.evaluate(peekRequest, 'session:97')
    await expect(page.getByText('Could not view this step', { exact: true }).first()).toBeVisible()
    expect(
        await page.evaluate(async () => {
            const selection = await window.editorTest.appImport<
                typeof import('../../src/editor/history/selection')
            >('/src/editor/history/selection.ts')
            return [...selection.removedEntries.value, ...selection.damagedEntries.value]
        }),
    ).toEqual(['session:97'])
})

test('a Restore of an entry not stored yet is told, and does not mark it damaged, as a peek does not', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const peek =
            await appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
        const selection = await appImport<typeof import('../../src/editor/history/selection')>(
            '/src/editor/history/selection.ts',
        )
        await selection.requestRestore(peek.entryKey('session', 96))
        return {
            removed: [...selection.removedEntries.value],
            damaged: [...selection.damagedEntries.value],
            peeking: peek.isPeeking.value,
        }
    })
    expect(result).toEqual({ removed: [], damaged: [], peeking: false })
    await expect(page.getByText('Could not restore', { exact: true }).first()).toBeVisible()
})
