import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import legacyColors from './fixtures/legacy-colors.json' with { type: 'json' }

// Step 4's UI (Part 1 §1.4.3, §1.3.4, §1.4.1, §1.4.9, §1.4.14): the load notices in the start-up
// pill with their actions, the status bar label and the page title, the Reopen notice, the in-app
// not-stored prompt, and Settings › Local Data's Recovery rows.

const prefix = 'sonolus-next-sekai-editor.'

/** Seeds every page of the context: the storage hooks, a fixed version, and the panels away. */
const seed = (context: BrowserContext, extra: Record<string, string> = {}) =>
    context.addInitScript((extra) => {
        performance.setResourceTimingBufferSize(5000)
        localStorage.setItem('nse.test.storage', '{}')
        localStorage.setItem(
            'nse.test.version',
            JSON.stringify({ appVersion: '0.6.0', atTag: true }),
        )
        localStorage.setItem('sonolus-next-sekai-editor.lastAppVersion', JSON.stringify('0.6.0'))
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value)
    }, extra)

const opened = (page: Page) =>
    expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const { startupGate } =
                        (await import('/src/startup/gate.ts')) as typeof import('../../src/startup/gate')
                    return startupGate.phase
                }),
            { timeout: 20_000 },
        )
        .toBe('done')

const visit = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await opened(page)
}

const edit = (page: Page, initialLife: number) =>
    page.evaluate(async (initialLife) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        pushState(() => `Life ${initialLife}`, { ...state.value, initialLife })
    }, initialLife)

const lifeOf = (page: Page) =>
    page.evaluate(async () => {
        const { state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        return state.value.initialLife
    })

const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(() => {
                const flusher = window.nseFlushTest!.flusher
                return !flusher.hasPending && !!flusher.session?.stored
            }),
        )
        .toBe(true)

const hide = (page: Page) =>
    page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
    })

/** Binds the open session's chain to a file, as a Save would (Step 6 writes the file). */
const bind = (page: Page, name: string) =>
    page.evaluate(
        (name) =>
            window.nseFlushTest!.flusher.setChainFields({
                file: {
                    name,
                    event: 'saved',
                    at: Date.now(),
                    hash: new Uint8Array(16),
                    options: { history: true, bgm: true },
                },
            }),
        name,
    )

const pill = (page: Page) => page.locator('.notification-pill')

/** Runs a command by its id, as a key or the toolbar does. */
const run = (page: Page, id: string) =>
    page.evaluate(async (id) => {
        const { commands } =
            (await import('/src/editor/commands/index.ts')) as typeof import('../../src/editor/commands')
        const { runCommand } =
            (await import('/src/editor/commands/runCommand.ts')) as typeof import('../../src/editor/commands/runCommand')
        await runCommand(commands[id as keyof typeof commands])
    }, id)

const addEvent = (page: Page, event: object) =>
    page.evaluate(async (event) => {
        const { addLoadEvent } =
            (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
        addLoadEvent(event as never)
    }, event)

test.beforeEach(async ({ context }) => {
    await seed(context)
})

test.describe('load notices in the start-up pill', () => {
    test('a new visit says which session it continued, with no storage line', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
        await bind(page, 'coconut.nxsp')
        await settled(page)
        await page.close({ runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        await expect(pill(next)).toContainText('Next SEKAI Editor')
        await expect(pill(next)).toContainText('Version 0.6.0')
        await expect(pill(next)).toContainText(/Continued "coconut" from [A-Z][a-z]{2} \d{1,2}\./)
        // No storage line at load, on any override (Z22).
        await expect(pill(next)).not.toContainText(/stored|browser|Recent Sessions/i)
        // Its one button is Open History (Step 5), so the pill sits with the action notices.
        await expect(pill(next).locator('[data-notice-action]')).toHaveText(['Open History'])
        // It goes at the first edit.
        await edit(next, 980)
        await expect(pill(next)).toHaveCount(0)
    })

    test('a migrated auto save says so, with no "Continued … from" line besides', async ({
        page,
        context,
    }) => {
        await visit(page)
        await page.evaluate(
            ({ stored, prefix }) => {
                localStorage.setItem(`${prefix}autoSave.levelData`, stored)
            },
            { stored: JSON.stringify(legacyColors.autoSave), prefix },
        )
        await page.close({ runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        await expect(pill(next)).toContainText(/Continued ".+" from auto save\./)
        await expect(pill(next)).not.toContainText(/ from [A-Z][a-z]{2} \d/)
    })

    test('the date fallback reads "Continued your session from …"', async ({ page, context }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await page.close({ runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        await expect(pill(next)).toContainText(
            /Continued your session from [A-Z][a-z]{2} \d{1,2}\./,
        )
        await expect(pill(next)).not.toContainText('Continued "')
    })

    test('a session open elsewhere puts Restore as a Copy on the pill, at the bottom', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        const next = await context.newPage()
        await visit(next)
        await expect(pill(next)).toContainText('is open in another tab or window.')
        const button = pill(next).getByRole('button', { name: 'Restore as a Copy' })
        await expect(button).toBeVisible()
        // Above the toolbar, where a tap on the chart does not land.
        const box = (await pill(next).boundingBox())!
        const toolbar = (await next.locator('[data-editor-toolbar] > div').boundingBox())!
        expect(box.y + box.height).toBeLessThanOrEqual(toolbar.y)
        // Alt+N reaches the first action.
        await next.keyboard.press('Alt+KeyN')
        await expect(button).toBeFocused()
        await button.click()
        await expect.poll(() => lifeOf(next)).toBe(990)
    })

    test('each event is a line of its own with the table’s English, and its action', async ({
        page,
    }) => {
        await visit(page)
        const name = { name: { kind: 'name', text: 'Coconut (Master)' }, at: Date.now() }
        const events = [
            { kind: 'storageCleared' },
            { kind: 'migrated', name, sessionId: 'a', opened: true },
            { kind: 'journalLater' },
        ]
        for (const event of events) await addEvent(page, event)
        const lines = pill(page).locator(':scope > div')
        await expect(lines).toHaveText([
            'Next SEKAI Editor · Version 0.6.0',
            'Work from earlier visits is missing. The browser cleared this site’s storage.',
            'Continued "Coconut (Master)" from auto save.',
            'A recovered change needs a newer version of the editor.',
        ])
    })

    test('notices are ordered by the table, three show, and the rest are "and N more in Local Data"', async ({
        page,
    }) => {
        await visit(page)
        const name = { name: { kind: 'name', text: 'Coconut (Master)' }, at: Date.now() }
        // Found in the opposite order of the table's.
        for (const event of [
            { kind: 'bgmNotLoaded' },
            { kind: 'journalLater' },
            { kind: 'journalRecovered', name, sessionId: 'a' },
            { kind: 'migrationFailed' },
            { kind: 'storageCleared' },
        ])
            await addEvent(page, event)
        const lines = pill(page).locator(':scope > div')
        await expect(lines).toHaveCount(5)
        await expect(lines.nth(1)).toContainText('Work from earlier visits is missing.')
        await expect(lines.nth(2)).toContainText('The old auto save could not be restored.')
        await expect(lines.nth(3)).toContainText(
            'Recovered your last change to "Coconut (Master)".',
        )
        await expect(lines.nth(4)).toContainText('and 2 more in Local Data')
        // Local Data is offered once, on the last line, and Alt+N reaches it.
        await expect(pill(page).getByRole('button', { name: 'Local Data' })).toHaveCount(1)
        await expect(lines.nth(4).getByRole('button', { name: 'Local Data' })).toBeVisible()
        await page.keyboard.press('Alt+KeyN')
        await expect(pill(page).getByRole('button', { name: 'Local Data' })).toBeFocused()
        await pill(page).getByRole('button', { name: 'Local Data' }).click()
        // Settings opens scrolled to Local Data with its heading focused.
        const heading = page.locator('#settings-localData [data-settings-heading]')
        await expect(heading).toBeFocused()
        await expect(heading).toBeInViewport()
        // Every notice of this load is listed there, not only the three on the pill.
        const atLoad = page.locator('[data-at-load]')
        await expect(atLoad).toContainText('At this load:')
        await expect(atLoad.locator('li')).toHaveText([
            'Work from earlier visits is missing. The browser cleared this site’s storage.',
            'The old auto save could not be restored.',
            'Recovered your last change to "Coconut (Master)".',
            'A recovered change needs a newer version of the editor.',
            'The BGM is not loaded.',
        ])
    })

    test('the pill stays about 8 s with notices, and a later notice replaces it', async ({
        page,
    }) => {
        await visit(page)
        await addEvent(page, { kind: 'storageCleared' })
        await expect(pill(page)).toBeVisible()
        await run(page, 'reset')
        await expect(pill(page)).toHaveCount(0)
        await expect(page.locator('.notification')).toHaveText('New level')
    })

    test('the card has a ×, goes at a session switch, and a quick toast leaves it', async ({
        page,
    }) => {
        await visit(page)
        await addEvent(page, { kind: 'storageCleared' })
        await expect(pill(page)).toBeVisible()
        // A quick toast shows apart from it.
        await page.keyboard.press('a')
        await expect(pill(page)).toBeVisible()
        await expect(page.locator('.notification:not(.notification-pill)')).toHaveCount(1)
        // Placed above the toolbar like every card.
        const box = (await pill(page).boundingBox())!
        const toolbar = (await page.locator('[data-editor-toolbar] > div').boundingBox())!
        expect(box.y + box.height).toBeLessThanOrEqual(toolbar.y)
        await run(page, 'reset')
        await expect(pill(page)).toHaveCount(0)
        await addEvent(page, { kind: 'storageCleared' })
        // Loads add to the card only while it still shows, so a closed card stays closed.
        await expect(pill(page)).toHaveCount(0)
    })

    test('the × closes the card with its notices, which stay in Local Data', async ({ page }) => {
        await visit(page)
        await addEvent(page, { kind: 'storageCleared' })
        await expect(pill(page)).toBeVisible()
        await pill(page).getByRole('button', { name: 'Close' }).click()
        await expect(pill(page)).toHaveCount(0)
    })

    test('a version-only start-up is the quick toast, centred, with no ×', async ({ page }) => {
        await visit(page)
        await expect(page.locator('.notification')).toHaveText('Next SEKAI Editor\nVersion 0.6.0')
        await expect(page.locator('[data-notice-close]')).toHaveCount(0)
    })

    test.describe('on a phone', () => {
        test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

        test('a tall card keeps its × in the pane and above the toolbar', async ({ page }) => {
            await visit(page)
            for (const kind of [
                'storageCleared',
                'migrationFailed',
                'journalLater',
                'bgmNotLoaded',
            ])
                await addEvent(page, { kind })
            await expect(pill(page)).toBeVisible()
            const close = (await pill(page).getByRole('button', { name: 'Close' }).boundingBox())!
            const pane = (await page.locator('.chart-pane').boundingBox())!
            const toolbar = (await page.locator('[data-editor-toolbar] > div').boundingBox())!
            expect(close.y).toBeGreaterThanOrEqual(pane.y)
            expect(close.width).toBeGreaterThanOrEqual(44)
            const card = (await pill(page).boundingBox())!
            expect(card.y).toBeGreaterThanOrEqual(pane.y)
            expect(card.y + card.height).toBeLessThanOrEqual(toolbar.y)
        })
    })

    test('every line is read by the one live region', async ({ page }) => {
        await visit(page)
        await addEvent(page, { kind: 'storageCleared' })
        await expect(page.locator('[role="status"][data-notice-region]')).toHaveCount(1)
        await expect(page.locator('[role="status"][data-notice-region]')).toContainText(
            'Work from earlier visits is missing.',
        )
    })
})

test.describe('the status bar label', () => {
    const label = (page: Page) => page.locator('[data-status-text]')
    const button = (page: Page) => page.locator('[data-status-label]')

    test('an unbound session shows "not saved to a file", and the page title mirrors it', async ({
        page,
    }) => {
        await visit(page)
        await expect(label(page)).toHaveText(
            /^Untitled · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M · not saved to a file$/,
        )
        await expect(page).toHaveTitle(/^Untitled · .* · not saved to a file – Next SEKAI Editor$/)
        await page.evaluate(async () => {
            const { pushState, state } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            pushState(() => 'Title', {
                ...state.value,
                levelInfo: { ...state.value.levelInfo, title: 'Coconut' },
            })
        })
        await expect(label(page)).toHaveText('Coconut · not saved to a file')
        await expect(page).toHaveTitle('Coconut · not saved to a file – Next SEKAI Editor')
    })

    test('a bound session shows the file name, and the name before it when they differ', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
        await bind(page, 'coconut.nxsp')
        await settled(page)
        await page.close({ runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        // The displayed name is the file's stem, so the file name stands alone.
        await expect(label(next)).toHaveText('coconut.nxsp')
        await expect(next).toHaveTitle('coconut.nxsp – Next SEKAI Editor')
        await next.evaluate(async () => {
            const { pushState, state } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            pushState(() => 'Name', { ...state.value })
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            session.value = { ...session.value, name: 'Coconut (Master)' }
        })
        await expect(label(next)).toHaveText('Coconut (Master) · coconut.nxsp')
        await expect(next).toHaveTitle('Coconut (Master) · coconut.nxsp – Next SEKAI Editor')
    })

    test('a separate copy says which file it is a copy of', async ({ page, context }) => {
        await visit(page)
        await edit(page, 990)
        await bind(page, 'coconut.nxsp')
        await settled(page)
        const record = await page.evaluate((key) => sessionStorage.getItem(key), `${prefix}tab`)
        const duplicate = await context.newPage()
        await duplicate.addInitScript(
            ({ key, record }) => {
                if (!sessionStorage.getItem('copied')) {
                    sessionStorage.setItem(key, record)
                    sessionStorage.setItem('copied', 'true')
                }
            },
            { key: `${prefix}tab`, record: record! },
        )
        await visit(duplicate)
        await expect(label(duplicate)).toHaveText('coconut (2) · separate copy of coconut.nxsp')
        await expect(pill(duplicate)).toContainText(
            '"coconut.nxsp" is open in another tab or window, so this is a separate copy.',
        )
    })

    test('pressing it opens the level’s dialog, and it describes itself', async ({ page }) => {
        await visit(page)
        await expect(button(page)).toHaveAccessibleDescription('Opens Level Info')
        await expect(button(page)).toHaveAccessibleName(/ · not saved to a file$/)
        await button(page).click()
        await expect(page.getByRole('dialog')).toBeVisible()
    })

    test.describe('on a phone', () => {
        test.use({ viewport: { width: 360, height: 700 } })

        test('the reason is left out, but the name stays', async ({ page }) => {
            await visit(page)
            await expect(label(page)).toBeVisible()
            await expect(page.locator('[data-status-state]')).toBeHidden()
            await expect(label(page)).toContainText('Untitled')
        })

        test('the reason stays in a suspected private window and on Safari, iPhone and iPad', async ({
            page,
        }) => {
            await page.addInitScript(() => {
                localStorage.setItem(
                    'nse.test.platform',
                    JSON.stringify({ engine: 'webkit', os: 'ios' }),
                )
            })
            await visit(page)
            await expect(page.locator('[data-status-state]')).toBeVisible()
        })
    })
})

test.describe('Reopen', () => {
    test('New after a stored session offers Reopen, which continues it', async ({ page }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await run(page, 'reset')
        const notice = page.locator('.notification-pill')
        await expect(notice).toContainText('New level')
        await expect(notice.getByRole('button', { name: /^Reopen Session from / })).toBeVisible()
        expect(await lifeOf(page)).toBe(1000)
        await notice.getByRole('button', { name: /^Reopen / }).click()
        await expect.poll(() => lifeOf(page)).toBe(990)
        await expect(page.locator('.notification-pill')).toHaveCount(0)
    })

    test('z with nothing to undo, right after New, offers Reopen too', async ({ page }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await run(page, 'reset')
        await run(page, 'undo')
        const notice = page.locator('.notification-pill')
        await expect(notice).toContainText('Nothing to undo')
        await notice.getByRole('button', { name: /^Reopen / }).click()
        await expect.poll(() => lifeOf(page)).toBe(990)
    })

    test('after an edit, z with nothing to undo offers Open History, not Reopen', async ({
        page,
    }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await run(page, 'reset')
        await edit(page, 980)
        await run(page, 'undo')
        await run(page, 'undo')
        // A card, shown apart from the quick "Undid" toasts before it.
        const card = page.locator('.notification-pill')
        await expect(card).toContainText('Nothing to undo')
        await expect(card.locator('[data-notice-action]')).toHaveText(['Open History'])
    })

    test('a blank start left by New has nothing to reopen', async ({ page }) => {
        await visit(page)
        await run(page, 'reset')
        await expect(page.locator('.notification')).toHaveText('New level')
        await expect(page.locator('.notification-pill')).toHaveCount(0)
    })

    test('an unedited continuation left by New reopens the session it continued', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await page.close({ runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        expect(await lifeOf(next)).toBe(990)
        await run(next, 'reset')
        const notice = next.locator('.notification-pill')
        await notice.getByRole('button', { name: /^Reopen / }).click()
        await expect.poll(() => lifeOf(next)).toBe(990)
    })
})

test.describe('the not-stored prompt', () => {
    test.beforeEach(async ({ context }) => {
        // Storage unavailable: nothing is durably stored.
        await context.addInitScript(() => {
            localStorage.setItem('nse.test.noStorage', 'true')
        })
    })

    const prompt = (page: Page) => page.getByRole('dialog', { name: 'Changes Not Stored' })

    test('New with edits asks first: Cancel stays, Leave Anyway goes on, with nothing to reopen', async ({
        page,
    }) => {
        await visit(page)
        await edit(page, 990)
        const going = run(page, 'reset')
        await expect(prompt(page)).toContainText(
            'Your changes are not being stored in this browser. Leaving loses them.',
        )
        // Cancel, Leave Anyway (danger), then Save (focused) on the right.
        const buttons = prompt(page).locator('[data-choice-buttons] button')
        await expect(buttons).toHaveText(['Cancel', 'Leave Anyway', 'Save'])
        await expect(prompt(page).getByRole('button', { name: 'Save' })).toBeFocused()
        await page.waitForTimeout(400)
        await prompt(page).getByRole('button', { name: 'Cancel' }).click()
        await going
        expect(await lifeOf(page)).toBe(990)
        const leaving = run(page, 'reset')
        await page.waitForTimeout(400)
        await prompt(page).getByRole('button', { name: 'Leave Anyway' }).click()
        await leaving
        await expect.poll(() => lifeOf(page)).toBe(1000)
        // Nothing was stored, so the notice is plain.
        await expect(page.locator('.notification')).toHaveText('New level')
        await expect(page.locator('.notification-pill')).toHaveCount(0)
    })

    test('without edits there is no prompt', async ({ page }) => {
        await visit(page)
        await run(page, 'reset')
        await expect(prompt(page)).toHaveCount(0)
        await expect(page.locator('.notification')).toHaveText('New level')
    })

    test('Save runs today’s Save and leaves the switch for the user to repeat', async ({
        page,
    }) => {
        await page.addInitScript(() => {
            localStorage.setItem('nse.test.platform', JSON.stringify({ fileSystemAccess: false }))
        })
        await visit(page)
        await edit(page, 990)
        const going = run(page, 'reset')
        await page.waitForTimeout(400)
        const download = page.waitForEvent('download')
        await prompt(page).getByRole('button', { name: 'Save' }).click()
        await download
        await going
        expect(await lifeOf(page)).toBe(990)
    })

    test('Open, Restore as a Copy and Reopen ask the same', async ({ page }) => {
        await visit(page)
        await edit(page, 990)
        for (const start of [
            () => run(page, 'open'),
            () =>
                page.evaluate(async () => {
                    const { restoreCopy } =
                        (await import('/src/editor/switch.ts')) as typeof import('../../src/editor/switch')
                    await restoreCopy('nothing')
                }),
            () =>
                page.evaluate(async () => {
                    const { previousSession } =
                        (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
                    previousSession.value = {
                        sessionId: 'nothing',
                        name: { name: { kind: 'name', text: 'Earlier' }, at: 0 },
                    }
                    const { reopenPrevious } =
                        (await import('/src/editor/switch.ts')) as typeof import('../../src/editor/switch')
                    await reopenPrevious()
                }),
        ]) {
            const going = start()
            await expect(prompt(page)).toBeVisible()
            await page.waitForTimeout(400)
            await prompt(page).getByRole('button', { name: 'Cancel' }).click()
            await going
            expect(await lifeOf(page)).toBe(990)
        }
    })
})

test.describe('Settings › Local Data', () => {
    const openLocalData = async (page: Page) => {
        await page.evaluate(async () => {
            const { openSettings } =
                (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
            void openSettings('localData')
        })
        await expect(page.locator('#settings-localData [data-settings-heading]')).toBeFocused()
    }

    test('the section sits second, after Editor, and the index jumps to each section', async ({
        page,
    }) => {
        await visit(page)
        await page.evaluate(async () => {
            const { openSettings } =
                (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
            void openSettings()
        })
        const titles = await page.locator('[data-settings-section] > h2').allTextContents()
        expect(titles.map((title) => title.trim())).toEqual([
            'Editor',
            'Local Data',
            'Panels',
            'Preview',
            'Toolbar',
            'Play',
            'Touch',
            'Mouse',
            'Keyboard Shortcuts',
            'About',
        ])
        const pills = page.locator('[data-settings-index] button')
        await expect(pills).toHaveCount(10)
        await pills.last().click()
        await expect(page.locator('#settings-about [data-settings-heading]')).toBeFocused()
        await expect(page.locator('#settings-about')).toBeInViewport()
        await page.locator('[data-settings-pill="localData"]').click()
        await expect(page.locator('#settings-localData [data-settings-heading]')).toBeFocused()
    })

    test('the storage line is static text under the heading', async ({ page }) => {
        await visit(page)
        await openLocalData(page)
        await expect(page.locator('[data-storage-line]')).toHaveText(
            'Recent Sessions are kept in this browser, which may clear them if space runs low. Save to a file to keep your work.',
        )
    })

    test.describe('with storage unavailable', () => {
        test.beforeEach(async ({ context }) => {
            await context.addInitScript(() => {
                localStorage.setItem('nse.test.noStorage', 'true')
                // An old auto save this build cannot read.
                if (!sessionStorage.getItem('seeded')) {
                    sessionStorage.setItem('seeded', '1')
                    localStorage.setItem(
                        'sonolus-next-sekai-editor.autoSave.unreadable',
                        JSON.stringify({ version: 99, levelData: 'xx', filename: 'old.nsld' }),
                    )
                }
            })
        })

        const earlierVisit = async (page: Page, context: BrowserContext) => {
            await visit(page)
            await edit(page, 990)
            await hide(page)
            await page.close({ runBeforeUnload: false })
            const later = await context.newPage()
            await visit(later)
            return later
        }

        test('the rows list what is kept, with Open, Download and Discard…', async ({
            page,
            context,
        }) => {
            const later = await earlierVisit(page, context)
            await expect(pill(later).getByRole('button', { name: 'Local Data' })).toBeVisible()
            await pill(later).getByRole('button', { name: 'Local Data' }).click()
            await expect(later.locator('#settings-localData [data-settings-heading]')).toBeFocused()
            await expect(later.locator('[data-storage-line]')).toContainText(
                'This browser is not letting the editor store anything.',
            )
            const rows = later.locator('[data-recovery-row]')
            await expect(rows).toHaveCount(3)
            const journal = later.locator('[data-recovery-row="journal"]')
            await expect(journal).toContainText(
                /Unsaved work from an earlier visit, [A-Z][a-z]{2} \d/,
            )
            await expect(journal.getByRole('button')).toHaveText(['Open', 'Download'])
            const autoSave = later.locator('[data-recovery-row="autoSave"]')
            await expect(autoSave).toContainText('Old auto save')
            await expect(autoSave).toContainText('(cannot be opened in this version)')
            await expect(autoSave.getByRole('button')).toHaveText(['Download', 'Discard…'])
            const legacy = later.locator('[data-recovery-row="legacy"]')
            await expect(legacy).toContainText('Legacy recovery copy')
            await expect(legacy.getByRole('button')).toHaveText(['Download'])
            // The load notices of this load are listed too.
            await expect(later.locator('[data-at-load] li')).toContainText([
                'Unsaved work from an earlier visit is in Local Data.',
            ])
        })

        test('Open puts a readable old auto save’s chart in this tab, and its key stays', async ({
            page,
            context,
        }) => {
            const slot = JSON.stringify({
                bgmOffset: 0,
                entities: [
                    { archetype: 'Initialization', data: [] },
                    {
                        archetype: '#BPM_CHANGE',
                        data: [
                            { name: '#BEAT', value: 0 },
                            { name: '#BPM', value: 150 },
                        ],
                    },
                ],
            })
            await context.addInitScript((slot) => {
                localStorage.setItem('sonolus-next-sekai-editor.autoSave.levelData', slot)
            }, slot)
            await visit(page)
            await page.evaluate(async () => {
                const { openSettings } =
                    (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
                void openSettings('localData')
            })
            const row = page.locator('[data-recovery-row="autoSave"]').filter({
                hasNotText: 'cannot be opened',
            })
            await expect(row.getByRole('button')).toHaveText(['Open', 'Download', 'Discard…'])
            await row.getByRole('button', { name: 'Open' }).click()
            await expect(page.locator('#settings-localData')).toHaveCount(0)
            await expect(page.getByText('Opened the old auto save.')).toBeVisible()
            expect(
                await page.evaluate(() =>
                    localStorage.getItem('sonolus-next-sekai-editor.autoSave.levelData'),
                ),
            ).toBe(slot)
        })

        test('Download hands the file over', async ({ page, context }) => {
            const later = await earlierVisit(page, context)
            await later.evaluate(async () => {
                const { openSettings } =
                    (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
                void openSettings('localData')
            })
            const download = later.waitForEvent('download')
            await later
                .locator('[data-recovery-row="journal"]')
                .getByRole('button', { name: 'Download' })
                .click()
            expect((await download).suggestedFilename()).toMatch(/\.nsld$/)
        })

        test('Open puts the journal’s work in this tab', async ({ page, context }) => {
            const later = await earlierVisit(page, context)
            await later.evaluate(async () => {
                const { openSettings } =
                    (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
                void openSettings('localData')
            })
            expect(await lifeOf(later)).toBe(1000)
            await later
                .locator('[data-recovery-row="journal"]')
                .getByRole('button', { name: 'Open' })
                .click()
            await expect.poll(() => lifeOf(later)).toBe(990)
            // Settings gives way to the chart.
            await expect(later.locator('#settings-localData')).toHaveCount(0)
        })

        test('Discard… confirms with Download focused, and Discard removes the row', async ({
            page,
            context,
        }) => {
            const later = await earlierVisit(page, context)
            await later.evaluate(async () => {
                const { openSettings } =
                    (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
                void openSettings('localData')
            })
            const autoSave = later.locator('[data-recovery-row="autoSave"]')
            await autoSave.getByRole('button', { name: 'Discard…' }).click()
            const dialog = later.getByRole('dialog', { name: 'Discard' })
            await expect(dialog).toContainText(/Discard the old auto save \(\d+(\.\d)? kB\)\?/)
            await expect(dialog.locator('[data-choice-buttons] button')).toHaveText([
                'Cancel',
                'Discard',
                'Download',
            ])
            await expect(dialog.getByRole('button', { name: 'Download' })).toBeFocused()
            await later.waitForTimeout(400)
            // Cancel removes nothing.
            await dialog.getByRole('button', { name: 'Cancel' }).click()
            await expect(autoSave).toHaveCount(1)
            await autoSave.getByRole('button', { name: 'Discard…' }).click()
            await later.waitForTimeout(400)
            await later
                .getByRole('dialog', { name: 'Discard' })
                .getByRole('button', { name: 'Discard', exact: true })
                .click()
            await expect(later.locator('[data-recovery-row="autoSave"]')).toHaveCount(0)
            expect(
                await later.evaluate(() =>
                    localStorage.getItem('sonolus-next-sekai-editor.autoSave.unreadable'),
                ),
            ).toBeNull()
        })
    })
})

test('safe mode opens read-only on purpose, so its pill has no "older than your data" line', async ({
    page,
}) => {
    await page.goto('/?safe')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await opened(page)
    await expect(page.locator('[data-safe-bar]')).toBeVisible()
    await expect(page.locator('.notification')).not.toContainText('older than your data')
})
