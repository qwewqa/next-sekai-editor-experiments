import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { confirmNew, confirmWhenReady } from './confirmWhenReady'
import { closePage } from './editorFixture'
import legacyColors from './fixtures/legacy-colors.json' with { type: 'json' }

// Step 4's UI (Part 1 §1.4.3, §1.3.4, §1.4.1, §1.4.9, §1.4.14): the load notices in the start-up
// pill with their actions, the status bar label and the page title, the Reopen notice, the in-app
// not-stored prompt, and Settings › Local Data's Recovery rows.

const prefix = 'sonolus-next-sekai-editor.'

/** Seeds every page of the context: the storage hooks, a fixed version, and the panels away. */
const seed = (context: BrowserContext, extra: Record<string, string> = {}) =>
    context.addInitScript((extra) => {
        if (location.href === 'about:blank') return
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
        const { initialLife: operation } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        pushState(operation(state.value.initialLife, initialLife), { ...state.value, initialLife })
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

/** Binds the open session's chain to a file, as a Save would: its hash is the head's. */
const bind = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const { flusher } = window.nseFlushTest!
        await flusher.flush({ strict: true })
        const committed = flusher.session!.stack.committed
        return flusher.setChainFields({
            file: {
                name,
                event: 'saved',
                at: Date.now(),
                hash: committed.at(committed.index)?.hash ?? new Uint8Array(16),
            },
        })
    }, name)

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

const unsaved = (page: Page) => page.getByRole('dialog', { name: 'Unsaved Changes' })

/** New on a chart with changes not saved to a file: it asks first, and New goes on (§1.4.9). */
const runNew = async (page: Page) => {
    const going = run(page, 'reset')
    await confirmNew(page)
    await going
}

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
        await closePage(page, { runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        await expect(pill(next)).toContainText('Next SEKAI Editor')
        await expect(pill(next)).toContainText('Version 0.6.0')
        await expect(pill(next)).toContainText(
            /Continued "coconut" from (\d{1,2}:\d{2}|[A-Z][a-z]{2}\u00A0\d{1,2})/,
        )
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
        await closePage(page, { runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        await expect(pill(next)).toContainText(/Continued ".+" from the old auto save\./)
        await expect(pill(next)).not.toContainText(/ from [A-Z][a-z]{2} \d/)
    })

    test('the date fallback reads "Continued your session from …"', async ({ page, context }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await closePage(page, { runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        await expect(pill(next)).toContainText(
            /Continued your session from (\d{1,2}:\d{2}|[A-Z][a-z]{2}\u00A0\d{1,2})/,
        )
        await expect(pill(next)).not.toContainText('Continued "')
    })

    test('a continued session whose time is unknown names no time, never 1970', async ({
        page,
    }) => {
        await visit(page)
        const lines = pill(page).locator(':scope > div')
        await addEvent(page, {
            kind: 'continued',
            name: { name: { kind: 'name', text: 'coconut' } },
        })
        await expect(lines.nth(1)).toContainText('Continued "coconut".')
        await expect(pill(page)).not.toContainText('1970')
        // An untitled one has no date to show in its name either.
        await addEvent(page, { kind: 'continued', name: { name: { kind: 'date' } } })
        await expect(pill(page)).toContainText('Continued "Untitled".')
        await expect(pill(page)).not.toContainText(/1970|Untitled · /)
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
        await expect(pill(next)).toContainText(
            'was not restored here because it is open in another tab or window.',
        )
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
            'Continued "Coconut (Master)" from the old auto save.',
            'A recovered change needs a newer version of the editor.',
        ])
    })

    for (const kind of ['journalKept', 'unsavedRecovered'] as const)
        test(`the ${kind} notice has Restore Session, which opens the session it names`, async ({
            page,
        }) => {
            await visit(page)
            await edit(page, 990)
            await settled(page)
            const sessionId = await page.evaluate(() => window.nseFlushTest!.flusher.session!.id)
            // The session is left behind, stored and not open anywhere.
            await page.evaluate(async () => {
                const { resetState } =
                    (await import('/src/history/index.ts')) as typeof import('../../src/history')
                resetState(false)
            })
            // A load notice comes at load, before any edit: a reload keeps this tab's blank session.
            await page.reload()
            await expect(page.locator('canvas.editor-chart')).toBeVisible()
            await opened(page)
            expect(await lifeOf(page)).toBe(1000)
            const name = { name: { kind: 'name', text: 'Coconut (Master)' }, at: Date.now() }
            await addEvent(
                page,
                kind === 'journalKept' ? { kind, name, sessionId } : { kind, sessionId },
            )
            await pill(page).getByRole('button', { name: 'Restore Session' }).click()
            await expect.poll(() => lifeOf(page)).toBe(990)
            expect(await page.evaluate(() => window.nseFlushTest!.flusher.session!.id)).not.toBe(
                sessionId,
            )
            await expect(
                page.locator('.notification-pill, .notification').filter({ hasText: /^Restored / }),
            ).toBeVisible()
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
        await expect(atLoad.getByRole('heading', { name: 'Startup Notices' })).toBeVisible()
        await expect(atLoad.locator('li')).toHaveText([
            'Work from earlier visits is missing. The browser cleared this site’s storage.',
            'The old auto save could not be restored.',
            'Recovered your last change to "Coconut (Master)".',
            'A recovered change needs a newer version of the editor.',
            'The BGM is not loaded.',
        ])
    })

    test('four notices show whole: "and 1 more" would be a row as tall as the line it hides', async ({
        page,
    }) => {
        await visit(page)
        for (const event of [
            { kind: 'bgmNotLoaded' },
            { kind: 'journalLater' },
            { kind: 'migrationFailed' },
            { kind: 'storageCleared' },
        ])
            await addEvent(page, event)
        const lines = pill(page).locator(':scope > div')
        await expect(lines).toHaveCount(5)
        await expect(pill(page)).not.toContainText('more in Local Data')
        await expect(pill(page)).toContainText('The BGM is not loaded.')
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

    // A line found late (a resumed import finding damaged history) while the clean load's toast
    // is still the quick notice: only kept, never a card at an arbitrary time (round 5 S5-1).
    for (const after of ['an edit', '12 s'] as const)
        test(`a load notice after ${after} is kept for Local Data, with no card`, async ({
            page,
        }) => {
            await visit(page)
            await expect(page.locator('.notification')).toHaveText(
                'Next SEKAI Editor\nVersion 0.6.0',
            )
            if (after === 'an edit') await edit(page, 990)
            else
                await page.evaluate(() => {
                    const now = performance.now.bind(performance)
                    performance.now = () => now() + 12_000
                })
            const shown = await page.evaluate(async () => {
                const n =
                    (await import('/src/editor/notification.ts')) as typeof import('../../src/editor/notification')
                const startup = n.notification.value.startup === true
                n.addLoadNotice(() => 'Late line.', undefined, 0, 'warning')
                return { startup, card: n.noticeCard.value !== undefined }
            })
            expect(shown).toEqual({ startup: true, card: false })
            await expect(pill(page)).toHaveCount(0)
            await page.evaluate(async () => {
                const { openSettings } =
                    (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
                void openSettings('localData')
            })
            await expect(page.locator('[data-at-load] li')).toHaveText(['Late line.'])
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
            expect(close.width).toBe(32)
            const card = (await pill(page).boundingBox())!
            expect(card.y).toBeGreaterThanOrEqual(pane.y)
            expect(card.y + card.height).toBeLessThanOrEqual(toolbar.y)
        })
    })

    test.describe('on a touch tablet', () => {
        test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true })

        test('the card goes back above the toolbar when the History sheet closes (X-8)', async ({
            page,
        }) => {
            await visit(page)
            await addEvent(page, { kind: 'storageCleared' })
            await expect(pill(page)).toBeVisible()
            // Held, so it stays while the sheet opens and closes.
            await page.evaluate(async () => {
                const { holdNotice } =
                    (await import('/src/editor/notification.ts')) as typeof import('../../src/editor/notification')
                holdNotice('focus', true)
            })
            const toolbar = page.locator('[data-editor-toolbar] > div')
            // The card's foot, against the bar's top: 8 px above it once the card has risen in.
            const space = async () =>
                (await toolbar.boundingBox())!.y -
                (await pill(page).evaluate((card) => card.getBoundingClientRect().bottom))
            await expect.poll(space).toBe(8)
            // The sheet unmounts the toolbar while it is open; closing it mounts a new one.
            await run(page, 'history')
            const sheet = page.locator('[data-tool-dialog][data-sheet]')
            await expect(sheet).toBeVisible()
            await expect(toolbar).toHaveCount(0)
            await page.keyboard.press('Escape')
            await expect(sheet).toHaveCount(0)
            await expect(toolbar).toBeVisible()
            await expect.poll(space).toBe(8)
            const bar = (await toolbar.boundingBox())!
            // A tap on the toolbar's centre lands on the toolbar.
            const hit = await page.evaluate(
                ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-editor-toolbar]'),
                { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 },
            )
            expect(hit).toBe(true)
        })
    })

    test.describe('beside the right sheet', () => {
        // A short landscape window: the card narrows beside the sheet to about 184 px, the X-F
        // phone's, where the heading has 118 px.
        test.use({ viewport: { width: 560, height: 390 }, hasTouch: true, isMobile: true })

        test('the heading keeps the version whole, on a line of its own when it must (X-9)', async ({
            page,
            context,
        }) => {
            // A build between tags carries its commit, the longest version there is.
            await context.addInitScript(() => {
                localStorage.setItem(
                    'nse.test.version',
                    JSON.stringify({ appVersion: '0.6.0+2de308ef', atTag: false }),
                )
            })
            await visit(page)
            await addEvent(page, { kind: 'storageCleared' })
            await expect(pill(page)).toBeVisible()
            await page.evaluate(async () => {
                const { holdNotice } =
                    (await import('/src/editor/notification.ts')) as typeof import('../../src/editor/notification')
                holdNotice('focus', true)
            })
            const heading = pill(page).locator('.sticky p')
            // Where the name and the version are drawn, read from their text, and whether the
            // heading shows the version whole: inside its room, with no ellipsis.
            const parts = () =>
                heading.evaluate((p) => {
                    const texts: Text[] = []
                    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
                    while (walker.nextNode()) texts.push(walker.currentNode as Text)
                    const rect = (node: Text) => {
                        const range = document.createRange()
                        range.selectNodeContents(node)
                        return range.getBoundingClientRect()
                    }
                    const name = texts[0]!
                    const version = texts.find((node) => /\d+\.\d+/.test(node.data))!
                    const separator = texts.find((node) => node.data.includes('·'))
                    const dot = document.createRange()
                    if (separator) {
                        dot.setStart(separator, separator.data.indexOf('·'))
                        dot.setEnd(separator, separator.data.indexOf('·') + 1)
                    }
                    const room = p.getBoundingClientRect()
                    const end = room.right - parseFloat(getComputedStyle(p).paddingRight)
                    const holder = version.parentElement!
                    const start = room.left + parseFloat(getComputedStyle(p).paddingLeft)
                    return {
                        text: p.textContent,
                        width: room.width,
                        need: rect(version).width,
                        content: end - start,
                        oneLine: rect(name).top === rect(version).top,
                        nameWhole:
                            name.parentElement!.scrollWidth <= name.parentElement!.clientWidth,
                        versionWhole:
                            rect(version).right <= end + 0.5 &&
                            holder.scrollWidth <= holder.clientWidth,
                        // Beside the name its " · " shows; on a line of its own it is hidden.
                        separatorShown: !!separator && dot.getBoundingClientRect().left >= start,
                    }
                })
            // In the full card, one line: the name, then " · Version …".
            await expect(heading).toHaveText('Next SEKAI Editor · Version 0.6.0+2de308ef')
            expect(await parts()).toMatchObject({
                oneLine: true,
                nameWhole: true,
                versionWhole: true,
                separatorShown: true,
            })
            await run(page, 'history')
            await expect(page.locator('[data-tool-dialog][data-sheet]')).toBeVisible()
            // The card narrows to the left of the sheet.
            await expect.poll(async () => (await parts()).width).toBeLessThan(240)
            for (const locale of ['en', 'ja', 'fr', 'tr']) {
                await page.evaluate(async (locale) => {
                    const { settings } =
                        (await import('/src/settings.ts')) as typeof import('../../src/settings')
                    settings.locale = locale as never
                }, locale)
                await page.evaluate(() => new Promise(requestAnimationFrame))
                const narrow = await parts()
                test.info().annotations.push({ type: locale, description: JSON.stringify(narrow) })
                expect(narrow.width, locale).toBeLessThan(240)
                expect(narrow.versionWhole, locale).toBe(true)
                expect(narrow.separatorShown, locale).toBe(narrow.oneLine)
            }
            // A little wider, the name gives way first and the version stays on its line.
            await page.setViewportSize({ width: 680, height: 390 })
            await expect.poll(async () => (await parts()).oneLine).toBe(true)
            const wider = await parts()
            test.info().annotations.push({ type: 'wider', description: JSON.stringify(wider) })
            expect(wider).toMatchObject({
                oneLine: true,
                nameWhole: false,
                versionWhole: true,
                separatorShown: true,
            })
        })
    })

    test.describe('on a phone with the dock open', () => {
        // The pane under the dock is 360 × 312: too narrow for the right sheet, and too short for a
        // bottom sheet with a useful list, so History opens as the full dialog over the card.
        test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true })

        test('History opens as the full dialog, and the card under it keeps its time', async ({
            page,
            context,
        }) => {
            await context.addInitScript((prefix) => {
                localStorage.setItem(`${prefix}showPreview`, 'true')
                localStorage.setItem(`${prefix}showSidebar`, 'true')
            }, prefix)
            await visit(page)
            await page.clock.install()
            await addEvent(page, { kind: 'storageCleared' })
            await expect(pill(page)).toBeVisible()
            const text = await pill(page).innerText()
            const { width } = (await pill(page).boundingBox())!
            await run(page, 'history')
            const history = page.locator('[data-history-presentation]')
            await expect(history).toHaveAttribute('data-history-presentation', 'compact')
            await expect(page.locator('[data-tool-dialog]')).toHaveCount(0)
            // Under the dialog, its time does not run.
            await page.clock.runFor(20_000)
            await page.keyboard.press('Escape')
            await expect(history).toHaveCount(0)
            await expect(pill(page)).toBeVisible()
            expect(await pill(page).innerText()).toBe(text)
            expect((await pill(page).boundingBox())!.width).toBe(width)
            // Then it stays its own 8 s.
            await page.clock.runFor(6_000)
            await expect(pill(page)).toBeVisible()
            await page.clock.runFor(2_500)
            await expect(pill(page)).toHaveCount(0)
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
            const { futureInitialLife } =
                (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
            pushState(
                futureInitialLife(state.value.initialLife, state.value.initialLife, 'Title'),
                {
                    ...state.value,
                    levelInfo: { ...state.value.levelInfo, title: 'Coconut' },
                },
            )
        })
        await expect(label(page)).toHaveText('Coconut · not saved to a file')
        await expect(page).toHaveTitle('Coconut · not saved to a file – Next SEKAI Editor')
    })

    test('a bound session shows the file name alone, whatever its Name', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
        await bind(page, 'coconut.nxsp')
        await settled(page)
        await closePage(page, { runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        // The displayed name is the file's stem, so the file name stands alone.
        await expect(label(next)).toHaveText('coconut.nxsp')
        await expect(next).toHaveTitle('coconut.nxsp – Next SEKAI Editor')
        await next.evaluate(async () => {
            const { pushState, state } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            const { futureInitialLife } =
                (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
            pushState(futureInitialLife(state.value.initialLife, state.value.initialLife, 'Name'), {
                ...state.value,
            })
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            session.value = { ...session.value, name: 'Coconut (Master)' }
        })
        // The file outranks a Name: it stays the displayed name.
        await expect(label(next)).toHaveText('coconut.nxsp')
        await expect(next).toHaveTitle('coconut.nxsp – Next SEKAI Editor')
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

    // X-13: an untitled chart has no name of its own, so its copy names it by its date, as the
    // "open in another tab" notice does, and the label and title never carry an empty name.
    test('a Duplicate Tab of an untitled chart names its date and leaves no empty name', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
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
        await expect(pill(duplicate)).toContainText(
            /"Untitled · [^"]+" is open in another tab or window, so this is a separate copy./,
        )
        await expect(pill(duplicate)).not.toContainText('"" is open')
        await expect(label(duplicate)).toHaveText(/^Untitled · .+ · separate copy$/)
        await expect(duplicate).toHaveTitle(/^Untitled · .+ · separate copy – Next SEKAI Editor$/)
        const copyOf = await duplicate.evaluate(async () => {
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            return session.value.copyOf
        })
        expect(copyOf).toMatchObject({ name: '', bound: false, at: expect.any(Number) })
    })

    test('Restore as a Copy of an untitled chart leaves no empty name', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        const next = await context.newPage()
        await visit(next)
        await pill(next).getByRole('button', { name: 'Restore as a Copy' }).click()
        await expect.poll(() => lifeOf(next)).toBe(990)
        await expect(label(next)).toHaveText(/^Untitled · .+ · separate copy$/)
        await expect(next).toHaveTitle(/^Untitled · .+ · separate copy – Next SEKAI Editor$/)
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
        await runNew(page)
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
        await runNew(page)
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
        await runNew(page)
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

    // Reopen and Restore as a Copy say why a session cannot be opened, as Restore Session does,
    // and the card stops offering a Reopen that cannot work (final review R2 #3).
    test('Reopen of a session deleted since says so and is offered no more', async ({ page }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        const chainId = await page.evaluate(() => window.nseFlushTest!.flusher.session!.chainId)
        await runNew(page)
        const notice = page.locator('.notification-pill')
        const reopen = notice.getByRole('button', { name: /^Reopen / })
        await expect(reopen).toBeVisible()
        await page.evaluate(
            (chainId) =>
                new Promise<void>((resolve, reject) => {
                    const open = indexedDB.open('nse-local-data')
                    open.onsuccess = () => {
                        const tx = open.result.transaction('chains', 'readwrite')
                        const store = tx.objectStore('chains')
                        const get = store.get(chainId)
                        get.onsuccess = () =>
                            store.put({ ...get.result, deleting: { at: Date.now() } })
                        tx.oncomplete = () => {
                            open.result.close()
                            resolve()
                        }
                        tx.onerror = () => reject(tx.error ?? new Error('Not marked'))
                    }
                    open.onerror = () => reject(open.error ?? new Error('Not opened'))
                }),
            chainId,
        )
        await reopen.click()
        // A card: the request was the user's, and a quick toast would fade before it is read.
        await expect(
            page
                .locator('.notification-pill')
                .filter({ hasText: 'This session was deleted in another tab or window.' }),
        ).toBeVisible()
        await expect(page.getByRole('button', { name: /^Reopen / })).toHaveCount(0)
        expect(await lifeOf(page)).toBe(1000)
        expect(
            await page.evaluate(async () => {
                const { previousSession } =
                    (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
                return previousSession.value
            }),
        ).toBeUndefined()
    })

    // The card names the session it was raised for. Another switch can leave a different one
    // while the card still shows, and the button must not open that one.
    test('a Reopen offered for a session this tab has since left reopens nothing', async ({
        page,
    }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await runNew(page)
        await expect(
            page.locator('.notification-pill').getByRole('button', { name: /^Reopen / }),
        ).toBeVisible()
        const result = await page.evaluate(async () => {
            const { previousSession } =
                (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
            const { reopenPrevious } =
                (await import('/src/editor/switch.ts')) as typeof import('../../src/editor/switch')
            const { createSwitchRequest } =
                (await import('/src/editor/switchRequest.ts')) as typeof import('../../src/editor/switchRequest')
            const offered = previousSession.value
            // Not stored: an attempt on it would fail and clear the offer.
            previousSession.value = {
                sessionId: 'nothing',
                name: { name: { kind: 'name', text: 'Later' }, at: 0 },
            }
            // A switch that is finishing stays current: the stale card does not supersede it.
            const finishing = createSwitchRequest()
            const opened = await reopenPrevious(offered)
            return {
                opened,
                still: previousSession.value?.sessionId,
                finishingCurrent: finishing.isCurrent(),
            }
        })
        expect(result).toEqual({ opened: false, still: 'nothing', finishingCurrent: true })
        expect(await lifeOf(page)).toBe(1000)
    })

    test('Restore as a Copy from a load notice says why when the session is gone', async ({
        page,
    }) => {
        await visit(page)
        await page.evaluate(async () => {
            const { restoreCopy } =
                (await import('/src/editor/switch.ts')) as typeof import('../../src/editor/switch')
            await restoreCopy('nothing')
        })
        await expect(
            page
                .locator('.notification-pill')
                .filter({ hasText: 'This session could not be opened.' }),
        ).toBeVisible()
    })

    test('an unedited continuation left by New reopens the session it continued', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await closePage(page, { runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        expect(await lifeOf(next)).toBe(990)
        await runNew(next)
        const notice = next.locator('.notification-pill')
        await notice.getByRole('button', { name: /^Reopen / }).click()
        await expect.poll(() => lifeOf(next)).toBe(990)
    })
})

// New (`n`) asks before it replaces a chart with changes not saved to a file (Part 1 §1.4.9,
// owner 2026-10-23), as v0.5.22's Reset did; the chart stays in Recent Sessions either way.
test.describe('New with unsaved changes', () => {
    test('n asks first: Cancel keeps the chart, New makes the new level with Reopen', async ({
        page,
    }) => {
        await visit(page)
        await edit(page, 990)
        await settled(page)
        await page.keyboard.press('n')
        await expect(unsaved(page)).toBeVisible()
        // New (danger), then Cancel, the default, on the right: a stray Enter replaces nothing.
        await expect(unsaved(page).locator('[data-choice-buttons] button')).toHaveText([
            'New',
            'Cancel',
        ])
        await expect(unsaved(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
        await confirmWhenReady(unsaved(page).getByRole('button', { name: 'Cancel' }), unsaved(page))
        expect(await lifeOf(page)).toBe(990)
        await page.keyboard.press('n')
        await confirmNew(page)
        await expect.poll(() => lifeOf(page)).toBe(1000)
        const notice = page.locator('.notification-pill')
        await expect(notice).toContainText('New level')
        await notice.getByRole('button', { name: /^Reopen / }).click()
        await expect.poll(() => lifeOf(page)).toBe(990)
    })

    test('n on a fresh level, and right after New, does not ask', async ({ page }) => {
        await visit(page)
        await page.keyboard.press('n')
        await expect(page.locator('.notification')).toHaveText('New level')
        await page.keyboard.press('n')
        await expect(page.locator('.notification')).toHaveText('New level')
        await expect(unsaved(page)).toHaveCount(0)
    })

    // A download counts as the file here, confirmed or not: the chart stays in Recent Sessions.
    for (const confirmed of [true, false])
        test(`n right after a Save does not ask, the download ${confirmed ? 'confirmed' : 'not confirmed'}`, async ({
            page,
        }) => {
            await page.addInitScript(
                ({ prefix, confirmed }) => {
                    localStorage.setItem(
                        'nse.test.platform',
                        JSON.stringify({ fileSystemAccess: false }),
                    )
                    if (confirmed) localStorage.setItem(`${prefix}downloadConfirmed`, 'true')
                },
                { prefix, confirmed },
            )
            await visit(page)
            await edit(page, 990)
            const download = page.waitForEvent('download')
            const saving = run(page, 'save')
            const save = page.getByRole('dialog').filter({ hasText: 'Save Project File' })
            await save.getByRole('button', { name: 'Save', exact: true }).click()
            await download
            await saving
            await page.keyboard.press('n')
            await expect.poll(() => lifeOf(page)).toBe(1000)
            await expect(page.locator('.notification-pill')).toContainText('New level')
            await expect(unsaved(page)).toHaveCount(0)
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
            'Your changes are not being stored in this browser. Leaving will discard them.',
        )
        // Cancel, Leave Anyway (danger), then Save (focused) on the right.
        const buttons = prompt(page).locator('[data-choice-buttons] button')
        await expect(buttons).toHaveText(['Cancel', 'Leave Anyway', 'Save'])
        await expect(prompt(page).getByRole('button', { name: 'Save' })).toBeFocused()
        await confirmWhenReady(prompt(page).getByRole('button', { name: 'Cancel' }), prompt(page))
        await going
        expect(await lifeOf(page)).toBe(990)
        const leaving = run(page, 'reset')
        await confirmWhenReady(
            prompt(page).getByRole('button', { name: 'Leave Anyway' }),
            prompt(page),
        )
        await leaving
        await expect.poll(() => lifeOf(page)).toBe(1000)
        // One prompt only: New's own question does not follow.
        await expect(unsaved(page)).toHaveCount(0)
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

    test('Save runs this session’s Save and leaves the switch for the user to repeat', async ({
        page,
    }) => {
        await page.addInitScript(() => {
            localStorage.setItem('nse.test.platform', JSON.stringify({ fileSystemAccess: false }))
        })
        await visit(page)
        await edit(page, 990)
        const going = run(page, 'reset')
        const download = page.waitForEvent('download')
        await confirmWhenReady(prompt(page).getByRole('button', { name: 'Save' }), prompt(page))
        // An unbound session's Save asks for its file first (§1.4.7).
        const save = page.getByRole('dialog').filter({ hasText: 'Save Project File' })
        await save.getByRole('button', { name: 'Save', exact: true }).click()
        await download
        await going
        expect(await lifeOf(page)).toBe(990)
    })

    // A file that holds the work is as good as a store, so the repeated switch goes on; a
    // download that is not confirmed is not.
    for (const confirmed of [true, false])
        test(`after a Save to a file the repeated switch ${confirmed ? 'does not ask' : 'still asks while the download is unconfirmed'}`, async ({
            page,
        }) => {
            await page.addInitScript(
                ({ prefix, confirmed }) => {
                    localStorage.setItem(
                        'nse.test.platform',
                        JSON.stringify({ fileSystemAccess: false }),
                    )
                    if (confirmed) localStorage.setItem(`${prefix}downloadConfirmed`, 'true')
                },
                { prefix, confirmed },
            )
            await visit(page)
            await edit(page, 990)
            const going = run(page, 'reset')
            const download = page.waitForEvent('download')
            await confirmWhenReady(prompt(page).getByRole('button', { name: 'Save' }), prompt(page))
            const save = page.getByRole('dialog').filter({ hasText: 'Save Project File' })
            await save.getByRole('button', { name: 'Save', exact: true }).click()
            await download
            await going
            expect(await lifeOf(page)).toBe(990)
            const repeated = run(page, 'reset')
            if (confirmed) {
                await repeated
                await expect.poll(() => lifeOf(page)).toBe(1000)
                await expect(prompt(page)).toHaveCount(0)
            } else {
                // Save would only offer the download again: the prompt offers the confirm.
                const unconfirmed = page.getByRole('dialog', { name: 'Download Not Confirmed' })
                await expect(unconfirmed).toContainText('finished downloading')
                await expect(unconfirmed.locator('[data-choice-buttons] button')).toHaveText([
                    'Cancel',
                    'Leave Anyway',
                    'I Have the File',
                ])
                await confirmWhenReady(
                    unconfirmed.getByRole('button', { name: 'Cancel' }),
                    unconfirmed,
                )
                await repeated
                expect(await lifeOf(page)).toBe(990)
                // I Have the File settles the download and goes on.
                const confirming = run(page, 'reset')
                await confirmWhenReady(
                    unconfirmed.getByRole('button', { name: 'I Have the File' }),
                    unconfirmed,
                )
                await confirming
                await expect.poll(() => lifeOf(page)).toBe(1000)
            }
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
            await confirmWhenReady(
                prompt(page).getByRole('button', { name: 'Cancel' }),
                prompt(page),
            )
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
            'Recent Sessions are kept in this browser unless it runs low on space. Save to a file to keep your work.',
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
            await closePage(page, { runBeforeUnload: false })
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
                'The editor cannot store changes in this browser.',
            )
            const rows = later.locator('[data-recovery-row]')
            await expect(rows).toHaveCount(2)
            const journal = later.locator('[data-recovery-row="journal"]')
            await expect(journal).toContainText(
                /Unsaved work from an earlier visit, [A-Z][a-z]{2} \d/,
            )
            await expect(journal.getByRole('button')).toHaveText(['Open', 'Download'])
            const autoSave = later.locator('[data-recovery-row="autoSave"]')
            await expect(autoSave).toContainText('Old auto save')
            await expect(autoSave).toContainText('(cannot be opened in this version)')
            await expect(autoSave.getByRole('button')).toHaveText(['Download', 'Discard…'])
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
            // The notice shows once; the screen reader's live region repeats its text out of sight.
            await expect(
                page
                    .locator('.notification, .notification-pill')
                    .filter({ hasText: 'Opened the old auto save.' }),
            ).toBeVisible()
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

        test('a Download that fails is an error card', async ({ page, context }) => {
            const later = await earlierVisit(page, context)
            await later.evaluate(async () => {
                const { openSettings } =
                    (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
                void openSettings('localData')
                // The download fails as the platform reports a failed file operation.
                const { platform } =
                    (await import('/src/platform/index.ts')) as typeof import('../../src/platform')
                const { FileError } =
                    (await import('/src/platform/types.ts')) as typeof import('../../src/platform/types')
                platform.saveFile = () =>
                    Promise.reject(new FileError('io', 'No space', undefined, 'download'))
            })
            await later
                .locator('[data-recovery-row="journal"]')
                .getByRole('button', { name: 'Download' })
                .click()
            const card = later.locator('[data-notice-card]')
            await expect(card).toContainText('could not be downloaded.')
            await expect(card.locator('svg[data-severity="error"]')).toHaveCount(1)
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
            await expect(dialog).toContainText(/Discard the old auto save \(\d+(\.\d)?\skB\)\?/)
            await expect(dialog.locator('[data-choice-buttons] button')).toHaveText([
                'Cancel',
                'Discard',
                'Download',
            ])
            await expect(dialog.getByRole('button', { name: 'Download' })).toBeFocused()
            // Cancel removes nothing.
            await confirmWhenReady(dialog.getByRole('button', { name: 'Cancel' }), dialog)
            await expect(autoSave).toHaveCount(1)
            await autoSave.getByRole('button', { name: 'Discard…' }).click()
            await confirmWhenReady(
                dialog.getByRole('button', { name: 'Discard', exact: true }),
                dialog,
            )
            await expect(later.locator('[data-recovery-row="autoSave"]')).toHaveCount(0)
            // The row's own button went with it: focus stays in Settings, on the first row left.
            await expect(
                later.locator('#settings-localData [data-recovery-row] button').first(),
            ).toBeFocused()
            expect(
                await later.evaluate(() =>
                    localStorage.getItem('sonolus-next-sekai-editor.autoSave.unreadable'),
                ),
            ).toBeNull()
        })
    })
})

test('safe mode opens read-only on purpose, so its pill has no "newer version" line', async ({
    page,
}) => {
    await page.goto('/?safe')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await opened(page)
    await expect(page.locator('[data-safe-bar]')).toBeVisible()
    await expect(page.locator('.notification')).not.toContainText(
        'A newer version of the editor has been opened',
    )
})

// An app’s built-in browser (Part 1 §1.4.3, §1.4.13, §1.6.10): one more line on the start-up card
// with Copy Link, and a storage line in Settings › Local Data.
test.describe('the in-app browser line', () => {
    const inApp =
        'This looks like an app’s built-in browser. Some features may not work, and stored work may be deleted. To keep your work, open this page in your browser.'
    const inAppStorage =
        'This looks like an app’s built-in browser. Stored work may be deleted. To keep your work, open this page in your browser.'
    const androidWebView =
        'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36'
    const iosWebView =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

    const platformOverride = (context: BrowserContext, override: object) =>
        context.addInitScript((override) => {
            if (location.href === 'about:blank') return
            localStorage.setItem('nse.test.platform', JSON.stringify(override))
        }, override)

    const openLocalData = async (page: Page) => {
        await page.evaluate(async () => {
            const { openSettings } =
                (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
            void openSettings('localData')
        })
        await expect(page.locator('#settings-localData [data-settings-heading]')).toBeFocused()
    }

    test('the override puts the line on the card, and in Local Data twice', async ({
        page,
        context,
    }) => {
        await platformOverride(context, { inAppBrowser: true })
        await visit(page)
        await expect(pill(page).locator(':scope > div')).toContainText([
            'Next SEKAI Editor · Version 0.6.0',
            inApp,
        ])
        await expect(pill(page).locator('[data-notice-action]')).toHaveText(['Copy Link'])
        await openLocalData(page)
        await expect(page.locator('[data-storage-line]')).toHaveText(inAppStorage)
        await expect(page.locator('[data-at-load] li')).toHaveText([inApp])
    })

    test('a WebView user agent is found by the detection itself', async ({ browser }) => {
        const context = await browser.newContext({ userAgent: androidWebView })
        await seed(context)
        const page = await context.newPage()
        await visit(page)
        await expect(pill(page)).toContainText(inApp)
        await context.close()
    })

    test('it comes after a cleared-storage line and before the later ones', async ({
        page,
        context,
    }) => {
        await platformOverride(context, { inAppBrowser: true })
        await visit(page)
        const name = { name: { kind: 'name', text: 'Coconut (Master)' }, at: Date.now() }
        // Found in the opposite order of the table's.
        for (const event of [
            { kind: 'migrated', name, sessionId: 'a', opened: true },
            { kind: 'storageCleared' },
        ])
            await addEvent(page, event)
        await expect(pill(page).locator(':scope > div')).toContainText([
            'Next SEKAI Editor · Version 0.6.0',
            'Work from earlier visits is missing. The browser cleared this site’s storage.',
            inApp,
            'Continued "Coconut (Master)" from the old auto save.',
        ])
    })

    test('a normal load has no such line, and stays the quick toast', async ({ page }) => {
        await visit(page)
        await expect(page.locator('.notification')).toHaveText('Next SEKAI Editor\nVersion 0.6.0')
        await expect(pill(page)).toHaveCount(0)
        await openLocalData(page)
        await expect(page.locator('[data-storage-line]')).toContainText('Recent Sessions are kept')
        await expect(page.locator('[data-at-load] li')).toHaveCount(0)
    })

    test.describe('on a plain WebKit view', () => {
        test.use({ userAgent: iosWebView })

        test('it is found without Safari/ in the user agent', async ({ page }) => {
            await visit(page)
            await expect(pill(page)).toContainText(inApp)
        })

        test('a Home Screen web app is never flagged', async ({ page, context }) => {
            await platformOverride(context, { standalone: true })
            await visit(page)
            await expect(page.locator('.notification')).toHaveText(
                'Next SEKAI Editor\nVersion 0.6.0',
            )
            await expect(pill(page)).toHaveCount(0)
            await openLocalData(page)
            await expect(page.locator('[data-storage-line]')).not.toContainText('built-in browser')
        })
    })

    test.describe('Copy Link', () => {
        test('copies the page without its query or hash, and says so', async ({
            page,
            context,
        }) => {
            await context.grantPermissions(['clipboard-read', 'clipboard-write'])
            await platformOverride(context, { inAppBrowser: true })
            await page.goto('/?utm_source=chat#section')
            await expect(page.locator('canvas.editor-chart')).toBeVisible()
            await opened(page)
            await pill(page).getByRole('button', { name: 'Copy Link' }).click()
            await expect(page.locator('.notification:not(.notification-pill)')).toHaveText(
                'Copied the link',
            )
            const url = new URL(page.url())
            await expect
                .poll(() => page.evaluate(() => navigator.clipboard.readText()))
                .toBe(`${url.origin}${url.pathname}`)
            // The card stays.
            await expect(pill(page)).toBeVisible()
        })

        test('falls back to the copy command where the clipboard API is refused', async ({
            page,
            context,
        }) => {
            await platformOverride(context, { inAppBrowser: true })
            await context.addInitScript(() => {
                Object.defineProperty(navigator.clipboard, 'writeText', {
                    configurable: true,
                    value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
                })
                const copied: string[] = []
                ;(window as unknown as { copied: string[] }).copied = copied
                document.execCommand = (command: string) => {
                    const field = document.activeElement
                    if (command === 'copy' && field instanceof HTMLTextAreaElement)
                        copied.push(field.value)
                    return command === 'copy'
                }
            })
            await visit(page)
            await pill(page).getByRole('button', { name: 'Copy Link' }).click()
            await expect(page.locator('.notification:not(.notification-pill)')).toHaveText(
                'Copied the link',
            )
            const url = new URL(page.url())
            const copied = await page.evaluate(
                () => (window as unknown as { copied: string[] }).copied,
            )
            expect(copied).toEqual([`${url.origin}${url.pathname}`])
        })

        test('says so when both the clipboard API and the copy command fail', async ({
            page,
            context,
        }) => {
            await platformOverride(context, { inAppBrowser: true })
            await context.addInitScript(() => {
                Object.defineProperty(navigator.clipboard, 'writeText', {
                    configurable: true,
                    value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
                })
                document.execCommand = () => false
            })
            await visit(page)
            await pill(page).getByRole('button', { name: 'Copy Link' }).click()
            await expect(page.locator('.notification:not(.notification-pill)')).toHaveText(
                'Could not copy the link',
            )
        })
    })
})
