import { expect, test, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'
import type { GroupId } from '../../src/chart/groups'
import type { State } from '../../src/state'
import { installEditorFixture, waitForStartup } from './editorFixture'

const errors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
    const caught: string[] = []
    errors.set(page, caught)
    page.on('pageerror', (error) => caught.push(error.message))
    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        localStorage.setItem('nse.test.storage', '{}')
    })
    await page.emulateMedia({ colorScheme: process.env.NSE_SCHEME === 'dark' ? 'dark' : 'light' })
    await page.goto('/')
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
})
test.afterEach(({ page }) => {
    expect(errors.get(page)).toEqual([])
})

const expectFocusedWithRing = async (target: Locator, name = '') => {
    await expect(target).toBeFocused()
    await expect(target).toBeInViewport()
    await expect
        .poll(() =>
            target.evaluate((element) => {
                const style = getComputedStyle(element)
                return (
                    element.matches(':focus-visible') &&
                    style.outlineStyle !== 'none' &&
                    parseFloat(style.outlineWidth) > 0 &&
                    style.outlineColor !== 'rgba(0, 0, 0, 0)'
                )
            }),
        )
        .toBe(true)
    const folder = process.env.NSE_HISTORY_SHOTS
    if (folder) {
        const scheme = process.env.NSE_SCHEME ?? 'light'
        await target.page().screenshot({ path: join(folder, `${name}-${scheme}.png`) })
    }
}
const tabTo = async (page: Page, target: Locator) => {
    for (let i = 0; i < 60; i++) {
        if (await target.evaluate((element) => element === document.activeElement)) return
        await page.keyboard.press('Tab')
    }
    await expect(target).toBeFocused()
}
// Enter on the focused Show More; the button keeps focus while more remain.
const pressMore = async (page: Page, button: Locator, remaining: boolean) => {
    await tabTo(page, button)
    await page.keyboard.press('Enter')
    if (remaining) await expect(button).toBeFocused()
}

const openDetails = async (page: Page, kind: 'steps' | 'recovery') => {
    await page.evaluate(async (kind) => {
        const { appImport, historySteps } = window.editorTest
        const [{ openOperationDetails }, { captureOperationRecipe }] = await Promise.all([
            appImport<typeof import('../../src/editor/history/operationDetails')>(
                '/src/editor/history/operationDetails.ts',
            ),
            appImport<typeof import('../../src/history/operationPresentation')>(
                '/src/history/operationPresentation/index.ts',
            ),
        ])
        const step = (name: string) =>
            historySteps.editStep(historySteps.futureFixtureOperation(name, {}, name))
        if (kind === 'steps') {
            void openOperationDetails(
                captureOperationRecipe(
                    Array.from({ length: 45 }, (_, i) => ({
                        description: {
                            kind: 'edit' as const,
                            step: historySteps.editStep(
                                historySteps.initialLife(1000 + i, 1001 + i),
                            ),
                        },
                        time: 1_720_000_000_000 + i,
                        id: `step:${i}`,
                    })),
                ),
                1_720_000_000_000,
            )
            return
        }
        const dropped = Array.from({ length: 45 }, (_, i) => step(`Earlier action ${i}`))
        void openOperationDetails(
            captureOperationRecipe([
                {
                    description: {
                        kind: 'recovered',
                        operation: historySteps.nativeOperation(
                            { id: 'nse.recovery', data: { droppedSteps: 45 } },
                            'Recovered',
                        ),
                        recoveryContext: {
                            head: step('Source metadata'),
                            headIndex: 2,
                            dropped,
                            omitted: 0,
                        },
                    },
                },
            ]),
            1_720_000_000_000,
        )
    }, kind)
    const details = page.getByRole('dialog', { name: 'Step Details', exact: true })
    await expect(details).toBeVisible()
    return details
}

const openProperties = async (page: Page, mode: 'rows' | 'items') => {
    await page.evaluate(async (mode) => {
        const { appImport, history, historySteps, settings } = window.editorTest
        const [{ captureOperationRecipe }, peek, selection] = await Promise.all([
            appImport<typeof import('../../src/history/operationPresentation')>(
                '/src/history/operationPresentation/index.ts',
            ),
            appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
            appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
        ])
        settings.dimUnchangedObjects = true
        const live = history.liveState.value
        const before: State = { ...live }
        let after: State
        if (mode === 'rows') {
            before.groups = new Map([
                ...live.groups,
                ...Array.from(
                    { length: 250 },
                    (_, index): [GroupId, { name: string; forceNoteSpeed: number }] => [
                        (index + 1000) as GroupId,
                        { name: `Historical group ${index + 1}`, forceNoteSpeed: 1 },
                    ],
                ),
            ])
            after = {
                ...before,
                groups: new Map(
                    [...before.groups].map(([id, group]) => [
                        id,
                        id >= 1000 ? { ...group, forceNoteSpeed: 2 } : group,
                    ]),
                ),
            }
        } else {
            before.levelInfo = { ...live.levelInfo, tags: [{ title: 'Tag' }] }
            after = {
                ...before,
                levelInfo: {
                    ...before.levelInfo,
                    tags: Array.from({ length: 250 }, (_, index) => ({
                        title: `Historical tag ${index + 1}`,
                    })),
                },
            }
        }
        const states = new Map([
            [0, before],
            [1, after],
        ])
        peek.setPeekSource({
            sameSnapshot: (a, b) => a === b,
            load: (key) => {
                const state = states.get(Number(key.split(':').at(-1)))
                if (!state) throw new peek.PeekError('missing')
                return Promise.resolve({ state, time: 1_720_000_000_000 })
            },
        })
        const metadata = historySteps.editStep(
            historySteps.futureFixtureOperation('inspection-metadata', {}, 'Imported Metadata'),
        )
        selection.requestPeek({
            key: 'inspection:1',
            previous: { key: 'inspection:0' },
            time: 1_720_000_000_001,
            recipe: captureOperationRecipe([
                {
                    description: { kind: 'edit', step: metadata },
                    time: 1_720_000_000_001,
                    id: 'inspection:1',
                },
            ]),
        })
    }, mode)
    await page.locator('[data-property-summary]').click()
    const dialog = page.getByRole('dialog', { name: 'Property Changes', exact: true })
    await expect(dialog.locator('[data-property-row]').first()).toBeVisible()
    return dialog
}

test('Step Details steps focus the first new step after the last Show More', async ({ page }) => {
    const details = await openDetails(page, 'steps')
    const steps = details.locator('[data-operation-children] > div > details')
    const more = details.locator('[data-operation-more]')
    await expect(steps).toHaveCount(20)
    await pressMore(page, more, true)
    await expect(steps).toHaveCount(40)
    await pressMore(page, more, false)
    await expect(steps).toHaveCount(45)
    await expect(more).toHaveCount(0)
    await expectFocusedWithRing(steps.nth(40).locator('summary'), 'steps')
})

test('Step Details recovery focuses the first new entry after the last Show More', async ({
    page,
}) => {
    const details = await openDetails(page, 'recovery')
    const recovery = details.locator('[data-operation-recovery]')
    const entries = recovery.locator('li')
    const more = recovery.getByRole('button', { name: 'Show More', exact: true })
    await expect(entries).toHaveCount(20)
    await pressMore(page, more, true)
    await expect(entries).toHaveCount(40)
    await pressMore(page, more, false)
    await expect(entries).toHaveCount(46)
    await expect(more).toHaveCount(0)
    // The row is a rule over a focusable box.
    await expectFocusedWithRing(entries.nth(40).locator(':scope > div'), 'recovery')
})

test('Property Changes rows focus the first new row after the last Show More', async ({ page }) => {
    const dialog = await openProperties(page, 'rows')
    const rows = dialog.locator('[data-property-row]')
    const more = dialog.locator('[data-property-more]')
    await expect(rows).toHaveCount(100)
    await pressMore(page, more, true)
    await expect(rows).toHaveCount(200)
    await pressMore(page, more, false)
    await expect(more).toHaveCount(0)
    expect(await rows.count()).toBeGreaterThan(200)
    await expectFocusedWithRing(rows.nth(200), 'rows')
})

test('Property Changes tag items focus the first new item after the last Show More', async ({
    page,
}) => {
    const dialog = await openProperties(page, 'items')
    const tags = dialog.locator('[data-property-row="tags"] [data-property-after]')
    const items = tags.locator('[data-property-items] > li')
    const more = tags.locator('[data-property-items-more]')
    await expect(items).toHaveCount(100)
    await pressMore(page, more, true)
    await expect(items).toHaveCount(200)
    await pressMore(page, more, false)
    await expect(items).toHaveCount(250)
    await expect(more).toHaveCount(0)
    await expectFocusedWithRing(items.nth(200), 'items')
})
