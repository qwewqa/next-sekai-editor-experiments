import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type { PlatformOverride } from '../../src/platform/detect'
import { SampleClock } from '../samples/driver'
import { installEditorFixture, installTestPlatform, useTool, waitForStartup } from './editorFixture'

/*
 * Shared helper for the D2 History journey specs (work/history-redesign/testplan/plan.md §3.0).
 * It holds no tests. P1 to P4 import it read-only; anything a package needs beyond it stays local
 * to that package's spec.
 *
 * Conventions every spec built on it follows (plan §3):
 * - No fixed waits. Wait on conditions (web-first `expect`, `expect.poll`, a flush, two frames or
 *   a released gate). Assert that nothing happened only after a later positive event ordered
 *   behind it: run a sentinel action, wait for it, then check the absence.
 * - Hold up under load. One read per poll (never `expect(await x)` for async state). Find notices
 *   by text (`notice`), not by a single `.notification`: a leaving toast can overlap a new one. Use
 *   `confirmWhenReady` for guarded dialogs, `closePage` before a second visit, a fresh context per
 *   multi-tab test and `test.slow()` for long journeys. Release every hold in `finally`.
 * - Errors fail the test (`errorsFail`: page errors, console errors, Vue duplicate-key and
 *   unhandled-error warnings).
 * - Real input first. Synthetic steps (`history.pushState`) only for volume or for what the UI
 *   cannot make. Read chart state from `chartOf` / `liveOf`, and file bytes from OPFS
 *   (`saveFlows.projectOf`).
 * - Assert user-facing text from `src/i18n/en/index.json`, never prose that is not in it.
 *
 * API (final; every function takes the page first):
 *   load(page, opts?)               start the editor, install the fixture and show a blank chart
 *   errorsFail(page, opts?)         make page errors, console errors and Vue warnings fail the test
 *                                   (opts.allow: patterns of errors a test expects)
 *   noErrors(page)                  assert nothing was caught (for a `test.afterEach`)
 *   openHistory(page, opts?)        press Shift+H (History's key) and wait for the Timeline, Now focused
 *   timeline(page, surface?)        the Timeline treegrid ('dialog' by default, or 'panel')
 *   row(page, title)                the row whose title is exactly `title`
 *   rowTitles(page)                 rendered row titles, top down ("Now" row: its full text)
 *   rowLabels(page)                 the rows' accessible names (aria-label), top down
 *   peekRow(page, title)            click a row and wait until its state is shown
 *   restoreFromStrip(page)          press Restore in the peek strip and wait for the peek to end
 *   backToNow(page)                 press Back to Now and wait for the peek to end
 *   flush(page)                     store everything now
 *   reloadAndWait(page)             reload, wait for startup, reinstall `window.editorTest`
 *   chartOf(page) / liveOf(page)    digest of the shown / live chart (Digest)
 *   placeTap(page, at)              Note tool click at {lane, beat}; waits for the entry
 *   dragNote(page, from, to)        Select tool drag of the note at `from` to `to`
 *   selectNote(page, at)            Select tool click on the note at {lane, beat}
 *   setProperty(page, label, value) fill a Properties field of the selection; waits for the entry
 *   holdWorker(page, method, opts?) gate the storage worker's `method`; returns a Hold
 *   release(page, fail?)            release the page's hold(s); `fail` rejects the held calls
 *   sampleClock(context, start)     an installed SampleClock (page clock and worker Date together)
 *   notice(page, text?)             notices, optionally filtered by text
 *   newestSeq(page)                 the newest entry's seq in the open session
 *
 * The Hold returned by `holdWorker` has `reached()` (resolves when a call is held), `count()`
 * and `release(fail?)`. A hold gates a call BEFORE it runs, so a held `flush` writes nothing.
 * `opts.when` limits it to calls whose second argument has these fields (for example
 * `{ before: 12 }`).
 *
 * After `reloadAndWait`, `window.editorTest` holds history, store, historySteps, settings, view,
 * nextTick and appImport only (the fixture's `show`, `fixtures` and `point` would replace the
 * restored session).
 */

export { closePage } from './editorFixture'
export { SampleClock }

// --- Errors fail the test

const caught = new WeakMap<Page, string[]>()
const VUE_WARNING = /Duplicate keys|Unhandled error/

/**
 * Collects page errors, console errors and Vue duplicate-key / unhandled-error warnings. Each one
 * fails the test at once (a soft failure, so the test still runs to its end) and is also kept in
 * the returned list. `allow` names the errors a test expects on purpose, such as the flusher's
 * "A flush failed" after `release(page, true)`. Call it before `load`.
 */
export const errorsFail = (page: Page, opts: { allow?: RegExp[] } = {}) => {
    const found: string[] = []
    caught.set(page, found)
    const add = (text: string) => {
        if (opts.allow?.some((pattern) => pattern.test(text))) return
        found.push(text)
        try {
            expect.soft(text, 'an error reached the page').toBe('')
        } catch {
            // The test has ended: the list still holds it.
        }
    }
    page.on('pageerror', (error) => add(`pageerror: ${error.message}`))
    page.on('console', (message) => {
        const text = message.text()
        if (message.type() === 'error') add(`console.error: ${text}`)
        else if (message.type() === 'warning' && VUE_WARNING.test(text))
            add(`console.warn: ${text}`)
    })
    return found
}

/** Asserts that nothing was caught since `errorsFail`: use it in a `test.afterEach`. */
export const noErrors = (page: Page) => expect(caught.get(page) ?? []).toEqual([])

// --- Load

export type LoadOptions = {
    /** The storage worker's test flags (`nse.test.storage`), such as `forceQuota`. */
    storage?: Record<string, unknown>
    /** The platform override (`nse.test.platform`), such as `{ fileSystemAccess: 'opfs' }`. */
    platform?: PlatformOverride
    /** Extra localStorage items, set before the app loads. Values are written as given. */
    local?: Record<string, string>
    /** Whether the Properties sidebar shows. Default false. */
    sidebar?: boolean
    /**
     * The chart to show: a blank one (default), the fixture's interaction chart, or the session
     * as stored ('keep': the fixture's `show` is skipped, so `window.editorTest` is the reloaded
     * one, without `show`, `fixtures` and `point`).
     */
    chart?: 'blank' | 'interaction' | 'keep'
    /** The viewport; the config's 1600 x 1000 otherwise. */
    viewport?: { width: number; height: number }
}

const prefix = 'sonolus-next-sekai-editor.'

/**
 * The init script with the storage hooks (`nseFlushTest`), then `waitForStartup`,
 * `installEditorFixture` and a blank chart at the chart's top (`chart: 'keep'` installs the
 * reloaded `window.editorTest` instead and shows no chart). The fixture's settings (width 20,
 * 120 pixels per second, no smooth scrolling) apply.
 */
export const load = async (page: Page, opts: LoadOptions = {}) => {
    const { storage = {}, platform, local = {}, sidebar = false, chart = 'blank' } = opts
    if (opts.viewport) await page.setViewportSize(opts.viewport)
    await page.addInitScript(
        ({ prefix, storage, local, sidebar }) => {
            performance.setResourceTimingBufferSize(5000)
            localStorage.setItem('nse.test.storage', JSON.stringify(storage))
            localStorage.setItem(`${prefix}showPreview`, 'false')
            localStorage.setItem(`${prefix}showSidebar`, String(sidebar))
            // The shown version never depends on the checkout's tags, and the "Updated to" notice
            // stays out of the way.
            localStorage.setItem(
                'nse.test.version',
                JSON.stringify({ appVersion: '0.6.0', atTag: true }),
            )
            localStorage.setItem(`${prefix}lastAppVersion`, JSON.stringify('0.6.0'))
            for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value)
        },
        { prefix, storage, local, sidebar },
    )
    if (platform) await page.addInitScript(installTestPlatform, platform)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    // The fixture ends by showing its interaction chart, which would replace the stored session.
    await page.evaluate(chart === 'keep' ? installReloaded : installEditorFixture)
    if (chart === 'blank')
        await page.evaluate(async () => {
            const { fixtures, show, nextTick } = window.editorTest
            show({ ...fixtures.interaction, slides: [] }, 3)
            await nextTick()
        })
}

/** Reloads the page (the caller flushes first if it wants the entries stored) and waits for startup. */
export const reloadAndWait = async (page: Page) => {
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installReloaded)
}

/**
 * The fixture's `window.editorTest` without its `show`: the fixture would replace the session the
 * reload restored. Evaluated in the page.
 */
export const installReloaded = async () => {
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

// --- The Timeline

export type Surface = 'dialog' | 'panel'

export const timeline = (page: Page, surface: Surface = 'dialog') =>
    page.locator(`[data-history-surface="${surface}"] [data-history-list]`)

/** The row whose rendered title is exactly `title` (a group row's title is its action). */
export const row = (page: Page, title: string, surface: Surface = 'dialog'): Locator =>
    timeline(page, surface)
        .locator('[data-history-row]')
        .filter({
            has: page.locator('[data-history-group-action]').filter({
                hasText: new RegExp(`^\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`),
            }),
        })

const rowsTopDown = <T>(page: Page, surface: Surface, pick: string) =>
    timeline(page, surface)
        .locator('[data-history-row]')
        .evaluateAll(
            (rows, pick) =>
                rows
                    .map((row) => ({ row, top: parseFloat((row as HTMLElement).style.top) }))
                    .sort((a, b) => a.top - b.top)
                    .map(({ row }) =>
                        pick === 'label'
                            ? (row.getAttribute('aria-label') ?? '')
                            : (() => {
                                  const text = row.matches('.timeline-now')
                                      ? row.querySelector('.timeline-entry-text')
                                      : row.querySelector('[data-history-group-action]')
                                  return (text?.textContent ?? '').replace(/\s+/g, ' ').trim()
                              })(),
                    ),
            pick,
        ) as Promise<T>

/** The rendered row titles, top down (the rows in the DOM: the Timeline renders the visible ones). */
export const rowTitles = (page: Page, surface: Surface = 'dialog') =>
    rowsTopDown<string[]>(page, surface, 'title')

/** The rows' accessible names, top down (Now has none). */
export const rowLabels = (page: Page, surface: Surface = 'dialog') =>
    rowsTopDown<string[]>(page, surface, 'label')

/**
 * Presses H (Shift+H) with nothing focused and waits until the Timeline shows and Now has focus. The
 * list takes focus as it opens, before its first read lands: `timelineRead` waits for that.
 */
export const openHistory = async (page: Page, opts: { focused?: boolean } = {}) => {
    await page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body) active.blur()
    })
    await page.keyboard.press('Shift+H')
    const list = timeline(page)
    await expect(list).toBeVisible()
    const now = list.getByRole('row', { name: /^Now/ })
    await expect(now).toBeVisible()
    if (opts.focused ?? true) await expect(now).toBeFocused()
}

/** Waits for the Timeline's first read: until it lands, only Now and steps not stored yet show. */
export const timelineRead = (page: Page, surface: Surface = 'dialog') =>
    expect(timeline(page, surface).locator('[data-history-loading]')).toHaveCount(0)

// --- Peek

const peekState = (page: Page) =>
    page.evaluate(async () => {
        const peek =
            await window.editorTest.appImport<typeof import('../../src/history/peek')>(
                '/src/history/peek.ts',
            )
        return {
            peeking: peek.isPeeking.value,
            requested: peek.peekedKey.value ?? null,
            displayed: peek.displayedPeekKey.value ?? null,
            loading: peek.peekLoading.value,
        }
    })

/** Clicks the row's title (a real click) and waits until the peek shows that row's state. */
export const peekRow = async (page: Page, title: string, surface: Surface = 'dialog') => {
    const target = row(page, title, surface)
    await expect(target).toHaveCount(1)
    await target.locator('[data-history-group-action]').click()
    await expect(page.locator('[data-peek-bar]')).toBeVisible()
    await expect
        .poll(async () => {
            const state = await peekState(page)
            return state.peeking && state.requested !== null && state.displayed === state.requested
        })
        .toBe(true)
    await expect.poll(async () => (await peekState(page)).loading).toBe(false)
}

const peekEnded = async (page: Page) => {
    await expect(page.locator('[data-peek-bar]')).toHaveCount(0)
    await expect.poll(async () => (await peekState(page)).peeking).toBe(false)
}

/** Presses Restore in the peek strip; waits until the peek has ended (restored, or already matching). */
export const restoreFromStrip = async (page: Page) => {
    await page.locator('[data-peek-restore]').click()
    await peekEnded(page)
}

/** Presses Back to Now in the peek strip and waits until the peek has ended. */
export const backToNow = async (page: Page) => {
    await page.locator('[data-peek-back]').click()
    await peekEnded(page)
}

// --- Storing

export const flush = (page: Page) =>
    page.evaluate(async () => {
        await window.nseFlushTest!.flusher.flush({ strict: true })
    })

/** The newest entry's seq in the open session (0 before storing starts). */
export const newestSeq = (page: Page) =>
    page.evaluate(() => {
        const flusher = window.nseFlushTest?.flusher
        return flusher?.session ? flusher.newestSeq(flusher.session) : 0
    })

// --- Chart digests

export type Digest = {
    /** Notes by beat, then lane, then size. `left` is the note's left lane. */
    notes: { beat: number; left: number; size: number }[]
    initialLife: number
    offset: number
    levelInfo: {
        title: string
        artists: string
        author: string
        description: string
        tags: string[]
        rating?: number
    }
    bpms: { beat: number; bpm: number }[]
    groups: [number, string][]
    stages: [number, string][]
}

const digestOf = (page: Page, which: 'state' | 'liveState') =>
    page.evaluate((which) => {
        const { history } = window.editorTest
        const state = history[which].value
        const notes = [...state.store.slides.note.values()]
            .flat()
            .map(({ beat, left, size }) => ({ beat, left, size }))
            .sort((a, b) => a.beat - b.beat || a.left - b.left || a.size - b.size)
        const info = state.levelInfo
        return {
            notes,
            initialLife: state.initialLife,
            offset: state.bgm.offset,
            levelInfo: {
                title: info.title,
                artists: info.artists,
                author: info.author,
                description: info.description,
                tags: info.tags.map((tag) => tag.title),
                ...(info.rating === undefined ? {} : { rating: info.rating }),
            },
            bpms: state.bpms.map((bpm) => ({
                beat: bpm.x,
                bpm: Math.round((60 / bpm.s) * 1e6) / 1e6,
            })),
            groups: [...state.groups].map(([id, group]) => [id as number, group.name]),
            stages: [...state.stages].map(([id, stage]) => [id as number, stage.name]),
        } satisfies Digest as Digest
    }, which)

/** A digest of the chart as shown: the peeked state while peeking, else the live one. */
export const chartOf = (page: Page) => digestOf(page, 'state')

/** A digest of the live chart, which a peek never changes. */
export const liveOf = (page: Page) => digestOf(page, 'liveState')

// --- Real edits

type At = { lane: number; beat: number }

/** Waits until the view holds still for two frames, so a point lands on the beat asked for. */
const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(async () => {
                const { view, settings } = window.editorTest
                const at = () =>
                    [
                        view.x,
                        view.y,
                        view.w,
                        view.h,
                        view.time,
                        view.lane,
                        settings.pps,
                        settings.width,
                    ].join()
                const before = at()
                await new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                )
                return !view.scrollingX && !view.scrollingY && at() === before
            }),
        )
        .toBe(true)

/** The screen point of a lane and beat, from the app's own tempo map. */
const pointOf = async (page: Page, { lane, beat }: At) => {
    await settled(page)
    return page.evaluate(
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
}

/** Runs a real input and waits until it makes exactly one entry. */
const makesEntry = async (page: Page, input: () => Promise<unknown>) => {
    const before = await newestSeq(page)
    await input()
    await expect.poll(() => newestSeq(page)).toBe(before + 1)
}

/** Places a tap with the Note tool: a real click at the lane and beat. */
export const placeTap = async (page: Page, at: At) => {
    await useTool(page, 'note')
    const { x, y } = await pointOf(page, at)
    await makesEntry(page, async () => {
        await page.mouse.move(x, y)
        await page.mouse.click(x, y)
    })
}

/** Selects the note at a lane (its centre) and beat with the Select tool. */
export const selectNote = async (page: Page, at: At) => {
    await useTool(page, 'select')
    const { x, y } = await pointOf(page, at)
    await page.mouse.move(x, y)
    await page.mouse.click(x, y)
    await expect
        .poll(() =>
            page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
        )
        .toBeGreaterThan(0)
}

/** Drags the note at `from` to `to` with the Select tool: a real press, moves and release. */
export const dragNote = async (page: Page, from: At, to: At, steps = 8) => {
    await useTool(page, 'select')
    const a = await pointOf(page, from)
    const b = await pointOf(page, to)
    await makesEntry(page, async () => {
        await page.mouse.move(a.x, a.y)
        await page.mouse.down()
        await page.mouse.move(b.x, b.y, { steps })
        await page.mouse.up()
    })
}

/**
 * Types a value into a Properties field of the selected notes (the field's label, such as
 * "Lane") and commits it with Enter. Shows the sidebar if it is hidden. Waits for the entry.
 */
export const setProperty = async (page: Page, label: string, value: string) => {
    await page.evaluate(() => {
        window.editorTest.settings.showSidebar = true
        window.editorTest.settings.propertiesSection = 'selection'
    })
    const field = page
        .locator('#workspace-panel-properties #properties-section-selection label')
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator('input')
    await expect(field).toBeVisible()
    await makesEntry(page, async () => {
        await field.fill(value)
        await field.press('Enter')
    })
}

// --- Holding the storage worker

declare global {
    interface Window {
        nseJourneyHold?: {
            calls: number
            release: (fail: boolean) => void
        }
    }
}

export type Hold = {
    /** Resolves when at least one call is held. */
    reached: () => Promise<void>
    /** How many calls are held now. */
    count: () => Promise<number>
    release: (fail?: boolean) => Promise<void>
}

/**
 * Gates the storage worker's `method` before it runs: held calls wait, and `release()` lets them
 * through, or with `release(true)` makes them reject. Calls after the release pass freely, and
 * another `holdWorker` gates them again. One hold at a time per page.
 */
export const holdWorker = async (
    page: Page,
    method: string,
    opts: { when?: Record<string, unknown> } = {},
): Promise<Hold> => {
    await page.evaluate(
        async ({ method, when }) => {
            const { storageWorker } =
                await window.editorTest.appImport<typeof import('../../src/local/start')>(
                    '/src/local/start.ts',
                )
            const worker = storageWorker!
            const original = worker.call
            const hold = {
                calls: 0,
                release: (_fail: boolean) => {},
            }
            const gate = new Promise<boolean>((resolve) => {
                hold.release = (fail) => {
                    window.nseJourneyHold = undefined
                    worker.call = original
                    resolve(fail)
                }
            })
            window.nseJourneyHold = hold
            worker.call = new Proxy(original, {
                async apply(target, self, args) {
                    const matches =
                        args[0] === method &&
                        Object.entries(when ?? {}).every(
                            ([key, value]) =>
                                (args[1] as Record<string, unknown> | undefined)?.[key] === value,
                        )
                    if (matches) {
                        hold.calls++
                        try {
                            if (await gate) throw new Error(`held ${method} call failed`)
                        } finally {
                            hold.calls--
                        }
                    }
                    return Reflect.apply(target, self, args)
                },
            })
        },
        { method, when: opts.when },
    )
    return {
        reached: () =>
            expect
                .poll(() => page.evaluate(() => window.nseJourneyHold?.calls ?? 0))
                .toBeGreaterThan(0),
        count: () => page.evaluate(() => window.nseJourneyHold?.calls ?? 0),
        release: (fail = false) => release(page, fail),
    }
}

/** Releases the page's hold, if any. A call made while no hold exists is a no-op. */
export const release = (page: Page, fail = false) =>
    page.evaluate((fail) => window.nseJourneyHold?.release(fail), fail)

// --- Time

/** A clock for the page and the storage worker, installed on the context before any page loads. */
export const sampleClock = async (context: BrowserContext, start: number) => {
    const clock = new SampleClock(context, start)
    await clock.install()
    return clock
}

// --- Notices

/** The notices shown, optionally those containing `text`. */
export const notice = (page: Page, text?: string | RegExp): Locator => {
    const all = page.locator('.notification, .notification-pill')
    return text === undefined ? all : all.filter({ hasText: text })
}
