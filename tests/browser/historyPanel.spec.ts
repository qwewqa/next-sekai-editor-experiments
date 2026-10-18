import { expect, test, type Locator, type Page } from '@playwright/test'
import { installEditorFixture, waitForStartup } from './editorFixture'

// The History panel, its Timeline and the peek bar (Part 1 §1.4.10, §1.4.11, Step 5). Entries
// are made through the undo stack's own `pushState`, as history.spec.ts does.

const prefix = 'sonolus-next-sekai-editor.'
const shots = 'D:/sonolus/nse-next/work/step5/panel-shots'

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

const list = (page: Page) => page.locator('[data-history-list]')

const row = (page: Page, text: string): Locator =>
    list(page)
        .getByRole('option')
        .filter({ has: page.getByText(text, { exact: true }) })

const peekBar = (page: Page) => page.locator('[data-peek-bar]')

const dock = (page: Page, side: 'left' | 'right' | 'top') =>
    page.locator(`[data-workspace-dock="${side}"]`)

const tab = (page: Page, side: 'left' | 'right' | 'top', name: string) =>
    dock(page, side).getByRole('tab', { name, exact: false })

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

/** The saved panel state: its open states, recency and folds. */
const panelState = (page: Page) =>
    getSettings(page, [
        'showPreview',
        'showGroups',
        'showStages',
        'showSidebar',
        'panelRecency',
        'leftDockCollapsed',
        'rightDockCollapsed',
        'topDockCollapsed',
    ])

test.describe('panel and layout', () => {
    test('H opens History with the list focused at the Now row, and H again closes it', async ({
        page,
    }) => {
        await edit(page, 3)
        await page.keyboard.press('Shift+H')
        await expect(list(page)).toBeVisible()
        await expect(list(page)).toBeFocused()
        // Now, three edits and the first entry.
        await expect(list(page).getByRole('option')).toHaveCount(5)
        await expect(list(page)).toHaveAttribute('aria-activedescendant', /history-row-now/)
        await expect(row(page, 'Now · Life 3')).toHaveAttribute('aria-selected', 'true')
        // The right dock beside Properties on a desktop.
        await expect(tab(page, 'right', 'History')).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('Shift+H')
        await expect(list(page)).toHaveCount(0)
        await expect(tab(page, 'right', 'History')).toHaveCount(0)
    })

    test('its tab exists only while it is open, last in its rail, and is never saved', async ({
        page,
    }) => {
        await expect(page.locator('[data-panel-tab="history"]')).toHaveCount(0)
        const before = await panelState(page)
        await page.keyboard.press('Shift+H')
        await expect(page.locator('[data-panel-tab="history"]')).toHaveCount(1)
        const tabs = await dock(page, 'right')
            .locator('[data-panel-tab]')
            .evaluateAll((tabs) => tabs.map((tab) => (tab as HTMLElement).dataset.panelTab))
        expect(tabs.at(-1)).toBe('history')
        // The saved panel state is as it was, and nothing about History is saved.
        expect(await panelState(page)).toEqual(before)
        const keys = await page.evaluate(
            (prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
            prefix,
        )
        expect(keys.filter((key) => /showHistory|historyOpen/.test(key))).toEqual([])
        expect((await getSettings(page, ['panelRecency'])).panelRecency).not.toContain('history')
        // A reload starts without it.
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(page)
        await expect(page.locator('[data-panel-tab="history"]')).toHaveCount(0)
    })

    test('a phone shows it in the top dock over Preview, and closing gives Preview back', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await setSettings(page, { showPreview: true })
        await settle(page)
        await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-selected', 'true')
        const saved = await panelState(page)
        await page.keyboard.press('Shift+H')
        await expect(list(page)).toBeVisible()
        await expect(tab(page, 'top', 'History')).toHaveAttribute('aria-selected', 'true')
        await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-selected', 'false')
        // Nothing of the saved workspace changed.
        expect(await panelState(page)).toEqual(saved)
        await page.keyboard.press('Shift+H')
        await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-selected', 'true')
        await expect(tab(page, 'top', 'History')).toHaveCount(0)
        expect(await panelState(page)).toEqual(saved)
    })

    test('a tab on another panel saves what was on screen, and History stays only with room', async ({
        page,
    }) => {
        // A phone: Preview is covered, and tapping its tab closes History.
        await page.setViewportSize({ width: 390, height: 844 })
        await setSettings(page, { showPreview: true })
        await settle(page)
        await page.keyboard.press('Shift+H')
        await expect(list(page)).toBeVisible()
        await tab(page, 'top', 'Preview').click()
        await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-selected', 'true')
        await expect(list(page)).toHaveCount(0)
        expect((await getSettings(page, ['showPreview'])).showPreview).toBe(true)

        // A desktop: Groups opens on the other side and History stays.
        await page.setViewportSize({ width: 1600, height: 1000 })
        await settle(page)
        await page.keyboard.press('Shift+H')
        await expect(list(page)).toBeVisible()
        await tab(page, 'left', 'Groups').click()
        await expect(tab(page, 'left', 'Groups')).toHaveAttribute('aria-selected', 'true')
        await expect(list(page)).toBeVisible()
        expect((await getSettings(page, ['showGroups'])).showGroups).toBe(true)
    })

    test('folding the dock keeps History open and a peek going', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await edit(page, 3)
        await stored(page)
        await page.keyboard.press('Shift+H')
        await row(page, 'Life 2').click()
        await expect(peekBar(page)).toBeVisible()
        const saved = await panelState(page)
        // The only panel in the dock: its tab folds it.
        await tab(page, 'top', 'History').click()
        await expect(list(page)).toHaveCount(0)
        await expect(peekBar(page)).toBeVisible()
        expect(await panelState(page)).toEqual(saved)
        // Again unfolds it, with the peek unchanged.
        await tab(page, 'top', 'History').click()
        await expect(list(page)).toBeVisible()
        await expect(peekBar(page)).toBeVisible()
        // Closing ends the peek.
        await page.keyboard.press('Shift+H')
        await expect(peekBar(page)).toHaveCount(0)
        expect((await lives(page)).shown).toBe((await lives(page)).live)
    })

    test('the tab menu offers dock positions and Close, and a middle click closes', async ({
        page,
    }) => {
        await page.keyboard.press('Shift+H')
        const history = page.locator('[data-panel-tab="history"]')
        await history.click({ button: 'right' })
        const items = page.getByRole('menuitemradio')
        await expect(items).toHaveText([
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
        await expect(list(page)).toHaveCount(0)
    })

    test('Settings › Panels lists History without Disabled, and a saved Disabled reads as Auto', async ({
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
        expect(await options('History')).toHaveLength((await options('Groups')).length - 1)
        expect(await options('History')).not.toContain('Disabled')
        expect(await options('Groups')).toContain('Disabled')
        await page.keyboard.press('Escape')
        await page.addInitScript((prefix) => {
            localStorage.setItem(`${prefix}historyPosition`, JSON.stringify('disabled'))
        }, prefix)
        await page.reload()
        await waitForStartup(page)
        await page.evaluate(installEditorFixture)
        expect((await getSettings(page, ['historyPosition'])).historyPosition).toBe('auto')
    })
})

test.describe('timeline', () => {
    test('rows show kind icons, groups collapse, and undone steps are flagged not in undo', async ({
        page,
    }) => {
        await edit(page, 4)
        await page.keyboard.press('z')
        await page.keyboard.press('z')
        await edit(page, 1, 'Branch')
        await page.keyboard.press('Shift+H')
        // Two undos collapse into one row, in the side dock's two lines.
        await expect(list(page).getByRole('option').filter({ hasText: '×2' })).toHaveCount(1)
        const dropped = list(page).getByRole('option').filter({ hasText: 'not in undo' })
        await expect(dropped).toHaveCount(2)
        await expect(dropped.first()).toHaveAttribute('title', 'Undo cannot reach this.')
        // Branch is in undo, so it carries no flag.
        await expect(row(page, 'Branch')).not.toContainText('not in undo')
        // The group opens with the arrow key and lists its two undos.
        await list(page).press('ArrowDown')
        await list(page).press('ArrowDown')
        await expect(list(page).getByRole('option').filter({ hasText: /^Undo/ })).toHaveCount(1)
        await page.screenshot({ path: `${shots}/desktop.png` })
    })

    test('edits with the same label collapse into ×N, and the group opens', async ({ page }) => {
        for (let i = 0; i < 3; i++) await edit(page, 1, 'Scrub')
        await page.keyboard.press('Shift+H')
        const group = list(page).getByRole('option').filter({ hasText: '×3' })
        await expect(group).toHaveCount(1)
        await expect(group).toHaveAttribute('aria-expanded', 'false')
        // Peek the group row, then open it with the arrow key.
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

    test('the All and Saves and Exports chips filter the rows', async ({ page }) => {
        await edit(page, 2)
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.markSaved('coconut.nxsp', false)
            history.markExported('coconut.nsld')
        })
        await page.keyboard.press('Shift+H')
        await expect(row(page, 'Saved coconut.nxsp')).toBeVisible()
        await page.getByRole('button', { name: 'Saves and Exports' }).click()
        await expect(page.getByRole('button', { name: 'Saves and Exports' })).toHaveAttribute(
            'aria-pressed',
            'true',
        )
        await expect(row(page, 'Saved coconut.nxsp')).toBeVisible()
        await expect(row(page, 'Exported coconut.nsld')).toBeVisible()
        await expect(row(page, 'Life 1')).toHaveCount(0)
        await page.getByRole('button', { name: 'All', exact: true }).click()
        await expect(row(page, 'Life 1')).toBeVisible()
    })

    test('the list is windowed: a long history renders about 60 rows with ARIA positions', async ({
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
        await page.keyboard.press('Shift+H')
        await expect(list(page).getByRole('option').first()).toBeVisible()
        const rendered = await list(page).getByRole('option').count()
        expect(rendered).toBeLessThan(60)
        const first = list(page).getByRole('option').first()
        await expect(first).toHaveAttribute('aria-posinset', '1')
        await expect(first).toHaveAttribute('aria-setsize', /^40[0-9]$/)
        // Scrolling brings later rows in.
        await list(page).evaluate((element) => element.scrollTo({ top: 4000 }))
        await expect(row(page, 'Step 300')).toBeVisible()
    })
})

test.describe('peek', () => {
    test('selecting a row shows it with the peek bar, Back to Now and Esc leave it', async ({
        page,
    }) => {
        await edit(page, 3)
        await stored(page)
        const base = (await lives(page)).live
        await page.keyboard.press('Shift+H')
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

        // Arrow keys peek; Home goes back; Esc goes back and then closes.
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
        await expect(list(page)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(list(page)).toHaveCount(0)
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
        await page.keyboard.press('Shift+H')
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

    test('Enter in the list restores the selected row', async ({ page }) => {
        await edit(page, 3)
        const peak = (await lives(page)).live
        await page.keyboard.press('z')
        await page.keyboard.press('z')
        await stored(page)
        await page.keyboard.press('Shift+H')
        await list(page).focus()
        await row(page, 'Life 3').click()
        await expect(peekBar(page)).toBeVisible()
        await page.keyboard.press('Enter')
        await expect(peekBar(page)).toHaveCount(0)
        await expect.poll(() => lives(page)).toEqual({ shown: peak, live: peak })
    })

    test('a right click offers Restore', async ({ page }) => {
        await edit(page, 2)
        const peak = (await lives(page)).live
        await page.keyboard.press('z')
        await stored(page)
        await page.keyboard.press('Shift+H')
        await row(page, 'Life 2').click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Restore' }).click()
        await expect.poll(() => lives(page)).toEqual({ shown: peak, live: peak })
    })

    test('Closing History ends the peek', async ({ page }) => {
        await edit(page, 2)
        await stored(page)
        await page.keyboard.press('Shift+H')
        await row(page, 'Life 1').click()
        await expect(peekBar(page)).toBeVisible()
        await page.keyboard.press('Shift+H')
        await expect(peekBar(page)).toHaveCount(0)
        const { shown, live } = await lives(page)
        expect(shown).toBe(live)
    })
})

test.describe('keys with focus in the list', () => {
    test('H toggles, Space plays and c copies', async ({ page }) => {
        const isPlaying = () =>
            page.evaluate(
                async () =>
                    (
                        await window.editorTest.appImport<typeof import('../../src/player')>(
                            '/src/player.ts',
                        )
                    ).isPlaying.value,
            )
        await page.keyboard.press('Shift+H')
        await expect(list(page)).toBeFocused()
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
        await expect(list(page)).toBeFocused()
        await page.keyboard.press('Shift+H')
        await expect(list(page)).toHaveCount(0)
    })

    test('a press on the canvas or the toolbar takes focus out of the list', async ({ page }) => {
        await edit(page, 2)
        await page.keyboard.press('Shift+H')
        await expect(list(page)).toBeFocused()
        await page.locator('.chart-pane').click({ position: { x: 300, y: 300 } })
        await expect(list(page)).not.toBeFocused()
        await list(page).focus()
        await page.locator('[data-editor-toolbar] button[title="Select"]').first().click()
        await expect(list(page)).not.toBeFocused()
    })
})

test.describe('the toolbar tool', () => {
    test('it shows pressed while the panel is open and the Undo face stays', async ({ page }) => {
        const face = page.locator('[data-editor-toolbar] button[title="Undo"]')
        await expect(face).toBeVisible()
        await face.hover()
        const tool = page.locator('[data-editor-toolbar] button[title="History"]')
        await expect(tool).toHaveAttribute('aria-pressed', 'false')
        await tool.click()
        await expect(list(page)).toBeVisible()
        // The face is still Undo; History never takes it.
        await expect(face).toBeVisible()
        await face.hover()
        await expect(page.locator('[data-editor-toolbar] button[title="History"]')).toHaveAttribute(
            'aria-pressed',
            'true',
        )
        // Picking it again closes the panel.
        await page.locator('[data-editor-toolbar] button[title="History"]').click()
        await expect(list(page)).toHaveCount(0)
        await expect(face).toBeVisible()
    })
})

test.describe('ways in', () => {
    test('Nothing to undo and Nothing to redo offer Open History', async ({ page }) => {
        await edit(page, 2)
        await page.keyboard.press('Shift+Z')
        await page.keyboard.press('y')
        await expect(page.getByText('Nothing to redo').first()).toBeVisible()
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(list(page)).toBeVisible()
        await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveAttribute(
            'aria-selected',
            'true',
        )
    })

    test('with only its first entry, Nothing to undo opens Recent Sessions', async ({ page }) => {
        await page.keyboard.press('z')
        await expect(page.getByText('Nothing to undo').first()).toBeVisible()
        await page.getByRole('button', { name: 'Open History' }).click()
        await expect(page.getByRole('tab', { name: 'Recent Sessions' })).toHaveAttribute(
            'aria-selected',
            'true',
        )
        // The tab is an empty stub until Step 7.
        await expect(page.getByRole('tabpanel')).toBeEmpty()
    })

    test('the Settings button closes Settings first and opens History', async ({ page }) => {
        await page.keyboard.press(',')
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await dialog.locator('[data-open-history]').click()
        await expect(dialog).toHaveCount(0)
        await expect(list(page)).toBeVisible()
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

test.describe('after a reload', () => {
    test('Undo at the first stored slot says earlier steps are in History, with Open History', async ({
        page,
    }) => {
        // A stack restored from a capped window (Shown.earlier), as a reload gives it.
        await page.evaluate(async () => {
            const { history, view } = window.editorTest
            void view
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
        await expect(list(page)).toBeVisible()
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
        await expect(list(page)).toBeVisible()
    })
})

test.describe('the warning glyph', () => {
    test('shows on the tab and the tool when history is not being stored', async ({ page }) => {
        // Storage unavailable (as in a private window that blocks it), then after about 3 s.
        const next = await page.context().newPage()
        await next.addInitScript(() => localStorage.setItem('nse.test.noStorage', 'true'))
        await next.goto('/')
        await expect(next.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(next)
        await next.keyboard.press('Shift+H')
        await expect(next.locator('[data-panel-tab="history"]')).toBeVisible()
        await expect(next.locator('[data-panel-tab="history"] [data-history-warning]')).toBeVisible(
            { timeout: 8000 },
        )
        await expect(next.locator('[data-panel-tab="history"]')).toHaveAccessibleName(
            /Changes are not being stored in this browser\./,
        )
    })
})

test.describe('ARIA', () => {
    test('the tabs, the listbox and its options are linked and counted', async ({ page }) => {
        await edit(page, 3)
        await stored(page)
        await page.keyboard.press('Shift+H')
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

const sizes = [
    ['phone', { width: 390, height: 844 }],
    ['tablet', { width: 820, height: 1180 }],
    ['desktop', { width: 1600, height: 1000 }],
    ['landscape', { width: 844, height: 390 }],
] as const

test.describe('screenshots', () => {
    for (const [name, size] of sizes)
        test(`${name}, peeking`, async ({ page }) => {
            await page.setViewportSize(size)
            await edit(page, 4)
            await page.keyboard.press('z')
            await page.keyboard.press('z')
            await edit(page, 1, 'Branch')
            await edit(page, 3, 'Scrub')
            await stored(page)
            await page.keyboard.press('Shift+H')
            await expect(list(page)).toBeVisible()
            await row(page, 'Branch').click()
            await expect(peekBar(page)).toBeVisible()
            await page.waitForTimeout(400)
            await page.screenshot({ path: `${shots}/${name}.png` })
        })
})

test.describe('with a touch screen', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    test('the peek bar hints that tapping History folds the list, and a mouse is not told', async ({
        page,
    }) => {
        await edit(page, 2)
        await stored(page)
        await page.keyboard.press('Shift+H')
        await row(page, 'Life 1').tap()
        await expect(peekBar(page)).toBeVisible()
        await expect(page.locator('[data-peek-hint]')).toHaveText('Tap History to fold the list')
        // Folded, there is nothing left to tap.
        await tab(page, 'top', 'History').tap()
        await expect(page.locator('[data-peek-hint]')).toHaveCount(0)
        await expect(peekBar(page)).toBeVisible()
    })
})

test('a mouse gets no fold hint', async ({ page }) => {
    await edit(page, 2)
    await stored(page)
    await page.keyboard.press('Shift+H')
    await row(page, 'Life 1').click()
    await expect(peekBar(page)).toBeVisible()
    await expect(page.locator('[data-peek-hint]')).toHaveCount(0)
})

test('New while History is open starts a new Timeline and ends a peek', async ({ page }) => {
    await edit(page, 3)
    await stored(page)
    await page.keyboard.press('Shift+H')
    await row(page, 'Life 1').click()
    await expect(peekBar(page)).toBeVisible()
    await page.evaluate(() => window.editorTest.history.resetState(false))
    await expect(peekBar(page)).toHaveCount(0)
    await expect(list(page)).toBeVisible()
    await expect(list(page).getByRole('option')).toHaveCount(2)
    await expect(row(page, 'Life 1')).toHaveCount(0)
    // The new session's first entry, and nothing selected but Now.
    await expect(list(page).locator('[aria-selected="true"]')).toHaveCount(1)
})
