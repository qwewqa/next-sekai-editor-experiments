import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type english from '../../src/i18n/en/index.json'
import { waitForStartup } from './editorFixture'
import {
    chartOf,
    closePage,
    errorsFail,
    flush,
    liveOf,
    load,
    noErrors,
    notice,
    openHistory,
    peekRow,
    placeTap,
    restoreFromStrip,
    rowTitles,
    timeline,
} from './historyJourney'

// Two tabs and continuation (D2 plan §3.3, F3 and F4): each tab's Timeline lists its own
// session's rows, a fork or a continuation divides from what it came from, and one tab's History
// never reaches the other.

const messages = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english

/** A divider's text in `rowsAndDividers`, up to the time. */
const dividerPrefix = `| ${messages.history.continuedFrom.replace('{0}', '')}`

const tabKey = 'sonolus-next-sekai-editor.tab'

/** A page of the context that takes over another tab's sessionStorage, as Duplicate Tab does. */
const withTabRecord = async (context: BrowserContext, record: string) => {
    const page = await context.newPage()
    await page.addInitScript(
        ({ key, record }) => {
            if (!sessionStorage.getItem('copied')) {
                sessionStorage.setItem(key, record)
                sessionStorage.setItem('copied', 'true')
            }
        },
        { key: tabKey, record },
    )
    return page
}

const tabRecord = (page: Page) =>
    page.evaluate((key) => sessionStorage.getItem(key), tabKey) as Promise<string>

const claimOf = (page: Page) => page.evaluate(() => window.nseStartupTest?.claim)

/**
 * `window.editorTest` for a page that kept the session it opened: the fixture would replace it
 * with a chart of its own. Only what the specs here use.
 */
const installApp = async (page: Page) => {
    await page.evaluate(async () => {
        const moduleUrls = new Map(
            performance
                .getEntriesByType('resource')
                .map((entry) => [new URL(entry.name).pathname, entry.name]),
        )
        const appImport = <T>(pathname: string): Promise<T> =>
            import(moduleUrls.get(pathname) ?? pathname)
        const history = await appImport<typeof import('../../src/history')>('/src/history/index.ts')
        const historySteps = await appImport<typeof import('../helpers/historySteps')>(
            '/tests/helpers/historySteps.ts',
        )
        window.editorTest = {
            appImport,
            history,
            historySteps,
        } as unknown as typeof window.editorTest
    })
}

/** Duplicates the tab: a new page that opens with the tab's record, as the browser's Duplicate Tab. */
const duplicate = async (context: BrowserContext, page: Page) => {
    const copy = await withTabRecord(context, await tabRecord(page))
    errorsFail(copy)
    await copy.goto('/')
    await expect(copy.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(copy)
    expect(await claimOf(copy)).toBe('duplicate')
    await installApp(copy)
    return copy
}

/** Pushes `count` steps titled "<tag> <n>". */
const edits = (page: Page, tag: string, count: number) =>
    page.evaluate(
        ({ tag, count }) => {
            const { history, historySteps } = window.editorTest
            for (let i = 1; i <= count; i++) {
                const life = history.state.value.initialLife
                history.pushState(historySteps.futureInitialLife(life, life + 1, `${tag} ${i}`), {
                    ...history.state.value,
                    initialLife: life + 1,
                })
            }
        },
        { tag, count },
    )

/** The Timeline's rows and continuation dividers top down: a row's title, a divider's text. */
const rowsAndDividers = (page: Page) =>
    timeline(page).evaluate((list) =>
        [...list.querySelectorAll('[data-history-row], [data-history-continuation]')]
            .map((element) => ({ element, top: parseFloat((element as HTMLElement).style.top) }))
            .sort((a, b) => a.top - b.top)
            .map(({ element }) =>
                element.hasAttribute('data-history-continuation')
                    ? `| ${(element.textContent ?? '').trim()}`
                    : (
                          element.querySelector('[data-history-group-action]') ??
                          element.querySelector('.timeline-entry-text')
                      )?.textContent
                          ?.replace(/\s+/g, ' ')
                          .trim(),
            ),
    )

/** Opens the History tab on the right dock: the Timeline beside the chart. */
const openPanel = async (page: Page) => {
    await page
        .locator('[data-workspace-dock="right"]')
        .getByRole('tab', { name: 'History', exact: false })
        .click()
    await expect(page.locator('[data-history-surface="panel"]')).toBeVisible()
    await expect(timeline(page, 'panel').getByRole('row', { name: /^Now/ })).toBeVisible()
}

/** Records every notice the page shows, so one that came and went is still counted. */
const recordNotices = (page: Page) =>
    page.evaluate(() => {
        const seen: string[] = []
        ;(window as unknown as { seenNotices: string[] }).seenNotices = seen
        new MutationObserver((records) => {
            for (const record of records)
                for (const node of record.addedNodes)
                    if (node instanceof HTMLElement)
                        for (const found of [node, ...node.querySelectorAll('*')])
                            if (
                                found.matches('.notification, .notification-pill') &&
                                found.textContent
                            )
                                seen.push(found.textContent.trim())
        }).observe(document.body, { childList: true, subtree: true })
    })

const seenNotices = (page: Page) =>
    page.evaluate(() => (window as unknown as { seenNotices: string[] }).seenNotices)

test('F3: a duplicated tab forks with a divider, and nothing it does reaches the first tab', async ({
    page,
    context,
}) => {
    errorsFail(page)
    await load(page)
    await placeTap(page, { lane: -2, beat: 1 })
    await placeTap(page, { lane: 0, beat: 2 })
    await flush(page)
    const original = await liveOf(page)
    expect(original.notes).toHaveLength(2)
    await openPanel(page)
    await recordNotices(page)
    const aRows = await rowTitles(page, 'panel')

    const b = await duplicate(context, page)
    await edits(b, 'B', 2)
    await flush(b)
    await openHistory(b)
    const listed = await rowsAndDividers(b)
    const at = listed.findIndex((text) => text?.startsWith('| '))
    expect(listed.slice(0, at)).toEqual([expect.stringMatching(/^Now/), 'B 2', 'B 1'])
    expect(listed[at]?.startsWith(dividerPrefix)).toBe(true)
    // Below the divider: the first tab's rows from before the fork.
    expect(listed.slice(at + 1)).toEqual(aRows.slice(1))

    // The first tab's row, peeked: its state; then restored.
    await peekRow(b, aRows[1]!)
    expect(await chartOf(b)).toEqual(original)
    await restoreFromStrip(b)
    await flush(b)
    expect(await liveOf(b)).toEqual(original)

    // Meanwhile the first tab: the same rows, the same chart, and no notice of its own.
    await expect.poll(() => rowTitles(page, 'panel')).toEqual(aRows)
    expect(await liveOf(page)).toEqual(original)
    // A step of its own, after everything the other tab did: the only notice is that step's.
    await page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body) active.blur()
    })
    await page.keyboard.press('z')
    await expect(notice(page, 'Undid')).toBeVisible()
    expect(await seenNotices(page)).toEqual([expect.stringMatching(/^Undid "/)])
    noErrors(page)
    noErrors(b)
})

/**
 * The stored entries of the open session's chain as the Timeline reads them, newest session first:
 * each session's entry kinds in order, up to the entry the next session continued.
 */
const chainKinds = (page: Page) =>
    page.evaluate(async () => {
        const found = (await window.nseStorageTest!.worker.call('testRows', [
            'entries',
            'sessions',
        ])) as Record<string, { value: Record<string, unknown> }[]>
        const sessions = new Map(found.sessions!.map(({ value }) => [value.id as string, value]))
        const { sessionId } = (
            await window.editorTest.appImport<typeof import('../../src/history/session')>(
                '/src/history/session.ts',
            )
        ).session.value
        const chain: { id: string; kinds: string[] }[] = []
        let upto = Infinity
        for (let id: string | undefined = sessionId; id;) {
            const own = id
            const limit = upto
            chain.push({
                id: own,
                kinds: found
                    .entries!.map(({ value }) => value)
                    .filter((row) => row.sessionId === own && (row.seq as number) <= limit)
                    .sort((a, b) => (a.seq as number) - (b.seq as number))
                    .map((row) => row.kind as string),
            })
            const parent = sessions.get(id)?.parent as { id: string; uptoSeq: number } | undefined
            id = parent?.id
            upto = parent?.uptoSeq ?? Infinity
        }
        return chain
    })

test('F4: a new visit continues with a divider, its earlier rows peek and restore, and Go To counts both visits', async ({
    page,
    context,
}) => {
    errorsFail(page)
    await load(page)
    await placeTap(page, { lane: -2, beat: 1 })
    await placeTap(page, { lane: 0, beat: 2 })
    await flush(page)
    const earlier = await liveOf(page)
    expect(earlier.notes).toHaveLength(2)
    await closePage(page, { runBeforeUnload: false })

    const next = await context.newPage()
    errorsFail(next)
    await next.goto('/')
    await expect(next.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(next)
    expect(await claimOf(next)).toBe('none')
    await installApp(next)
    // The new visit adds nothing until its first edit, which begins with the "Continued" entry.
    expect(await liveOf(next)).toEqual(earlier)
    await edits(next, 'Visit 2', 1)
    await flush(next)
    const before = await liveOf(next)
    await openHistory(next)
    const listed = await rowsAndDividers(next)
    const at = listed.findIndex((text) => text?.startsWith('| '))
    expect(listed.slice(0, at)).toEqual([expect.stringMatching(/^Now/), 'Visit 2 1'])
    expect(listed[at]?.startsWith(dividerPrefix)).toBe(true)
    expect(listed.slice(at + 1)).toEqual(['Added 2 notes', 'Imported a level'])

    // A row below the divider: its state, then Restore, then Undo back to where the visit was.
    await peekRow(next, 'Added 2 notes')
    expect(await chartOf(next)).toEqual(earlier)
    await restoreFromStrip(next)
    expect(await liveOf(next)).toEqual(earlier)
    await flush(next)
    await next.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body) active.blur()
    })
    await next.keyboard.press('z')
    await expect.poll(() => liveOf(next)).toEqual(before)
    await flush(next)

    // Go To lists each visit on its day, each with the steps storage holds for it.
    const sessions = await chainKinds(next)
    expect(sessions).toHaveLength(2)
    // History is still open beside the chart: a sheet leaves the editor's keys working.
    await expect(timeline(next)).toBeVisible()
    await next.locator('[data-history-surface="dialog"] [data-history-goto-button]').click()
    const items = next.locator('[data-history-goto] [data-goto-item]')
    // Now, today with all the steps, then each visit's share of it.
    await expect(items).toHaveCount(2 + sessions.length)
    await expect(items.first()).toHaveAttribute('aria-current', 'location')
    // A "Continued from" divider is not a step, so Go To does not count it.
    const stepsIn = (kinds: string[]) => kinds.filter((kind) => kind !== 'continue').length
    const steps = (count: number) => (count === 1 ? '1 step' : `${count} steps`)
    await expect(items.nth(1)).toContainText(messages.history.today)
    await expect(items.nth(1)).toContainText(
        steps(sessions.reduce((total, { kinds }) => total + stepsIn(kinds), 0)),
    )
    for (const [i, { kinds }] of sessions.entries())
        await expect(items.nth(i + 2)).toContainText(steps(stepsIn(kinds)))
    noErrors(next)
})
