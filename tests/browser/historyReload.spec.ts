import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type english from '../../src/i18n/en/index.json'
import { useTool, waitForStartup } from './editorFixture'
import {
    backToNow,
    chartOf,
    dragNote,
    errorsFail,
    flush,
    holdWorker,
    liveOf,
    load,
    openHistory,
    peekRow,
    placeTap,
    release,
    reloadAndWait,
    restoreFromStrip,
    rowLabels,
    rowTitles,
    timeline,
    timelineRead,
} from './historyJourney'
import { pressSave, readFile, submitSave } from './saveFlows'

// D2 package P2: reload, lazy slots, queued moves and recovery (testplan/plan.md §3.2, R1 to R6).
// After a reload the stack holds only its head and the head's neighbours (the rest are stored
// roots), so Undo and Redo past them wait for the storage worker: the worker's slot read is held
// to keep a move waiting. The queued-move rules themselves are unit-tested in
// tests/local/timeline/queuedMoves.test.ts.

const en = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english

/** The stack's slot read fails: the stack logs it, and the flusher logs a failed flush. */
const SLOT_FAILED = /A stored undo step could not be loaded/

/**
 * Records the text of every notice shown, from before the page loads: the quick notice and the
 * live region that announces it. A notice that only flashes by is still in the log.
 */
const recordNotices = (page: Page) =>
    page.addInitScript(() => {
        const log: string[] = []
        ;(window as unknown as { nseNoticeLog: string[] }).nseNoticeLog = log
        const NOTICE = '.notification, .notification-pill, [aria-live]'
        const take = (node: Node | null) => {
            const element = node instanceof Element ? node : (node?.parentElement ?? null)
            const holder = element?.closest(NOTICE)
            const text = (holder ?? (element?.querySelector(NOTICE) as Element | null))?.textContent
            if (text?.trim()) log.push(text.trim().replace(/\s+/g, ' '))
        }
        const start = () =>
            new MutationObserver((records) => {
                for (const record of records) {
                    if (record.type === 'characterData') take(record.target)
                    for (const node of record.addedNodes) take(node)
                }
            }).observe(document.documentElement, {
                subtree: true,
                childList: true,
                characterData: true,
            })
        if (document.documentElement) start()
        else document.addEventListener('DOMContentLoaded', start)
    })

const noticeLog = (page: Page) =>
    page.evaluate(() => (window as unknown as { nseNoticeLog: string[] }).nseNoticeLog)

/** Distinct notice texts that mention Undo or Redo. */
const moveNotices = async (page: Page) => [
    ...new Set((await noticeLog(page)).filter((text) => /^(Undid|Redid) /.test(text))),
]

/** Steps of Initial Life, from the current value up by `count`, one stored step each. */
const pushLifeSteps = (page: Page, count: number) =>
    page.evaluate((count) => {
        const { history, historySteps } = window.editorTest
        for (let i = 0; i < count; i++) {
            const before = history.liveState.value.initialLife
            history.pushState(historySteps.initialLife(before, before + 1), {
                ...history.liveState.value,
                initialLife: before + 1,
            })
        }
    }, count)

const lifeOf = async (page: Page) => (await liveOf(page)).initialLife

/** The slots that hold a state, and the head's index. */
const slots = (page: Page) =>
    page.evaluate(async () => {
        const stack =
            await window.editorTest.appImport<typeof import('../../src/history/stack')>(
                '/src/history/stack.ts',
            )
        return stack.loadedSlotsForTests()
    })

/** Waits until the head's neighbours are loaded: the prefetch after a reload has run. */
const neighboursLoaded = (page: Page) =>
    expect
        .poll(async () => {
            const loaded = await slots(page)
            const head = loaded.lastIndexOf(true)
            const count = loaded.length
            // The head is the last slot after a reload that stored no redo.
            return head === count - 1 && loaded[count - 2] === true
        })
        .toBe(true)

/** What the pointer shows over the chart, and over the editor's root. */
const cursors = (page: Page) =>
    page.evaluate(() => ({
        canvas: getComputedStyle(document.querySelector('canvas.editor-chart')!).cursor,
        root: getComputedStyle(document.querySelector('canvas.editor-chart')!.closest('.isolate')!)
            .cursor,
    }))

const slotLoading = (page: Page) => page.evaluate(() => window.editorTest.history.slotLoading.value)

/** The kinds of every stored entry, oldest first. */
const entryKinds = async (page: Page) => {
    const { entries } = (await page.evaluate(() =>
        window.nseStorageTest!.worker.call('testRows', ['entries']),
    )) as unknown as { entries: { value: { kind: string } }[] }
    return entries.map(({ value }) => value.kind)
}

/**
 * A tap with the Note tool while the flush is held: a real click, waiting for the note instead
 * of the stored entry (the helper's `placeTap` waits for the flusher's newest seq, which a
 * held flush does not move).
 */
const tapWhileHeld = async (page: Page, { lane, beat }: { lane: number; beat: number }) => {
    const before = (await liveOf(page)).notes.length
    await useTool(page, 'note')
    const at = await page.evaluate(
        async ([lane, beat]) => {
            const { appImport, view, settings } = window.editorTest
            const { bpms } =
                await appImport<typeof import('../../src/history/bpms')>('/src/history/bpms.ts')
            const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
                '/src/state/integrals/bpms.ts',
            )
            return {
                x: view.x + view.w * (0.5 + (lane - view.lane) / settings.width),
                y: view.y + view.h / 2 - (beatToTime(bpms.value, beat) - view.time) * settings.pps,
            }
        },
        [lane, beat] as const,
    )
    await page.mouse.move(at.x, at.y)
    await page.mouse.click(at.x, at.y)
    await expect.poll(async () => (await liveOf(page)).notes.length).toBe(before + 1)
}

/**
 * The app's own blank chart, which every value of survives level data (a journal recovery
 * builds the chart from level data, so the fixture's richer chart would differ after it).
 */
const startBlank = async (page: Page, opts: Parameters<typeof load>[1] = {}) => {
    await load(page, { ...opts, chart: 'keep' })
    await page.evaluate(async () => {
        const { history, view, nextTick } = window.editorTest
        history.resetState(false)
        view.time = 3
        await nextTick()
    })
    await expect.poll(async () => (await liveOf(page)).notes).toHaveLength(0)
}

/** Flushes until nothing is pending: after a new chart starts, its session is stored too. */
const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(async () => {
                const test = window.nseFlushTest!
                await test.flusher.flush({ strict: true })
                return !test.flusher.hasPending
            }),
        )
        .toBe(true)

/**
 * The fixture's `window.editorTest` without its `show`, for a visit that must keep the session
 * startup opened (`load` with `chart: 'keep'` still installs the whole fixture, which replaces it).
 * A copy of the journey helper's `installReloaded`, evaluated in the page.
 */
const installRestored = async () => {
    const moduleUrls = new Map(
        performance
            .getEntriesByType('resource')
            .map((entry) => [new URL(entry.name).pathname, entry.name]),
    )
    const resolve = (pathname: string) => moduleUrls.get(pathname) ?? pathname
    const appImport = <T>(pathname: string): Promise<T> => import(resolve(pathname))
    const history = await appImport<typeof import('../../src/history')>('/src/history/index.ts')
    const store = await appImport<typeof import('../../src/history/store')>('/src/history/store.ts')
    const historySteps = await appImport<typeof import('../helpers/historySteps')>(
        '/tests/helpers/historySteps.ts',
    )
    const { settings } = await appImport<typeof import('../../src/settings')>('/src/settings.ts')
    const { view } = await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
    const { nextTick } = await appImport<typeof import('../helpers/vue')>('/tests/helpers/vue.ts')
    settings.mouseSmoothScrolling = false
    settings.dragToPanX = false
    settings.dragToPanY = false
    settings.width = 20
    settings.pps = 120
    view.noteSize = 2
    view.division = 4
    view.snapping = 'absolute'
    window.editorTest = {
        history,
        store,
        historySteps,
        settings,
        view,
        nextTick,
        appImport,
    } as unknown as typeof window.editorTest
}

/** A new visit in a fresh tab: startup opens the session it finds, and nothing replaces it. */
const newVisit = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installRestored)
}

const canUndo = (page: Page) => page.evaluate(() => window.editorTest.history.canUndo.value)

const press = async (page: Page, key: string, times: number) => {
    await page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body) active.blur()
    })
    for (let i = 0; i < times; i++) await page.keyboard.press(key)
}

/**
 * Forty Initial Life steps, stored and reloaded: the stack holds the head and its neighbours.
 * Returns the head's Initial Life.
 */
const reloadedStack = async (page: Page) => {
    await load(page)
    const start = await lifeOf(page)
    await pushLifeSteps(page, 40)
    await flush(page)
    await reloadAndWait(page)
    await neighboursLoaded(page)
    expect(await lifeOf(page)).toBe(start + 40)
    return start + 40
}

test.beforeEach(async ({ page }) => {
    await recordNotices(page)
})

test('R1: Undo by real keys over unloaded slots waits, shows the busy cursor, then lands exactly', async ({
    page,
}) => {
    test.slow()
    errorsFail(page)
    const head = await reloadedStack(page)
    const hold = await holdWorker(page, 'readSnapshotVerified')
    try {
        await press(page, 'z', 5)
        // The loaded neighbour was crossed at once; the rest wait for their slots.
        await hold.reached()
        await expect.poll(() => slotLoading(page)).toBe(true)
        await expect.poll(() => cursors(page)).toEqual({ canvas: 'progress', root: 'progress' })
        expect(await lifeOf(page)).toBe(head - 1)
        expect(await canUndo(page)).toBe(true)
        await hold.release()
        await expect.poll(() => lifeOf(page)).toBe(head - 5)
        await expect.poll(() => slotLoading(page)).toBe(false)
        await expect.poll(async () => (await cursors(page)).canvas).not.toBe('progress')
    } finally {
        await release(page)
    }
    // One Undo group of five steps heads the Timeline.
    await flush(page)
    await openHistory(page)
    await expect
        .poll(async () => (await rowTitles(page))[1])
        .toBe(en.history.undidSteps.replace('{0}', '5'))
    {
        const group = en.history.undidSteps.replace('{0}', '5')
        await peekRow(page, group)
        await page
            .locator('[data-peek-main]')
            .getByRole('button', { name: /^Step Details:/ })
            .click()
        const dialog = page.getByRole('dialog', { name: en.history.details.title, exact: true })
        await expect(dialog).toBeVisible()
        // The five crossed steps, the last one undone first as in the Timeline, without the repeated Undo prefix.
        await expect(dialog.locator('[data-operation-children] summary span.flex-1')).toHaveText(
            Array.from(
                { length: 5 },
                (_, i) => `Set Initial Life to ${(head - 4 + i).toLocaleString('en')}`,
            ),
        )
        await page.keyboard.press('Escape')
    }
    // Redo twice lands exactly.
    await page.keyboard.press('Escape')
    await press(page, 'y', 2)
    await expect.poll(() => lifeOf(page)).toBe(head - 3)
})

test('R2: an edit while Undo waits applies to the chart on screen, and the Undo never lands', async ({
    page,
}) => {
    test.slow()
    errorsFail(page)
    const head = await reloadedStack(page)
    const hold = await holdWorker(page, 'readSnapshotVerified')
    try {
        // The first press crosses the loaded neighbour; the other two wait for their slots.
        await press(page, 'z', 3)
        await hold.reached()
        expect(await lifeOf(page)).toBe(head - 1)
        await placeTap(page, { lane: 4, beat: 4 })
        // The edit is built on the chart on screen.
        expect(await lifeOf(page)).toBe(head - 1)
        await expect.poll(async () => (await liveOf(page)).notes).toHaveLength(1)
        await hold.release()
        await expect.poll(() => slotLoading(page)).toBe(false)
    } finally {
        await release(page)
    }
    // The held read has come back; a flush is ordered behind it, so the cancelled move has had
    // its chance to land.
    await flush(page)
    const after = await liveOf(page)
    expect(after.initialLife).toBe(head - 1)
    expect(after.notes).toHaveLength(1)
    expect(await entryKinds(page)).toEqual(expect.arrayContaining(['undo', 'edit']))
    expect((await entryKinds(page)).filter((kind) => kind === 'undo')).toHaveLength(1)
    // Only the press that crossed the loaded slot told the user anything.
    expect(await moveNotices(page)).toHaveLength(1)
})

test('R3: a queued Undo onto an unloadable slot changes nothing, and the next press undoes one step', async ({
    page,
}) => {
    test.slow()
    errorsFail(page, { allow: [SLOT_FAILED] })
    const head = await reloadedStack(page)
    const hold = await holdWorker(page, 'readSnapshotVerified')
    try {
        await press(page, 'z', 2)
        await hold.reached()
        expect(await lifeOf(page)).toBe(head - 1)
        // The slot's read fails.
        await hold.release(true)
        await expect.poll(() => slotLoading(page)).toBe(false)
    } finally {
        await release(page)
    }
    // A sentinel ordered behind the failure: the queued move has settled once a flush has.
    await flush(page)
    expect(await lifeOf(page)).toBe(head - 1)
    expect(await canUndo(page)).toBe(true)
    // The user was told about the first step only (the one that landed), and that the second
    // could not be undone.
    expect(await moveNotices(page)).toHaveLength(1)
    await expect
        .poll(async () => (await noticeLog(page)).includes(en.commands.undo.failed))
        .toBe(true)
    // With the loader healthy, one press undoes exactly one step.
    await press(page, 'z', 1)
    await expect.poll(() => lifeOf(page)).toBe(head - 2)
    await expect.poll(() => moveNotices(page)).toHaveLength(2)
    await flush(page)
    expect(await lifeOf(page)).toBe(head - 2)
})

test('R4: a step eight back in the Timeline of a reloaded stack peeks and restores', async ({
    page,
}) => {
    test.slow()
    errorsFail(page)
    await load(page)
    const start = await lifeOf(page)
    await pushLifeSteps(page, 20)
    await flush(page)
    await reloadAndWait(page)
    const head = start + 20
    expect(await lifeOf(page)).toBe(head)
    await openHistory(page)
    // The 20 steps are one group.
    await page.locator('[data-history-disclosure]').first().click()
    const target = head - 8
    await peekRow(page, `Set Initial Life to ${target.toLocaleString('en')}`)
    expect((await chartOf(page)).initialLife).toBe(target)
    expect((await liveOf(page)).initialLife).toBe(head)
    await restoreFromStrip(page)
    await expect.poll(() => lifeOf(page)).toBe(target)
    // Undo returns to the head the Restore replaced.
    await press(page, 'z', 1)
    await expect.poll(() => lifeOf(page)).toBe(head)
})

test('R5: the Timeline survives a reload exactly, with an edit only the journal holds', async ({
    page,
}) => {
    test.slow()
    errorsFail(page, { allow: [/A flush failed/] })
    await recordNotices(page)
    await startBlank(page, { platform: { fileSystemAccess: 'opfs' } })
    await placeTap(page, { lane: -4, beat: 2 })
    await placeTap(page, { lane: 0, beat: 4 })
    await dragNote(page, { lane: 1, beat: 4 }, { lane: 1, beat: 5 })
    await press(page, 'z', 2)
    await expect.poll(() => canUndo(page)).toBe(true)
    await press(page, 'y', 1)
    // A Save, to a file the test platform provides.
    await pressSave(page)
    await submitSave(page, 'r5')
    await expect
        .poll(() => readFile(page, 'r5.nxsp').then((bytes) => bytes?.length ?? 0))
        .toBeGreaterThan(0)
    await flush(page)
    // Then an edit that is never flushed.
    await holdWorker(page, 'flush')
    await tapWhileHeld(page, { lane: -4, beat: 5 })
    const live = await liveOf(page)
    await openHistory(page)
    await timelineRead(page)
    const titles = await rowTitles(page)
    const labels = await rowLabels(page)
    const count = await timeline(page).getAttribute('aria-rowcount')
    expect(new Set(labels).size).toBe(labels.length)
    await page.keyboard.press('Escape')
    // The tab hides as it reloads: the journal takes what the flush did not.
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new PageTransitionEvent('pagehide'))
    })
    await reloadAndWait(page)
    expect(await liveOf(page)).toEqual(live)
    await openHistory(page)
    await timelineRead(page)
    // The journal holds the chart, not the step that made it: the edit comes back as a Recovered
    // entry in its place. Every stored row is as it was, with its time.
    const addedOne = en.tools.note.added.split('|')[0]!.replace('{0}', '1')
    const after = await rowTitles(page)
    expect(after.slice(0, 2)).toEqual([
        `Now · ${en.entry.recoveredChanges}`,
        en.entry.recoveredChanges,
    ])
    expect(titles.slice(0, 2)).toEqual([`Now · ${addedOne}`, addedOne])
    expect(after.slice(2)).toEqual(titles.slice(2))
    const afterLabels = await rowLabels(page)
    expect(afterLabels.slice(2)).toEqual(labels.slice(2))
    expect(new Set(afterLabels).size).toBe(afterLabels.length)
    expect(await timeline(page).getAttribute('aria-rowcount')).toBe(count)
})

test('R6: after a crash the recovered rows are in the Timeline, and peek and Restore work on them', async ({
    playwright,
    browserName,
}, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP Page.crash is Chromium’s')
    // Two browser starts over one profile on disk.
    test.setTimeout(120_000)
    const { baseURL } = testInfo.project.use
    const dir = await mkdtemp(join(tmpdir(), 'nse-history-recovery-'))
    // A renderer crash takes the context down with it, so the next visit is the browser started
    // again over the same profile.
    const launch = () =>
        playwright.chromium.launchPersistentContext(dir, {
            ...(baseURL ? { baseURL } : {}),
            viewport: { width: 1600, height: 1000 },
            ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
                ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
                : {}),
            args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        })
    let context = await launch()
    try {
        const first = await context.newPage()
        errorsFail(first)
        await recordNotices(first)
        await startBlank(first)
        // A new chart's session is stored with its first edit.
        await placeTap(first, { lane: -4, beat: 1 })
        await settled(first)
        const stored = await liveOf(first)
        // Three edits that only the journal will hold.
        await holdWorker(first, 'flush')
        const digests = []
        for (const at of [
            { lane: -4, beat: 2 },
            { lane: 0, beat: 3 },
            { lane: 4, beat: 4 },
        ]) {
            await tapWhileHeld(first, at)
            digests.push(await liveOf(first))
        }
        // The tab is hidden (the journal is written), then the renderer is gone.
        await first.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
                value: 'hidden',
                configurable: true,
            })
            document.dispatchEvent(new Event('visibilitychange'))
        })
        const cdp = await context.newCDPSession(first)
        const crashed = first.waitForEvent('crash')
        // The call never answers: the renderer is gone.
        void cdp.send('Page.crash').catch(() => undefined)
        await crashed
        await context.close().catch(() => undefined)
        context = await launch()

        const page = await context.newPage()
        errorsFail(page)
        await recordNotices(page)
        await newVisit(page)
        // The journal's chart is the chart, and the start-up notice says it was recovered.
        expect(await liveOf(page)).toEqual(digests.at(-1))
        await expect
            .poll(async () =>
                (await noticeLog(page)).some((text) =>
                    text.includes(en.load.journal.split('{0}')[0]!),
                ),
            )
            .toBe(true)
        // The journal keeps the chart, not each step: the three edits are one Recovered entry on
        // the stored ones.
        await openHistory(page)
        await expect
            .poll(() => rowTitles(page))
            .toEqual([
                `Now · ${en.entry.recoveredChanges}`,
                en.entry.recoveredChanges,
                en.tools.note.added.split('|')[0]!.replace('{0}', '1'),
                en.history.operation.newLevel,
            ])
        // The stored edit peeks to the chart as it was before the journal's edits, and the
        // recovered row to the chart as recovered.
        await peekRow(page, en.tools.note.added.split('|')[0]!.replace('{0}', '1'))
        expect(await chartOf(page)).toEqual(stored)
        expect(await liveOf(page)).toEqual(digests.at(-1))
        // Back to Now leaves History open.
        await backToNow(page)
        await peekRow(page, en.entry.recoveredChanges)
        expect(await chartOf(page)).toEqual(digests.at(-1))
        await backToNow(page)
        // Restore the stored edit, then Undo: the recovered chart is back.
        await peekRow(page, en.tools.note.added.split('|')[0]!.replace('{0}', '1'))
        await restoreFromStrip(page)
        await expect.poll(async () => await liveOf(page)).toEqual(stored)
        await press(page, 'z', 1)
        await expect.poll(async () => await liveOf(page)).toEqual(digests.at(-1))
    } finally {
        await context.close().catch(() => undefined)
        // Windows can hold the closed browser's files a moment longer.
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
            () => undefined,
        )
    }
})
