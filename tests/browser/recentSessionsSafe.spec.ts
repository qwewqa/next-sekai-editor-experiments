import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type english from '../../src/i18n/en/index.json'
import { errorsFail, flush, load, noErrors, notice, openHistory } from './historyJourney'
import { saveDialog, submitSave } from './saveFlows'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

// `?safe`: Recent Sessions lists what is stored and reads it, and the
// only way into a session is a copy that stores nothing. Recent Sessions' Save… still writes the file.

const messages = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english

test.afterEach(({ page }) => {
    noErrors(page)
})

const storedRows = (page: Page) =>
    page.evaluate(async () => {
        const found = (await window.nseStorageTest!.worker.call('testRows', [
            'chains',
            'sessions',
            'entries',
        ])) as Record<string, { value: Record<string, unknown> }[]>
        return JSON.stringify(found)
    })

const lifeOf = (page: Page) =>
    page.evaluate(async () => {
        const { state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        return state.value.initialLife
    })

/** One stored chain titled Alpha, then the page in safe mode over the same storage. */
const safePage = async (page: Page) => {
    errorsFail(page)
    await load(page, { platform: { fileSystemAccess: false } })
    await page.evaluate(() => {
        const { history, historySteps } = window.editorTest
        const state = history.state.value
        history.pushState(historySteps.futureInitialLife(state.initialLife, 990, 'Life 990'), {
            ...state,
            initialLife: 990,
            levelInfo: { ...state.levelInfo, title: 'Alpha' },
        })
    })
    await flush(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await page.goto('/?safe')
    await expect(page.locator('[data-safe-bar]')).toBeVisible()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest?.status()?.mode))
        .toBe('readOnly')
    await openHistory(page, { focused: false })
    await page.getByRole('tab', { name: messages.history.recentSessions }).click()
    await expect(page.locator('[data-sessions-loading]')).toHaveCount(0)
}

const row = (page: Page, name: string) =>
    page.locator('[data-sessions-row]').filter({ hasText: name })

test('safe mode lists the stored sessions, peeks them, and Restore as a Copy opens one unbound and stores nothing', async ({
    page,
}) => {
    await safePage(page)
    await expect(row(page, 'Alpha')).toBeVisible()
    const before = await storedRows(page)

    // The row is peeked; its bar offers the copy, the only way in.
    await row(page, 'Alpha').click()
    const bar = page.locator('[data-peek-bar]')
    await expect(bar.locator('[data-peek-session]')).toContainText('"Alpha"')
    await expect(bar.locator('[data-peek-restore]')).toHaveText(messages.load.restoreAsCopy)
    await bar.locator('[data-peek-restore]').click()

    await expect.poll(() => lifeOf(page)).toBe(990)
    await expect(notice(page, 'Restored a copy of "Alpha"')).toBeVisible()
    await expect(page.getByRole('tab', { name: messages.history.timeline })).toHaveAttribute(
        'aria-selected',
        'true',
    )
    // The copy is not bound to a file, and nothing it did reached storage.
    await expect(page.getByText('separate copy of Alpha').last()).toBeVisible()
    expect(await storedRows(page)).toBe(before)
})

test('safe mode’s menu is Restore as a Copy and Save…, and Save… writes the file', async ({
    page,
}) => {
    await safePage(page)
    await row(page, 'Alpha').locator('[data-sessions-more]').click()
    await expect(page.getByRole('menuitem')).toHaveText([
        messages.load.restoreAsCopy,
        messages.history.sessions.saveToFile,
    ])
    const before = await storedRows(page)
    await page.getByRole('menuitem', { name: messages.history.sessions.saveToFile }).click()
    await expect(saveDialog(page)).toBeVisible()
    const downloading = page.waitForEvent('download')
    await submitSave(page, 'alpha')
    const download = await downloading
    expect(download.suggestedFilename()).toBe('alpha.nxsp')
    // Nothing was applied to storage to write it.
    expect(await storedRows(page)).toBe(before)
})

test('safe mode has no Delete Sessions… button, and the command says why', async ({ page }) => {
    await safePage(page)
    await expect(row(page, 'Alpha')).toBeVisible()
    await expect(page.locator('[data-history-delete-sessions]')).toHaveCount(0)
    await page.evaluate(async () => {
        const { commands } =
            (await import('/src/editor/commands/index.ts')) as typeof import('../../src/editor/commands')
        void commands.deleteSessions.execute()
    })
    await expect(notice(page, messages.safe.bar)).toBeVisible()
    await expect(page.locator('[data-delete-sessions]')).toHaveCount(0)
})
