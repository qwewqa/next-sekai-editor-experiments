import { expect, test, type Page } from '@playwright/test'
import {
    errorsFail,
    flush,
    holdWorker,
    load,
    noErrors,
    notice,
    openHistory,
    placeTap,
    release,
    reloadAndWait,
    timeline,
} from './historyJourney'
import { pressSave, submitSave } from './saveFlows'

// History's rows (audit package C): a save from another device names it, and a row waiting to
// be stored already carries its note delta.

test.skip(
    ({ browserName }) => browserName === 'webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not provide Web Audio',
)

test.afterEach(({ page }) => noErrors(page))

const opfs = { fileSystemAccess: 'opfs' } as const

/** The rows' titles with their note deltas, top down. */
const titlesAndDeltas = (page: Page) =>
    timeline(page)
        .locator('[data-history-row]')
        .evaluateAll((rows) =>
            rows
                .map((row) => ({ row, top: parseFloat((row as HTMLElement).style.top) }))
                .sort((a, b) => a.top - b.top)
                .map(({ row }) => ({
                    title: row.querySelector('[data-history-group-action]')?.textContent?.trim(),
                    delta: row.querySelector('.timeline-count')?.textContent?.trim(),
                })),
        )

test('a save made on another device names it; this browser’s own does not', async ({ page }) => {
    test.slow()
    errorsFail(page)
    await load(page, { platform: opfs })
    await placeTap(page, { lane: -3, beat: 4 })
    await pressSave(page)
    await submitSave(page, 'device')
    await expect(notice(page, 'Saved to device.nxsp')).toBeVisible()
    await flush(page)
    await openHistory(page)
    await expect(timeline(page).getByText('Saved device.nxsp', { exact: true })).toBeVisible()

    // The same history, opened by another browser: the entry's device is no longer this one's.
    await page.evaluate(() =>
        localStorage.setItem(
            'sonolus-next-sekai-editor.deviceId',
            JSON.stringify('another-device'),
        ),
    )
    await reloadAndWait(page)
    await openHistory(page)
    await expect(
        timeline(page).getByText(/^Saved in the web editor \((Chrome|Edge|Firefox|Safari)\)$/),
    ).toBeVisible()
    await expect(timeline(page).getByText('Saved device.nxsp', { exact: true })).toHaveCount(0)
})

test('an undo and a redo waiting to be stored show their note delta', async ({ page }) => {
    test.slow()
    errorsFail(page, { allow: [/A flush failed/] })
    await load(page)
    await placeTap(page, { lane: -3, beat: 4 })
    await placeTap(page, { lane: -1, beat: 5 })
    await flush(page)
    const hold = await holdWorker(page, 'flush')
    try {
        await page.locator('canvas.editor-chart').focus()
        await page.keyboard.press('z')
        await hold.reached()
        await openHistory(page)
        await expect
            .poll(async () =>
                (await titlesAndDeltas(page)).find((row) => /^Undo/.test(row.title ?? '')),
            )
            .toMatchObject({ delta: '−1' })
        await page.locator('canvas.editor-chart').focus()
        await page.keyboard.press('y')
        await expect
            .poll(async () =>
                (await titlesAndDeltas(page)).find((row) => /^Redo/.test(row.title ?? '')),
            )
            .toMatchObject({ delta: '+1' })
    } finally {
        await release(page)
    }
})
