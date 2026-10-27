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
    placeTap,
    reloadAndWait,
    selectNote,
} from './historyJourney'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

// Delete in Recent Sessions: the ⋯ menu and the Delete key mark a chain, and its
// row becomes an inline Undo row (the Node tests of `sessionDelete` pin the state machine; what
// is checked here is the row, the live region, focus and the real worker); Delete is refused for a
// chain open in another tab or held by this tab's unstored copy.

const messages = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english
const { sessions } = messages.history

test.afterEach(({ page }) => {
    noErrors(page)
})

type Edit = { title: string; life: number }

const edit = (page: Page, { title, life }: Edit) =>
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

const newSession = (page: Page) =>
    page.evaluate(() => {
        window.editorTest.history.resetState(false)
    })

const flushIds = (page: Page) =>
    page.evaluate(() => {
        const session = window.nseFlushTest!.flusher.session!
        return { sessionId: session.id, chainId: session.chainId }
    })

/** A stored chain, closed: the page ends on a blank session. */
const closedChain = async (page: Page, each: Edit) => {
    await edit(page, each)
    await flush(page)
    const ids = await flushIds(page)
    await newSession(page)
    return ids
}

const lifeOf = (page: Page) =>
    page.evaluate(() => window.editorTest.history.state.value.initialLife)

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
    page.locator('[data-sessions-row]:not([data-sessions-deleted])').filter({
        has: page.getByText(title, { exact: true }),
    })
const deletedRows = (page: Page) => page.locator('[data-sessions-deleted]')
const deletedFor = (page: Page, title: string): Locator =>
    deletedRows(page).filter({ hasText: `Deleted "${title}"` })

const card = (page: Page, text: string | RegExp) => notice(page, text)

/** Runs a change on the stored rows of the page's profile, as another build or a stray write would. */
const tamper = (page: Page, store: string, key: string, change: 'newer' | 'noHead') =>
    page.evaluate(
        ({ store, key, change }) =>
            new Promise<void>((resolve, reject) => {
                const open = indexedDB.open('nse-local-data')
                open.onsuccess = () => {
                    const tx = open.result.transaction(store, 'readwrite')
                    const rows = tx.objectStore(store)
                    const get = rows.get(key)
                    get.onsuccess = () => {
                        const row = { ...(get.result as Record<string, unknown>) }
                        if (change === 'newer') row.v = 999
                        else delete row.head
                        rows.put(row)
                    }
                    tx.oncomplete = () => {
                        open.result.close()
                        resolve()
                    }
                    tx.onerror = () => reject(tx.error ?? new Error('Not changed'))
                }
                open.onerror = () => reject(open.error ?? new Error('Not opened'))
            }),
        { store, key, change },
    )

/** Whether the chain's record is in storage, read from IndexedDB itself. */
const stored = (page: Page, chainId: string) =>
    page.evaluate(
        (chainId) =>
            new Promise<boolean>((resolve, reject) => {
                const open = indexedDB.open('nse-local-data')
                open.onsuccess = () => {
                    const get = open.result
                        .transaction('chains', 'readonly')
                        .objectStore('chains')
                        .get(chainId)
                    get.onsuccess = () => {
                        open.result.close()
                        resolve(get.result !== undefined)
                    }
                    get.onerror = () => reject(get.error ?? new Error('Not read'))
                }
                open.onerror = () => reject(open.error ?? new Error('Not opened'))
            }),
        chainId,
    )

const sweep = (page: Page) => page.evaluate(() => window.nseStorageTest!.sweepDeleted!(0))

const notesIn = (page: Page) =>
    page.evaluate(() => {
        let count = 0
        for (const notes of window.editorTest.history.state.value.store.slides.note.values())
            count += notes.length
        return count
    })

test('Delete from the menu turns the row into an inline Undo row; its Undo brings it back', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await closedChain(page, { title: 'Beta', life: 980 })
    await openSessions(page)

    await rowFor(page, 'Alpha').locator('[data-sessions-more]').click()
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem')).toHaveText([
        messages.open.restoreIt,
        sessions.saveToFile,
        sessions.delete,
    ])
    // The menu names its chain.
    await expect(menu).toContainText('Alpha')
    await menu.getByRole('menuitem', { name: sessions.delete }).click()

    // The row stands in its place as "Deleted" with its Undo, and a live region says so. The list
    // is on screen, so no notice repeats it.
    await expect(rowFor(page, 'Alpha')).toHaveCount(0)
    const inline = deletedFor(page, 'Alpha')
    await expect(inline).toHaveCount(1)
    await expect(rowsOf(page).nth(1)).toHaveAttribute('data-sessions-deleted', '')
    await expect(page.locator('[data-sessions-live]')).toHaveText('Deleted "Alpha"')
    await expect(page.locator('[data-notice-card]')).toHaveCount(0)
    expect(await stored(page, alpha.chainId)).toBe(true)

    await inline.getByRole('button', { name: messages.commands.undo.title }).click()
    await expect(deletedRows(page)).toHaveCount(0)
    await expect(rowFor(page, 'Alpha')).toHaveCount(1)
    // The row is back where it was.
    await expect(rowsOf(page).nth(1)).toContainText('Alpha')
})

test('the Delete key deletes the focused row, focus moves to the next real row, three presses delete three, and a held key deletes one', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    for (const [title, life] of [
        ['Alpha', 990],
        ['Beta', 980],
        ['Gamma', 970],
        ['Delta', 960],
    ] as const)
        await closedChain(page, { title, life })
    await openSessions(page)

    // Delta is the first row. A held key deletes it once: its repeats, which reach the next row
    // once focus has moved on, start no Delete (each one would read the chain first).
    await page.evaluate(async () => {
        const { storageWorker } =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const worker = storageWorker!
        const original = worker.call.bind(worker)
        Reflect.set(window, 'deleteReads', 0)
        worker.call = ((...args: Parameters<typeof original>) => {
            if (args[0] === 'deleteTarget')
                Reflect.set(window, 'deleteReads', Number(Reflect.get(window, 'deleteReads')) + 1)
            return original(...args)
        }) as typeof worker.call
    })
    await rowFor(page, 'Delta').focus()
    await page.keyboard.down('Delete')
    await expect(deletedFor(page, 'Delta')).toHaveCount(1)
    await expect(rowFor(page, 'Gamma')).toBeFocused()
    await page.keyboard.down('Delete')
    await page.keyboard.down('Delete')
    await page.keyboard.up('Delete')
    expect(await page.evaluate(() => Reflect.get(window, 'deleteReads'))).toBe(1)
    await expect(deletedRows(page)).toHaveCount(1)
    // Focus went to the next row, so the next press deletes it.
    await expect(rowFor(page, 'Gamma')).toBeFocused()
    await page.keyboard.press('Delete')
    await expect(deletedFor(page, 'Gamma')).toHaveCount(1)
    await expect(rowFor(page, 'Beta')).toBeFocused()
    await page.keyboard.press('Delete')
    await expect(deletedRows(page)).toHaveCount(3)
    // No notice for any of them; each row has its own Undo.
    await expect(page.locator('[data-notice-card]')).toHaveCount(0)
    for (const title of ['Delta', 'Gamma', 'Beta'])
        await deletedFor(page, title)
            .getByRole('button', { name: messages.commands.undo.title })
            .click()
    await expect(deletedRows(page)).toHaveCount(0)
    for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta'])
        await expect(rowFor(page, title)).toHaveCount(1)
})

test('an inline row is reached by the arrow keys, Enter or Space undoes it, and Delete does nothing on it', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await closedChain(page, { title: 'Beta', life: 980 })
    await openSessions(page)
    await rowFor(page, 'Beta').focus()
    await page.keyboard.press('Delete')
    await expect(deletedFor(page, 'Beta')).toHaveCount(1)
    // Focus went on to Alpha; the arrow back reaches the inline row without peeking.
    await expect(rowFor(page, 'Alpha')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(deletedFor(page, 'Beta')).toBeFocused()
    await expect(page.locator('[data-peek-bar]')).toHaveCount(0)
    // Delete and a held key do nothing on it; the row has no menu.
    await page.keyboard.press('Delete')
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(deletedRows(page)).toHaveCount(1)
    await expect(rowFor(page, 'Alpha')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(deletedRows(page)).toHaveCount(0)
    await expect(rowFor(page, 'Beta')).toHaveCount(1)

    // Space undoes an inline row too; its button does the same.
    await rowFor(page, 'Beta').focus()
    await page.keyboard.press('Delete')
    await expect(deletedFor(page, 'Beta')).toHaveCount(1)
    await page.keyboard.press('ArrowUp')
    await expect(deletedFor(page, 'Beta')).toBeFocused()
    await page.keyboard.press('Space')
    await expect(deletedRows(page)).toHaveCount(0)
    await rowFor(page, 'Alpha').locator('[data-sessions-more]').click()
    await page.getByRole('menuitem', { name: sessions.delete }).click()
    await deletedFor(page, 'Alpha')
        .getByRole('button', { name: messages.commands.undo.title })
        .click()
    await expect(rowFor(page, 'Alpha')).toHaveCount(1)
})

test('Delete is refused for a chain open in another tab, with its reason in the menu', async ({
    page,
    context,
}) => {
    errorsFail(page)
    await load(page)
    await edit(page, { title: 'Alpha', life: 990 })
    await flush(page)
    const alpha = await flushIds(page)
    const other = await otherTab(context)
    await openSessions(other)

    await rowFor(other, 'Alpha').locator('[data-sessions-more]').click()
    const menu = other.getByRole('menu')
    const item = menu.getByRole('menuitem', { name: sessions.delete })
    await expect(item).toBeDisabled()
    await expect(menu).toContainText(sessions.openReason)
    await expect(item).toHaveAttribute('aria-describedby', /.+/)
    await other.keyboard.press('Escape')

    // The key is refused by the core, which asks the locks, not the badge.
    await rowFor(other, 'Alpha').focus()
    await other.keyboard.press('Delete')
    await expect(card(other, 'Not deleted. "Alpha" is in use in a tab or window.')).toBeVisible()
    await expect(deletedRows(other)).toHaveCount(0)
    await expect(rowFor(other, 'Alpha')).toHaveCount(1)
    expect(await stored(other, alpha.chainId)).toBe(true)
    expect(await lifeOf(page)).toBe(990)
})

// A copy keeps its parent held until its first write, so the refusal is not about another tab.
test('Delete is refused while this tab’s unstored copy holds the chain, in words that fit', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await page.evaluate(async (sessionId) => {
        const { restoreCopy } =
            await window.editorTest.appImport<typeof import('../../src/editor/switch')>(
                '/src/editor/switch.ts',
            )
        await restoreCopy(sessionId)
    }, alpha.sessionId)
    expect(await lifeOf(page)).toBe(990)
    await openSessions(page)
    await rowFor(page, 'Alpha').focus()
    await page.keyboard.press('Delete')
    await expect(card(page, 'Not deleted. "Alpha" is in use in a tab or window.')).toBeVisible()
    await expect(deletedRows(page)).toHaveCount(0)
    expect(await stored(page, alpha.chainId)).toBe(true)
})

test('the Delete key works only in the list: the chart’s Delete deletes the note, the list’s the chain', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await placeTap(page, { lane: 0, beat: 2 })
    await selectNote(page, { lane: 0, beat: 2 })
    expect(await notesIn(page)).toBe(1)
    await openSessions(page)

    // In the list the key deletes the chain and leaves the selected note alone.
    await rowFor(page, 'Alpha').focus()
    await page.keyboard.press('Delete')
    await expect(deletedFor(page, 'Alpha')).toHaveCount(1)
    expect(await notesIn(page)).toBe(1)
    await expect
        .poll(() =>
            page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
        )
        .toBe(1)
    await deletedFor(page, 'Alpha')
        .getByRole('button', { name: messages.commands.undo.title })
        .click()

    // On the chart the same key deletes the note and no chain.
    await page.locator('[data-history-surface="dialog"] [data-history-close]').click()
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('Delete')
    await expect.poll(() => notesIn(page)).toBe(0)
    await page.keyboard.press('Shift+H')
    await expect(page.locator('[data-recent-sessions]')).toBeVisible()
    await expect(rowFor(page, 'Alpha')).toHaveCount(1)
    await expect(deletedRows(page)).toHaveCount(0)
    expect(await stored(page, alpha.chainId)).toBe(true)
})

test('Undo after the sweep says the chain can no longer be undone', async ({ page }) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await rowFor(page, 'Alpha').focus()
    await page.keyboard.press('Delete')
    await expect(deletedFor(page, 'Alpha')).toHaveCount(1)
    // The sweep runs 10 minutes on; a spec runs it now.
    await sweep(page)
    expect(await stored(page, alpha.chainId)).toBe(false)

    await deletedFor(page, 'Alpha')
        .getByRole('button', { name: messages.commands.undo.title })
        .click()
    // The inline row says so, with no Undo left, and the live region reads it.
    await expect(deletedRows(page)).toContainText(
        'Deleted “Alpha”. This deletion can no longer be undone.',
    )
    await expect(page.locator('[data-sessions-live]')).toHaveText(
        'Deleted “Alpha”. This deletion can no longer be undone.',
    )
    await expect(deletedRows(page).getByRole('button')).toHaveCount(0)
    await expect(rowFor(page, 'Alpha')).toHaveCount(0)
})

test('a kill between the mark and the sweep: after a reload the chain never shows, and the sweep removes it', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await rowFor(page, 'Alpha').focus()
    await page.keyboard.press('Delete')
    await expect(deletedFor(page, 'Alpha')).toHaveCount(1)

    await reloadAndWait(page)
    // Marked in storage: still stored, never listed.
    expect(await stored(page, alpha.chainId)).toBe(true)
    await openSessions(page)
    await expect(page.getByText('Alpha', { exact: true })).toHaveCount(0)
    await sweep(page)
    expect(await stored(page, alpha.chainId)).toBe(false)
})

test('Undo with storing failing says it could not undo, and Try Again works once it is back', async ({
    page,
}) => {
    errorsFail(page, { allow: [/held undoDeleting call failed/] })
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await rowFor(page, 'Alpha').focus()
    await page.keyboard.press('Delete')
    await expect(deletedFor(page, 'Alpha')).toHaveCount(1)

    const hold = await holdWorker(page, 'undoDeleting')
    await deletedFor(page, 'Alpha')
        .getByRole('button', { name: messages.commands.undo.title })
        .click()
    await hold.reached()
    await hold.release(true)
    // The row itself says it failed and offers Try Again for the same Delete.
    const failed = deletedFor(page, 'Alpha')
    await expect(failed.locator('[data-sessions-undo-failed]')).toHaveText('Could not undo')
    await failed.getByRole('button', { name: messages.history.tryAgain }).click()
    await expect(rowFor(page, 'Alpha')).toHaveCount(1)
    await expect(deletedRows(page)).toHaveCount(0)
})

test('a failed Delete is reported and leaves the row', async ({ page }) => {
    errorsFail(page, { allow: [/held markDeleting call failed/] })
    await load(page)
    await closedChain(page, { title: 'Alpha', life: 990 })
    await openSessions(page)
    await rowFor(page, 'Alpha').focus()
    const hold = await holdWorker(page, 'markDeleting')
    await page.keyboard.press('Delete')
    await hold.reached()
    await hold.release(true)
    await expect(card(page, '"Alpha" could not be deleted.')).toBeVisible()
    await expect(rowFor(page, 'Alpha')).toHaveCount(1)
    await expect(deletedRows(page)).toHaveCount(0)
})

test('a row that needs a newer version is deleted, though it cannot be restored or saved', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    await tamper(page, 'sessions', alpha.sessionId, 'newer')
    await openSessions(page)
    const row = rowFor(page, 'Alpha')
    await expect(row.locator('[data-sessions-caption]')).toContainText(messages.history.needsNewer)
    await row.locator('[data-sessions-more]').click()
    const items = page.getByRole('menuitem')
    await expect(items).toHaveText([messages.open.restoreIt, sessions.saveToFile, sessions.delete])
    await expect(items.nth(0)).toBeDisabled()
    await expect(items.nth(1)).toBeDisabled()
    await expect(items.nth(2)).toBeEnabled()
    // The reason is said once, under Restore.
    await expect(page.getByRole('menu').getByText(messages.load.sessionLater)).toHaveCount(1)
    await items.nth(2).click()
    await expect(deletedFor(page, 'Alpha')).toHaveCount(1)
    await sweep(page)
    expect(await stored(page, alpha.chainId)).toBe(false)
})

test('a damaged row, one with no head, is deleted from its menu or by the key', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    const alpha = await closedChain(page, { title: 'Alpha', life: 990 })
    const beta = await closedChain(page, { title: 'Beta', life: 980 })
    await tamper(page, 'chains', alpha.chainId, 'noHead')
    await tamper(page, 'chains', beta.chainId, 'noHead')
    await openSessions(page)
    const row = rowFor(page, 'Alpha')
    await expect(row.locator('[data-sessions-caption]')).toContainText(messages.history.damaged)
    // It cannot be restored or saved: the menu holds Delete alone.
    await row.locator('[data-sessions-more]').click()
    await expect(page.getByRole('menuitem')).toHaveText([sessions.delete])
    await page.getByRole('menuitem', { name: sessions.delete }).click()
    await expect(deletedFor(page, 'Alpha')).toHaveCount(1)
    await rowFor(page, 'Beta').focus()
    await page.keyboard.press('Delete')
    await expect(deletedFor(page, 'Beta')).toHaveCount(1)
    await sweep(page)
    expect(await stored(page, alpha.chainId)).toBe(false)
    expect(await stored(page, beta.chainId)).toBe(false)
})

test('a fork whose parent chain was deleted ends its Timeline with a line, and Restore Session of the fork works', async ({
    page,
    context,
}) => {
    errorsFail(page)
    await load(page)
    await edit(page, { title: 'Alpha', life: 990 })
    await flush(page)
    const alpha = await flushIds(page)
    // A second tab finds Alpha open elsewhere and makes a copy of it: a fork of Alpha.
    const other = await otherTab(context)
    await openSessions(other)
    await rowFor(other, 'Alpha').locator('[data-sessions-more]').click()
    await other.getByRole('menuitem', { name: messages.load.restoreAsCopy }).click()
    await expect(notice(other, 'Restored a copy of "Alpha"')).toBeVisible()
    await expect.poll(() => lifeOf(other)).toBe(990)
    await edit(other, { title: 'Alpha', life: 950 })
    await flush(other)
    const copy = await flushIds(other)
    expect(copy.chainId).not.toBe(alpha.chainId)
    // The Timeline has read the copy's edit back as stored, so it holds Alpha's rows below it.
    await expect
        .poll(() =>
            other.evaluate(async (sessionId) => {
                const { entries } = await window.editorTest.appImport<
                    typeof import('../../src/editor/history/source')
                >('/src/editor/history/source.ts')
                const newest = entries.value[0]
                return {
                    newest: newest && { sessionId: newest.sessionId, pending: !!newest.pending },
                    parent: entries.value.some((entry) => entry.sessionId === sessionId),
                }
            }, alpha.sessionId),
        )
        .toEqual({ newest: { sessionId: copy.sessionId, pending: false }, parent: true })
    // The first tab lets go of Alpha, and Alpha is deleted and swept.
    await closePage(page, { runBeforeUnload: false })
    await other.getByRole('tab', { name: messages.history.recentSessions }).click()
    const byChain = (id: string) => other.locator(`[data-sessions-row][data-chain="${id}"]`)
    await expect(byChain(alpha.chainId)).toBeVisible()
    await expect(byChain(alpha.chainId).locator('[data-sessions-badge]')).toHaveCount(0)
    await byChain(alpha.chainId).focus()
    await other.keyboard.press('Delete')
    await expect(deletedRows(other)).toHaveCount(1)
    await sweep(other)
    expect(await stored(other, alpha.chainId)).toBe(false)

    // The fork's Timeline ends at its divider, with the line.
    await other.getByRole('tab', { name: messages.history.timeline }).click()
    await expect(other.locator('[data-history-end]')).toHaveText(messages.history.earlierNotStored)
    await expect(other.locator('[data-history-continuation]')).toHaveCount(1)

    // Restore Session of the fork works from another session.
    await newSession(other)
    await other.getByRole('tab', { name: messages.history.recentSessions }).click()
    await expect(byChain(copy.chainId)).toBeVisible()
    await byChain(copy.chainId).focus()
    await other.keyboard.press('Enter')
    await expect.poll(() => lifeOf(other)).toBe(950)
    expect((await flushIds(other)).chainId).toBe(copy.chainId)
})

test('Help names the menu key for rows and where unsaved work is', async ({ page }) => {
    errorsFail(page)
    await load(page)
    await page.evaluate(async () => {
        const { commands } =
            (await import('/src/editor/commands/index.ts')) as typeof import('../../src/editor/commands')
        const { runCommand } =
            (await import('/src/editor/commands/runCommand.ts')) as typeof import('../../src/editor/commands/runCommand')
        await runCommand(commands.help, 'button')
    })
    const help = page.getByRole('dialog', { name: messages.help.modal.title })
    await expect(help).toContainText(messages.help.shiftF10)
    await expect(help).toContainText(messages.help.recentSessions)
})
