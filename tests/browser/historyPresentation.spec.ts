import { expect, test, type Page } from '@playwright/test'
import { installEditorFixture, waitForStartup } from './editorFixture'

const presentation = (page: Page) => page.locator('[data-history-presentation]')
const list = (page: Page) => presentation(page).locator('[data-history-list]')
const viewChart = (page: Page) => page.locator('[data-history-view-chart]')
const row = (page: Page, label: string) =>
    list(page)
        .getByRole('option')
        .filter({ has: page.getByText(label, { exact: true }) })

const load = async (page: Page) => {
    await page.addInitScript(() => {
        performance.setResourceTimingBufferSize(5000)
        localStorage.setItem('nse.test.storage', '{}')
        for (const setting of ['showPreview', 'showSidebar'])
            localStorage.setItem(`sonolus-next-sekai-editor.${setting}`, 'false')
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
    await page.evaluate(async () => {
        const { history } = window.editorTest
        for (let i = 1; i <= 30; i++)
            history.pushState(() => `Property ${i}`, {
                ...history.state.value,
                initialLife: history.state.value.initialLife + 1,
            })
        await window.nseFlushTest!.flusher.flush({ strict: true })
    })
}

const open = async (page: Page) => {
    await page.evaluate(async () => {
        const history = await window.editorTest.appImport<
            typeof import('../../src/editor/history/openHistory')
        >('/src/editor/history/openHistory.ts')
        void history.openHistoryDialog('timeline')
    })
    await expect(presentation(page)).toBeVisible()
}

const selected = (page: Page) =>
    page.evaluate(async () => {
        const [peek, selection] = await Promise.all([
            window.editorTest.appImport<typeof import('../../src/history/peek')>(
                '/src/history/peek.ts',
            ),
            window.editorTest.appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
        ])
        return {
            requested: peek.peekedKey.value,
            displayed: peek.displayedPeekKey.value,
            label: selection.peekedInfo.value?.label,
            life: window.editorTest.history.state.value.initialLife,
        }
    })

test.beforeEach(async ({ page }) => load(page))

for (const size of [
    { width: 520, height: 320 },
    { width: 568, height: 320 },
    { width: 667, height: 375 },
])
    for (const filtered of [false, true])
        test(`${size.width}×${size.height}, ${filtered ? 'filtered' : 'all'}: useful list and explicit chart transfer`, async ({
            page,
        }) => {
            await page.setViewportSize(size)
            if (filtered)
                await page.evaluate(async () => {
                    const state = await window.editorTest.appImport<
                        typeof import('../../src/editor/history/state')
                    >('/src/editor/history/state.ts')
                    state.historyFilter.value = 'saves'
                })
            await open(page)
            if (size.width < 600)
                await expect(presentation(page)).toHaveAttribute(
                    'data-history-presentation',
                    'compact',
                )
            await expect
                .poll(() => list(page).evaluate((element) => element.clientHeight))
                .toBeGreaterThanOrEqual(116)
            if (filtered) await presentation(page).getByRole('button', { name: 'Show All' }).click()
            await row(page, 'Property 29').click()
            await expect.poll(async () => (await selected(page)).label).toBe('Property 29')
            await expect
                .poll(async () => {
                    const state = await selected(page)
                    return !!state.requested && state.requested === state.displayed
                })
                .toBe(true)
            const before = await selected(page)
            if (await viewChart(page).count()) {
                await viewChart(page).click()
                await expect(presentation(page)).toHaveCount(0)
                expect(await selected(page)).toEqual(before)
                await expect(page.locator('[data-peek-main] button').first()).toBeFocused()
                await open(page)
                await expect(row(page, 'Property 29')).toHaveAttribute('aria-selected', 'true')
                expect(await selected(page)).toEqual(before)
            }
            await page.keyboard.press('Escape')
            await expect.poll(async () => (await selected(page)).requested).toBeUndefined()
            await expect(presentation(page)).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(presentation(page)).toHaveCount(0)
        })

test('a portrait sheet promotes once without ending peek, losing the cursor or returning old focus', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'sheet')
    await row(page, 'Property 29').click()
    await expect.poll(async () => (await selected(page)).displayed).toBeTruthy()
    const before = await selected(page)
    await page.evaluate(async () => {
        const peek =
            await window.editorTest.appImport<typeof import('../../src/history/peek')>(
                '/src/history/peek.ts',
            )
        const target = window as unknown as { historyExits: number }
        target.historyExits = 0
        peek.onPeekLeft(() => target.historyExits++)
    })
    await page.setViewportSize({ width: 520, height: 320 })
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
    await expect(presentation(page)).toHaveCount(1)
    await expect(list(page)).toBeFocused()
    await expect(row(page, 'Property 29')).toHaveAttribute('aria-selected', 'true')
    expect(await selected(page)).toEqual(before)
    expect(
        await page.evaluate(() => (window as unknown as { historyExits: number }).historyExits),
    ).toBe(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
    await presentation(page).getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(async () => (await selected(page)).requested).toBeUndefined()
})

test('View Chart is disabled for the placeholder and for a pending different endpoint', async ({
    page,
}) => {
    await page.setViewportSize({ width: 520, height: 320 })
    await open(page)
    await expect(viewChart(page)).toBeDisabled()
    await page.evaluate(async () => {
        const [peek, selection] = await Promise.all([
            window.editorTest.appImport<typeof import('../../src/history/peek')>(
                '/src/history/peek.ts',
            ),
            window.editorTest.appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
        ])
        const target = window as unknown as {
            releaseHistory: () => void
            requestSecond: () => void
            historyLoader: number
        }
        target.historyLoader = 0
        const state = window.editorTest.history.state.value
        const a = peek.entryKey('controlled', 1)
        const b = peek.entryKey('controlled', 2)
        peek.setPeekSource({
            load: (key) =>
                new Promise((resolve) => {
                    target.historyLoader++
                    target.releaseHistory = () =>
                        resolve({
                            state: { ...state, initialLife: key === a ? 100 : 200 },
                            time: 1,
                        })
                }),
            sameSnapshot: (left, right) => left === right,
        })
        target.requestSecond = () => selection.requestPeek({ key: b, label: 'B', time: 2 })
        selection.requestPeek({ key: a, label: 'A', time: 1 })
    })
    await expect(viewChart(page)).toBeDisabled()
    await page.evaluate(() =>
        (window as unknown as { releaseHistory: () => void }).releaseHistory(),
    )
    await expect(viewChart(page)).toBeEnabled()
    await page.evaluate(() => (window as unknown as { requestSecond: () => void }).requestSecond())
    await expect(viewChart(page)).toBeDisabled()
    expect((await selected(page)).life).toBe(100)
    await expect
        .poll(() =>
            page.evaluate(() => (window as unknown as { historyLoader: number }).historyLoader),
        )
        .toBe(2)
    await page.evaluate(() =>
        (window as unknown as { releaseHistory: () => void }).releaseHistory(),
    )
    await expect(viewChart(page)).toBeEnabled()
    expect((await selected(page)).life).toBe(200)
})

test('View Chart defers fullscreen elevation restoration until peek exit', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 320 })
    await page.evaluate(async () => {
        const elevation = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        elevation.openElevationEditor(12)
    })
    const elevation = () =>
        page.evaluate(async () => {
            const state = await window.editorTest.appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            return { open: state.isElevationEditorOpen.value, beat: state.elevationBeat.value }
        })
    await expect.poll(elevation).toEqual({ open: true, beat: 12 })
    await open(page)
    await row(page, 'Property 29').click()
    await expect(viewChart(page)).toBeEnabled()
    await viewChart(page).click()
    expect((await elevation()).open).toBe(false)
    await page.keyboard.press('Escape')
    await expect.poll(elevation).toEqual({ open: true, beat: 12 })
})

test('reopening restores the scroll anchor without selecting again; command close and Enter retain their meanings', async ({
    page,
}) => {
    await page.setViewportSize({ width: 520, height: 320 })
    await open(page)
    await list(page).focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('PageDown')
    await page.keyboard.press('PageDown')
    await expect(viewChart(page)).toBeEnabled()
    const before = await selected(page)
    const top = await list(page).evaluate((element) => element.scrollTop)
    expect(top).toBeGreaterThan(0)
    await viewChart(page).click()
    await open(page)
    await expect.poll(() => list(page).evaluate((element) => element.scrollTop)).toBe(top)
    expect(await selected(page)).toEqual(before)
    await expect(list(page).getByRole('option', { selected: true })).toContainText(before.label!)
    await viewChart(page).focus()
    await page.keyboard.press('Shift+H')
    await expect(presentation(page)).toHaveCount(0)
    await expect.poll(async () => (await selected(page)).requested).toBeUndefined()
    await open(page)
    await row(page, 'Property 29').click()
    await expect(viewChart(page)).toBeEnabled()
    const restoredLife = (await selected(page)).life
    await list(page).focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await selected(page)).requested).toBeUndefined()
    expect(await page.evaluate(() => window.editorTest.history.liveState.value.initialLife)).toBe(
        restoredLife,
    )
})

test('reset clears view memory and discards the deferred elevation return', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 320 })
    await page.evaluate(async () => {
        const elevation = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        elevation.openElevationEditor(12)
    })
    await open(page)
    await row(page, 'Property 29').click()
    await expect(viewChart(page)).toBeEnabled()
    await viewChart(page).click()
    await page.evaluate(() => {
        const history = window.editorTest.history
        history.resetStates({ isDirty: false, name: () => 'Reset', state: history.liveState.value })
    })
    await expect.poll(async () => (await selected(page)).requested).toBeUndefined()
    expect(
        await page.evaluate(async () => {
            const [elevation, memory] = await Promise.all([
                window.editorTest.appImport<typeof import('../../src/editor/elevation/state')>(
                    '/src/editor/elevation/state.ts',
                ),
                window.editorTest.appImport<typeof import('../../src/editor/history/state')>(
                    '/src/editor/history/state.ts',
                ),
            ])
            return {
                open: elevation.isElevationEditorOpen.value,
                memory: memory.rememberedHistoryView(),
            }
        }),
    ).toEqual({ open: false, memory: undefined })
})

test('promotion waits for an interrupted Edits Here scan before restoring its anchor', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    await expect(row(page, 'Property 29')).toBeVisible()
    await page.evaluate(async () => {
        const [start, source, state] = await Promise.all([
            window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            ),
            window.editorTest.appImport<typeof import('../../src/editor/history/source')>(
                '/src/editor/history/source.ts',
            ),
            window.editorTest.appImport<typeof import('../../src/editor/history/state')>(
                '/src/editor/history/state.ts',
            ),
        ])
        const target = window as unknown as { hereCalls: number; releaseHere: () => void }
        target.hereCalls = 0
        const matches = source.entries.value.slice(0, 20).map((entry, index) => ({
            ...entry,
            pos: index,
            previous: source.entries.value[index + 1],
        }))
        const worker = start.storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const original = worker.call.bind(worker)
        worker.call = (name, ...args) => {
            if (name !== 'findEdits') return original(name, ...args)
            target.hereCalls++
            const result = { matches, unreadable: 0, top: matches[0] }
            if (target.hereCalls === 1) return Promise.resolve({ ...result, cursor: { before: 1 } })
            if (target.hereCalls === 2) return new Promise(() => {})
            return new Promise((resolve) => {
                target.releaseHere = () => resolve(result)
            })
        }
        state.hereRange.value = { from: 0, to: 16 }
        state.historyFilter.value = 'here'
    })
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { hereCalls: number }).hereCalls))
        .toBe(2)
    await list(page).focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('PageDown')
    await expect.poll(async () => (await selected(page)).displayed).toBeTruthy()
    await page.keyboard.press('PageDown')
    await expect
        .poll(async () => {
            const current = await selected(page)
            return current.requested === current.displayed
        })
        .toBe(true)
    const before = await selected(page)
    const top = await list(page).evaluate((element) => element.scrollTop)
    expect(top).toBeGreaterThan(0)
    const pinned = () =>
        page.evaluate(async () => {
            const selection = await window.editorTest.appImport<
                typeof import('../../src/editor/history/selection')
            >('/src/editor/history/selection.ts')
            return selection.peekedInfo.value?.pinned
        })
    const beforePinned = await pinned()
    await page.setViewportSize({ width: 520, height: 320 })
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { hereCalls: number }).hereCalls))
        .toBe(3)
    await expect(list(page).getByRole('option')).toHaveCount(1)
    await page.evaluate(() => (window as unknown as { releaseHere: () => void }).releaseHere())
    await expect.poll(() => list(page).evaluate((element) => element.scrollTop)).toBe(top)
    await expect(list(page).getByRole('option', { selected: true })).toContainText(before.label!)
    await expect(list(page)).toBeFocused()
    expect(await selected(page)).toEqual(before)
    expect(await pinned()).toEqual(beforePinned)
})

test.describe('touch compact History', () => {
    test.use({ hasTouch: true, viewport: { width: 568, height: 320 } })
    test('selection stays in a useful list until View Chart is tapped', async ({ page }) => {
        await open(page)
        await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
        await row(page, 'Property 29').tap()
        await expect(viewChart(page)).toBeEnabled()
        await expect
            .poll(() => list(page).evaluate((element) => element.clientHeight))
            .toBeGreaterThanOrEqual(116)
        expect((await viewChart(page).boundingBox())?.height).toBe(36)
        const before = await selected(page)
        await viewChart(page).tap()
        await expect(presentation(page)).toHaveCount(0)
        expect(await selected(page)).toEqual(before)
    })
    test('Go To remains reachable in the compact dialog top layer', async ({ page }) => {
        await open(page)
        await presentation(page).getByRole('button', { name: 'Go To', exact: true }).tap()
        const goTo = page.locator('[data-history-goto]')
        expect(await goTo.evaluate((element) => !!element.closest('dialog[open]'))).toBe(true)
        await goTo.getByRole('radio', { name: 'Saves and Exports', exact: true }).tap()
        await expect(
            goTo.getByRole('radio', { name: 'Saves and Exports', exact: true }),
        ).toHaveAttribute('aria-checked', 'true')
        await goTo.getByRole('radio', { name: 'All', exact: true }).tap()
        await goTo.getByRole('option', { name: 'Now', exact: true }).tap()
        await expect(goTo).toHaveCount(0)
        await expect(list(page)).toBeFocused()
    })
})

test('compact Go To supports pointer filters and keyboard picks inside the native dialog', async ({
    page,
}) => {
    await page.setViewportSize({ width: 520, height: 320 })
    await open(page)
    await presentation(page).getByRole('button', { name: 'Go To', exact: true }).click()
    const goTo = page.locator('[data-history-goto]')
    expect(await goTo.evaluate((element) => !!element.closest('dialog[open]'))).toBe(true)
    await goTo.getByRole('radio', { name: 'Saves and Exports', exact: true }).click()
    await expect(
        goTo.getByRole('radio', { name: 'Saves and Exports', exact: true }),
    ).toHaveAttribute('aria-checked', 'true')
    await goTo.getByRole('radio', { name: 'All', exact: true }).click()
    await page.keyboard.press('Tab')
    await expect(goTo.locator('[data-goto-list]')).toBeFocused()
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await expect(goTo).toHaveCount(0)
    await expect(list(page)).toBeFocused()
    await expect(list(page).getByRole('option', { selected: true })).toContainText('Now')
})

test('filter-driven promotion retains an open Go To chooser, while window resize still dismisses it', async ({
    page,
}) => {
    await page.setViewportSize({ width: 667, height: 375 })
    await open(page)
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'sheet')
    await presentation(page).getByRole('button', { name: 'Go To', exact: true }).click()
    const goTo = page.locator('[data-history-goto]')
    await goTo.getByRole('radio', { name: 'Saves and Exports', exact: true }).click()
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
    await expect(goTo).toHaveCount(1)
    await expect(goTo.getByRole('radio', { name: 'Saves and Exports', exact: true })).toBeFocused()
    expect(await goTo.evaluate((element) => !!element.closest('dialog[open]'))).toBe(true)
    await page.setViewportSize({ width: 668, height: 375 })
    await expect(goTo).toHaveCount(0)
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
})
