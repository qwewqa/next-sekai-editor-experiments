import { expect, test, type Page } from '@playwright/test'
import { installEditorFixture, waitForStartup } from './editorFixture'

// Long histories (Part 1 §1.4.10.5): Go To's jump list, the window it reads, the gap row above it
// and End. Three days of edits: made now, then their stored times moved back a day apart.

const prefix = 'sonolus-next-sekai-editor.'
// Screenshots are written only when NSE_SHOTS is set.
const shots = 'D:/sonolus/nse-next/work/step5/p4-shots'

const DAYS = 3
const PER_DAY = 150
/** The days, oldest first: ten, nine and eight days ago, from 10 AM. */
const dayStart = (d: number) => {
    const date = new Date()
    date.setDate(date.getDate() - 10 + d)
    date.setHours(10, 0, 0, 0)
    return date.getTime()
}
const dayName = (d: number) =>
    new Date(dayStart(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

test.beforeEach(async ({ page }) => {
    await page.addInitScript((prefix) => {
        localStorage.setItem(`${prefix}showPreview`, 'false')
        localStorage.setItem(`${prefix}showSidebar`, 'false')
        localStorage.setItem('nse.test.storage', '{}')
    }, prefix)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
    await page.evaluate(
        async ({ days, perDay }) => {
            const { history } = window.editorTest
            for (let d = 0; d < days; d++)
                for (let i = 0; i < perDay; i++)
                    history.pushState(
                        window.editorTest.historySteps.futureInitialLife(
                            history.state.value.initialLife,
                            history.state.value.initialLife + 1,
                            `Day ${d + 1} edit ${i + 1}`,
                        ),
                        {
                            ...history.state.value,
                            initialLife: history.state.value.initialLife + 1,
                        },
                    )
            await window.nseFlushTest!.flusher.flush({ strict: true })
        },
        { days: DAYS, perDay: PER_DAY },
    )
    // Initialize and each day's edits a minute apart, on their days.
    await page.evaluate(
        async ({ starts, perDay }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open('nse-local-data')
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
            })
            const tx = db.transaction('entries', 'readwrite')
            const store = tx.objectStore('entries')
            const rows = await new Promise<{ seq: number; time: number }[]>((resolve) => {
                const request = store.getAll()
                request.onsuccess = () => resolve(request.result as never)
            })
            rows.sort((a, b) => a.seq - b.seq)
            for (const [i, row] of rows.entries()) {
                const d = Math.min(starts.length - 1, Math.floor(Math.max(0, i - 1) / perDay))
                row.time = starts[d]! + (i - d * perDay) * 60_000
                store.put(row)
            }
            await new Promise((resolve) => (tx.oncomplete = resolve))
            db.close()
        },
        { starts: [0, 1, 2].map(dayStart), perDay: PER_DAY },
    )
})

const dialog = (page: Page) => page.locator('[data-history-surface="dialog"]')
const list = (page: Page) => dialog(page).locator('[data-history-list]')
const goTo = (page: Page) => page.locator('[data-history-goto]')
const items = (page: Page) => goTo(page).locator('[data-goto-item]')
const selected = (page: Page) => list(page).locator('[role="row"][aria-selected="true"]')

const openDialog = async (page: Page) => {
    await page.locator('.chart-pane').click({ position: { x: 300, y: 300 } })
    await page.keyboard.press('Shift+H')
    await expect(selected(page)).toBeFocused()
}

const openGoTo = async (page: Page) => {
    await dialog(page).locator('[data-history-goto-button]').click()
    await expect(items(page)).toHaveCount(DAYS + 1)
}

/** Holds the reads of newer pages until the returned function is called. */
const holdNewerPages = (page: Page) =>
    page.evaluate(async () => {
        const start =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const worker = start.storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const call = worker.call.bind(worker)
        const win = window as unknown as { releaseNewer?: () => void }
        let gate = new Promise<void>((resolve) => (win.releaseNewer = resolve))
        worker.call = async (name, ...args) => {
            const request = args[0] as { after?: number; limit?: number } | undefined
            if (name === 'readTimeline' && request?.after !== undefined && request.limit) {
                await gate
                gate = new Promise<void>((resolve) => (win.releaseNewer = resolve))
            }
            return call(name, ...args)
        }
    })

test('Go To lists Now and each day with its steps, and a day peeks its newest entry', async ({
    page,
}) => {
    await openDialog(page)
    await openGoTo(page)
    await expect(items(page).first()).toHaveAttribute('aria-current', 'location')
    // Days of one session are one row each, newest first; the first day also has Initialize.
    await expect(items(page).nth(1)).toContainText(dayName(2))
    await expect(items(page).nth(1)).toContainText(`${PER_DAY} steps`)
    await expect(items(page).nth(3)).toContainText(dayName(0))
    await expect(items(page).nth(3)).toContainText(`${PER_DAY + 1} steps`)
    if (process.env.NSE_SHOTS) await page.screenshot({ path: `${shots}/spec-goto.png` })

    await items(page).nth(3).click()
    await expect(goTo(page)).toHaveCount(0)
    await expect(selected(page)).toContainText(`Day 1 edit ${PER_DAY}`)
    await expect(page.locator('[data-peek-bar]')).toContainText(dayName(0))
    await expect(selected(page)).toBeFocused()
    // Go To now has its check on that day.
    await openGoTo(page)
    await expect(items(page).nth(3)).toHaveAttribute('aria-current', 'location')
    await expect(goTo(page).locator('[data-goto-check]')).toHaveCount(1)
})

test('the gap row loads newer pages as it comes into view, and the rows on screen stay', async ({
    page,
}) => {
    await openDialog(page)
    await openGoTo(page)
    await items(page).nth(3).click()
    await expect(selected(page)).toContainText(`Day 1 edit ${PER_DAY}`)
    await holdNewerPages(page)
    // The window holds a page above the target; the rest is in the gap.
    await list(page).evaluate((element) => (element.scrollTop = 0))
    const gap = list(page).locator('[data-history-gap]')
    await expect(gap).toContainText(`${PER_DAY * 2 - 100} newer steps`)
    const firstRow = list(page).getByRole('row').nth(2)
    const label = (await firstRow.textContent()) ?? ''
    const before = await firstRow.boundingBox()
    await page.evaluate(() => (window as unknown as { releaseNewer: () => void }).releaseNewer())
    await expect(gap).not.toBeInViewport()
    const after = await list(page)
        .getByRole('row')
        .filter({ hasText: label.trim() })
        .first()
        .boundingBox()
    expect(after?.y).toBeCloseTo(before?.y ?? 0, 0)
    // Scrolled up again, the rest loads and the gap goes.
    await page.evaluate(() => (window as unknown as { releaseNewer: () => void }).releaseNewer())
    await list(page).evaluate((element) => (element.scrollTop = 0))
    await page.evaluate(() => (window as unknown as { releaseNewer: () => void }).releaseNewer())
    await expect(list(page).locator('[data-history-gap]')).toHaveCount(0)
})

test('keys: Up crosses the gap, End reads the oldest entry, Home goes back to Now', async ({
    page,
}) => {
    await openDialog(page)
    await openGoTo(page)
    // Tab from the Show switch goes to the list; Enter picks there.
    await page.keyboard.press('Tab')
    await expect(goTo(page).locator('[data-goto-list]')).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(selected(page)).toContainText(`Day 2 edit ${PER_DAY}`)
    // Up from the top of the window: the next newer entry, read across the gap.
    await selected(page).focus()
    for (let i = 0; i < 101; i++) await page.keyboard.press('ArrowUp')
    await expect(selected(page)).toContainText('Day 3 edit 101')

    await page.keyboard.press('End')
    await expect(selected(page)).toContainText('Imported a level')
    await page.keyboard.press('Home')
    await expect(list(page).locator('[data-history-gap]')).toHaveCount(0)
    await expect(selected(page)).toContainText('Now')
    await expect(page.locator('[data-peek-bar]')).toHaveCount(0)
})
