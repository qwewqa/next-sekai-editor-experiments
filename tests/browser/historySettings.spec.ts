import { expect, test, type JSHandle, type Page } from '@playwright/test'
import {
    backToNow,
    errorsFail,
    flush,
    holdWorker,
    load,
    noErrors,
    openHistory,
    placeTap,
    release,
    reloadAndWait,
    timeline,
} from './historyJourney'
import { confirmReset } from './resetConfirm'

test.afterEach(({ page }) => noErrors(page))

// --- Settings, the dialog and the rows

const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true })

const openSettings = async (page: Page) => {
    await page.keyboard.press(',')
    await expect(settingsDialog(page)).toBeVisible()
}

const closeSettings = async (page: Page) => {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
}

const showEditsSwitch = (page: Page) =>
    settingsDialog(page).getByRole('switch', { name: 'Show Edits by Default' })

const eye = (page: Page) => page.locator('[data-show-edits]')

/** Clicks the first row under Now, and waits until the strip shows. */
const peekFirstRow = async (page: Page) => {
    await timeline(page)
        .locator('[data-history-row]')
        .nth(1)
        .locator('[data-history-group-action]')
        .click()
    await expect(page.locator('[data-peek-bar]')).toBeVisible()
    await expect(eye(page)).toBeVisible()
}

const savedSetting = (page: Page) =>
    page.evaluate(() => window.editorTest.settings.dimUnchangedObjects)

// --- S1: the Show Edits default and the local choice

test('S1: Show Edits starts from the setting, and the eye does not change it', async ({ page }) => {
    test.slow()
    errorsFail(page)
    await load(page)
    await placeTap(page, { lane: 0, beat: 1 })
    await placeTap(page, { lane: 2, beat: 2 })
    // The default is On: a peek starts with the edits shown.
    expect(await savedSetting(page)).toBe(true)
    await openHistory(page)
    await peekFirstRow(page)
    await expect(eye(page)).toHaveAttribute('aria-pressed', 'true')
    await backToNow(page)
    await page.keyboard.press('Escape')
    await expect(timeline(page)).toHaveCount(0)

    // Settings > Editor > Show Edits by Default: Off, and it stays Off after a reload.
    await openSettings(page)
    const toggle = showEditsSwitch(page)
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(await savedSetting(page)).toBe(false)
    await closeSettings(page)
    await flush(page)
    await reloadAndWait(page)
    expect(await savedSetting(page)).toBe(false)

    // The next peek starts Off.
    await openHistory(page)
    await peekFirstRow(page)
    await expect(eye(page)).toHaveAttribute('aria-pressed', 'false')
    // The eye turns it On for this peek, and the setting stays Off.
    await eye(page).click()
    await expect(eye(page)).toHaveAttribute('aria-pressed', 'true')
    expect(await savedSetting(page)).toBe(false)
    await backToNow(page)
    await page.keyboard.press('Escape')
    await expect(timeline(page)).toHaveCount(0)
    await flush(page)
    await reloadAndWait(page)
    expect(await savedSetting(page)).toBe(false)
    await openSettings(page)
    await expect(showEditsSwitch(page)).toHaveAttribute('aria-checked', 'false')
    await closeSettings(page)

    // The next peek starts Off again: the eye was a local choice.
    await openHistory(page)
    await peekFirstRow(page)
    await expect(eye(page)).toHaveAttribute('aria-pressed', 'false')

    // Changing the setting while peeking leaves this peek as it is and applies to the next one.
    await page.evaluate(() => {
        window.editorTest.settings.dimUnchangedObjects = true
    })
    await expect(eye(page)).toHaveAttribute('aria-pressed', 'false')
    await backToNow(page)
    await peekFirstRow(page)
    await expect(eye(page)).toHaveAttribute('aria-pressed', 'true')
})

// --- S2: rebinding History

test('S2: History follows its binding as a tool, a hotkey and in the command list', async ({
    page,
}) => {
    test.slow()
    errorsFail(page)
    await load(page)
    await placeTap(page, { lane: 0, beat: 1 })
    const shortcuts = () =>
        settingsDialog(page)
            .locator('section')
            .filter({ has: page.getByRole('heading', { name: 'Keyboard Shortcuts', exact: true }) })
    const historyKey = () =>
        shortcuts()
            .locator('label')
            .filter({ has: page.getByText('History', { exact: true }) })
            .getByRole('button')
    const sheet = timeline(page)
    const now = sheet.getByRole('row', { name: /^Now/ })

    // The default key shows in the command list.
    await openSettings(page)
    await expect(historyKey()).toHaveText('Shift+H')
    // Real keys into the key field: click it, then press L. J is Generate Slide Notes by default,
    // and a key two commands share runs both.
    await historyKey().click()
    await expect(historyKey()).toHaveText('Press a key or click again to clear')
    await historyKey().press('l')
    await expect(historyKey()).toHaveText('L')
    expect(await page.evaluate(() => window.editorTest.settings.keyboardShortcuts.history)).toBe(
        'l',
    )
    await closeSettings(page)

    // L opens History with focus in the list, and a second L closes it.
    await page.keyboard.press('l')
    await expect(sheet).toBeVisible()
    await expect(now).toBeFocused()
    await page.keyboard.press('l')
    await expect(sheet).toHaveCount(0)

    // H no longer opens it: a sentinel L after it opens it only if H did nothing.
    await page.keyboard.press('Shift+H')
    await page.keyboard.press('l')
    await expect(sheet).toBeVisible()
    await page.keyboard.press('l')
    await expect(sheet).toHaveCount(0)

    // The toolbar tool opens it, and L closes it, as it does after the hotkey.
    // It sits in the Undo group's flyout, which opens when the face is hovered.
    await page.locator('[data-editor-toolbar] button[title="Undo"]').hover()
    await page.locator('[data-editor-toolbar] button[title="History"]').click()
    await expect(sheet).toBeVisible()
    await expect(now).toBeFocused()
    await page.keyboard.press('l')
    await expect(sheet).toHaveCount(0)

    // The command list still shows L.
    await openSettings(page)
    await expect(historyKey()).toHaveText('L')
    // Reset Shortcuts brings Shift+H back.
    await settingsDialog(page).getByRole('button', { name: 'Reset Shortcuts', exact: true }).click()
    await confirmReset(page, 'Reset Shortcuts')
    await expect(historyKey()).toHaveText('Shift+H')
    await closeSettings(page)
    await page.keyboard.press('Shift+H')
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Shift+H')
    await expect(sheet).toHaveCount(0)
})

// --- S3: the first key after opening (DEF-4)

const focusedRow = (page: Page) => timeline(page).locator('[data-history-row]:focus')
const rovingEntries = (page: Page) =>
    timeline(page).locator('[data-history-row][tabindex="0"], [data-history-row] [tabindex="0"]')

test.describe('S3: the first key after opening History is kept (DEF-4)', () => {
    test('a key that reaches the list container acts on the cursor', async ({ page }) => {
        errorsFail(page)
        await load(page)
        await placeTap(page, { lane: 0, beat: 1 })
        await openHistory(page)
        const now = timeline(page).getByRole('row', { name: /^Now/ })
        await expect(now).toBeFocused()
        // The container holds focus for a moment as the list opens, before the cursor's row takes
        // it. A synthetic key sent in the same task as the focus lands in that moment, which no
        // real key press can be timed to hit.
        await page.evaluate(() => {
            const list = document.querySelector<HTMLElement>('[data-history-list]')!
            list.focus()
            list.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
            )
        })
        await expect(page.locator('[data-peek-bar]')).toBeVisible()
        await expect(timeline(page).getByRole('row', { selected: true })).toHaveCount(1)
        await expect(timeline(page).getByRole('row', { name: /^Now/ })).not.toBeFocused()
        await expect(focusedRow(page)).toHaveCount(1)
        await expect(rovingEntries(page)).toHaveCount(1)
    })

    test('while the read is held, keys act on the rows already shown', async ({ page }) => {
        errorsFail(page)
        await load(page)
        await placeTap(page, { lane: 0, beat: 1 })
        await page.evaluate(() => {
            const active = document.activeElement
            if (active instanceof HTMLElement && active !== document.body) active.blur()
        })
        const hold = await holdWorker(page, 'readTimeline')
        try {
            await page.keyboard.press('Shift+H')
            await hold.reached()
            const now = timeline(page).getByRole('row', { name: /^Now/ })
            await expect(now).toBeFocused()
            await page.keyboard.press('ArrowDown')
            await expect(page.locator('[data-peek-bar]')).toBeVisible()
            await expect(rovingEntries(page)).toHaveCount(1)
            await expect(now).not.toBeFocused()
        } finally {
            await release(page)
        }
        // The rows that arrive do not take the focus back.
        await expect(timeline(page).getByRole('row', { name: /^Now/ })).not.toBeFocused()
        await expect(timeline(page).getByRole('row', { selected: true })).toHaveCount(1)
        await expect(rovingEntries(page)).toHaveCount(1)
    })

    test('a newer focus is kept when the read finishes (INV 7)', async ({ page }) => {
        errorsFail(page)
        await load(page)
        await placeTap(page, { lane: 0, beat: 1 })
        await page.evaluate(() => {
            const active = document.activeElement
            if (active instanceof HTMLElement && active !== document.body) active.blur()
        })
        const hold = await holdWorker(page, 'readTimeline')
        let pressed: JSHandle | undefined
        try {
            await page.keyboard.press('Shift+H')
            await hold.reached()
            await expect(timeline(page).getByRole('row', { name: /^Now/ })).toBeFocused()
            // A pointer press on another control moves the focus there.
            await page.locator('[data-history-focus="goto"]').click()
            await expect(timeline(page).getByRole('row', { name: /^Now/ })).not.toBeFocused()
            pressed = await page.evaluateHandle(() => document.activeElement)
        } finally {
            await release(page)
        }
        await expect(timeline(page).locator('[data-history-row]')).not.toHaveCount(0)
        // The rows arriving did not take the focus from where the press put it.
        await expect(focusedRow(page)).toHaveCount(0)
        expect(await page.evaluate((el) => el === document.activeElement, pressed)).toBe(true)
    })
})

// --- DEF-5: a filter shows its list from the top

/** Pushes `count` separate rows (future extensions are never grouped). */
const synthesise = (page: Page, count: number) =>
    page.evaluate((count) => {
        const { history, historySteps } = window.editorTest
        for (let i = 0; i < count; i++)
            history.pushState(
                historySteps.futureInitialLife(
                    history.state.value.initialLife,
                    history.state.value.initialLife + 1,
                    `Life ${i + 1}`,
                ),
                { ...history.state.value, initialLife: history.state.value.initialLife + 1 },
            )
    }, count)

test('DEF-5: choosing a filter shows its list from the top', async ({ page }) => {
    errorsFail(page)
    // A short phone sheet: the banner takes 40 px of the list's height, so the empty list no
    // longer fits and a scroll position kept from the full list stays behind.
    await load(page, { viewport: { width: 390, height: 300 } })
    await synthesise(page, 30)
    await openHistory(page, { focused: false })
    const list = timeline(page)
    const scrollTop = () => list.evaluate((element) => element.scrollTop)
    await list.hover()
    await page.mouse.wheel(0, 300)
    await expect.poll(scrollTop).toBeGreaterThan(100)
    await page.locator('[data-history-focus="goto"]').click()
    await page.locator('[data-goto-filter="saves"]').click()
    await expect(page.locator('[data-history-empty]')).toBeVisible()
    // Now sits at the top of the list, whole, under the banner.
    await expect.poll(scrollTop).toBe(0)
    const now = list.getByRole('row', { name: /^Now/ })
    await expect(now).toBeVisible()
    const clearance = await now.evaluate(
        (row) =>
            row.getBoundingClientRect().top -
            (row.closest('[data-history-list]')?.getBoundingClientRect().top ?? 0),
    )
    expect(clearance).toBeGreaterThanOrEqual(0)
    // Show All brings the full list back, again from the top.
    await page.locator('[data-goto-filter="all"]').click()
    await expect(list.locator('[data-history-row]').nth(1)).toBeVisible()
    await expect.poll(scrollTop).toBe(0)
})
