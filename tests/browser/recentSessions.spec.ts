import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type english from '../../src/i18n/en/index.json'
import {
    closePage,
    errorsFail,
    flush,
    holdWorker,
    load,
    noErrors,
    notice,
    openHistory,
} from './historyJourney'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

// Recent Sessions (Part 1 §1.4.10.6): one row per chain, newest first, with a badge for this tab and
// for a session open elsewhere. A click peeks the session without BGM; Restore Session continues
// it, or opens a copy when it cannot; the ⋯ menu offers Save to File….

const messages = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english
const { sessions } = messages.history

test.afterEach(({ page }) => {
    noErrors(page)
})

type Edit = { title: string; life: number }

/** Titles the chart and sets its initial life: one entry, so the chain has something to list. */
const edit = (page: Page, { title, life }: Edit) =>
    page.evaluate(
        ({ title, life }) => {
            const { history, historySteps } = window.editorTest
            const state = history.state.value
            history.pushState(
                historySteps.futureInitialLife(state.initialLife, life, `Life ${life}`),
                {
                    ...state,
                    initialLife: life,
                    levelInfo: { ...state.levelInfo, title },
                },
            )
        },
        { title, life },
    )

const newSession = (page: Page) =>
    page.evaluate(() => {
        window.editorTest.history.resetState(false)
    })

/** A stored chain, closed: the page ends on a blank session. */
const closedChain = async (page: Page, each: Edit) => {
    await edit(page, each)
    await flush(page)
    const ids = await flushIds(page)
    await newSession(page)
    return ids
}

const flushIds = (page: Page) =>
    page.evaluate(() => {
        const session = window.nseFlushTest!.flusher.session!
        return { sessionId: session.id, chainId: session.chainId }
    })

const lifeOf = (page: Page) =>
    page.evaluate(() => window.editorTest.history.state.value.initialLife)
const openedChain = (page: Page) =>
    expect.poll(() => page.evaluate(() => window.nseFlushTest!.flusher.session?.chainId))

/** A second tab in the context, on the session it opened (a new visit continues the newest). */
const otherTab = async (context: BrowserContext) => {
    const page = await context.newPage()
    errorsFail(page)
    await load(page, { chart: 'keep' })
    return page
}

const openSessions = async (page: Page) => {
    await openHistory(page)
    await page.getByRole('tab', { name: messages.history.recentSessions }).click()
    await expect(page.locator('[data-recent-sessions]')).toBeVisible()
    await expect(page.locator('[data-sessions-loading]')).toHaveCount(0)
}

const rowsOf = (page: Page) => page.locator('[data-sessions-row]')
const rowFor = (page: Page, title: string): Locator =>
    rowsOf(page).filter({ has: page.getByText(title, { exact: true }) })

const peekedLife = (page: Page) =>
    page.evaluate(async () => {
        const { peek } =
            await window.editorTest.appImport<typeof import('../../src/history/stack')>(
                '/src/history/stack.ts',
            )
        return peek.value?.state.initialLife
    })

const peekBar = (page: Page) => page.locator('[data-peek-bar]')

test('one row for each chain, newest first, and a click peeks it with a bar that names it', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await closedChain(page, { title: 'Beta', life: 980 })
    await openSessions(page)

    // The fixture’s own chart is a stored chain too, the oldest.
    await expect(rowsOf(page)).toHaveCount(3)
    await expect(rowsOf(page).nth(0)).toContainText('Beta')
    await expect(rowsOf(page).nth(1)).toContainText('Alpha')
    await expect(page.locator('[data-history-list] [data-sessions-footer]')).toBeVisible()
    // The day header, and a caption with the file state and the note count.
    await expect(page.getByRole('grid', { name: messages.history.recentSessions })).toContainText(
        messages.history.today,
    )
    await expect(rowFor(page, 'Alpha').locator('[data-sessions-caption]')).toContainText(
        / · 0 notes · not saved to a file$/,
    )

    await rowFor(page, 'Alpha').click()
    await expect.poll(() => peekedLife(page)).toBe(990)
    const bar = peekBar(page)
    await expect(bar.locator('[data-peek-session]')).toContainText('"Alpha"')
    await expect(bar.locator('[data-peek-restore]')).toHaveText(messages.open.restoreIt)
    // No steps in a session’s peek: no arrows, no Step Details.
    await expect(bar.locator('[data-peek-details]')).toHaveCount(0)
    await expect(rowFor(page, 'Alpha')).toHaveAttribute('aria-selected', 'true')

    // Arrow keys move through the rows and peek each.
    await rowFor(page, 'Alpha').focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => peekedLife(page)).toBe(980)
    await expect(bar.locator('[data-peek-session]')).toContainText('"Beta"')

    await bar.locator('[data-peek-back]').click()
    await expect(bar).toHaveCount(0)
})

test('Restore Session in the peek bar opens the session, shows the Timeline and keeps History open', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    // What this tab has open is stored, so the card can offer it back.
    await edit(page, { title: 'Beta', life: 970 })
    await flush(page)
    await openSessions(page)
    await rowFor(page, 'Alpha').click()
    await expect.poll(() => peekedLife(page)).toBe(990)
    await peekBar(page).locator('[data-peek-restore]').click()

    await expect.poll(() => lifeOf(page)).toBe(990)
    await openedChain(page).toBe(alpha.chainId)
    await expect(page.getByRole('tab', { name: messages.history.timeline })).toHaveAttribute(
        'aria-selected',
        'true',
    )
    await expect(page.locator('[data-history-surface="dialog"]')).toBeVisible()
    await expect(peekBar(page)).toHaveCount(0)
    // The switch card names the session and offers Reopen of what was left.
    const card = notice(page, 'Restored "Alpha"')
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: /^Reopen/ })).toBeVisible()
})

test('this tab’s chain is a row with a badge, its text is live, and a click on it is Back to Now', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await edit(page, { title: 'Beta', life: 970 })
    await flush(page)
    // A later edit is not stored yet: the row reads the open session.
    await edit(page, { title: 'Gamma', life: 960 })
    await openSessions(page)

    const own = page.locator('[data-sessions-row][data-badge="thisTab"]')
    await expect(own).toHaveCount(1)
    await expect(own.locator('[data-sessions-badge]')).toHaveText(sessions.thisTab)
    await expect(own).toContainText('Gamma')
    // No menu for the row of the open session.
    await expect(own.locator('[data-sessions-more]')).toHaveCount(0)

    await rowFor(page, 'Alpha').click()
    await expect.poll(() => peekedLife(page)).toBe(990)
    await own.click()
    await expect(peekBar(page)).toHaveCount(0)
    await expect(own).toHaveAttribute('aria-selected', 'true')
})

test('the ⋯ button has no tab stop and a label, and Shift+F10 opens the same menu', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    const more = rowFor(page, 'Alpha').locator('[data-sessions-more]')
    await expect(more).toHaveAttribute('tabindex', '-1')
    await expect(more).toHaveAttribute('aria-label', 'More Actions for "Alpha"')
    await expect(more).toHaveAttribute('aria-haspopup', 'menu')

    await more.click()
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem')).toHaveText([
        messages.open.restoreIt,
        sessions.saveToFile,
        sessions.delete,
    ])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(rowFor(page, 'Alpha')).toBeFocused()

    await page.keyboard.press('Shift+F10')
    await expect(menu.getByRole('menuitem')).toHaveText([
        messages.open.restoreIt,
        sessions.saveToFile,
        sessions.delete,
    ])
    await page.keyboard.press('Escape')
    await page.keyboard.press('ContextMenu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    // Enter restores the focused row, once.
    await page.keyboard.press('Enter')
    await expect.poll(() => lifeOf(page)).toBe(990)
})

test('a session’s peek has no BGM, and Back to Now returns the audio the open session has', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await page.evaluate(() => window.editorTest.addWaveform())
    await openSessions(page)
    await rowFor(page, 'Alpha').click()
    await expect.poll(() => peekedLife(page)).toBe(990)
    const audio = () =>
        page.evaluate(async () => {
            const { peek, liveState } =
                await window.editorTest.appImport<typeof import('../../src/history/stack')>(
                    '/src/history/stack.ts',
                )
            return {
                peeked: peek.value ? !!peek.value.state.bgm.buffer : undefined,
                live: !!liveState.value.bgm.buffer,
            }
        })
    expect(await audio()).toEqual({ peeked: false, live: true })
    await peekBar(page).locator('[data-peek-back]').click()
    await expect(peekBar(page)).toHaveCount(0)
    expect(await audio()).toEqual({ peeked: undefined, live: true })
})

test('a session open in another tab has the badge, offers Restore as a Copy and opens a separate copy', async ({
    page,
    context,
}) => {
    errorsFail(page)
    await load(page)
    await edit(page, { title: 'Alpha', life: 990 })
    await flush(page)
    const original = await flushIds(page)
    // A new visit in a second tab finds it open elsewhere and starts blank.
    const other = await otherTab(context)
    await openSessions(other)
    const row = rowFor(other, 'Alpha')
    await expect(row.locator('[data-sessions-badge]')).toHaveText(sessions.elsewhere)

    await row.locator('[data-sessions-more]').click()
    const menu = other.getByRole('menu')
    await expect(menu.getByRole('menuitem')).toHaveText([
        messages.load.restoreAsCopy,
        sessions.saveToFile,
        sessions.delete,
    ])
    await menu.getByRole('menuitem', { name: messages.load.restoreAsCopy }).click()

    await expect.poll(() => lifeOf(other)).toBe(990)
    const copy = await flushIds(other)
    expect(copy.chainId).not.toBe(original.chainId)
    await expect(notice(other, 'Restored a copy of "Alpha"')).toBeVisible()
    // The tab that has it open is untouched.
    expect((await flushIds(page)).chainId).toBe(original.chainId)
    expect(await lifeOf(page)).toBe(990)
})

test('a row whose chain another tab continued since the list was drawn opens a copy, and says so', async ({
    page,
    context,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await expect(rowFor(page, 'Alpha')).toBeVisible()
    // The list holds still under the pointer, so the other tab’s write does not change it.
    await rowFor(page, 'Alpha').hover()
    const other = await otherTab(context)
    await expect.poll(() => lifeOf(other)).toBe(990)
    await edit(other, { title: 'Alpha', life: 950 })
    await flush(other)
    expect((await flushIds(other)).chainId).toBe(alpha.chainId)

    await rowFor(page, 'Alpha').locator('[data-sessions-more]').click()
    // The other tab holds its newer session, not the one the row names: Restore Session finds out.
    await page.getByRole('menuitem', { name: messages.open.restoreIt }).click()
    // The copy is of the session the row named, not of what the other tab has made of it since.
    await expect.poll(() => lifeOf(page)).toBe(990)
    expect((await flushIds(page)).chainId).not.toBe(alpha.chainId)
    await expect(notice(page, 'Restored a copy of "Alpha"')).toBeVisible()
})

test('restoring the chain’s latest session continues it with its file', async ({ page }) => {
    errorsFail(page)
    await load(page)
    await edit(page, { title: 'Alpha', life: 990 })
    await page.evaluate(() =>
        window.nseFlushTest!.flusher.setChainFields({
            file: {
                name: 'coconut.nxsp',
                event: 'saved',
                at: Date.now(),
                hash: new Uint8Array(16),
            },
        }),
    )
    await flush(page)
    const alpha = await flushIds(page)
    await newSession(page)
    await openSessions(page)
    // The file part is the status bar’s own, with its “•” for a file the session has changed.
    await expect(rowFor(page, 'coconut').locator('[data-sessions-caption]')).toContainText(
        'coconut.nxsp •',
    )
    await rowFor(page, 'coconut').focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => lifeOf(page)).toBe(990)
    await openedChain(page).toBe(alpha.chainId)
    await expect(notice(page, 'Restored "coconut"')).toBeVisible()
    await expect(page.getByText('coconut.nxsp').last()).toBeVisible()
})

test('a list that cannot be read says so with Try Again, never an empty list', async ({ page }) => {
    errorsFail(page, { allow: [/held listRecent call failed/] })
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    const hold = await holdWorker(page, 'listRecent')
    await openHistory(page)
    await page.getByRole('tab', { name: messages.history.recentSessions }).click()
    await hold.reached()
    await expect(page.locator('[data-sessions-loading]')).toBeVisible()
    await hold.release(true)
    const failed = page.locator('[data-sessions-failed]')
    await expect(failed).toContainText(sessions.loadFailed)
    await expect(page.locator('[data-sessions-empty]')).toHaveCount(0)
    await failed.getByRole('button', { name: messages.history.tryAgain }).click()
    await expect(rowFor(page, 'Alpha')).toBeVisible()
    await expect(failed).toHaveCount(0)
})

test('with nothing stored the list says so and still has the storage line', async ({ page }) => {
    errorsFail(page)
    await load(page, { chart: 'keep' })
    await openSessions(page)
    await expect(page.locator('[data-sessions-empty]')).toHaveText(messages.history.empty)
    await expect(page.locator('[data-sessions-footer]')).toBeVisible()
})

test('rows hold still under the pointer, and a refresh lands when it leaves', async ({
    page,
    context,
}) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    const before = await rowsOf(page).count()
    await rowFor(page, 'Alpha').hover()
    const other = await otherTab(context)
    await newSession(other)
    await edit(other, { title: 'Omega', life: 940 })
    await flush(other)
    // Another tab says a chain was made; the list under the pointer does not move.
    await other.evaluate(() => {
        const channel = new BroadcastChannel('nse-local-data')
        channel.postMessage({ type: 'sessionUpdated' })
        channel.close()
    })
    await expect(rowsOf(page)).toHaveCount(before)
    // The message has been heard once the pointer leaves.
    await page.mouse.move(5, 5)
    await expect(rowsOf(page)).toHaveCount(before + 1)
    await expect(rowsOf(page).nth(0)).toContainText('Omega')
})

test('a message from another tab refreshes a list nothing holds', async ({ page, context }) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await page.mouse.move(5, 5)
    const before = await rowsOf(page).count()
    const other = await otherTab(context)
    await newSession(other)
    await edit(other, { title: 'Omega', life: 940 })
    await flush(other)
    await other.evaluate(() => {
        const channel = new BroadcastChannel('nse-local-data')
        channel.postMessage({ type: 'sessionUpdated' })
        channel.close()
    })
    await expect(rowsOf(page)).toHaveCount(before + 1)
})

test('a session deleted since the list was drawn says so when restored', async ({
    page,
    context,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await rowFor(page, 'Alpha').hover()
    const other = await context.newPage()
    await other.goto('/privacy/')
    await other.evaluate(
        (chainId) =>
            new Promise<void>((resolve, reject) => {
                const open = indexedDB.open('nse-local-data')
                open.onsuccess = () => {
                    const tx = open.result.transaction('chains', 'readwrite')
                    const store = tx.objectStore('chains')
                    const get = store.get(chainId)
                    get.onsuccess = () => store.put({ ...get.result, deleting: { at: Date.now() } })
                    tx.oncomplete = () => {
                        open.result.close()
                        resolve()
                    }
                    tx.onerror = () => reject(tx.error ?? new Error('Not marked'))
                }
                open.onerror = () => reject(open.error ?? new Error('Not opened'))
            }),
        alpha.chainId,
    )
    await closePage(other, { runBeforeUnload: false })
    await rowFor(page, 'Alpha').focus()
    await page.keyboard.press('Enter')
    await expect(notice(page, messages.load.sessionDeleted)).toBeVisible()
    expect(await lifeOf(page)).toBe(1000)
})

test('a session written by a newer version is listed but cannot be peeked or restored', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await page.evaluate(
        (sessionId) =>
            new Promise<void>((resolve, reject) => {
                const open = indexedDB.open('nse-local-data')
                open.onsuccess = () => {
                    const tx = open.result.transaction('sessions', 'readwrite')
                    const store = tx.objectStore('sessions')
                    const get = store.get(sessionId)
                    get.onsuccess = () => store.put({ ...get.result, v: 999 })
                    tx.oncomplete = () => {
                        open.result.close()
                        resolve()
                    }
                    tx.onerror = () => reject(tx.error ?? new Error('Not changed'))
                }
                open.onerror = () => reject(open.error ?? new Error('Not opened'))
            }),
        alpha.sessionId,
    )
    await openSessions(page)
    const row = rowFor(page, 'Alpha')
    await expect(row.locator('[data-sessions-caption]')).toContainText(messages.history.needsNewer)
    await row.click()
    await expect(peekBar(page)).toHaveCount(0)
    await row.locator('[data-sessions-more]').click()
    const items = page.getByRole('menuitem')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toBeDisabled()
    await expect(items.nth(1)).toBeDisabled()
    // Delete is the user's own act and works on any chain; the others say why they are off.
    await expect(items.nth(2)).toBeEnabled()
    await expect(page.getByRole('menu').getByText(messages.load.sessionLater)).toHaveCount(1)
})

test('moving onto a row that cannot be peeked (arrow, click, ⋯) leaves the previous row’s peek', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await closedChain(page, { title: 'Beta', life: 980 })
    await page.evaluate(
        (sessionId) =>
            new Promise<void>((resolve, reject) => {
                const open = indexedDB.open('nse-local-data')
                open.onsuccess = () => {
                    const tx = open.result.transaction('sessions', 'readwrite')
                    const store = tx.objectStore('sessions')
                    const get = store.get(sessionId)
                    get.onsuccess = () => store.put({ ...get.result, v: 999 })
                    tx.oncomplete = () => {
                        open.result.close()
                        resolve()
                    }
                    tx.onerror = () => reject(tx.error ?? new Error('Not changed'))
                }
                open.onerror = () => reject(open.error ?? new Error('Not opened'))
            }),
        alpha.sessionId,
    )
    await openSessions(page)
    await rowFor(page, 'Beta').click()
    await expect.poll(() => peekedLife(page)).toBe(980)
    await expect(peekBar(page)).toHaveCount(1)
    // Newest first: Alpha, which needs a newer version, is the row below.
    await page.keyboard.press('ArrowDown')
    await expect(rowFor(page, 'Alpha')).toBeFocused()
    await expect(peekBar(page)).toHaveCount(0)
    expect(await lifeOf(page)).toBe(1000)
    // A click and the ⋯ menu on that row leave no earlier peek either.
    await rowFor(page, 'Beta').click()
    await expect.poll(() => peekedLife(page)).toBe(980)
    await rowFor(page, 'Alpha').click()
    await expect(peekBar(page)).toHaveCount(0)
    await rowFor(page, 'Beta').click()
    await expect.poll(() => peekedLife(page)).toBe(980)
    await rowFor(page, 'Alpha').locator('[data-sessions-more]').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(peekBar(page)).toHaveCount(0)
    expect(await lifeOf(page)).toBe(1000)
})

test('Save to File… of a closed session opens the save dialog for it', async ({ page }) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await rowFor(page, 'Alpha').locator('[data-sessions-more]').click()
    await page.getByRole('menuitem', { name: sessions.saveToFile }).click()
    await expect(page.getByRole('dialog', { name: /Save/ }).last()).toBeVisible()
})

test('a session’s peek ends with the tab, and offers no Find Edits Here', async ({ page }) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await rowFor(page, 'Alpha').click()
    await expect.poll(() => peekedLife(page)).toBe(990)
    // Another chain’s chart says nothing of this Timeline’s beats.
    await page.locator('[data-history-surface="dialog"] [data-history-close]').click()
    await page.mouse.click(800, 500, { button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(
        page.getByRole('menuitem', { name: messages.commands.editsHere.title }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+H')
    await page.getByRole('tab', { name: messages.history.timeline }).click()
    await expect(peekBar(page)).toHaveCount(0)
})

test('opening the ⋯ menu of a row peeks that row, and the menu names its chain', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await closedChain(page, { title: 'Beta', life: 980 })
    await openSessions(page)
    await rowFor(page, 'Alpha').click()
    await expect.poll(() => peekedLife(page)).toBe(990)
    // The menu of another row moves the peek there, so focus and peek stay on one row.
    await rowFor(page, 'Beta').locator('[data-sessions-more]').click()
    await expect.poll(() => peekedLife(page)).toBe(980)
    await expect(rowFor(page, 'Beta')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('menu')).toContainText('Beta')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(rowFor(page, 'Beta')).toBeFocused()
})
