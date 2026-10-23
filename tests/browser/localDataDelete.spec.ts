import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type english from '../../src/i18n/en/index.json'
import { confirmKeyWhenReady, confirmWhenReady } from './confirmWhenReady'
import { errorsFail, flush, load, noErrors, notice, openHistory } from './historyJourney'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

// Settings › Local Data › Delete Sessions… (Local Data design §3.7, §5): ranges with counts that
// follow the box, a confirm that names the work it deletes, and the removal.

const messages = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english
const local = messages.settings.localData

const DAY = 86_400_000

test.afterEach(({ page }) => {
    noErrors(page)
})

const edit = (page: Page, title: string, life: number) =>
    page.evaluate(
        ({ title, life }) => {
            const { history, historySteps } = window.editorTest
            const state = history.state.value
            history.pushState(
                historySteps.futureInitialLife(state.initialLife, life, `Life ${life}`),
                { ...state, initialLife: life, levelInfo: { ...state.levelInfo, title } },
            )
        },
        { title, life },
    )

/** Stores a chain titled `title`, last edited `daysAgo` days ago, then leaves the page on a blank session. */
const chainAged = async (page: Page, title: string, daysAgo: number) => {
    await edit(page, title, 900 + daysAgo)
    await flush(page)
    const ids = await page.evaluate(() => {
        const session = window.nseFlushTest!.flusher.session!
        return { sessionId: session.id, chainId: session.chainId }
    })
    await page.evaluate(() => {
        window.editorTest.history.resetState(false)
    })
    // The worker stamps the edit with its own clock, so the age is set in the row.
    await tamper(page, 'chains', ids.chainId, { updatedAt: Date.now() - daysAgo * DAY })
    return ids
}

/** Changes rows of the database directly, as another build or an old profile would. */
const tamper = (
    page: Page,
    store: 'chains' | 'sessions',
    key: string,
    patch: Record<string, unknown>,
) =>
    page.evaluate(
        ({ store, key, patch }) =>
            new Promise<void>((resolve, reject) => {
                const open = indexedDB.open('nse-local-data')
                open.onsuccess = () => {
                    const tx = open.result.transaction(store, 'readwrite')
                    const objects = tx.objectStore(store)
                    const get = objects.get(key)
                    get.onsuccess = () => objects.put({ ...get.result, ...patch })
                    tx.oncomplete = () => {
                        open.result.close()
                        resolve()
                    }
                    tx.onerror = () => reject(tx.error ?? new Error('Not changed'))
                }
                open.onerror = () => reject(open.error ?? new Error('Not opened'))
            }),
        { store, key, patch },
    )

/** The fixture's own chart is a stored chain too; ids of the chains stored now. */
const storedChains = (page: Page) =>
    page.evaluate(async () => {
        const sessions = await import('/src/local/deleteSessions.ts')
        const read = await sessions.readDeleteChoices()
        return read.storedRead === 'value' ? read.storedValue.map((chain) => chain.chainId) : []
    })

/**
 * A profile: a chain from a newer version at 120 days, the fixture's own chain with nothing in it
 * to lose at 100 (`Fixture`), and three edited ones at 40, 8 and 2 days. The tab's own blank
 * session is open, so it is left out of the choices.
 */
const seed = async (page: Page) => {
    errorsFail(page)
    await load(page)
    await flush(page)
    const [fixture] = await storedChains(page)
    expect(fixture).toBeDefined()
    await tamper(page, 'chains', fixture!, { hasContent: false, updatedAt: Date.now() - 100 * DAY })
    const later = await chainAged(page, 'Later', 120)
    await tamper(page, 'sessions', later.sessionId, { v: 999 })
    await chainAged(page, 'Month', 40)
    await chainAged(page, 'Week', 8)
    await chainAged(page, 'Fresh', 2)
    return { fixture: fixture! }
}

const openLocalData = async (page: Page) => {
    await page.evaluate(async () => {
        const { openSettings } =
            (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
        void openSettings('localData')
    })
    await expect(page.locator('[data-local-data-storage]')).toBeVisible()
}

const settingsDialog = (page: Page) => page.getByRole('dialog', { name: messages.settings.title })
const deleteDialog = (page: Page) => page.getByRole('dialog', { name: local.deleteTitle })

const openDelete = async (page: Page) => {
    await page.locator('[data-delete-sessions-open]').click()
    await expect(page.locator('[data-delete-sessions]')).toBeVisible()
}

const countOf = (page: Page, range: string | number): Locator =>
    page.locator(`[data-delete-range="${range}"] [data-delete-count]`)

const boxCount = (page: Page) => page.locator('[data-delete-include] [data-delete-count]')

const counts = async (page: Page) => {
    const out: Record<string, string | null> = {}
    for (const range of [1, 7, 30, 90, 'all'])
        out[String(range)] = await countOf(page, range).textContent()
    return out
}

const confirmDialog = (page: Page) => page.getByRole('dialog', { name: local.deleteTitle }).last()

const recentRows = async (page: Page) => {
    await openHistory(page)
    await page.getByRole('tab', { name: messages.history.recentSessions }).click()
    await expect(page.locator('[data-recent-sessions]')).toBeVisible()
    await expect(page.locator('[data-sessions-loading]')).toHaveCount(0)
    return page.locator('[data-sessions-row]')
}

test('the dialog opens on over 90 days with the box unticked, and its counts follow the box', async ({
    page,
}) => {
    await seed(page)
    await openLocalData(page)
    await openDelete(page)
    await expect(page.locator('[data-delete-range="90"] input')).toBeChecked()
    await expect(page.locator('[data-delete-range="90"] input')).toBeFocused()
    await expect(page.locator('[data-delete-include] input')).not.toBeChecked()
    // Unticked: only the chains with nothing to lose are counted (the fixture’s, 100 days).
    expect(await counts(page)).toEqual({ '1': '1', '7': '1', '30': '1', '90': '1', all: '1' })
    // The box counts the work not saved to a file in the selected range: the 120 day newer one.
    await expect(boxCount(page)).toHaveText('1')
    await page.locator('[data-delete-range="all"]').click()
    await expect(boxCount(page)).toHaveText('4')
    await page.locator('[data-delete-range="30"]').click()
    await expect(boxCount(page)).toHaveText('2')
    await page.locator('[data-delete-include]').click()
    expect(await counts(page)).toEqual({ '1': '5', '7': '4', '30': '3', '90': '2', all: '5' })
    await expect(page.locator('[data-delete-next]')).toBeEnabled()
    // Every opening starts over.
    await page.locator('[data-delete-sessions] button', { hasText: 'Cancel' }).click()
    await openDelete(page)
    await expect(page.locator('[data-delete-range="90"] input')).toBeChecked()
    await expect(page.locator('[data-delete-include] input')).not.toBeChecked()
})

test('Delete… is off at zero, the confirm names the unsaved work and the newer one, and Enter cancels it', async ({
    page,
}) => {
    await seed(page)
    await openLocalData(page)
    await openDelete(page)
    await page.locator('[data-delete-include]').click()
    await page.locator('[data-delete-range="1"]').click()
    await page.locator('[data-delete-next]').click()
    const confirm = confirmDialog(page)
    await expect(confirm).toContainText('Delete 5 sessions?')
    // Newest first; the fixture’s chain has no work to lose, so it is not named.
    await expect(confirm).toContainText(
        '4 sessions are not saved to a file: "Fresh", "Week", "Month" and 1 more.',
    )
    await expect(confirm).toContainText(
        'Some of these sessions need a newer version of the editor.',
    )
    // Cancel is the default, and Enter on it deletes nothing.
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await confirmKeyWhenReady(page, 'Enter', deleteDialog(page))
    await expect(notice(page, /Deleted/)).toHaveCount(0)
    await page.keyboard.press('Escape')
    const rows = await recentRows(page)
    for (const title of ['browser-regression.json', 'Month', 'Week', 'Fresh', 'Later'])
        await expect(rows.filter({ hasText: title })).toHaveCount(1)
})

test('with the box unticked the unsaved work is kept, and what is deleted leaves Recent Sessions', async ({
    page,
}) => {
    await seed(page)
    await openLocalData(page)
    await openDelete(page)
    // Over 90 days, unticked: just the fixture’s chain; its confirm names no work and no newer line.
    await page.locator('[data-delete-next]').click()
    const confirm = confirmDialog(page)
    await expect(confirm).toContainText('Delete 1 session?')
    await expect(confirm).not.toContainText('not saved to a file')
    await expect(confirm).not.toContainText('newer version')
    await confirmWhenReady(
        confirm.getByRole('button', { name: messages.modals.confirm.delete }),
        deleteDialog(page),
    )
    await expect(notice(page, 'Deleted 1 session')).toBeVisible()
    await expect(deleteDialog(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    const rows = await recentRows(page)
    await expect(rows.filter({ hasText: 'browser-regression.json' })).toHaveCount(0)
    // The unsaved work is all still there.
    for (const title of ['Month', 'Week', 'Fresh', 'Later'])
        await expect(rows.filter({ hasText: title })).toHaveCount(1)
})

test('ticking the box deletes the unsaved work too, including a chain from a newer version', async ({
    page,
}) => {
    await seed(page)
    await openLocalData(page)
    await openDelete(page)
    await page.locator('[data-delete-range="30"]').click()
    await page.locator('[data-delete-include]').click()
    await page.locator('[data-delete-next]').click()
    const confirm = confirmDialog(page)
    await expect(confirm).toContainText('Delete 3 sessions?')
    await expect(confirm).toContainText('"Month"')
    await expect(confirm).toContainText('"Later"')
    await expect(confirm).not.toContainText('"Week"')
    await confirmWhenReady(
        confirm.getByRole('button', { name: messages.modals.confirm.delete }),
        deleteDialog(page),
    )
    await expect(notice(page, 'Deleted 3 sessions')).toBeVisible()
    await page.keyboard.press('Escape')
    const rows = await recentRows(page)
    for (const title of ['browser-regression.json', 'Month', 'Later'])
        await expect(rows.filter({ hasText: title })).toHaveCount(0)
    for (const title of ['Week', 'Fresh'])
        await expect(rows.filter({ hasText: title })).toHaveCount(1)
})

test('Delete… is disabled when nothing is chosen', async ({ page }) => {
    errorsFail(page)
    await load(page)
    await openLocalData(page)
    await openDelete(page)
    expect(await counts(page)).toEqual({ '1': '0', '7': '0', '30': '0', '90': '0', all: '0' })
    await expect(page.locator('[data-delete-next]')).toBeDisabled()
    // Enter in the form does not go on to the confirm either.
    await page.locator('[data-delete-range="90"] input').press('Enter')
    await expect(page.getByRole('dialog', { name: local.deleteTitle })).toHaveCount(1)
})

test('a chain edited since the dialog read it is skipped, and a run that deletes nothing says so', async ({
    page,
}) => {
    const { fixture } = await seed(page)
    await openLocalData(page)
    await openDelete(page)
    // The chain is edited (by another tab, say) while the dialog is open.
    await tamper(page, 'chains', fixture, { updatedAt: Date.now() })
    await page.locator('[data-delete-next]').click()
    await confirmWhenReady(
        confirmDialog(page).getByRole('button', { name: messages.modals.confirm.delete }),
        deleteDialog(page),
    )
    // Edited since it was read: skipped, so nothing went, and the failure says so.
    await expect(notice(page, local.deleteFailed)).toBeVisible()
})

// --- The Storage subsection, Recovery's Export Raw Data…, and the almost-full notice.

/** The browser's estimate, as a fixed answer (or none). */
const estimateOf = (page: Page, answer: { usage?: number; quota?: number } | undefined) =>
    page.addInitScript((value) => {
        StorageManager.prototype.estimate = () =>
            value ? Promise.resolve(value) : Promise.reject(new Error('unsupported'))
    }, answer)

const stored = (page: Page) => page.locator('[data-stored-total]')

test('Storage shows what the browser holds, only when the estimate says both figures', async ({
    page,
}) => {
    await estimateOf(page, { usage: 84_000_000, quota: 2_100_000_000 })
    errorsFail(page)
    await load(page)
    await openLocalData(page)
    await expect(stored(page)).toHaveText('Stored in this browser: 84 MB of about 2.1 GB')
    // Delete Sessions… sits under it; Open History moved into Recovery.
    await expect(
        page.locator('[data-local-data-storage] [data-delete-sessions-open]'),
    ).toBeVisible()
    await expect(page.locator('[data-local-data-recovery] [data-open-history]')).toBeVisible()
    await expect(page.locator('[data-local-data-storage] [data-not-stored-line]')).toHaveCount(0)
})

test('no figure is guessed: without a quota the total is left out', async ({ page }) => {
    await estimateOf(page, { usage: 84_000_000 })
    errorsFail(page)
    await load(page)
    await openLocalData(page)
    await expect(page.locator('[data-delete-sessions-open]')).toBeVisible()
    await expect(stored(page)).toHaveCount(0)
})

test('a full browser: Local Data says why, Try Again says it is still full, Delete Sessions… is there', async ({
    page,
}) => {
    // A full browser logs each failed flush.
    errorsFail(page, { allow: [/Storing paused: full/] })
    await load(page, { storage: { forceQuota: true } })
    await edit(page, 'Full', 990)
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest?.status()))
        .toEqual({ mode: 'stored', reason: 'full' })
    await openLocalData(page)
    const line = page.locator('[data-not-stored-line]')
    await expect(line).toContainText('Changes are not being stored in this browser.', {
        timeout: 8000,
    })
    await expect(line).toContainText('Browser storage is full.')
    await expect(page.locator('[data-delete-sessions-open]')).toBeVisible()
    await line.getByRole('button', { name: 'Try Again' }).click()
    await expect(notice(page, 'Changes are not being stored in this browser.')).toBeVisible()
    await expect(line).toBeVisible()
})

test('Export Raw Data… downloads the stored data and says so', async ({ page }) => {
    errorsFail(page)
    await load(page)
    await openLocalData(page)
    await expect(page.locator('[data-local-data-recovery]')).toContainText(local.exportRawNote)
    const download = page.waitForEvent('download')
    await page.locator('[data-export-raw]').click()
    expect((await download).suggestedFilename()).toMatch(
        /^Next SEKAI Editor raw data \d{4}-\d{2}-\d{2}\.zip$/,
    )
    await expect(notice(page, /^Download started: Next SEKAI Editor raw data/)).toBeVisible()
    // The progress dialog is gone.
    await expect(page.getByRole('dialog', { name: local.exportRaw })).toHaveCount(0)
})

test.describe('almost full', () => {
    const nearlyFull = { usage: 900_000_000, quota: 1_000_000_000 }
    const line = (page: Page) => notice(page, messages.load.storageNearlyFull)

    test('says so once per day, with Local Data as its action, and not when there is room', async ({
        page,
    }) => {
        await estimateOf(page, nearlyFull)
        errorsFail(page)
        await load(page)
        await expect(line(page)).toBeVisible({ timeout: 15_000 })
        await line(page).getByRole('button', { name: messages.load.localData }).click()
        await expect(page.locator('[data-local-data-storage]')).toBeVisible()
        // Local Data lists it among this load's notices.
        await expect(page.locator('[data-at-load] li')).toContainText([
            messages.load.storageNearlyFull,
        ])
        // A reload the same day says nothing.
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect
            .poll(() => page.evaluate(() => window.nseStorageTest?.status()?.mode))
            .toBe('stored')
        await expect(line(page)).toHaveCount(0)
        // Another day says it again.
        await page.evaluate(() => {
            localStorage.setItem('sonolus-next-sekai-editor.nearlyFullDay', '"1"')
        })
        await page.reload()
        await expect(line(page)).toBeVisible({ timeout: 15_000 })
    })

    test('with room left there is no notice and no stamp', async ({ page }) => {
        await estimateOf(page, { usage: 500_000_000, quota: 1_000_000_000 })
        errorsFail(page)
        await load(page)
        await expect
            .poll(() => page.evaluate(() => window.nseStorageTest?.status()?.mode))
            .toBe('stored')
        // The load's run has had its idle time.
        await page.waitForFunction(() => document.readyState === 'complete')
        await expect(line(page)).toHaveCount(0)
        expect(
            await page.evaluate(() =>
                localStorage.getItem('sonolus-next-sekai-editor.nearlyFullDay'),
            ),
        ).toBeNull()
    })
})
