// User actions at scale for run.mjs's `act` scenario (docs/performance-testing.md, "Actions"):
// History's Timeline and Recent Sessions, Local Data, Save and Open, and the dialogs. Each action
// prepares the page, sends one input (or a held key or a wheel run), and waits for the frame that
// shows its result.

import { copyFileSync, statSync } from 'node:fs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ---- in the page

/**
 * The action probe: from an input to the first animation frame where `done` holds, with the
 * Event Timing entries, long tasks and long animation frames in between. Predicates are
 * expressions of `P` (window.nsePerf) and `A` (what `before` read just before the input).
 */
export const installActionProbe = () => {
    let armed
    for (const type of ['keydown', 'keyup', 'pointerdown', 'mousedown', 'wheel', 'touchstart'])
        window.addEventListener(
            type,
            (event) => {
                if (!armed || !event.isTrusted) return
                armed.inputs.push([type, event.timeStamp])
                if (type !== 'keyup') armed.input ??= event.timeStamp
            },
            { capture: true, passive: true },
        )
    const compile = (source) => source && new Function('P', 'A', `return (${source})`)
    // scrollIntoView also scrolls clipped ancestors and the page. This resets the clipped
    // ancestors of `element` (or the page's first levels) that moved.
    const unscroll = (element) => {
        const list = [document.documentElement, document.body]
        if (element) for (let e = element.parentElement; e; e = e.parentElement) list.push(e)
        else list.push(...document.querySelectorAll('body > *, body > * > *, body > * > * > *'))
        for (const e of list) {
            if (!e.scrollTop && !e.scrollLeft) continue
            const style = getComputedStyle(e)
            if (
                /auto|scroll/.test(style.overflowY + style.overflowX) &&
                e !== document.documentElement
            )
                continue
            e.scrollTop = 0
            e.scrollLeft = 0
        }
    }
    window.nsePerfAct = {
        unscroll,
        centre(element) {
            element?.scrollIntoView({ block: 'center' })
            unscroll(element)
        },
        arm(spec) {
            const P = window.nsePerf
            const a = (armed = {
                spec,
                A: compile(spec.before)?.(P),
                done: compile(spec.done),
                busy: compile(spec.busy),
                marks: Object.fromEntries(
                    Object.entries(spec.marks ?? {}).map(([k, v]) => [k, compile(v)]),
                ),
                inputs: [],
                frames: [],
                events: [],
                tasks: [],
                loaf: [],
                at: { marks: {} },
                start: performance.now(),
                released: !spec.release,
                finished: false,
            })
            a.observers = [
                [
                    'event',
                    (e) =>
                        a.events.push([
                            e.name,
                            e.startTime,
                            e.duration,
                            e.processingStart,
                            e.processingEnd,
                        ]),
                ],
                ['longtask', (e) => a.tasks.push([e.startTime, e.duration])],
                [
                    'long-animation-frame',
                    (e) => a.loaf.push([e.startTime, e.duration, e.blockingDuration]),
                ],
            ].map(([type, push]) => {
                const observer = new PerformanceObserver((list) => list.getEntries().forEach(push))
                observer.observe(type === 'event' ? { type, durationThreshold: 16 } : { type })
                return observer
            })
            const limit = spec.timeout ?? 30_000
            const loop = (t) => {
                a.frames.push(t)
                const from = a.input ?? a.manual
                if (from !== undefined && t >= from) {
                    const check = (fn) => {
                        try {
                            return !!fn(P, a.A)
                        } catch {
                            return false
                        }
                    }
                    if (a.busy && a.at.busy === undefined && check(a.busy)) a.at.busy = t
                    for (const [name, fn] of Object.entries(a.marks))
                        if (a.released && a.at.marks[name] === undefined && check(fn))
                            a.at.marks[name] = t
                    if (a.released && a.at.done === undefined && check(a.done)) a.at.done = t
                }
                // `until`: a mark to wait for after done, for at most `untilMs`.
                const tail =
                    a.at.done !== undefined &&
                    t - a.at.done >= (spec.tail ?? 200) &&
                    (!spec.until ||
                        a.at.marks[spec.until] !== undefined ||
                        t - a.at.done >= (spec.untilMs ?? 30_000))
                if (tail || performance.now() - a.start > limit) {
                    a.finished = true
                    for (const o of a.observers) o.disconnect()
                    return
                }
                requestAnimationFrame(loop)
            }
            requestAnimationFrame(loop)
        },
        /** An input that is not a DOM event (a setting flipped by the harness). */
        input() {
            armed.manual ??= performance.now()
        },
        /** The end of a held input: `done` is checked from here, and timed from the last input. */
        release() {
            armed.released = true
            armed.releasedAt = performance.now()
        },
        finished: () => !!armed?.finished,
        inputAt: () => armed?.input ?? armed?.manual,
        result() {
            const a = armed
            const input = a.input ?? a.manual
            const lastInput = a.spec.release
                ? Math.max(a.releasedAt ?? 0, ...a.inputs.map(([, t]) => t))
                : input
            const done = a.at.done
            const end = done ?? performance.now()
            const overlaps = ([start, duration]) => start + duration >= input && start <= end
            const intervals = []
            const after = []
            for (let i = 1; i < a.frames.length; i++) {
                const [prev, t] = [a.frames[i - 1], a.frames[i]]
                if (t >= input && t <= end) intervals.push(t - prev)
                else if (t > end) after.push(t - prev)
            }
            const keyEvents = a.events.filter(
                ([name, start]) => name === 'keydown' && start >= input - 1,
            )
            const sorted = (list) => [...list].sort((x, y) => x - y)
            const pct = (list, p) => {
                const s = sorted(list)
                return s.length
                    ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
                    : undefined
            }
            const rel = (t) => (t === undefined ? undefined : t - lastInput)
            return {
                timedOut: done === undefined,
                // To the start of the frame after the one that showed the result, so the work of
                // that frame (rows, chart) is included.
                response: rel(a.frames.find((t) => done !== undefined && t > done)),
                resultFrame: rel(done),
                busy: rel(a.at.busy),
                marks: Object.fromEntries(Object.entries(a.at.marks).map(([k, t]) => [k, rel(t)])),
                inputs: a.inputs.length,
                eventMax: Math.max(
                    0,
                    ...a.events.filter(([, start]) => start >= input - 1).map((e) => e[2]),
                ),
                keyEvents: keyEvents.length
                    ? {
                          n: keyEvents.length,
                          p50: pct(
                              keyEvents.map((e) => e[2]),
                              50,
                          ),
                          p95: pct(
                              keyEvents.map((e) => e[2]),
                              95,
                          ),
                          max: Math.max(...keyEvents.map((e) => e[2])),
                      }
                    : undefined,
                longestTask: Math.max(0, ...a.tasks.filter(overlaps).map(([, d]) => d)),
                tasksOver50: a.tasks.filter(overlaps).length,
                longestLoaf: Math.max(0, ...a.loaf.filter(overlaps).map(([, d]) => d)),
                frameMax: intervals.reduce((m, x) => Math.max(m, x), 0),
                frames: intervals.length,
                frameP50: pct(intervals, 50),
                frameP95: pct(intervals, 95),
                afterMax: Math.max(0, ...after.slice(0, 5)),
                tailTask: Math.max(0, ...a.tasks.filter(([s]) => s > end).map(([, d]) => d)),
            }
        },
    }
}

// ---- helpers

const dialog = '[data-history-surface="dialog"]'
const visible = (page, selector) =>
    page.evaluate((s) => {
        const e = document.querySelector(s)
        return !!e && e.getClientRects().length > 0
    }, selector)
const waitFor = (page, fn, arg, timeout = 60_000) =>
    page.waitForFunction(fn, arg, { timeout, polling: 50 })

const noPeek = async (page) => {
    if (await page.evaluate(() => !!window.nsePerf.peek().key)) {
        await page
            .locator('[data-peek-back]')
            .click({ timeout: 5000 })
            .catch(() => {})
        await waitFor(page, () => !window.nsePerf.peek().key)
    }
}
const openHistory = async (page, tab = 'Timeline') => {
    if (!(await visible(page, `${dialog} [role=tablist]`))) {
        await page
            .locator('canvas.editor-chart')
            .focus()
            .catch(() => {})
        await page.keyboard.press('Shift+H')
        await page.locator(`${dialog} [role=tablist]`).waitFor({ timeout: 30_000 })
    }
    await page.getByRole('tab', { name: tab, exact: true }).click()
    if (tab === 'Timeline')
        await waitFor(
            page,
            (d) =>
                document.querySelectorAll(`${d} [data-history-row]`).length > 1 &&
                !document.querySelector('[data-history-loading]'),
            dialog,
        )
    else
        await waitFor(
            page,
            () =>
                document.querySelectorAll('[data-sessions-row]').length > 0 &&
                !document.querySelector('[data-sessions-loading]'),
        )
}
const closeHistory = async (page) => {
    await noPeek(page)
    for (let i = 0; i < 3 && (await visible(page, `${dialog} [role=tablist]`)); i++) {
        await page.keyboard.press('Escape')
        await sleep(200)
    }
}
const closeDialogs = async (page) => {
    for (let i = 0; i < 4 && (await page.getByRole('dialog').count()); i++) {
        await page.keyboard.press('Escape')
        await sleep(250)
    }
}
/** The centre of the nth row of a list (top down), scrolled into view, and its id. */
const rowAt = (page, selector, n) =>
    page.evaluate(
        ({ selector, n }) => {
            const rows = [...document.querySelectorAll(selector)]
                .filter((r) => r.getAttribute('aria-disabled') !== 'true')
                .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
            const row = rows[Math.min(n, rows.length - 1)]
            if (!row) return
            window.nsePerfAct.centre(row)
            const r = row.getBoundingClientRect()
            return {
                x: r.x + Math.min(r.width / 2, 120),
                y: r.y + r.height / 2,
                label: row.getAttribute('aria-label'),
                count: rows.length,
            }
        },
        { selector, n },
    )
/** Scrolls the Timeline down until a row whose name matches `pattern` is drawn. */
const findRow = async (page, pattern) => {
    await page.evaluate((d) => {
        document.querySelector(`${d} [data-history-list]`).scrollTop = 0
    }, dialog)
    await sleep(300)
    for (let i = 0; i < 400; i++) {
        const found = await page.evaluate(
            ({ d, source }) => {
                const re = new RegExp(source)
                const row = [...document.querySelectorAll(`${d} [data-history-row]`)].find((r) =>
                    re.test(r.getAttribute('aria-label') ?? ''),
                )
                if (row) {
                    window.nsePerfAct.centre(row)
                    return true
                }
                const list = document.querySelector(`${d} [data-history-list]`)
                list.scrollTop += list.clientHeight
                return false
            },
            { d: dialog, source: pattern },
        )
        if (found) break
        await sleep(60)
    }
    await sleep(300)
    return page.evaluate(
        ({ d, source }) => {
            const re = new RegExp(source)
            const row = [...document.querySelectorAll(`${d} [data-history-row]`)].find((r) =>
                re.test(r.getAttribute('aria-label') ?? ''),
            )
            if (!row) return
            const r = row.getBoundingClientRect()
            return {
                x: r.x + Math.min(r.width / 2, 120),
                y: r.y + r.height / 2,
                label: row.getAttribute('aria-label'),
            }
        },
        { d: dialog, source: pattern },
    )
}
/** Closes the Go To popover, which a click elsewhere only dismisses. */
const closeGoTo = async (page) => {
    if (await visible(page, '[data-history-goto]')) {
        await page.keyboard.press('Escape')
        await sleep(300)
    }
}
const click = async (cdp, { x, y }) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
    })
    await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
    })
}
const centre = async (locator) => {
    const b = await locator.boundingBox({ timeout: 10_000 })
    if (!b) throw new Error('Not shown')
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
const keys = {
    ArrowDown: 40,
    ArrowUp: 38,
    Delete: 46,
    Enter: 13,
    Escape: 27,
    Home: 36,
    PageDown: 34,
}
const key = (cdp, name, type = 'rawKeyDown', autoRepeat = false) =>
    cdp.send('Input.dispatchKeyEvent', {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: keys[name],
        nativeVirtualKeyCode: keys[name],
        autoRepeat,
    })
const press = async (cdp, name) => {
    await key(cdp, name)
    await key(cdp, name, 'keyUp')
}

// Predicates (page expressions).
const peekShown = `(() => { const p = P.peek(); return !!p.key && p.shown === p.key && p.shown !== A && !p.loading })()`
const peekBefore = `P.peek().shown`
// The asked-for entry's change view is known (A: the entry shown before the input).
const changeKnown = `(() => { const p = P.peek(); return !!p.key && p.key !== A && p.changeKey === p.key && p.change !== 'loading' })()`
const notice = (pattern) =>
    `[...document.querySelectorAll('.notification, .notification-pill')].some((n) => ${pattern}.test(n.textContent) && !A.includes(n))`
// The app's modals are <dialog> elements; some menus and popovers use the role.
const openDialogs = `[...document.querySelectorAll('dialog[open], [role=dialog]')]`
/**
 * The Save or Download button the Preparing dialog shows once the file is ready. The dialog is
 * found by `[data-save-preparing]`, not by its text, which changes when the file is ready.
 */
const preparedButton = `[...document.querySelectorAll('dialog[open]')].filter((d) => d.querySelector('[data-save-preparing]')).flatMap((d) => [...d.querySelectorAll('button')]).find((b) => /^(Save|Download)$/.test(b.textContent.trim()))`
const noticesBefore = `[...document.querySelectorAll('.notification, .notification-pill')]`

// ---- the actions

/** Each: `prep` (not measured), `spec` (the probe's predicates), `input`, and `reset` (not measured). */
export const actions = {
    // History, Timeline
    historyOpen: {
        prep: closeHistory,
        spec: () => ({
            done: `document.querySelectorAll('${dialog} [data-history-row]').length > 0 && !document.querySelector('[data-history-loading]')`,
            busy: `!!document.querySelector('[data-history-loading]')`,
        }),
        input: (page) => page.keyboard.press('Shift+H'),
        reset: closeHistory,
    },
    /** Click the `row`th row, then `stride` rows further down at each repeat. */
    peekRow: {
        prep: async (page) => {
            await openHistory(page)
        },
        spec: () => ({
            before: peekBefore,
            done: peekShown,
            busy: 'P.peek().loading',
            marks: { change: changeKnown },
        }),
        input: async (page, cdp, cell, state) => {
            const n = (cell.row ?? 2) + state.rep * (cell.stride ?? 0)
            const at = await rowAt(page, `${dialog} [data-history-row]`, n)
            state.label = at?.label
            await sleep(300)
            const again = await rowAt(page, `${dialog} [data-history-row]`, n)
            await click(cdp, again)
        },
    },
    /** One ↓ in the Timeline: the next step's peek. */
    arrowStep: {
        prep: async (page, cell, state) => {
            if (state.rep === 0) {
                await openHistory(page)
                const at = await rowAt(page, `${dialog} [data-history-row]`, cell.row ?? 1)
                await page.mouse.click(at.x, at.y)
                await waitFor(
                    page,
                    () => !!window.nsePerf.peek().shown && !window.nsePerf.peek().loading,
                )
            }
            await sleep(400)
        },
        spec: () => ({
            before: peekBefore,
            done: peekShown,
            busy: 'P.peek().loading',
            marks: { change: changeKnown },
        }),
        input: (page, cdp) => press(cdp, 'ArrowDown'),
    },
    /** ↓ held for `seconds` (3) at 30 Hz: each repeat a peek; done when the last one shows. */
    arrowHold: {
        prep: async (page, cell) => {
            await openHistory(page)
            await noPeek(page)
            const at = await rowAt(page, `${dialog} [data-history-row]`, cell.row ?? 1)
            await page.mouse.click(at.x, at.y)
            await waitFor(
                page,
                () => !!window.nsePerf.peek().shown && !window.nsePerf.peek().loading,
            )
            await sleep(500)
        },
        spec: () => ({
            release: true,
            done: `(() => { const p = P.peek(); return !!p.key && p.shown === p.key && !p.loading })()`,
            marks: { change: changeKnown },
            timeout: 60_000,
        }),
        input: async (page, cdp, cell) => {
            const n = Math.round(((cell.seconds ?? 3) * 1000) / 33.3)
            for (let i = 0; i < n; i++) {
                const due = performance.now() + 33.3
                await key(cdp, cell.key ?? 'ArrowDown', 'rawKeyDown', i > 0)
                const wait = due - performance.now()
                if (wait > 0) await sleep(wait)
            }
            await key(cdp, cell.key ?? 'ArrowDown', 'keyUp')
        },
        // Back to Now and the top for the next repeat.
        reset: async (page) => noPeek(page),
    },
    /** Wheel over a list (`list`: 'timeline' or 'sessions') for 3 s, down. */
    listWheel: {
        prep: async (page, cell) => {
            await openHistory(page, cell.list === 'sessions' ? 'Recent Sessions' : 'Timeline')
            await noPeek(page)
            await page.evaluate(
                (s) => (document.querySelector(s).scrollTop = 0),
                cell.list === 'sessions' ? '[data-sessions-list]' : `${dialog} [data-history-list]`,
            )
            await sleep(500)
        },
        spec: () => ({ release: true, done: 'true', tail: 500 }),
        input: async (page, cdp, cell) => {
            const at = await centre(
                page.locator(
                    cell.list === 'sessions'
                        ? '[data-sessions-list]'
                        : `${dialog} [data-history-list]`,
                ),
            )
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
            const start = performance.now()
            for (let t = 0; t < 3000; t += 150)
                for (let i = 0; i < 8; i++, t += 40) {
                    const wait = start + t - performance.now()
                    if (wait > 0) await sleep(wait)
                    void cdp
                        .send('Input.dispatchMouseEvent', {
                            type: 'mouseWheel',
                            ...at,
                            deltaX: 0,
                            deltaY: 120,
                        })
                        .catch(() => {})
                }
        },
    },
    /** Peek a whole-chart edit (a flip of every note): its change diff and marks. */
    peekWhole: {
        prep: async (page, cell, state) => {
            await openHistory(page)
            await noPeek(page)
            const at = await findRow(page, cell.pattern ?? 'Flipped [\\d,]{4,}')
            if (!at) throw new Error('No whole-chart row')
            state.label = at.label
            // A neighbour first, so the whole-chart row is the next peek.
            await page.mouse.click(at.x, at.y + 30)
            await waitFor(
                page,
                () => !!window.nsePerf.peek().shown && !window.nsePerf.peek().loading,
            )
            await sleep(400)
            state.at = at
        },
        spec: () => ({
            before: peekBefore,
            done: peekShown,
            busy: 'P.peek().loading',
            marks: { change: changeKnown },
        }),
        input: (page, cdp, cell, state) => click(cdp, state.at),
    },
    /** While a whole-chart edit is peeked: an edge arrow (Changes Below or Above). */
    changeArrow: {
        prep: async (page, cell, state) => {
            if (state.rep === 0) await actions.peekWhole.prep(page, cell, state)
            if (state.rep === 0) await click(page._cdp, state.at)
            await waitFor(page, () => {
                const p = window.nsePerf.peek()
                return p.changeKey === p.key && p.change === 'known'
            })
            await sleep(600)
        },
        spec: () => ({ before: 'P.view.time', done: 'P.view.time !== A', tail: 500 }),
        input: async (page, cdp) => {
            const arrow = page.locator('[data-change-arrow]:not([aria-disabled="true"])').first()
            await click(cdp, await centre(arrow))
        },
    },
    /** Show Edits (the eye) while a whole-chart edit is peeked. */
    showEdits: {
        prep: async (page, cell, state) => {
            if (state.rep === 0) {
                await actions.peekWhole.prep(page, cell, state)
                await click(page._cdp, state.at)
            }
            await waitFor(page, () => {
                const p = window.nsePerf.peek()
                return p.changeKey === p.key && p.change === 'known'
            })
            await sleep(400)
        },
        spec: () => ({
            before: `document.querySelector('[data-show-edits]')?.getAttribute('aria-pressed')`,
            done: `document.querySelector('[data-show-edits]')?.getAttribute('aria-pressed') !== A`,
            tail: 300,
        }),
        input: async (page, cdp) => click(cdp, await centre(page.locator('[data-show-edits]'))),
    },
    /** Go To › Edits Here: the first answer and the end of the scan. */
    editsHere: {
        prep: async (page) => {
            await openHistory(page)
            await noPeek(page)
            await page.locator('[data-history-goto-button]').click()
            await page.locator('[data-goto-filter="here"]').waitFor()
            await sleep(300)
        },
        spec: () => ({
            done: `!!document.querySelector('[data-history-filter-banner]') && (document.querySelectorAll('${dialog} [data-history-row]').length > 1 || !!document.querySelector('[data-history-empty]'))`,
            // "Checking older steps…" while the scan runs: its end, once it has shown. The tail
            // keeps the probe until then.
            marks: {
                scanning: `(window.__scanSeen ||= !!document.querySelector('[data-history-scan]'))`,
                complete: `window.__scanSeen && !document.querySelector('[data-history-scan]')`,
            },
            tail: 100,
            until: 'complete',
            timeout: 120_000,
        }),
        input: async (page, cdp) =>
            click(cdp, await centre(page.locator('[data-goto-filter="here"]'))),
        reset: async (page) => {
            await waitFor(
                page,
                () => !document.querySelector('[data-history-scan]'),
                undefined,
                120_000,
            ).catch(() => {})
            await closeGoTo(page)
            await page.evaluate(() => (window.__scanSeen = false))
            await page
                .getByRole('button', { name: 'Show All' })
                .click()
                .catch(() => {})
            await sleep(300)
        },
    },
    /** Show All after Edits Here. */
    showAll: {
        prep: async (page) => {
            await actions.editsHere.prep(page)
            await page.locator('[data-goto-filter="here"]').click()
            await waitFor(
                page,
                () =>
                    !!document.querySelector('[data-history-filter-banner]') &&
                    !document.querySelector('[data-history-scan]'),
                undefined,
                120_000,
            )
            await closeGoTo(page)
            await sleep(300)
        },
        spec: () => ({
            done: `!document.querySelector('[data-history-filter-banner]') && document.querySelectorAll('${dialog} [data-history-row]').length > 1`,
        }),
        input: async (page, cdp) =>
            click(cdp, await centre(page.getByRole('button', { name: 'Show All' }))),
    },
    /** Expand the first ×N group drawn. */
    expandGroup: {
        prep: async (page) => {
            await openHistory(page)
            await noPeek(page)
            const found = await page.evaluate(() => {
                const b = document.querySelector('[data-history-disclosure][aria-expanded="false"]')
                window.nsePerfAct.centre(b)
                return !!b
            })
            if (!found) throw new Error('No group drawn')
            await sleep(300)
        },
        spec: () => ({
            before: `document.querySelectorAll('[data-history-disclosure][aria-expanded="true"]').length`,
            done: `document.querySelectorAll('[data-history-disclosure][aria-expanded="true"]').length > A`,
        }),
        input: async (page, cdp) =>
            click(
                cdp,
                await centre(
                    page.locator('[data-history-disclosure][aria-expanded="false"]').first(),
                ),
            ),
        reset: async (page) => {
            await page
                .locator('[data-history-disclosure][aria-expanded="true"]')
                .first()
                .click()
                .catch(() => {})
            await sleep(300)
        },
    },
    goToOpen: {
        prep: async (page) => {
            await openHistory(page)
            await noPeek(page)
            await sleep(200)
        },
        spec: () => ({
            done: `document.querySelectorAll('[data-goto-list] [role=option]').length > 1 && !document.querySelector('[data-goto-loading]')`,
            busy: `!!document.querySelector('[data-goto-loading]')`,
        }),
        input: async (page, cdp) =>
            click(cdp, await centre(page.locator('[data-history-goto-button]'))),
        reset: async (page) => {
            await page.keyboard.press('Escape')
            await sleep(300)
        },
    },
    /** Go To: pick the oldest day; the jump and its peek. */
    goToPick: {
        prep: async (page) => {
            await actions.goToOpen.prep(page)
            await page.locator('[data-history-goto-button]').click()
            await waitFor(
                page,
                () =>
                    document.querySelectorAll('[data-goto-list] [role=option]').length > 1 &&
                    !document.querySelector('[data-goto-loading]'),
            )
            await sleep(300)
        },
        spec: () => ({
            before: peekBefore,
            done: peekShown,
            busy: 'P.peek().loading',
            marks: { change: changeKnown },
        }),
        input: async (page, cdp, cell) => {
            const options = page.locator('[data-goto-list] [data-goto-item="day"]')
            const target = cell.pick === 'first' ? options.first() : options.last()
            await target.evaluate((e) => window.nsePerfAct.centre(e))
            await click(cdp, await centre(target))
        },
        reset: noPeek,
    },
    /** Restore the peeked row (`row` rows down, deeper each repeat). */
    restore: {
        prep: async (page, cell, state) => {
            await openHistory(page)
            await noPeek(page)
            const at = await rowAt(
                page,
                `${dialog} [data-history-row]`,
                (cell.row ?? 6) + state.rep * (cell.stride ?? 3),
            )
            await page.mouse.click(at.x, at.y)
            await waitFor(
                page,
                () => !!window.nsePerf.peek().shown && !window.nsePerf.peek().loading,
            )
            await sleep(500)
        },
        spec: () => ({ before: 'P.live().state', done: '!P.peek().key && P.live().state !== A' }),
        input: async (page, cdp) => click(cdp, await centre(page.locator('[data-peek-restore]'))),
    },
    /** Undo (z) with History closed; deeper each repeat, through slots restored lazily. */
    undo: {
        prep: async (page, cell) => {
            await closeHistory(page)
            await page
                .locator('canvas.editor-chart')
                .focus()
                .catch(() => {})
            await sleep(cell.pause ?? 500)
        },
        spec: () => ({
            before: 'P.live().state',
            done: 'P.live().state !== A && !P.live().loading',
            busy: 'P.live().loading',
        }),
        input: (page, cdp, cell) => page.keyboard.press(cell.key ?? 'z'),
    },
    /** A flip of `count` notes near the view with the Timeline open: the edit and the work after it. */
    editOpen: {
        prep: async (page, cell) => {
            await openHistory(page)
            await noPeek(page)
            await page.evaluate(
                (count) => window.nsePerf.selectNear(window.nsePerf.view.time, count),
                cell.count ?? 20,
            )
            await page
                .locator('canvas.editor-chart')
                .focus()
                .catch(() => {})
            await sleep(500)
        },
        spec: () => ({ before: 'P.live().state', done: 'P.live().state !== A', tail: 2500 }),
        input: (page) => page.keyboard.press('u'),
        reset: async (page) => {
            await page.keyboard.press('z')
            await sleep(2500)
        },
    },

    // History, Recent Sessions
    sessionsOpen: {
        prep: async (page) => {
            await openHistory(page)
            await noPeek(page)
            await sleep(300)
        },
        spec: () => ({
            done: `document.querySelectorAll('[data-sessions-row]').length > 0 && !document.querySelector('[data-sessions-loading]')`,
            busy: `!!document.querySelector('[data-sessions-loading]')`,
        }),
        input: async (page, cdp) =>
            click(
                cdp,
                await centre(page.getByRole('tab', { name: 'Recent Sessions', exact: true })),
            ),
        reset: async (page) => {
            await page.getByRole('tab', { name: 'Timeline', exact: true }).click()
            await sleep(300)
        },
    },
    /** Peek a session (cold): `row`, then `stride` rows further at each repeat. */
    sessionPeek: {
        prep: async (page, cell, state) => {
            await openHistory(page, 'Recent Sessions')
            const n = (cell.row ?? 3) + state.rep * (cell.stride ?? 7)
            await rowAt(page, '[data-sessions-row]', n)
            await sleep(400)
        },
        spec: () => ({ before: peekBefore, done: peekShown, busy: 'P.peek().loading' }),
        input: async (page, cdp, cell, state) =>
            click(
                cdp,
                await rowAt(
                    page,
                    '[data-sessions-row]',
                    (cell.row ?? 3) + state.rep * (cell.stride ?? 7),
                ),
            ),
    },
    /** Restore Session from a peeked row (Enter). */
    restoreSession: {
        prep: async (page, cell, state) => {
            await openHistory(page, 'Recent Sessions')
            const at = await rowAt(
                page,
                '[data-sessions-row]',
                (cell.row ?? 3) + state.rep * (cell.stride ?? 5),
            )
            await page.mouse.click(at.x, at.y)
            await waitFor(
                page,
                () => !!window.nsePerf.peek().shown && !window.nsePerf.peek().loading,
            )
            await sleep(500)
        },
        spec: () => ({
            before: 'P.live().state',
            done: '!P.peek().key && P.live().state !== A',
            timeout: 60_000,
        }),
        input: async (page, cdp) => press(cdp, 'Enter'),
        reset: async (page) => {
            // A switch prompt, when one asks.
            await page
                .getByRole('dialog')
                .getByRole('button', { name: /^(Switch|Continue|Restore)/ })
                .click({ timeout: 1000 })
                .catch(() => {})
            await sleep(1500)
        },
    },
    /** Delete a session (the Delete key on a row), then its Undo (unmeasured reset). */
    sessionDelete: {
        prep: async (page, cell, state) => {
            await openHistory(page, 'Recent Sessions')
            await noPeek(page)
            const at = await rowAt(page, '[data-sessions-row]', (cell.row ?? 4) + state.rep)
            await page.mouse.click(at.x, at.y)
            await waitFor(
                page,
                () => !!window.nsePerf.peek().shown && !window.nsePerf.peek().loading,
            )
            await sleep(500)
        },
        spec: () => ({
            before: `document.querySelectorAll('[data-sessions-deleted]').length`,
            done: `document.querySelectorAll('[data-sessions-deleted]').length > A`,
        }),
        input: (page, cdp) => press(cdp, 'Delete'),
        reset: async () => {
            await sleep(500)
        },
    },
    /** Undo on a deleted row. */
    sessionUndo: {
        prep: async (page, cell, state) => {
            await actions.sessionDelete.prep(page, cell, state)
            await page.keyboard.press('Delete')
            const undo = page.locator('[data-sessions-undo]').first()
            await undo.waitFor()
            await undo.evaluate((e) => window.nsePerfAct.centre(e))
            await sleep(500)
        },
        spec: () => ({
            before: `document.querySelectorAll('[data-sessions-deleted]').length`,
            done: `document.querySelectorAll('[data-sessions-deleted]').length < A`,
        }),
        input: async (page, cdp) =>
            click(cdp, await centre(page.locator('[data-sessions-undo]').first())),
    },

    // Settings › Local Data
    localData: {
        prep: async (page) => {
            await closeHistory(page)
            await closeDialogs(page)
            await page
                .locator('canvas.editor-chart')
                .focus()
                .catch(() => {})
        },
        spec: () => ({
            done: `!!document.querySelector('[data-delete-sessions-open]') && /Stored in this browser/.test(document.body.textContent)`,
            timeout: 30_000,
        }),
        input: (page) => page.keyboard.press(','),
        reset: closeDialogs,
    },
    // Settings opens with its first screen and mounts the other sections in the frames after.
    // `openSettings` is the first screen (the Language field and Local Data's heading), with any
    // staging task of 50 ms or more in `tailTask`; `openSettingsAll` runs until About, the last
    // section, is mounted.
    openSettings: {
        prep: async (page) => {
            await actions.localData.prep(page)
        },
        spec: () => ({
            done: `!!document.querySelector('dialog[open] [data-settings-section="editor"] select') && !!document.querySelector('dialog[open] [data-settings-section="localData"] h2')`,
            tail: 600,
        }),
        input: (page) => page.keyboard.press(','),
        reset: closeDialogs,
    },
    openSettingsAll: {
        prep: async (page) => {
            await actions.localData.prep(page)
        },
        spec: () => ({
            done: `!!document.querySelector('dialog[open] [data-settings-section="about"]')`,
        }),
        input: (page) => page.keyboard.press(','),
        reset: closeDialogs,
    },
    closeSettings: {
        prep: async (page) => {
            await actions.localData.prep(page)
            await page.keyboard.press(',')
            await page.locator('dialog[open] [data-settings-section="about"]').waitFor()
            await sleep(500)
        },
        spec: () => ({ done: `!document.querySelector('dialog[open]')` }),
        input: (page) => page.keyboard.press('Escape'),
        reset: closeDialogs,
    },
    deleteCounts: {
        prep: async (page) => {
            await actions.localData.prep(page)
            await page.keyboard.press(',')
            await page
                .locator('[data-delete-sessions-open]')
                .evaluate((e) => window.nsePerfAct.centre(e))
            await sleep(500)
        },
        spec: () => ({
            done: `!!document.querySelector('[data-delete-sessions] [data-delete-count]')`,
        }),
        input: async (page, cdp) =>
            click(cdp, await centre(page.locator('[data-delete-sessions-open]'))),
        reset: closeDialogs,
    },
    /** Delete Sessions… › All › Delete: every chain. Destructive: one repeat in its own group. */
    deleteAll: {
        prep: async (page) => {
            await actions.deleteCounts.prep(page)
            await page.locator('[data-delete-sessions-open]').click()
            await page.locator('[data-delete-range="all"]').click()
            const include = page.locator('[data-delete-include]')
            if (await include.count()) await include.check().catch(() => include.click())
            await page.locator('[data-delete-next]').click()
            await sleep(500)
        },
        spec: () => ({
            done: `!/Deleting…/.test(document.body.textContent) && !document.querySelector('[data-delete-sessions]')`,
            busy: `/Deleting…/.test(document.body.textContent)`,
            timeout: 600_000,
        }),
        input: async (page, cdp) =>
            click(
                cdp,
                await centre(
                    page
                        .getByRole('dialog')
                        .getByRole('button', { name: 'Delete', exact: true })
                        .last(),
                ),
            ),
        reset: closeDialogs,
    },
    exportRaw: {
        prep: async (page, cell, state) => {
            await actions.deleteCounts.prep(page)
            state.download = page
                .waitForEvent('download', { timeout: 600_000 })
                .catch(() => undefined)
        },
        spec: () => ({
            done: `window.__busySeen && !${openDialogs}.some((d) => /Loading…/.test(d.textContent))`,
            busy: `(window.__busySeen ||= /Loading…/.test(document.body.textContent))`,
            timeout: 600_000,
        }),
        input: async (page, cdp) =>
            click(
                cdp,
                await centre(page.getByRole('button', { name: 'Export Raw Data…', exact: true })),
            ),
        reset: async (page, cell, state) => {
            const download = await state.download
            const path = await download?.path().catch(() => undefined)
            state.bytes = path ? statSync(path).size : undefined
            await page.evaluate(() => (window.__busySeen = false))
            await closeDialogs(page)
        },
    },

    // Files
    /** Save (p) after an edit: to the bound file (`platform` opfs), or a download. */
    save: {
        prep: async (page, cell, state) => {
            await closeHistory(page)
            await closeDialogs(page)
            await page.evaluate(() => window.nsePerf.selectNear(window.nsePerf.view.time, 3))
            await page
                .locator('canvas.editor-chart')
                .focus()
                .catch(() => {})
            await page.keyboard.press('u')
            await page.evaluate(() => window.nsePerf.selectNotes(false))
            await sleep(1500)
            state.download = page
                .waitForEvent('download', { timeout: 600_000 })
                .catch(() => undefined)
            if (state.rep === 0 && !state.bound) {
                // The first Save names the file.
                await page.keyboard.press('p')
                const d = page.getByRole('dialog').filter({ hasText: /Save Project File|Download/ })
                await d.waitFor({ timeout: 30_000 })
                state.first = d
            }
        },
        spec: () => ({
            before: noticesBefore,
            // Done when the file is written, or when "Preparing…" shows its button. A build that
            // outlasts the first press waits for a second press by the user, outside the response.
            done: `${notice(/^(Saved to|Download started)/)} || ${preparedButton} !== undefined`,
            busy: `/Preparing/.test(document.body.textContent)`,
            marks: { preparing: `/Preparing/.test(document.body.textContent)` },
            timeout: 600_000,
        }),
        input: async (page, cdp, cell, state) => {
            if (state.first) {
                const button = state.first.getByRole('button', { name: /^(Save|Download)$/ }).last()
                await click(cdp, await centre(button))
                state.first = undefined
                state.bound = true
            } else await page.keyboard.press('p')
        },
        reset: async (page, cell, state) => {
            const ready = page
                .locator('dialog[open]', { has: page.locator('[data-save-preparing]') })
                .getByRole('button', { name: /^(Save|Download)$/ })
            if (await ready.count()) await ready.click()
            const download = await Promise.race([state.download, sleep(3000)])
            if (download) {
                const path = await download.path().catch(() => undefined)
                if (!path) throw new Error(`The download failed: ${await download.failure()}`)
                state.bytes = statSync(path).size
                if (cell.keepDownload) copyFileSync(path, cell.keepDownload)
            }
            await sleep(1000)
        },
    },
    /** Open (o) a level or project file `file` through the file input; done when the chart shows. */
    open: {
        prep: async (page, cell, state) => {
            await closeHistory(page)
            await closeDialogs(page)
            await page
                .locator('canvas.editor-chart')
                .focus()
                .catch(() => {})
            state.chooser = page.waitForEvent('filechooser')
            await sleep(300)
        },
        spec: () => ({
            before: 'P.live().state',
            // A level file may open with a warning on top: the chart under it counts.
            done: `P.live().state !== A && !${openDialogs}.some((d) => /Loading file…|Importing level…/.test(d.textContent))`,
            busy: `/Loading file…|Importing/.test(document.body.textContent)`,
            timeout: 600_000,
            tail: 500,
        }),
        input: async (page, cdp, cell, state) => {
            await page.keyboard.press('o')
            const chooser = await state.chooser
            await chooser.setFiles(cell.file)
        },
        // A project file's history is stored in the background. `imported` is the time from the
        // input until storage reports no import in progress (skipped when `waitImport` is false).
        reset: async (page, cell, state) => {
            if (cell.waitImport !== false)
                state.extra = {
                    imported: await page.evaluate(async () => {
                        const worker = await window.nsePerf.worker()
                        const from = window.nsePerfAct.inputAt()
                        for (;;) {
                            const pending = await worker.call('openPendingImports')
                            if (!pending.length) return performance.now() - from
                            await new Promise((done) => setTimeout(done, 50))
                        }
                    }),
                }
            await page
                .getByRole('dialog')
                .getByRole('button', { name: 'OK' })
                .click({ timeout: 2000 })
                .catch(() => {})
            await sleep(2000)
        },
    },
    /** New (n), leaving the open chart. */
    newChart: {
        prep: async (page) => {
            await closeHistory(page)
            await closeDialogs(page)
            await page
                .locator('canvas.editor-chart')
                .focus()
                .catch(() => {})
            await sleep(300)
        },
        spec: () => ({
            before: 'P.live().state',
            done: `P.live().state !== A && !${openDialogs}.length`,
            tail: 500,
        }),
        // An unedited chart (just opened) asks nothing.
        input: (page) => page.keyboard.press('n'),
    },
    exportLevel: {
        prep: async (page, cell, state) => {
            await closeHistory(page)
            await closeDialogs(page)
            await page
                .locator('canvas.editor-chart')
                .focus()
                .catch(() => {})
            await page.keyboard.press('Shift+P')
            await page.getByRole('dialog').getByRole('textbox', { name: 'File Name' }).waitFor()
            state.download = page
                .waitForEvent('download', { timeout: 120_000 })
                .catch(() => undefined)
            await sleep(300)
        },
        spec: () => ({
            before: noticesBefore,
            done: notice(/^(Exported|Download started)/),
            timeout: 120_000,
        }),
        input: async (page) =>
            page.getByRole('dialog').getByRole('textbox', { name: 'File Name' }).press('Enter'),
        reset: async (page, cell, state) => {
            await state.download
            await closeDialogs(page)
        },
    },
    /** Level Info › Check: the stored history checked, until its result shows. */
    check: {
        prep: async (page) => {
            await closeHistory(page)
            await closeDialogs(page)
            await page.locator('[data-status-label]').click()
            await page.locator('[data-level-info-check]').waitFor()
            await sleep(300)
        },
        spec: () => ({
            done: `${openDialogs}.some((d) => /No damage found|Checked |damaged/.test(d.textContent))`,
            busy: `${openDialogs}.some((d) => /Checking/.test(d.textContent))`,
            timeout: 600_000,
        }),
        input: async (page, cdp) =>
            click(cdp, await centre(page.locator('[data-level-info-check]'))),
        reset: closeDialogs,
    },
    /**
     * Go To's index of an opened file's session of `rows` rows (10,000 or 50,000), written as
     * rows of their own: the worker's first read, a read from its memo, and one after 20 rows are
     * added. Read through the storage worker, without the UI.
     */
    goToIndex: {
        measure: (page, cell, state) =>
            page.evaluate(
                async ({ count, tag }) => {
                    const worker = await window.nsePerf.worker()
                    const id = `perf-${tag}-${count}`
                    const now = Date.now()
                    const database = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('nse-local-data')
                        request.onsuccess = () => resolve(request.result)
                        request.onerror = () => reject(request.error)
                    })
                    const write = async (from, to) => {
                        const tx = database.transaction(['sessions', 'entries'], 'readwrite')
                        const entries = tx.objectStore('entries')
                        for (let seq = from; seq <= to; seq++)
                            entries.put({
                                sessionId: id,
                                seq,
                                time: now - (count + 40 - seq) * 120_000,
                                kind: 'edit',
                                snapshot: new Uint8Array(32),
                                kept: true,
                            })
                        tx.objectStore('sessions').put({
                            id,
                            chainId: id,
                            origin: 'nxsp',
                            lastSeq: to,
                            entryCount: to,
                        })
                        await new Promise((resolve) => (tx.oncomplete = resolve))
                    }
                    const read = async () => {
                        const began = performance.now()
                        await worker.call('readTimelineIndex', { sessionId: id, zone: 'UTC' })
                        return performance.now() - began
                    }
                    await write(1, count)
                    const first = await read()
                    const hits = []
                    for (let i = 0; i < 5; i++) hits.push(await read())
                    const extended = []
                    let last = count
                    for (let i = 0; i < 5; i++) {
                        await write(last + 1, last + 20)
                        last += 20
                        extended.push(await read())
                    }
                    database.close()
                    const median = (values) => values.sort((a, b) => a - b)[values.length >> 1]
                    return { response: first, first, hit: median(hits), extend: median(extended) }
                },
                { count: cell.rows ?? 10_000, tag: state.rep },
            ),
    },
    /** A dialog by its key or button (`open`: a key, or `click:<selector>`), until its title shows. */
    dialog: {
        prep: async (page) => {
            await closeHistory(page)
            await closeDialogs(page)
            await page
                .locator('canvas.editor-chart')
                .focus()
                .catch(() => {})
            await sleep(300)
        },
        spec: (cell) => ({
            done: `${openDialogs}.some((d) => d.textContent.includes(${JSON.stringify(cell.title)}))`,
        }),
        input: async (page, cdp, cell) =>
            cell.open.startsWith('click:')
                ? click(cdp, await centre(page.locator(cell.open.slice(6)).first()))
                : page.keyboard.press(cell.open),
        reset: closeDialogs,
    },
    /** A setting flipped by the harness (`setting`), and the frames that redraw it. */
    setting: {
        prep: async (page) => {
            await closeDialogs(page)
            await sleep(500)
        },
        spec: () => ({ done: 'true', tail: 1000 }),
        input: (page, cdp, cell) =>
            page.evaluate((name) => {
                window.nsePerfAct.input()
                window.nsePerf.settings[name] = !window.nsePerf.settings[name]
            }, cell.setting),
    },
}

/** The `act` scenario: one repeat of `cell.action`. */
export const runAction = async (page, cdp, cell, state, onTimeout) => {
    const action = actions[cell.action]
    if (!action) throw new Error(`Unknown action ${cell.action}`)
    page._cdp = cdp
    if (action.measure) {
        const result = await action.measure(page, cell, state)
        state.rep++
        return result
    }
    await action.prep?.(page, cell, state)
    await page.evaluate(() => window.nsePerfAct.unscroll())
    await page.evaluate((spec) => window.nsePerfAct.arm(spec), action.spec(cell, state))
    await action.input(page, cdp, cell, state)
    const spec = action.spec(cell, state)
    if (spec.release) await page.evaluate(() => window.nsePerfAct.release())
    await page.waitForFunction(() => window.nsePerfAct.finished(), null, {
        timeout: (spec.timeout ?? 30_000) + 10_000,
        polling: 100,
    })
    const result = await page.evaluate(() => window.nsePerfAct.result())
    if (result.timedOut) await onTimeout?.()
    await action.reset?.(page, cell, state)
    result.label = state.label
    if (state.bytes !== undefined) result.bytes = state.bytes
    Object.assign(result, state.extra)
    state.extra = undefined
    state.rep++
    return result
}
