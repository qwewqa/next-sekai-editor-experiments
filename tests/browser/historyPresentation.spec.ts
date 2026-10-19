import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installEditorFixture, waitForStartup } from './editorFixture'

const presentation = (page: Page) => page.locator('[data-history-presentation]')
const list = (page: Page) => presentation(page).locator('[data-history-list]')
const viewChart = (page: Page) => page.locator('[data-history-view-chart]')
const errors = new WeakMap<Page, string[]>()
const capture = async (page: Page, name: string) => {
    const folder = process.env.NSE_HISTORY_SHOTS
    if (!folder) return
    await mkdir(folder, { recursive: true })
    await page.screenshot({ path: join(folder, `${name}.png`) })
}
const row = (page: Page, label: string) =>
    list(page)
        .getByRole('option')
        .filter({ has: page.getByText(label, { exact: true }) })

const load = async (page: Page) => {
    const caught: string[] = []
    errors.set(page, caught)
    page.on('pageerror', (error) => caught.push(error.message))
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
test.afterEach(({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test('unavailable group height and expansion preserve virtual offsets and the visible anchor', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { storageWorker } =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        storageWorker!.call = new Proxy(storageWorker!.call, {
            async apply(target, self, args) {
                const result = await Reflect.apply(target, self, args)
                if (args[0] !== 'readTimeline') return result
                const timeline =
                    result as import('../../src/local/worker/timelineHandlers').TimelinePage
                return {
                    ...timeline,
                    entries: timeline.entries.map((entry, i) =>
                        i < 2 ? { ...entry, label: 'Grouped property' } : entry,
                    ),
                }
            },
        })
    })
    await open(page)
    const group = row(page, 'Grouped property').filter({
        has: page.locator('[data-history-group-header]'),
    })
    const anchor = row(page, 'Property 26')
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    expect((await group.boundingBox())!.height).toBe(44)
    await list(page).evaluate((element) => {
        element.scrollTop = 190
    })
    const before = await anchor.boundingBox()
    const top = await list(page).evaluate((element) => element.scrollTop)
    await page.evaluate(async () => {
        const [{ listedEntries }, { damagedEntries, keyOf }] = await Promise.all([
            window.editorTest.appImport<typeof import('../../src/editor/history/source')>(
                '/src/editor/history/source.ts',
            ),
            window.editorTest.appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
        ])
        damagedEntries.value = new Set(listedEntries.value.slice(0, 2).map(keyOf))
    })
    await expect.poll(async () => (await group.boundingBox())!.height).toBe(80)
    await expect.poll(() => list(page).evaluate((element) => element.scrollTop)).toBe(top + 36)
    expect((await anchor.boundingBox())!.y).toBe(before!.y)
    const following = row(page, 'Property 28')
    expect(
        await following.evaluate((element) =>
            Number.parseFloat((element as HTMLElement).style.top),
        ),
    ).toBe(
        await group.evaluate(
            (element) => Number.parseFloat((element as HTMLElement).style.top) + 80,
        ),
    )
    await group.locator('[data-history-disclosure]').dispatchEvent('click')
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => list(page).evaluate((element) => element.scrollTop)).toBe(top + 36 + 88)
    expect((await anchor.boundingBox())!.y).toBe(before!.y)
    expect(
        await following.evaluate((element) =>
            Number.parseFloat((element as HTMLElement).style.top),
        ),
    ).toBe(
        await group.evaluate(
            (element) => Number.parseFloat((element as HTMLElement).style.top) + 80 + 88,
        ),
    )
})

test('actual 220px French dock protects partial count and the complete unavailable reason', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { storageWorker } =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        storageWorker!.call = new Proxy(storageWorker!.call, {
            async apply(target, self, args) {
                if (args[0] === 'readTimeline' && args[1]?.before === 0)
                    return new Promise(() => {})
                const result = await Reflect.apply(target, self, args)
                if (args[0] !== 'readTimeline') return result
                const timeline =
                    result as import('../../src/local/worker/timelineHandlers').TimelinePage
                const first = timeline.entries[0]!
                return {
                    ...timeline,
                    entries: [
                        { ...first, label: 'ノーツを追加' },
                        { ...timeline.entries[1]!, label: 'ノーツを追加' },
                        { ...timeline.entries[2]!, label: 'Added 1 note', kept: false },
                        { ...timeline.entries[3]!, label: 'Added 1 note', kept: false },
                        { ...timeline.entries[4]!, label: 'Moved 3 notes', kept: false },
                    ],
                    next: { sessionId: first.sessionId, before: 0 },
                }
            },
        })
        Object.assign(window.editorTest.settings, {
            locale: 'fr',
            rightDockWidth: 220,
            historyPosition: 'right',
            propertiesPosition: 'disabled',
            showHistory: true,
        })
        const { showHistoryLink } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/openHistory')
        >('/src/editor/history/openHistory.ts')
        showHistoryLink('timeline')
    })
    const dockList = page.locator('[data-history-surface="panel"] [data-history-list]')
    await expect(dockList).toBeVisible()
    await expect.poll(() => dockList.evaluate((element) => element.clientWidth)).toBe(220)
    const parents = dockList
        .getByRole('option')
        .filter({ has: page.locator('[data-history-group-header]') })
    await expect(parents).toHaveCount(3)
    await expect(parents.first().locator('[data-history-group-action]')).toHaveText('ノーツを追加')
    await expect(parents.first().locator('[data-history-group-count]')).toHaveText(
        '2 modifications',
    )
    await expect(parents.last().locator('[data-history-group-count]')).toHaveText(
        '1+ modifications',
    )
    await expect(parents.last().locator('[data-history-disclosure]')).toHaveCount(0)
    await expect(parents.locator('[data-history-group-time]')).toHaveCount(0)
    await expect(parents.locator('[data-history-group-header] > svg')).toHaveCount(0)
    for (const parent of [parents.nth(1), parents.last()]) {
        expect((await parent.boundingBox())!.height).toBe(80)
        const reason = parent.locator('[data-history-flag]')
        await expect(reason).toHaveText('supprimé pour libérer de l’espace')
        expect(
            await reason.evaluate((element) => ({
                height: element.scrollHeight,
                width: element.scrollWidth,
                client: element.clientWidth,
            })),
        ).toEqual({ height: 32, width: 204, client: 204 })
    }
    await capture(page, '220-fr-partial-unavailable-foreign')
    await page.emulateMedia({ forcedColors: 'active' })
    await capture(page, '220-fr-forced-colors')
})

for (const width of [1600, 390, 320]) {
    test.describe(`group composition at ${width}px`, () => {
        test.use({
            viewport: { width, height: width === 1600 ? 1000 : 844 },
            hasTouch: width < 600,
        })
        test('action captions, directional aggregate and expanded members remain distinct', async ({
            page,
        }) => {
            await page.evaluate(async () => {
                const { history } = window.editorTest
                for (const label of [
                    'Added 1 note',
                    'Added 1 note',
                    'Moved 3 notes',
                    'Moved 3 notes',
                    'Renamed chart',
                    'Adjusted life',
                ])
                    history.pushState(() => label, {
                        ...history.state.value,
                        initialLife: history.state.value.initialLife + 1,
                    })
                history.undoState()
                history.undoState()
                await window.nseFlushTest!.flusher.flush({ strict: true })
            })
            await open(page)
            const groups = list(page)
                .getByRole('option')
                .filter({ has: page.locator('[data-history-group-header]') })
            await expect(groups).toHaveCount(3)
            const undo = row(page, 'Undid 2 steps')
            await expect(undo.locator('[data-history-group-count]')).toHaveCount(0)
            await expect(undo).not.toContainText('Adjusted life')
            for (const action of ['Added 1 note', 'Moved 3 notes']) {
                const group = row(page, action)
                await expect(group.locator('[data-history-group-count]')).toHaveText('2 edits')
                expect(
                    (await group.locator('[data-history-disclosure]').boundingBox())!.width,
                ).toBe(44)
                const caption = group.locator('[data-history-group-caption]')
                expect(
                    await caption.evaluate((element) => element.scrollWidth <= element.clientWidth),
                ).toBe(true)
            }
            await capture(page, `${width}-groups`)
            await undo.locator('[data-history-disclosure]').click()
            await expect(row(page, 'Undo · Adjusted life')).toBeVisible()
            await expect(row(page, 'Undo · Renamed chart')).toBeVisible()
            await capture(page, `${width}-undo-expanded`)
            if (width === 1600) {
                await page.emulateMedia({ colorScheme: 'dark' })
                await capture(page, `${width}-dark`)
            }
        })
    })
}

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
            await capture(
                page,
                `${size.width}-${size.height}-${filtered ? 'filtered' : 'all'}-list`,
            )
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
                await capture(
                    page,
                    `${size.width}-${size.height}-${filtered ? 'filtered' : 'all'}-chart`,
                )
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
    await capture(page, 'portrait-sheet-peek')
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

for (const leave of ['Escape', 'Back to Now'])
    test(`View Chart defers fullscreen elevation restoration until ${leave}`, async ({ page }) => {
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
        if (leave === 'Escape') await page.keyboard.press('Escape')
        else await page.locator('[data-peek-back]').click()
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
        history.resetState(false)
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

test('reset closes an in-progress Go To chooser before a later presentation change', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    await presentation(page).getByRole('button', { name: 'Go To', exact: true }).click()
    await expect(page.locator('[data-history-goto]')).toBeVisible()
    await page.evaluate(() => {
        const history = window.editorTest.history
        history.resetState(false)
    })
    await expect(page.locator('[data-history-goto]')).toHaveCount(0)
    await page.setViewportSize({ width: 520, height: 320 })
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
    await expect(page.locator('[data-history-goto]')).toHaveCount(0)
})

test('filter-driven promotion retains an open Go To chooser, while window resize still dismisses it', async ({
    page,
}) => {
    await page.setViewportSize({ width: 667, height: 350 })
    await open(page)
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'sheet')
    await presentation(page).getByRole('button', { name: 'Go To', exact: true }).click()
    const goTo = page.locator('[data-history-goto]')
    await goTo.getByRole('radio', { name: 'Saves and Exports', exact: true }).click()
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
    await expect(goTo).toHaveCount(1)
    await expect(goTo.getByRole('radio', { name: 'Saves and Exports', exact: true })).toBeFocused()
    expect(await goTo.evaluate((element) => !!element.closest('dialog[open]'))).toBe(true)
    await capture(page, '667-filter-promotion-goto')
    await page.setViewportSize({ width: 668, height: 350 })
    await expect(goTo).toHaveCount(0)
    await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
})

test('520×320 uses identical fine and coarse History geometry and preserves Show Edits Off', async ({
    browser,
    baseURL,
}) => {
    const measurements: Record<string, Record<string, number>> = {}
    for (const hasTouch of [false, true]) {
        const mode = hasTouch ? 'coarse' : 'fine'
        const context = await browser.newContext({
            baseURL,
            viewport: { width: 520, height: 320 },
            hasTouch,
        })
        const page = await context.newPage()
        try {
            await load(page)
            await open(page)
            await expect(presentation(page)).toHaveAttribute('data-history-presentation', 'compact')
            if (hasTouch) await row(page, 'Property 29').tap()
            else await row(page, 'Property 29').click()
            await expect(viewChart(page)).toBeEnabled()
            const modal = await page.evaluate(() => {
                const height = (selector: string) =>
                    document.querySelector(selector)!.getBoundingClientRect().height
                return {
                    status: height('[data-status-bar]'),
                    header: height('[data-history-band]'),
                    footer: height('[data-history-view-chart]'),
                    list: height('[data-history-list]'),
                }
            })
            expect(modal.status).toBe(32)
            expect(modal.header).toBe(48)
            expect(modal.footer).toBe(36)
            expect(modal.list).toBeGreaterThanOrEqual(116)
            await capture(page, `520-320-${mode}-compact-list`)
            if (hasTouch) await viewChart(page).tap()
            else await viewChart(page).click()
            const shown = await selected(page)
            const chart = await page.evaluate(() => {
                const height = (selector: string) =>
                    document.querySelector(selector)!.getBoundingClientRect().height
                return {
                    main: height('[data-peek-main]'),
                    navigation: height('[data-peek-navigation]'),
                    chart: height('.chart-pane'),
                    gap:
                        document.querySelector('[data-peek-navigation]')!.getBoundingClientRect()
                            .top -
                        document.querySelector('[data-peek-main]')!.getBoundingClientRect().bottom,
                    stack:
                        document.querySelector('[data-peek-navigation]')!.getBoundingClientRect()
                            .bottom -
                        document.querySelector('[data-peek-main]')!.getBoundingClientRect().top,
                }
            })
            expect(chart.main).toBe(52)
            expect(chart.navigation).toBe(32)
            expect(chart.gap).toBe(8)
            expect(chart.stack).toBe(92)
            const clearance = await page.evaluate(async () => {
                const { appImport, view } = window.editorTest
                const [{ changeBand }, { peekClearance }, { prospectivePeekClearance }] =
                    await Promise.all([
                        appImport<typeof import('../../src/editor/history/changes')>(
                            '/src/editor/history/changes.ts',
                        ),
                        appImport<typeof import('../../src/editor/toolModals')>(
                            '/src/editor/toolModals.ts',
                        ),
                        appImport<typeof import('../../src/editor/sheetGeometry')>(
                            '/src/editor/sheetGeometry.ts',
                        ),
                    ])
                const pane = document.querySelector('.chart-pane')!.getBoundingClientRect()
                const bar = document.querySelector('[data-peek-bar]')!.getBoundingClientRect()
                return {
                    actual: bar.bottom - pane.top,
                    published: peekClearance.value,
                    band: changeBand.value.top,
                    prospective: prospectivePeekClearance(view.w),
                }
            })
            expect(clearance.actual).toBe(120)
            expect(clearance.published).toBe(clearance.actual)
            expect(clearance.band).toBe(clearance.actual)
            expect(clearance.prospective).toBe(clearance.actual)
            measurements[mode] = { ...modal, ...chart }
            const edits = page.locator('[data-show-edits]')
            if (hasTouch) await edits.tap()
            else await edits.click()
            await expect(edits).toHaveAttribute('aria-pressed', 'false')
            await capture(page, `520-320-${mode}-revealed-chart-off`)
            await open(page)
            if (hasTouch) await viewChart(page).tap()
            else await viewChart(page).click()
            await expect(edits).toHaveAttribute('aria-pressed', 'false')
            expect(await selected(page)).toEqual(shown)
            expect(errors.get(page)).toEqual([])
        } finally {
            await context.close()
        }
    }
    expect(measurements.coarse).toEqual(measurements.fine)
    if (process.env.NSE_HISTORY_SHOTS)
        await writeFile(
            join(process.env.NSE_HISTORY_SHOTS, '520-fine-coarse-metrics.json'),
            JSON.stringify(measurements, null, 2),
        )
})

for (const dismissal of ['native', 'backdrop'])
    test(`compact ${dismissal} dismissal ends peek and restores the live state`, async ({
        page,
    }) => {
        await page.setViewportSize({ width: 520, height: 320 })
        await open(page)
        await row(page, 'Property 29').click()
        await expect(viewChart(page)).toBeEnabled()
        expect((await selected(page)).requested).toBeTruthy()
        if (dismissal === 'native')
            await presentation(page).evaluate((element) => element.closest('dialog')!.close())
        else await page.mouse.click(2, 2)
        await expect(presentation(page)).toHaveCount(0)
        await expect.poll(async () => (await selected(page)).requested).toBeUndefined()
        expect(
            await page.evaluate(
                () =>
                    window.editorTest.history.state.value ===
                    window.editorTest.history.liveState.value,
            ),
        ).toBe(true)
    })

test('peek-control Escape preserves the live selection and ignores modified or composing events', async ({
    page,
}) => {
    await page.setViewportSize({ width: 520, height: 320 })
    await page.evaluate(async () => {
        const { history, fixtures, show } = window.editorTest
        show(fixtures.notes)
        history.pushState(() => 'Selected notes', { ...history.state.value, initialLife: 1234 })
        const note = [...history.state.value.store.slides.note.values()].flat()[0]!
        history.replaceState({ ...history.state.value, selectedEntities: [note] })
        await window.nseFlushTest!.flusher.flush({ strict: true })
    })
    const selection = await page.evaluate(() => window.editorTest.snapshot().selected)
    expect(selection).toHaveLength(1)
    await open(page)
    await row(page, 'Selected notes').click()
    await expect(viewChart(page)).toBeEnabled()
    await viewChart(page).click()
    const edits = page.locator('[data-show-edits]')
    await edits.focus()
    await edits.evaluate((button) => {
        for (const init of [
            { ctrlKey: true },
            { metaKey: true },
            { altKey: true },
            { shiftKey: true },
            { repeat: true },
            { isComposing: true },
            { keyCode: 229 },
        ])
            button.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    cancelable: true,
                    ...init,
                }),
            )
        const prevented = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        })
        prevented.preventDefault()
        button.dispatchEvent(prevented)
    })
    expect((await selected(page)).requested).toBeTruthy()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await selected(page)).requested).toBeUndefined()
    expect(await page.evaluate(() => window.editorTest.snapshot().selected)).toEqual(selection)
})

test('peek child dialogs own their first Escape and chart focus retains Deselect', async ({
    page,
}) => {
    await page.setViewportSize({ width: 280, height: 640 })
    await open(page)
    await row(page, 'Property 29').click()
    await expect(viewChart(page)).toBeEnabled()
    await viewChart(page).click()
    const trigger = page.locator('[data-change-options]')
    await trigger.click()
    await expect(page.locator('[data-change-options-menu]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-change-options-menu]')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect((await selected(page)).requested).toBeTruthy()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await selected(page)).requested).toBeUndefined()
    await page.setViewportSize({ width: 520, height: 320 })
    await open(page)
    await row(page, 'Property 29').click()
    await expect(viewChart(page)).toBeEnabled()
    await viewChart(page).click()
    await page.locator('[data-property-summary]').click()
    await expect(page.getByRole('dialog', { name: 'Property Changes', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Property Changes', exact: true })).toHaveCount(0)
    expect((await selected(page)).requested).toBeTruthy()
    await page.locator('.chart-pane').click({ position: { x: 10, y: 130 } })
    await expect(page.locator('.chart-pane')).toBeFocused()
    await page.keyboard.press('Escape')
    expect((await selected(page)).requested).toBeTruthy()
})
