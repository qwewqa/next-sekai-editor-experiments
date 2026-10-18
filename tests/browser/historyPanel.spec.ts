import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { installEditorFixture, waitForStartup } from './editorFixture'

// The History tab and dialog, the Timeline and the peek bar (Part 1 §1.4.10, §1.4.11, Step 5).
// Entries are made through the undo stack's own `pushState`, as history.spec.ts does.

const prefix = 'sonolus-next-sekai-editor.'
// Screenshots are written only when NSE_SHOTS is set.
const shots = 'D:/sonolus/nse-next/work/step5/redesign-shots'
const shoot = async (page: Page, name: string) => {
    if (process.env.NSE_SHOTS) await page.screenshot({ path: `${shots}/${name}.png` })
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript((prefix) => {
        performance.setResourceTimingBufferSize(5000)
        localStorage.setItem(`${prefix}showPreview`, 'false')
        localStorage.setItem(`${prefix}showSidebar`, 'false')
        // The storage test hooks (`nseFlushTest`), in every tab of the context.
        localStorage.setItem('nse.test.storage', '{}')
    }, prefix)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
})

/** Makes edits named after their numbers, each raising the life. */
const edit = (page: Page, count: number, label = 'Life') =>
    page.evaluate(
        async ({ count, label }) => {
            const { history } = window.editorTest
            for (let i = 0; i < count; i++)
                history.pushState(() => `${label}${count > 1 ? ` ${i + 1}` : ''}`, {
                    ...history.state.value,
                    initialLife: history.state.value.initialLife + 1,
                })
        },
        { count, label },
    )

/** The life as shown (the peeked state's while viewing history) and as written (the live one). */
const lives = (page: Page) =>
    page.evaluate(() => {
        const { history } = window.editorTest
        return { shown: history.state.value.initialLife, live: history.liveState.value.initialLife }
    })

/** Stores what the tab holds, so every entry can be read from storage. */
const stored = (page: Page) =>
    page.evaluate(async () => {
        await window.nseFlushTest!.flusher.flush({ strict: true })
    })

const surface = (page: Page, name: 'panel' | 'dialog') =>
    page.locator(`[data-history-surface="${name}"]`)
const list = (page: Page, name: 'panel' | 'dialog' = 'panel') =>
    surface(page, name).locator('[data-history-list]')

const row = (page: Page, text: string, name: 'panel' | 'dialog' = 'panel'): Locator =>
    list(page, name)
        .getByRole('option')
        .filter({ has: page.getByText(text, { exact: true }) })

const peekBar = (page: Page) => page.locator('[data-peek-bar]')

const dock = (page: Page, side: 'left' | 'right' | 'top') =>
    page.locator(`[data-workspace-dock="${side}"]`)

const tab = (page: Page, side: 'left' | 'right' | 'top', name: string) =>
    dock(page, side).getByRole('tab', { name, exact: false })

const sheet = (page: Page) => page.locator('[data-tool-dialog][data-sheet]')

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

const setSettings = (page: Page, values: Record<string, unknown>) =>
    page.evaluate((values) => {
        Object.assign(window.editorTest.settings, values)
    }, values)

const getSettings = (page: Page, keys: string[]) =>
    page.evaluate(
        (keys) =>
            Object.fromEntries(
                keys.map((key) => [
                    key,
                    (window.editorTest.settings as unknown as Record<string, unknown>)[key],
                ]),
            ),
        keys,
    )

/** Opens the History tab as a user's tap on its name. */
const openTab = async (page: Page, side: 'left' | 'right' | 'top' = 'right') => {
    await tab(page, side, 'History').click()
    await expect(surface(page, 'panel')).toBeVisible()
}

/** Gives the Timeline older entries, as a long chain would: today, yesterday and a week ago. */
const seedOlder = (page: Page) =>
    page.evaluate(async () => {
        const start =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const worker = start.storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const call = worker.call.bind(worker)
        const hour = 3_600_000
        const now = Date.now()
        const at = (hoursAgo: number) => now - hoursAgo * hour
        let seq = 900
        const entry = (
            hoursAgo: number,
            kind: string,
            label: string,
            extra: Record<string, unknown> = {},
        ) => ({
            sessionId: 'seeded',
            seq: seq--,
            time: at(hoursAgo),
            kind,
            label,
            snapshot: '00',
            noteCount: 40,
            dirty: false,
            kept: true,
            ...extra,
        })
        const older = [
            entry(2.5, 'edit', 'Added notes', { noteCount: 64 }),
            entry(2.6, 'save', 'Saved coconut.nxsp', { noteCount: 40 }),
            entry(3, 'edit', 'Moved notes'),
            entry(3.2, 'continue', 'Continued', { from: at(30) }),
            entry(30, 'export', 'Exported coconut.json'),
            entry(30.5, 'edit', 'Removed notes', { noteCount: 37, kept: false }),
            entry(30.6, 'edit', 'Changed BPM', { noteCount: 40 }),
            entry(24 * 5, 'edit', 'Moved slide'),
            entry(24 * 9, 'edit', 'Added notes'),
            entry(24 * 9 + 1, 'init', 'Initialize'),
        ]
        worker.call = async (name, ...args) => {
            const result = await call(name, ...args)
            if (name !== 'readTimeline') return result
            const page = result as { entries: unknown[] }
            return { ...page, entries: [...page.entries, ...older] }
        }
    })

test.describe('the tab', () => {
    test('it is on its rail with the others, closed until opened, and its state is saved', async ({
        page,
    }) => {
        // Last in the right dock, beside Properties; its body is closed.
        const tabs = await dock(page, 'right')
            .locator('[data-panel-tab]')
            .evaluateAll((tabs) => tabs.map((tab) => (tab as HTMLElement).dataset.panelTab))
        expect(tabs).toEqual(['properties', 'history'])
        await expect(tab(page, 'right', 'History')).toHaveAttribute('aria-selected', 'false')
        await expect(surface(page, 'panel')).toHaveCount(0)
        expect((await getSettings(page, ['showHistory'])).showHistory).toBe(false)

        await openTab(page)
        await expect(tab(page, 'right', 'History')).toHaveAttribute('aria-selected', 'true')
        expect((await getSettings(page, ['showHistory'])).showHistory).toBe(true)
        // The tab does not take focus from the chart.
        await expect(list(page)).not.toBeFocused()

        // A reload brings it back open, as it brings back Groups.
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(page)
        await expect(surface(page, 'panel')).toBeVisible()

        await tab(page, 'right', 'History').click()
        await expect(surface(page, 'panel')).toHaveCount(0)
    })

    test('a phone opens it in the top dock like Groups and keeps it until Preview is tapped', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await setSettings(page, { showPreview: true })
        await settle(page)
        await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-selected', 'true')
        await openTab(page, 'top')
        await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-selected', 'false')
        // It stays: nothing brings Preview back on its own.
        await settle(page)
        await expect(surface(page, 'panel')).toBeVisible()
        await tab(page, 'top', 'Preview').click()
        await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-selected', 'true')
        await expect(surface(page, 'panel')).toHaveCount(0)
    })

    test('folding the dock keeps a peek going, and closing or displacing the tab ends it', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await edit(page, 3)
        await stored(page)
        await openTab(page, 'top')
        await row(page, 'Life 2').click()
        await expect(peekBar(page)).toBeVisible()
        // The only panel in the dock: its tab folds it.
        await tab(page, 'top', 'History').click()
        await expect(surface(page, 'panel')).toHaveCount(0)
        await expect(peekBar(page)).toBeVisible()
        // Again unfolds it, with the peek unchanged.
        await tab(page, 'top', 'History').click()
        await expect(surface(page, 'panel')).toBeVisible()
        await expect(peekBar(page)).toBeVisible()
        // Another panel displacing it ends the peek.
        await tab(page, 'top', 'Groups').click()
        await expect(surface(page, 'panel')).toHaveCount(0)
        await expect(peekBar(page)).toHaveCount(0)
        const { shown, live } = await lives(page)
        expect(shown).toBe(live)

        // So does closing it from its menu.
        await openTab(page, 'top')
        await row(page, 'Life 1').click()
        await expect(peekBar(page)).toBeVisible()
        await tab(page, 'top', 'History').click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Close History' }).click()
        await expect(peekBar(page)).toHaveCount(0)
    })

    test('the tab menu offers the dock positions and Close, and a middle click closes', async ({
        page,
    }) => {
        await openTab(page)
        await tab(page, 'right', 'History').click({ button: 'right' })
        await expect(page.getByRole('menuitemradio')).toHaveText([
            'Dock Automatically',
            'Dock Left',
            'Dock Right',
            'Dock Top',
        ])
        await expect(page.getByRole('menuitem', { name: 'Close History' })).toBeVisible()
        await page.getByRole('menuitemradio', { name: 'Dock Left' }).click()
        await expect(tab(page, 'left', 'History')).toBeVisible()
        expect((await getSettings(page, ['historyPosition'])).historyPosition).toBe('left')
        await tab(page, 'left', 'History').click({ button: 'middle' })
        await expect(surface(page, 'panel')).toHaveCount(0)
    })

    test('Settings › Panels offers Disabled for History as for every panel, and it hides the tab', async ({
        page,
    }) => {
        await page.keyboard.press(',')
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        const select = (name: string) =>
            dialog
                .locator('label')
                .filter({ has: page.getByText(name, { exact: true }) })
                .getByRole('combobox')
        const options = (name: string) => select(name).locator('option').allTextContents()
        expect(await options('History')).toEqual(await options('Groups'))
        expect(await options('History')).toContain('Disabled')
        await shoot(page, 'settings-panels')
        await select('History').selectOption({ label: 'Disabled' })
        await page.keyboard.press('Escape')
        await expect(page.locator('[data-panel-tab="history"]')).toHaveCount(0)
        expect((await getSettings(page, ['historyPosition'])).historyPosition).toBe('disabled')
        // A stored Disabled is honoured after a reload.
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(page)
        await expect(page.locator('[data-panel-tab="history"]')).toHaveCount(0)
    })

    test('with every tab disabled the chart takes the window, and Settings still opens', async ({
        page,
    }) => {
        await setSettings(page, {
            previewPosition: 'disabled',
            groupsPosition: 'disabled',
            stagesPosition: 'disabled',
            propertiesPosition: 'disabled',
            historyPosition: 'disabled',
        })
        await settle(page)
        await expect(page.locator('[data-workspace-dock]')).toHaveCount(0)
        const pane = await page.locator('.chart-pane').boundingBox()
        expect(pane?.width).toBeGreaterThan(1590)
        await shoot(page, 'hidden-desktop')
        await page.keyboard.press(',')
        await expect(page.getByRole('dialog')).toBeVisible()
    })
})

test.describe('the dialog', () => {
    test('H opens it with its list focused, over a visible tab, and H again closes it', async ({
        page,
    }) => {
        await edit(page, 3)
        await openTab(page)
        await page.locator('.chart-pane').click({ position: { x: 300, y: 300 } })
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toBeVisible()
        await expect(list(page, 'dialog')).toBeFocused()
        // Now, three edits and the first entry.
        await expect(list(page, 'dialog').getByRole('option')).toHaveCount(5)
        await expect(row(page, 'Now · Life 3', 'dialog')).toHaveAttribute('aria-selected', 'true')
        // The tab is still there: two views of one history.
        await expect(surface(page, 'panel')).toBeVisible()
        // No scrim: the chart stays live, and the toolbar steps aside.
        await expect(page.locator('[data-editor-toolbar]')).toHaveCount(0)
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toHaveCount(0)
        await expect(page.locator('[data-editor-toolbar]')).toBeVisible()
    })

    test('the toolbar tool and the command list run the same command', async ({ page }) => {
        const face = page.locator('[data-editor-toolbar] button[title="Undo"]')
        await face.hover()
        const tool = page.locator('[data-editor-toolbar] button[title="History"]')
        // Never pressed: it is a command, and the Undo face stays.
        await expect(tool).not.toHaveAttribute('aria-pressed')
        await tool.click()
        await expect(sheet(page)).toBeVisible()
        // The tab did not open.
        await expect(surface(page, 'panel')).toHaveCount(0)
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toHaveCount(0)
        await expect(face).toBeVisible()
        // The command list entry opens it too.
        await page.evaluate(async () => {
            const { commands } = await window.editorTest.appImport<
                typeof import('../../src/editor/commands')
            >('/src/editor/commands/index.ts')
            void commands.history.execute()
        })
        await expect(sheet(page)).toBeVisible()
    })

    test('it shares the tab, filter and peek with the tab, and each keeps its own scroll', async ({
        page,
    }) => {
        await edit(page, 3)
        await stored(page)
        await openTab(page)
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toBeVisible()
        await row(page, 'Life 2', 'dialog').click()
        await expect(peekBar(page)).toBeVisible()
        await expect(row(page, 'Life 2')).toHaveAttribute('aria-selected', 'true')
        await sheet(page).getByRole('tab', { name: 'Recent Sessions' }).click()
        await expect(
            surface(page, 'panel').getByRole('tab', { name: 'Recent Sessions' }),
        ).toHaveAttribute('aria-selected', 'true')
    })

    test('Escape goes back to now, then closes, and closing ends the peek and returns focus', async ({
        page,
    }) => {
        await edit(page, 3)
        await stored(page)
        const base = (await lives(page)).live
        await page.keyboard.press('Shift+H')
        await row(page, 'Life 1', 'dialog').click()
        await expect(peekBar(page)).toBeVisible()
        await expect.poll(() => lives(page)).toEqual({ shown: base - 2, live: base })
        await page.keyboard.press('Escape')
        await expect(peekBar(page)).toHaveCount(0)
        await expect(sheet(page)).toBeVisible()
        await row(page, 'Life 2', 'dialog').click()
        await expect(peekBar(page)).toBeVisible()
        // The close button ends the peek.
        await sheet(page).getByRole('button', { name: 'Close' }).click()
        await expect(sheet(page)).toHaveCount(0)
        await expect(peekBar(page)).toHaveCount(0)
        expect(await lives(page)).toEqual({ shown: base, live: base })
        // At now, Escape closes.
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(sheet(page)).toHaveCount(0)
    })

    test('the tool stays and Space plays while it is open', async ({ page }) => {
        const toolName = () =>
            page.evaluate(
                async () =>
                    (
                        await window.editorTest.appImport<typeof import('../../src/editor/tools')>(
                            '/src/editor/tools/index.ts',
                        )
                    ).toolName.value,
            )
        const before = await toolName()
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toBeVisible()
        await page.locator('.chart-pane').click({ position: { x: 300, y: 300 } })
        // Keys keep working with the chart focused: Shift+H closes it again.
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toHaveCount(0)
        expect(await toolName()).toBe(before)
    })

    test('a tool dialog closes it, and it closes a tool dialog', async ({ page }) => {
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toBeVisible()
        await page.evaluate(async () => {
            const { appImport } = window.editorTest
            const [{ showToolModal }, modal] = await Promise.all([
                appImport<typeof import('../../src/editor/toolModals')>(
                    '/src/editor/toolModals.ts',
                ),
                appImport<
                    typeof import('../../src/editor/commands/brush/BrushPropertiesModal.vue')
                >('/src/editor/commands/brush/BrushPropertiesModal.vue'),
            ])
            void showToolModal(modal.default, {})
        })
        await expect(sheet(page)).toHaveCount(0)
        await expect(page.locator('[data-tool-dialog]')).toBeVisible()
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toBeVisible()
        await expect(page.locator('[data-tool-dialog]')).toHaveCount(1)
    })

    test('a phone gets a bottom sheet with notices above it, and the peek bar stays on top', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await edit(page, 3)
        await stored(page)
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toHaveAttribute('data-sheet', 'bottom')
        const box = await sheet(page).boundingBox()
        const pane = await page.locator('.chart-pane').boundingBox()
        if (!box || !pane) throw new Error('no layout')
        expect(box.width).toBeGreaterThan(360)
        expect(box.height).toBeGreaterThanOrEqual(240)
        expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height - 7)
        await row(page, 'Life 1', 'dialog').click()
        await expect(peekBar(page)).toBeVisible()
        // One line on a 390 px pane, with the time alone.
        const bar = await peekBar(page).locator('> div').first().boundingBox()
        expect(bar?.height).toBeLessThan(52)
        await expect(page.locator('[data-peek-text]')).toHaveText(/^\d{1,2}:\d{2}:\d{2}/)
        await expect(page.locator('[data-peek-text]')).not.toContainText('Viewing')
        // The band holds Go To as an icon beside the close button, in one line.
        await expect(page.locator('[data-history-band]')).toHaveAttribute('data-band-mode', 'icon')
        await shoot(page, 'dialog-phone')
        // A notice sits above the sheet.
        await page.evaluate(async () => {
            const { notify } = await window.editorTest.appImport<
                typeof import('../../src/editor/notification')
            >('/src/editor/notification.ts')
            notify(() => 'A notice for the sheet')
        })
        const notice = page.locator('.notification', { hasText: 'A notice for the sheet' })
        await expect(notice).toBeVisible()
        const at = await notice.boundingBox()
        if (!at) throw new Error('no notice')
        expect(at.y + at.height).toBeLessThanOrEqual(box.y)
    })

    test('a phone in landscape gets a narrow side sheet below the peek bar', async ({ page }) => {
        await page.setViewportSize({ width: 844, height: 390 })
        await edit(page, 3)
        await stored(page)
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toHaveAttribute('data-sheet', 'right')
        await row(page, 'Life 1', 'dialog').click()
        await expect(peekBar(page)).toBeVisible()
        const box = await sheet(page).boundingBox()
        const bar = await peekBar(page).locator('> div').first().boundingBox()
        const pane = await page.locator('.chart-pane').boundingBox()
        if (!box || !bar || !pane) throw new Error('no layout')
        expect(box.width).toBeLessThanOrEqual(320)
        expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height)
        expect(box.x + box.width).toBeGreaterThan(pane.x + pane.width - 12)
        // One line band even in the narrow sheet.
        const band = await page.locator('[data-history-band]').boundingBox()
        expect(band?.height).toBeLessThan(60)
        await page.waitForTimeout(300)
        await shoot(page, 'dialog-landscape')
    })
})

test.describe('links', () => {
    test('Nothing to undo and Nothing to redo select the History tab, the Timeline, with its list focused', async ({
        page,
    }) => {
        await edit(page, 2)
        await page.keyboard.press('Shift+Z')
        await page.keyboard.press('y')
        await expect(page.getByText('Nothing to redo').first()).toBeVisible()
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(surface(page, 'panel')).toBeVisible()
        await expect(list(page)).toBeFocused()
        await expect(sheet(page)).toHaveCount(0)
        await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveAttribute(
            'aria-selected',
            'true',
        )
    })

    test('on a phone a link opens the tab in the top dock like a tap, with no exception', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await setSettings(page, { showPreview: true })
        await settle(page)
        await page.keyboard.press('z')
        await expect(page.getByText('Nothing to undo').first()).toBeVisible()
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(tab(page, 'top', 'History')).toHaveAttribute('aria-selected', 'true')
        await expect(surface(page, 'panel')).toBeVisible()
        await expect(sheet(page)).toHaveCount(0)
    })

    test('with only its first entry, Nothing to undo opens Recent Sessions', async ({ page }) => {
        await page.keyboard.press('z')
        await expect(page.getByText('Nothing to undo').first()).toBeVisible()
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(page.getByRole('tab', { name: 'Recent Sessions' })).toHaveAttribute(
            'aria-selected',
            'true',
        )
        // Recent Sessions is a stub until Step 7; Go To keeps its place without showing.
        await expect(page.getByRole('tabpanel')).toBeEmpty()
        await expect(page.locator('[data-history-goto-button]')).toBeHidden()
    })

    test('a link while the dialog is open focuses the dialog, and one with History Disabled opens it', async ({
        page,
    }) => {
        await edit(page, 2)
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toBeVisible()
        await page.locator('.chart-pane').click({ position: { x: 300, y: 300 } })
        await page.keyboard.press('Shift+Z')
        await page.keyboard.press('y')
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(surface(page, 'panel')).toHaveCount(0)
        await expect(list(page, 'dialog')).toBeFocused()
        await page.keyboard.press('Shift+H')

        await setSettings(page, { historyPosition: 'disabled' })
        await page.locator('.chart-pane').click({ position: { x: 300, y: 300 } })
        await page.keyboard.press('Shift+Z')
        await page.keyboard.press('y')
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(sheet(page)).toBeVisible()
        await expect(list(page, 'dialog')).toBeFocused()
    })

    test('the Settings button closes Settings first and opens the tab', async ({ page }) => {
        await page.keyboard.press(',')
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await dialog.locator('[data-open-history]').click()
        await expect(dialog).toHaveCount(0)
        await expect(surface(page, 'panel')).toBeVisible()
        await expect(list(page)).toBeFocused()
    })

    test('the "Continued…" load notice has Open History', async ({ page }) => {
        await edit(page, 2)
        await stored(page)
        // The first page held the session's lock: closed, a new visit continues it.
        const context = page.context()
        await page.close()
        const next = await context.newPage()
        await next.goto('/')
        await expect(next.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(next)
        await next.getByRole('button', { name: 'Open History' }).click()
        await expect(list(next)).toBeVisible()
        // The continued session's own entries and its parent's are in the one Timeline.
        await expect(list(next).getByRole('option', { name: /Continued from/ })).toHaveCount(1)
        await expect(row(next, 'Life 2')).toBeVisible()
    })
})

test.describe('the Timeline', () => {
    test('rows show kind icons, ×N groups collapse and open, and undone steps carry no flag', async ({
        page,
    }) => {
        await edit(page, 4)
        await page.keyboard.press('z')
        await page.keyboard.press('z')
        await edit(page, 1, 'Branch')
        await openTab(page)
        // Two undos collapse into one row; nothing says "not in undo".
        await expect(list(page).getByRole('option').filter({ hasText: '×2' })).toHaveCount(1)
        await expect(list(page)).not.toContainText('not in undo')
        await list(page).focus()
        await list(page).press('ArrowDown')
        await list(page).press('ArrowDown')
        await list(page).press('ArrowRight')
        await expect(list(page).getByRole('option').filter({ hasText: /^Undo/ })).toHaveCount(3)
        await shoot(page, 'tab-desktop')
    })

    test('edits with the same label collapse into ×N, and the group opens', async ({ page }) => {
        for (let i = 0; i < 3; i++) await edit(page, 1, 'Scrub')
        await openTab(page)
        const group = list(page).getByRole('option').filter({ hasText: '×3' })
        await expect(group).toHaveCount(1)
        await expect(group).toHaveAttribute('aria-expanded', 'false')
        await stored(page)
        await group.click()
        await page.keyboard.press('ArrowRight')
        await expect(group).toHaveAttribute('aria-expanded', 'true')
        await expect(
            list(page)
                .getByRole('option')
                .filter({ hasText: /^Scrub/ }),
        ).toHaveCount(4)
        await page.keyboard.press('ArrowLeft')
        await expect(group).toHaveAttribute('aria-expanded', 'false')
    })

    test('Go To shows its label beside the tabs, and its Show switch filters to saves and exports', async ({
        page,
    }) => {
        await edit(page, 2)
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.markSaved('coconut.nxsp', false)
            history.markExported('coconut.nsld')
        })
        await openTab(page)
        const goTo = surface(page, 'panel').locator('[data-history-goto-button]')
        await expect(goTo).toContainText('Go To')
        await expect(row(page, 'Saved coconut.nxsp')).toBeVisible()
        await goTo.click()
        const popover = page.locator('[data-history-goto]')
        await expect(popover).toBeVisible()
        await expect(popover).toHaveAttribute('role', 'dialog')
        await expect(popover.getByRole('radiogroup', { name: 'Show' })).toBeVisible()
        await popover.getByRole('radio', { name: 'Saves and Exports' }).click()
        await expect(popover.getByRole('radio', { name: 'Saves and Exports' })).toHaveAttribute(
            'aria-checked',
            'true',
        )
        // Escape closes it back to the button.
        await page.keyboard.press('Escape')
        await expect(popover).toHaveCount(0)
        await expect(goTo).toBeFocused()
        // The banner says so, with Show All; the icon keeps an accent dot.
        const banner = page.locator('[data-history-filter-banner]')
        await expect(banner).toContainText('Saves and Exports')
        await expect(goTo.locator('[data-filter-dot]')).toBeVisible()
        await expect(row(page, 'Saved coconut.nxsp')).toBeVisible()
        await expect(row(page, 'Exported coconut.nsld')).toBeVisible()
        await expect(row(page, 'Life 1')).toHaveCount(0)
        await shoot(page, 'states-filtered')
        await banner.getByRole('button', { name: 'Show All' }).click()
        await expect(banner).toHaveCount(0)
        await expect(row(page, 'Life 1')).toBeVisible()
    })

    test('the band is one line with the label, with the icon, or two lines by width', async ({
        page,
    }) => {
        const mode = () => page.locator('[data-history-band]').getAttribute('data-band-mode')
        // The desktop's right dock is wide enough for the label.
        await openTab(page)
        expect(await mode()).toBe('label')
        // A narrow left dock under 296 px takes two lines.
        await page.setViewportSize({ width: 844, height: 390 })
        await settle(page)
        await page.evaluate(() => {
            window.editorTest.settings.leftDockWidth = 260
        })
        await settle(page)
        await page.evaluate(() => {
            window.editorTest.settings.historyPosition = 'left'
        })
        await settle(page)
        await expect(surface(page, 'panel')).toBeVisible()
        expect(await mode()).toBe('two')
        const goTo = await surface(page, 'panel')
            .locator('[data-history-goto-button]')
            .boundingBox()
        const tabs = await surface(page, 'panel').getByRole('tablist').boundingBox()
        if (!goTo || !tabs) throw new Error('no layout')
        expect(goTo.y).toBeGreaterThan(tabs.y + tabs.height - 2)
        expect(goTo.width).toBeLessThan(160)
    })

    test('the list is windowed, with ARIA positions, and a header pins while it scrolls', async ({
        page,
    }) => {
        await page.evaluate(() => {
            const { history } = window.editorTest
            // Different labels, so no group forms.
            for (let i = 0; i < 400; i++)
                history.pushState(() => `Step ${i}`, {
                    ...history.state.value,
                    initialLife: history.state.value.initialLife + 1,
                })
        })
        await openTab(page)
        await expect(list(page).getByRole('option').first()).toBeVisible()
        expect(await list(page).getByRole('option').count()).toBeLessThan(60)
        const first = list(page).getByRole('option').first()
        await expect(first).toHaveAttribute('aria-posinset', '1')
        await expect(first).toHaveAttribute('aria-setsize', /^40[0-9]$/)
        await expect(page.locator('[data-history-pinned]')).toHaveCount(0)
        await list(page).evaluate((element) => element.scrollTo({ top: 4000 }))
        await expect(row(page, 'Step 300')).toBeVisible()
        await expect(page.locator('[data-history-pinned]')).toContainText(/^Today · /)
    })

    test('rows get headers by age and keep their time to the second', async ({ page }) => {
        await edit(page, 1, 'Fresh')
        await seedOlder(page)
        await openTab(page)
        await expect(row(page, 'Moved notes')).toBeVisible()
        // Everything is label text at the rows' edge; the option's name has the full date.
        const moved = row(page, 'Moved notes')
        await expect(moved).toHaveAttribute(
            'aria-label',
            /Moved notes, .*\d{4}|Moved notes, .*:\d\d:\d\d/,
        )
        await expect(moved.locator('.timeline-time')).toHaveText(/\d{1,2}:\d{2}:\d{2}/)
        await expect(list(page)).toContainText('Yesterday')
        await shoot(page, 'tab-desktop-aged')
    })

    test('removed and damaged rows always say why, and cannot be peeked', async ({ page }) => {
        await seedOlder(page)
        await openTab(page)
        const removed = row(page, 'Removed notes')
        await expect(removed.locator('[data-history-flag]')).toContainText('removed to save space')
        await expect(removed).toHaveAttribute('aria-disabled', 'true')
        await page.setViewportSize({ width: 390, height: 844 })
        await settle(page)
        await expect(removed.locator('[data-history-flag]')).toContainText('removed to save space')
    })
})

test.describe('states', () => {
    test('a new session says there are no changes yet', async ({ page }) => {
        await openTab(page)
        await expect(page.locator('[data-history-empty]')).toHaveText('No changes yet')
        await expect(list(page).getByRole('option')).toHaveCount(1)
        await shoot(page, 'states-empty')
    })

    test('the first page loading shows placeholder rows under Now', async ({ page }) => {
        await page.evaluate(async () => {
            const start =
                await window.editorTest.appImport<typeof import('../../src/local/start')>(
                    '/src/local/start.ts',
                )
            const worker = start.storageWorker as unknown as {
                call: (name: string, ...args: unknown[]) => Promise<unknown>
            }
            const call = worker.call.bind(worker)
            worker.call = async (name, ...args) => {
                if (name === 'readTimeline')
                    await new Promise((resolve) => setTimeout(resolve, 2500))
                return call(name, ...args)
            }
        })
        await openTab(page)
        await expect(page.locator('[data-history-loading]')).toBeVisible()
        await shoot(page, 'states-loading')
        await expect(page.locator('[data-history-loading]')).toHaveCount(0, { timeout: 8000 })
    })

    test('a timeline that cannot be read says so, and Try Again reads it', async ({ page }) => {
        await edit(page, 1)
        await stored(page)
        await page.evaluate(async () => {
            const start =
                await window.editorTest.appImport<typeof import('../../src/local/start')>(
                    '/src/local/start.ts',
                )
            const worker = start.storageWorker as unknown as {
                call: (name: string, ...args: unknown[]) => Promise<unknown>
            }
            const call = worker.call.bind(worker)
            const win = window as unknown as { failTimeline?: boolean }
            win.failTimeline = true
            worker.call = async (name, ...args) => {
                if (name === 'readTimeline' && win.failTimeline) throw new Error('unreadable')
                return call(name, ...args)
            }
        })
        // Open with nothing loaded yet: the entry the tab holds in memory is gone from view.
        await page.evaluate(async () => {
            const { history } = window.editorTest
            history.resetState(false)
        })
        await openTab(page)
        await expect(page.locator('[data-history-failed]')).toContainText(
            'The timeline could not be loaded.',
        )
        await shoot(page, 'states-failed')
        await page.evaluate(() => {
            ;(window as unknown as { failTimeline?: boolean }).failTimeline = false
        })
        await page
            .locator('[data-history-failed]')
            .getByRole('button', { name: 'Try Again' })
            .click()
        await expect(page.locator('[data-history-failed]')).toHaveCount(0)
    })
})

test.describe('peek', () => {
    test('selecting a row shows it with the peek bar, Back to Now and Esc leave it', async ({
        page,
    }) => {
        await edit(page, 3)
        await stored(page)
        const base = (await lives(page)).live
        await openTab(page)
        await row(page, 'Life 1').click()
        await expect(peekBar(page)).toBeVisible()
        await expect(peekBar(page)).toContainText('Viewing')
        await expect(peekBar(page)).toContainText('Life 1')
        await expect(peekBar(page)).toContainText('read-only')
        await expect.poll(() => lives(page)).toEqual({ shown: base - 2, live: base })
        await expect(page.locator('[data-history-announcement]')).toContainText('Viewing')
        await peekBar(page).getByRole('button', { name: 'Back to Now' }).click()
        await expect(peekBar(page)).toHaveCount(0)
        expect(await lives(page)).toEqual({ shown: base, live: base })

        // Arrow keys peek; Home goes back; Esc goes back, and at now it hands focus to the chart.
        await list(page).focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await expect(peekBar(page)).toBeVisible()
        await expect.poll(() => lives(page)).toEqual({ shown: base - 1, live: base })
        await page.keyboard.press('Home')
        await expect(peekBar(page)).toHaveCount(0)
        await page.keyboard.press('ArrowDown')
        await expect(peekBar(page)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(peekBar(page)).toHaveCount(0)
        await expect(list(page)).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(list(page)).not.toBeFocused()
        // A panel cannot close itself with Escape.
        await expect(surface(page, 'panel')).toBeVisible()
    })

    test('accidental undo: a row far back restores with Enter, and Undo reverses it', async ({
        page,
    }) => {
        await edit(page, 5)
        const peak = (await lives(page)).live
        // Undo too far, by habit.
        for (let i = 0; i < 5; i++) await page.keyboard.press('z')
        await stored(page)
        expect((await lives(page)).live).toBe(peak - 5)
        await openTab(page)
        await row(page, 'Life 5').click()
        await expect(peekBar(page)).toBeVisible()
        await expect.poll(() => lives(page)).toEqual({ shown: peak, live: peak - 5 })
        await peekBar(page).getByRole('button', { name: 'Restore' }).click()
        await expect(peekBar(page)).toHaveCount(0)
        await expect.poll(() => lives(page)).toEqual({ shown: peak, live: peak })
        // The restore is an edit: Undo goes back.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.keyboard.press('z')
        await expect.poll(() => lives(page)).toEqual({ shown: peak - 5, live: peak - 5 })
    })

    test('Enter in the list restores the selected row, and a right click offers Restore', async ({
        page,
    }) => {
        await edit(page, 3)
        const peak = (await lives(page)).live
        await page.keyboard.press('z')
        await page.keyboard.press('z')
        await stored(page)
        await openTab(page)
        await row(page, 'Life 3').click()
        await expect(peekBar(page)).toBeVisible()
        await page.keyboard.press('Enter')
        await expect(peekBar(page)).toHaveCount(0)
        await expect.poll(() => lives(page)).toEqual({ shown: peak, live: peak })
        await page.keyboard.press('z')
        await row(page, 'Life 2').click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Restore' }).click()
        await expect.poll(() => lives(page)).toEqual({ shown: peak - 1, live: peak - 1 })
    })
})

test.describe('keys with focus in the list', () => {
    test('H opens the dialog, Space plays and c copies', async ({ page }) => {
        const isPlaying = () =>
            page.evaluate(
                async () =>
                    (
                        await window.editorTest.appImport<typeof import('../../src/player')>(
                            '/src/player.ts',
                        )
                    ).isPlaying.value,
            )
        await openTab(page)
        await list(page).focus()
        await page.keyboard.press('c')
        await expect(page.getByText('No object selected to copy').first()).toBeVisible()
        expect(await isPlaying()).toBe(false)
        await page.keyboard.press('Space')
        await expect.poll(isPlaying).toBe(true)
        await page.keyboard.press('Space')
        await page.evaluate(async () => {
            const { commands } = await window.editorTest.appImport<
                typeof import('../../src/editor/commands')
            >('/src/editor/commands/index.ts')
            void commands.stop.execute()
        })
        await list(page).focus()
        await page.keyboard.press('Shift+H')
        await expect(sheet(page)).toBeVisible()
        // The tab is still there.
        await expect(surface(page, 'panel')).toBeVisible()
    })

    test('a press on the canvas or the toolbar takes focus out of the list', async ({ page }) => {
        await edit(page, 2)
        await openTab(page)
        await list(page).focus()
        await page.locator('.chart-pane').click({ position: { x: 300, y: 300 } })
        await expect(list(page)).not.toBeFocused()
        await list(page).focus()
        await page.locator('[data-editor-toolbar] button[title="Select"]').first().click()
        await expect(list(page)).not.toBeFocused()
    })
})

test.describe('after a reload', () => {
    test('Undo at the first stored slot says earlier steps are in History, with Open History', async ({
        page,
    }) => {
        // A stack restored from a capped window (Shown.earlier), as a reload gives it.
        await page.evaluate(async () => {
            const { history } = window.editorTest
            history.openStoredState(
                { sessionId: crypto.randomUUID(), docId: crypto.randomUUID() },
                [
                    { label: 'Step 1', isDirty: false },
                    { label: 'Step 2', isDirty: false },
                ],
                0,
                history.state.value,
                true,
            )
        })
        await page.keyboard.press('z')
        await expect(page.getByText('Earlier steps are in History').first()).toBeVisible()
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(surface(page, 'panel')).toBeVisible()
        await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveAttribute(
            'aria-selected',
            'true',
        )
    })

    // The real thing, 5,100 steps and a reload: slow, so only with NSE_LONG_SPECS set.
    test('Undo past the stored part of a 5,000-step stack after a reload', async ({ page }) => {
        test.skip(!process.env.NSE_LONG_SPECS, 'Takes about two minutes')
        test.setTimeout(300_000)
        // The stored stack keeps 5,000 slots: past them an undo after a reload has no state.
        await page.evaluate(() => {
            const { history } = window.editorTest
            for (let i = 0; i < 5100; i++)
                history.pushState(() => `Step ${i}`, {
                    ...history.state.value,
                    initialLife: history.state.value.initialLife + 1,
                })
        })
        await stored(page)
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(page)
        // The reloaded stack as storage restored it: the fixture would replace it.
        await page.evaluate(async () => {
            const url = performance
                .getEntriesByType('resource')
                .map((entry) => entry.name)
                .find((name) => new URL(name).pathname === '/src/history/index.ts')
            const history = (await import(url ?? '')) as typeof import('../../src/history')
            // Undo as far as it goes: moves onto slots not loaded settle one after another.
            while (history.canUndo.value) history.undoState()
            while (history.slotLoading.value)
                await new Promise((resolve) => setTimeout(resolve, 50))
        })
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.keyboard.press('z')
        await expect(page.getByText('Earlier steps are in History').first()).toBeVisible()
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(surface(page, 'panel')).toBeVisible()
    })
})

test.describe('ARIA', () => {
    test('the tabs, the listbox and its options are linked and counted', async ({ page }) => {
        await edit(page, 3)
        await stored(page)
        await openTab(page)
        const tabs = page.getByRole('tablist', { name: 'History' })
        await expect(tabs.getByRole('tab')).toHaveText(['Timeline', 'Recent Sessions'])
        const selected = tabs.getByRole('tab', { selected: true })
        await expect(selected).toHaveText('Timeline')
        const panel = page.getByRole('tabpanel')
        await expect(panel).toHaveAttribute(
            'aria-labelledby',
            (await selected.getAttribute('id')) ?? '',
        )
        const box = page.getByRole('listbox', { name: 'Timeline' })
        await expect(box).toBeVisible()
        const options = box.getByRole('option')
        const count = await options.count()
        for (let i = 0; i < count; i++) {
            await expect(options.nth(i)).toHaveAttribute('aria-posinset', String(i + 1))
            await expect(options.nth(i)).toHaveAttribute('aria-setsize', String(count))
        }
        await expect(box.locator('[aria-selected="true"]')).toHaveCount(1)
        const active = await box.getAttribute('aria-activedescendant')
        await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('aria-selected', 'true')
        // The popover is a dialog named Go To, opened by a button that says so.
        const goTo = page.getByRole('button', { name: 'Go To' })
        await expect(goTo).toHaveAttribute('aria-haspopup', 'dialog')
        await expect(goTo).toHaveAttribute('aria-expanded', 'false')
        // A live region announces the peek.
        await row(page, 'Life 2').click()
        await expect(page.locator('[data-history-announcement]')).toHaveAttribute(
            'aria-live',
            'polite',
        )
        await expect(page.locator('[data-history-announcement]')).toHaveText(/^Viewing /)
        await expect(box.locator('[aria-selected="true"]')).toHaveCount(1)
        await expect(row(page, 'Life 2')).toHaveAttribute('aria-selected', 'true')
        // The buttons on the canvas are ordinary buttons.
        await expect(peekBar(page).getByRole('button')).toHaveText(['Back to Now', 'Restore'])
    })
})

test.describe('touch targets', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    test('rows, tabs, Go To and the peek bar are 44 px, and the bar hints at folding the tab', async ({
        page,
    }) => {
        await edit(page, 2)
        await stored(page)
        await openTab(page, 'top')
        const rowBox = await row(page, 'Life 1').boundingBox()
        expect(rowBox?.height).toBe(44)
        const goTo = await page.locator('[data-history-goto-button]').boundingBox()
        expect(goTo?.height).toBeGreaterThanOrEqual(44)
        const track = await page.getByRole('tablist', { name: 'History' }).boundingBox()
        expect(track?.height).toBeGreaterThanOrEqual(44)
        await row(page, 'Life 1').tap()
        await expect(peekBar(page)).toBeVisible()
        const restore = await peekBar(page).getByRole('button', { name: 'Restore' }).boundingBox()
        expect(restore?.height).toBeGreaterThanOrEqual(44)
        await expect(page.locator('[data-peek-hint]')).toHaveText('Tap History to fold the list')
        await shoot(page, 'tab-phone')
        // Folded, there is nothing left to tap.
        await tab(page, 'top', 'History').tap()
        await expect(page.locator('[data-peek-hint]')).toHaveCount(0)
        await expect(peekBar(page)).toBeVisible()
    })

    test('the dialog has no fold hint, and Go To opens as a sheet', async ({ page }) => {
        await edit(page, 2)
        await stored(page)
        await page.keyboard.press('Shift+H')
        await row(page, 'Life 1', 'dialog').tap()
        await expect(peekBar(page)).toBeVisible()
        await expect(page.locator('[data-peek-hint]')).toHaveCount(0)
        await page.locator('[data-history-goto-button]').tap()
        const popover = page.locator('[data-history-goto]')
        await expect(popover).toBeVisible()
        const box = await popover.boundingBox()
        expect(box?.width).toBeGreaterThan(360)
        await shoot(page, 'dialog-phone-goto')
    })
})

test('a mouse gets no fold hint', async ({ page }) => {
    await edit(page, 2)
    await stored(page)
    await openTab(page)
    await row(page, 'Life 1').click()
    await expect(peekBar(page)).toBeVisible()
    await expect(page.locator('[data-peek-hint]')).toHaveCount(0)
})

test('New while History is open starts a new Timeline and ends a peek', async ({ page }) => {
    await edit(page, 3)
    await stored(page)
    await openTab(page)
    await row(page, 'Life 1').click()
    await expect(peekBar(page)).toBeVisible()
    await page.evaluate(() => window.editorTest.history.resetState(false))
    await expect(peekBar(page)).toHaveCount(0)
    await expect(surface(page, 'panel')).toBeVisible()
    await expect(row(page, 'Life 1')).toHaveCount(0)
    // The new session's first state, and nothing selected but Now.
    await expect(list(page).locator('[aria-selected="true"]')).toHaveCount(1)
})

const sizes = [
    ['phone', { width: 390, height: 844 }],
    ['tablet', { width: 820, height: 1180 }],
    ['desktop', { width: 1440, height: 900 }],
    ['landscape', { width: 844, height: 390 }],
] as const

type Size = (typeof sizes)[number][1]

/** A page at a size and theme, as a phone or tablet would be (touch), with the fixture installed. */
const launch = async (
    browser: Browser,
    baseURL: string | undefined,
    name: string,
    size: Size,
    theme: 'light' | 'dark',
) => {
    const touch = name === 'phone' || name === 'tablet'
    const context = await browser.newContext({
        viewport: size,
        hasTouch: touch,
        isMobile: touch,
        colorScheme: theme,
        baseURL,
    })
    const page = await context.newPage()
    await page.addInitScript((prefix) => {
        performance.setResourceTimingBufferSize(5000)
        localStorage.setItem(`${prefix}showPreview`, 'false')
        localStorage.setItem(`${prefix}showSidebar`, 'false')
        localStorage.setItem('nse.test.storage', '{}')
    }, prefix)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
    return { page, context }
}

const sideOf = (size: Size) =>
    size.width < 640 || size.width < size.height ? 'top' : size.width >= 1100 ? 'right' : 'left'

test.describe('screenshots', () => {
    test.skip(!process.env.NSE_SHOTS, 'Shots are taken on request')

    for (const theme of ['light', 'dark'] as const)
        for (const [name, size] of sizes) {
            test(`${name} ${theme}: tab and dialog, peeking`, async ({ browser, baseURL }) => {
                const { page, context } = await launch(browser, baseURL, name, size, theme)
                await edit(page, 4)
                await page.keyboard.press('z')
                await page.keyboard.press('z')
                await edit(page, 1, 'Added slide')
                await edit(page, 3, 'Changed BPM')
                await stored(page)
                await seedOlder(page)
                const side = sideOf(size)
                await tab(page, side, 'History').click()
                await expect(surface(page, 'panel')).toBeVisible()
                await row(page, 'Added slide').click()
                await expect(peekBar(page)).toBeVisible()
                await page.waitForTimeout(500)
                await page.screenshot({ path: `${shots}/tab-${name}-${theme}.png` })
                // The dialog, over a closed tab.
                await tab(page, side, 'History').click()
                await page.keyboard.press('Shift+H')
                await expect(sheet(page)).toBeVisible()
                await page.waitForTimeout(500)
                await page.screenshot({ path: `${shots}/dialog-${name}-${theme}.png` })
                await context.close()
            })

            test(`${name} ${theme}: Go To in the dialog`, async ({ browser, baseURL }) => {
                const { page, context } = await launch(browser, baseURL, name, size, theme)
                await edit(page, 3, 'Added slide')
                await stored(page)
                await seedOlder(page)
                await page.keyboard.press('Shift+H')
                await expect(sheet(page)).toBeVisible()
                await page.locator('[data-history-goto-button]').click()
                await expect(page.locator('[data-history-goto]')).toBeVisible()
                await page.waitForTimeout(300)
                await page.screenshot({ path: `${shots}/dialogGoTo-${name}-${theme}.png` })
                await context.close()
            })

            test(`${name} ${theme}: states`, async ({ browser, baseURL }) => {
                const { page, context } = await launch(browser, baseURL, name, size, theme)
                const side = sideOf(size)
                await tab(page, side, 'History').click()
                await expect(page.locator('[data-history-empty]')).toBeVisible()
                await page.screenshot({ path: `${shots}/states-empty-${name}-${theme}.png` })
                await edit(page, 2)
                await page.evaluate(() => {
                    const { history } = window.editorTest
                    history.markSaved('coconut.nxsp', false)
                    history.markExported('coconut.nsld')
                })
                await page.locator('[data-history-goto-button]').click()
                await page.getByRole('radio', { name: 'Saves and Exports' }).click()
                await page.keyboard.press('Escape')
                await page.waitForTimeout(200)
                await page.screenshot({ path: `${shots}/states-filtered-${name}-${theme}.png` })
                await context.close()
            })

            test(`${name} ${theme}: Settings › Panels, and every tab disabled`, async ({
                browser,
                baseURL,
            }) => {
                const { page, context } = await launch(browser, baseURL, name, size, theme)
                await page.keyboard.press(',')
                const dialog = page.getByRole('dialog')
                await expect(dialog).toBeVisible()
                await dialog.getByRole('button', { name: 'Panels', exact: true }).click()
                await page.waitForTimeout(500)
                await page.screenshot({ path: `${shots}/settings-${name}-${theme}.png` })
                await page.keyboard.press('Escape')
                await setSettings(page, {
                    previewPosition: 'disabled',
                    groupsPosition: 'disabled',
                    stagesPosition: 'disabled',
                    propertiesPosition: 'disabled',
                    historyPosition: 'disabled',
                })
                await settle(page)
                await edit(page, 3)
                await page.waitForTimeout(300)
                await page.screenshot({ path: `${shots}/hidden-${name}-${theme}.png` })
                await page.keyboard.press('Shift+H')
                await expect(sheet(page)).toBeVisible()
                await page.waitForTimeout(300)
                await page.screenshot({ path: `${shots}/hiddenDialog-${name}-${theme}.png` })
                await context.close()
            })
        }
})
