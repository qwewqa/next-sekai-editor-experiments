// Runs a perf plan against a perf build in headed Chromium (docs/performance-testing.md).
//   npm run perf -- <plan.json> [--name <run>] [--out perf-results] [--port 5360]
//     [--affinity 0xFFFF0000] [--priority AboveNormal] [--url <served build>] [--no-build]
//     [--groups <regex of group ids>] [--timeout <minutes>]
//     [--preview-host main|worker]
// Builds with NSE_PERF=1 and sourcemaps into <out>/dist, serves it with vite preview, runs each
// group in a fresh browser profile and writes <out>/<run>/results.jsonl, traces and screenshots.
import { chromium } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { previewAssetsMode, stageDevPreviewAssets } from '../preview-assets.mjs'
import { installActionProbe, runAction } from './actions.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const parseArgs = (argv) => {
    const args = { positional: [] }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--no-build') args.noBuild = true
        else if (arg.startsWith('--')) args[arg.slice(2)] = argv[++i]
        else args.positional.push(arg)
    }
    return args
}
const args = parseArgs(process.argv.slice(2))
const planPath = args.positional[0]
if (!planPath) throw new Error('Usage: npm run perf -- <plan.json> [--name <run>]')
const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'))
const name = args.name ?? new Date().toISOString().replace(/[:.]/g, '-')
const out = resolve(root, args.out ?? 'perf-results')
const runDir = `${out}/${name}`
const traceDir = `${runDir}/traces`
const dist = `${out}/dist`
const port = Number(args.port ?? 5360)
mkdirSync(traceDir, { recursive: true })

const log = (...items) => {
    const text = items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    const line = `[${new Date().toISOString()}] ${text.join(' ')}`
    console.log(line)
    appendFileSync(`${runDir}/log.txt`, line + '\n')
}

// Pins a process tree to one set of cores at a raised priority (Windows), so runs are comparable.
// PowerShell variables ignore case: $affinity must not be named $mask, the string parameter.
const pinScript = `
param([string]$Roots, [string]$Mask, [string]$Priority)
$affinity = [IntPtr][Convert]::ToInt64($Mask, 16)
$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name
$queue = New-Object System.Collections.Queue
foreach ($r in ($Roots -split ',')) { $queue.Enqueue([uint32]$r) }
$seen = @{}; $out = @()
while ($queue.Count) {
    $id = $queue.Dequeue(); if ($seen.ContainsKey($id)) { continue }; $seen[$id] = $true
    try {
        $p = Get-Process -Id $id -ErrorAction Stop
        if ($p.ProcessorAffinity -ne $affinity) { $p.ProcessorAffinity = $affinity }
        if ("$($p.PriorityClass)" -ne $Priority) { $p.PriorityClass = $Priority }
        $p.Refresh()
        $out += [pscustomobject]@{ pid = $id; affinity = ('0x{0:X}' -f $p.ProcessorAffinity.ToInt64()); priority = "$($p.PriorityClass)" }
    } catch { }
    foreach ($c in $all) { if ($c.ParentProcessId -eq $id) { $queue.Enqueue([uint32]$c.ProcessId) } }
}
$out | ConvertTo-Json -Compress`
const pinFile = `${runDir}/pin.ps1`
writeFileSync(pinFile, pinScript)
const affinity = args.affinity?.replace(/^0x/i, '')
const priority = args.priority ?? 'AboveNormal'
/** Pins the given processes and their descendants; returns what it touched. */
const pin = (pids) => {
    if (!affinity || process.platform !== 'win32') return []
    try {
        const text = execFileSync(
            'powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', pinFile].concat([
                '-Roots',
                pids.join(','),
                '-Mask',
                affinity,
                '-Priority',
                priority,
            ]),
            { encoding: 'utf8' },
        )
        const list = JSON.parse(text || '[]')
        return Array.isArray(list) ? list : [list]
    } catch (error) {
        log('pin failed', String(error))
        return []
    }
}
const expectedAffinity = affinity && `0x${affinity.toUpperCase()}`
const offPin = (list) =>
    list.filter((p) => p.affinity !== expectedAffinity || p.priority !== priority).length

const PROFILES = {
    desktop1600: { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, throttle: 1 },
    desktop1280: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, throttle: 1 },
    desktop1280x4: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, throttle: 4 },
    phone: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
        throttle: 4,
    },
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
/** Runs `events` ([{ at, fn }]) on schedule from now; sends are not awaited. */
const schedule = async (events) => {
    const start = performance.now()
    const late = []
    for (const event of events) {
        const wait = start + event.at - performance.now()
        if (wait > 1.5) await sleep(wait - 1)
        while (performance.now() < start + event.at) await new Promise((done) => setImmediate(done))
        late.push(performance.now() - start - event.at)
        event.fn()
    }
    late.sort((a, b) => a - b)
    return { lateP50: late[late.length >> 1] ?? 0, lateMax: late.at(-1) ?? 0 }
}

// In the page: frames, long animation frames, long tasks and the app's probes over one run.
const installCollector = () => {
    // The last visibilitychange and pagehide listeners, after the app's.
    for (const type of ['visibilitychange', 'pagehide', 'freeze'])
        (type === 'freeze' ? document : window).addEventListener(type, () =>
            (window.nseVis ??= []).push({
                type,
                phase: 'last',
                state: document.visibilityState,
                t: performance.now(),
            }),
        )
    window.nsePerfRun = {
        start(noLoop) {
            const P = window.nsePerf
            const r = (this.r = { frames: [], loaf: [], longtasks: [], on: true })
            window.nseVis = []
            P.perfSamples.samples = {}
            P.perfSamples.on = true
            r.paints = P.minimapStats.paints
            r.annotationPaints = P.minimapStats.annotationPaints
            const loop = (t) => {
                if (!r.on) return
                r.frames.push([t, P.view.time, P.view.cursorTime])
                requestAnimationFrame(loop)
            }
            if (!noLoop) requestAnimationFrame(loop)
            r.loafObserver = new PerformanceObserver((list) => {
                for (const e of list.getEntries())
                    r.loaf.push({
                        start: e.startTime,
                        duration: e.duration,
                        blocking: e.blockingDuration,
                        renderStart: e.renderStart,
                        scripts: e.scripts.map((s) => ({
                            invoker: s.invoker,
                            fn: s.sourceFunctionName,
                            url: s.sourceURL,
                            duration: s.duration,
                            forced: s.forcedStyleAndLayoutDuration,
                        })),
                    })
            })
            r.loafObserver.observe({ type: 'long-animation-frame' })
            r.taskObserver = new PerformanceObserver((list) => {
                for (const e of list.getEntries())
                    r.longtasks.push({ start: e.startTime, duration: e.duration })
            })
            r.taskObserver.observe({ type: 'longtask' })
        },
        stop() {
            const P = window.nsePerf
            const r = this.r
            r.on = false
            r.loafObserver.disconnect()
            r.taskObserver.disconnect()
            P.perfSamples.on = false
            return {
                vis: window.nseVis,
                frames: r.frames,
                loaf: r.loaf,
                longtasks: r.longtasks,
                probes: P.perfSamples.samples,
                paints: P.minimapStats.paints - r.paints,
                annotationPaints: P.minimapStats.annotationPaints - r.annotationPaints,
                visibility: document.visibilityState,
            }
        },
    }
}

// A display slower than the monitor: animation frames run on every nth vsync.
const gateFrames = (hz) => {
    const native = window.requestAnimationFrame.bind(window)
    const period = 1000 / hz
    let queue = new Map()
    let nextId = 1
    let scheduled = false
    let last = -Infinity
    const pump = (t) => {
        if (t - last < period - 2) {
            native(pump)
            return
        }
        last = t
        scheduled = false
        const callbacks = queue
        queue = new Map()
        for (const callback of callbacks.values())
            try {
                callback(t)
            } catch (error) {
                reportError(error)
            }
    }
    window.requestAnimationFrame = (callback) => {
        const id = nextId++
        queue.set(id, callback)
        if (!scheduled) {
            scheduled = true
            native(pump)
        }
        return id
    }
    window.cancelAnimationFrame = (id) => queue.delete(id)
}

// ---- statistics

const pct = (sorted, p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN
/** Frame intervals over the moving window (`view` or `cursor` changes), or every frame (`all`). */
const summarizeFrames = (frames, key, hz) => {
    const k = key === 'cursor' ? 2 : 1
    let first = -1
    let last = -1
    if (key === 'all' && frames.length > 2) [first, last] = [0, frames.length - 2]
    else
        for (let i = 1; i < frames.length; i++)
            if (frames[i][k] !== frames[i - 1][k]) {
                if (first < 0) first = i - 1
                last = i
            }
    if (first < 0) return { frames: 0 }
    const end = Math.min(frames.length - 1, last + 1)
    const intervals = []
    for (let i = first + 1; i <= end; i++) intervals.push(frames[i][0] - frames[i - 1][0])
    const sorted = [...intervals].sort((a, b) => a - b)
    const budget = 1000 / hz
    const mean = intervals.reduce((a, x) => a + x, 0) / intervals.length
    const span = frames[end][0] - frames[first][0]
    const share = (test) => intervals.filter(test).length / intervals.length
    return {
        frames: intervals.length,
        spanMs: span,
        fps: (intervals.length / span) * 1000,
        p50: pct(sorted, 50),
        p95: pct(sorted, 95),
        p99: pct(sorted, 99),
        max: sorted.at(-1),
        late: share((x) => x > budget * 1.5),
        over33: share((x) => x > 33.4),
        over2x: intervals.filter((x) => x > budget * 2.08).length,
        over4x: intervals.filter((x) => x > budget * 4.16).length,
        sd: Math.sqrt(intervals.reduce((a, x) => a + (x - mean) ** 2, 0) / intervals.length),
        jumps:
            intervals.slice(1).filter((x, i) => Math.abs(x - intervals[i]) > budget * 0.9).length /
            Math.max(1, intervals.length - 1),
        moved: Math.abs(frames[end][k] - frames[first][k]),
        windowStart: frames[first][0],
        windowEnd: frames[end][0],
    }
}
/** Each probe's spread, and how many samples pass the work budget and twice and four times it. */
const summarizeProbes = (probes, budget) =>
    Object.fromEntries(
        Object.entries(probes).map(([probe, list]) => {
            const sorted = [...list].sort((a, b) => a - b)
            const over = (n) => list.filter((x) => x > n * budget).length
            return [
                probe,
                {
                    n: list.length,
                    sum: list.reduce((a, b) => a + b, 0),
                    p50: pct(sorted, 50),
                    p95: pct(sorted, 95),
                    p99: pct(sorted, 99),
                    max: sorted.at(-1),
                    overBudget: over(1),
                    over2x: over(2),
                    over4x: over(4),
                },
            ]
        }),
    )
const summarizeLongFrames = (loaf, frames) => {
    const inWindow = loaf.filter(
        (e) => e.start + e.duration >= frames.windowStart && e.start <= frames.windowEnd,
    )
    return {
        count: inWindow.length,
        maxMs: Math.max(0, ...inWindow.map((e) => e.duration)),
        forcedLayoutMs: inWindow.reduce(
            (a, e) => a + e.scripts.reduce((b, s) => b + s.forced, 0),
            0,
        ),
    }
}

// ---- tracing

const traceCategories = [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'disabled-by-default-v8.gc',
    'v8.execute',
    'v8',
    'blink.user_timing',
    'blink',
    'gpu',
    'viz',
    'cc',
    'benchmark',
    'latencyInfo',
    'input',
    'toplevel',
    'loading',
]
// Light traces: task timings without the CPU profiler's overhead (`traceEach`).
const lightCategories = [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-v8.gc',
    'v8.execute',
    'blink.user_timing',
    'toplevel',
    'gpu',
    'viz',
]
const startTrace = (cdp, light) =>
    cdp.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        traceConfig: {
            includedCategories: light ? lightCategories : traceCategories,
            recordMode: 'recordAsMuchAsPossible',
        },
    })
const endTrace = async (cdp) => {
    const complete = new Promise((done) => cdp.once('Tracing.tracingComplete', done))
    await cdp.send('Tracing.end')
    const { stream } = await complete
    const chunks = []
    for (;;) {
        const { data, eof, base64Encoded } = await cdp.send('IO.read', {
            handle: stream,
            size: 1 << 20,
        })
        chunks.push(Buffer.from(data, base64Encoded ? 'base64' : 'utf8'))
        if (eof) break
    }
    await cdp.send('IO.close', { handle: stream })
    return Buffer.concat(chunks)
}

// The path caches' counters over a run and their resident bytes at its end (`nsePerf.pathCaches`).
const pathCaches = (page) => page.evaluate(() => window.nsePerf.pathCaches?.() ?? {})
const cacheDelta = (before, after) =>
    Object.fromEntries(
        Object.entries(after).map(([name, end]) => [
            name,
            Object.fromEntries(
                Object.entries(end).map(([key, value]) => [
                    key,
                    ['bytes', 'pinned'].includes(key) ? value : value - (before[name]?.[key] ?? 0),
                ]),
            ),
        ]),
    )

// ---- scenarios

const pane = (page) =>
    page.evaluate(() => {
        const { view } = window.nsePerf
        return {
            x: view.x + view.w / 2,
            y: view.y + view.h / 2,
            left: view.x,
            top: view.y,
            w: view.w,
            h: view.h,
        }
    })
const send = (cdp, method, params) => () => void cdp.send(method, params).catch(() => {})
const wheel = (cdp, x, y, deltaY) =>
    send(cdp, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
const touch = (cdp, type, x, y) =>
    send(cdp, 'Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    })
const mouse = (cdp, type, x, y) =>
    send(cdp, 'Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
    })
const tick = 1000 / 120

const scenarios = {
    // Mouse wheel: 120-delta notches, 8 a burst 40 ms apart, 150 ms between bursts, 3 s.
    async wheel(page, cdp) {
        const c = await pane(page)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
        const events = []
        for (let t = 0; t < 3000; t += 150)
            for (let i = 0; i < 8; i++, t += 40)
                events.push({ at: t, fn: wheel(cdp, c.x, c.y, -120) })
        return schedule(events)
    },
    // Trackpad: pixel deltas at 120 Hz, three pushes with momentum, 3 s.
    async trackpad(page, cdp) {
        const c = await pane(page)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
        const events = []
        for (let g = 0; g < 3; g++)
            for (let s = 0; s < 900; s += tick) {
                const v = s < 150 ? 4000 * (s / 150) : 4000 * Math.exp(-(s - 150) / 250)
                const d = Math.round((v * tick) / 1000)
                if (d >= 1) events.push({ at: g * 1000 + s, fn: wheel(cdp, c.x, c.y, -d) })
            }
        return schedule(events)
    },
    // Page Up held: key repeats at 30 Hz for 3 s.
    async pagekeys(page, cdp) {
        const key = {
            key: 'PageUp',
            code: 'PageUp',
            windowsVirtualKeyCode: 33,
            nativeVirtualKeyCode: 33,
        }
        const events = []
        for (let i = 0; i < 90; i++)
            events.push({
                at: i * 33.3,
                fn: send(cdp, 'Input.dispatchKeyEvent', {
                    type: 'rawKeyDown',
                    ...key,
                    autoRepeat: i > 0,
                }),
            })
        events.push({
            at: 3000,
            fn: send(cdp, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key }),
        })
        return schedule(events)
    },
    // A held touch drag in the quick-scroll zone, 0.7 panes down and back each second, 3 s.
    async quicktouch(page, cdp) {
        const c = await pane(page)
        const x = c.left + c.w - 12
        const y0 = c.top + c.h * 0.85
        const events = [{ at: 0, fn: touch(cdp, 'touchStart', x, y0) }]
        for (let s = tick; s <= 3000; s += tick) {
            const phase = (s % 1000) / 1000
            const fold = phase < 0.5 ? phase * 2 : 2 - phase * 2
            events.push({ at: s, fn: touch(cdp, 'touchMove', x, y0 - fold * c.h * 0.7) })
        }
        events.push({ at: 3000 + tick, fn: touch(cdp, 'touchEnd', x, y0) })
        return schedule(events)
    },
    // About 25 screens in 2.5 s: a trackpad fling on desktop, quick-scroll flicks on touch.
    async flick(page, cdp, cell, profile) {
        const c = await pane(page)
        const events = []
        if (profile.hasTouch) {
            const x = c.left + c.w - 12
            const y0 = c.top + c.h * 0.15
            for (let f = 0; f < 10; f++) {
                const t0 = f * 250
                events.push({ at: t0, fn: touch(cdp, 'touchStart', x, y0) })
                for (let i = 1; i <= 12; i++)
                    events.push({
                        at: t0 + i * tick,
                        fn: touch(cdp, 'touchMove', x, y0 + (i / 12) * c.h * 0.75),
                    })
                events.push({ at: t0 + 13 * tick, fn: touch(cdp, 'touchEnd', x, 0) })
            }
        } else {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
            const tau = 700
            const v0 = (25 * c.h) / tau
            for (let s = 0; s < 2500; s += tick) {
                const d = Math.round(v0 * Math.exp(-s / tau) * tick)
                if (d >= 1) events.push({ at: s, fn: wheel(cdp, c.x, c.y, -d) })
            }
        }
        return schedule(events)
    },
    // Grab the minimap box and drag it to the strip's foot over 2 s.
    async minimapdrag(page, cdp, cell, profile) {
        const strip = await page.locator('[data-minimap]').boundingBox()
        const box = await page.locator('[data-minimap-box]').boundingBox()
        if (!strip || !box) throw new Error('The minimap is not shown')
        const x = box.x + box.width / 2
        const y0 = box.y + box.height / 2
        const y1 = strip.y + strip.height * 0.95
        const [down, move, up] = profile.hasTouch
            ? [
                  (y) => touch(cdp, 'touchStart', x, y),
                  (y) => touch(cdp, 'touchMove', x, y),
                  (y) => touch(cdp, 'touchEnd', x, y),
              ]
            : [
                  (y) => mouse(cdp, 'mousePressed', x, y),
                  (y) => mouse(cdp, 'mouseMoved', x, y),
                  (y) => mouse(cdp, 'mouseReleased', x, y),
              ]
        if (!profile.hasTouch)
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y0 })
        const steps = Math.round(2000 / tick)
        const events = [{ at: 0, fn: down(y0) }]
        for (let i = 1; i <= steps; i++)
            events.push({ at: i * tick, fn: move(y0 + ((y1 - y0) * i) / steps) })
        events.push({ at: (steps + 1) * tick, fn: up(y1) })
        return schedule(events)
    },
    // Playback with Follow from the view's start, `seconds` long at `speed`.
    async play(page, cdp, cell) {
        const steps = { 1: 0, 1.5: 1, 2: 2 }[cell.speed ?? 1] ?? 0
        await page.evaluate((steps) => {
            const P = window.nsePerf
            for (let i = 0; i < steps; i++) P.changePlayerSpeed(1)
            P.startOrStopPlayer()
        }, steps)
        await sleep((cell.seconds ?? 15) * 1000)
        await page.evaluate((steps) => {
            const P = window.nsePerf
            if (P.isPlaying.value) P.startOrStopPlayer()
            for (let i = 0; i < steps; i++) P.changePlayerSpeed(-1)
        }, steps)
    },
    // A separator drag (`handle`: its accessible name), out by `dx` and back twice over 2 s.
    async resizedrag(page, cdp, cell) {
        const b = await page
            .getByRole('separator', { name: cell.handle, exact: true })
            .boundingBox()
        if (!b) throw new Error(`No separator "${cell.handle}"`)
        const x0 = b.x + b.width / 2
        const y = b.y + b.height / 2
        const dx = cell.dx ?? -80
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y })
        const steps = Math.round(2000 / tick)
        const events = [{ at: 0, fn: mouse(cdp, 'mousePressed', x0, y) }]
        for (let i = 1; i <= steps; i++) {
            const phase = ((i / steps) * 2) % 1
            const fold = phase < 0.5 ? phase * 2 : 2 - phase * 2
            events.push({ at: i * tick, fn: mouse(cdp, 'mouseMoved', x0 + dx * fold, y) })
        }
        events.push({ at: (steps + 1) * tick, fn: mouse(cdp, 'mouseReleased', x0, y) })
        return schedule(events)
    },
    // One-shot edits on the prepared selection: flip, undo, redo, delete, undo, copy and paste
    // (hovering the paste ghost, then placing it), undo, then the Select tool again (F). Each
    // is marked, with `wait` ms (1500) after it.
    async edits(page, cdp, cell) {
        const c = await pane(page)
        const wait = cell.wait ?? 1500
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
        const step = async (mark, key) => {
            await page.evaluate((m) => performance.mark(m), mark)
            await page.keyboard.press(key)
            await sleep(wait)
        }
        await step('nse-flip', 'u')
        await step('nse-undo', 'z')
        await step('nse-redo', 'y')
        await step('nse-delete', 'Delete')
        await step('nse-undo2', 'z')
        await page.keyboard.press('c')
        await sleep(300)
        await page.keyboard.press('v')
        await sleep(300)
        await page.evaluate(() => performance.mark('nse-pastehover'))
        const steps = Math.round(1000 / tick)
        const events = []
        for (let i = 1; i <= steps; i++)
            events.push({
                at: i * tick,
                fn: send(cdp, 'Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: c.x + (60 * i) / steps,
                    y: c.y - (40 * i) / steps,
                }),
            })
        await schedule(events)
        await sleep(200)
        await page.evaluate(() => performance.mark('nse-paste'))
        mouse(cdp, 'mousePressed', c.x + 60, c.y - 40)()
        await sleep(30)
        mouse(cdp, 'mouseReleased', c.x + 60, c.y - 40)()
        await sleep(wait)
        await step('nse-undo3', 'z')
        await page.keyboard.press('f')
        await sleep(300)
    },
    // A horizontal drag across the preview image, which scrubs a second per image width, back
    // and forth for 3 s.
    async scrub(page, cdp, cell, profile) {
        const b = await page.locator('.preview-viewport canvas').first().boundingBox()
        if (!b) throw new Error('No preview')
        const x0 = b.x + b.width * 0.5
        const y = b.y + b.height * 0.5
        const [down, move, up] = profile.hasTouch
            ? [
                  (x) => touch(cdp, 'touchStart', x, y),
                  (x) => touch(cdp, 'touchMove', x, y),
                  (x) => touch(cdp, 'touchEnd', x, y),
              ]
            : [
                  (x) => mouse(cdp, 'mousePressed', x, y),
                  (x) => mouse(cdp, 'mouseMoved', x, y),
                  (x) => mouse(cdp, 'mouseReleased', x, y),
              ]
        if (!profile.hasTouch)
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y })
        const steps = Math.round(3000 / tick)
        const events = [{ at: 0, fn: down(x0) }]
        for (let i = 1; i <= steps; i++) {
            const phase = (i / steps) * 3
            const swing = Math.sin(phase * Math.PI * 2) * b.width * 0.4
            events.push({ at: i * tick, fn: move(x0 + swing) })
        }
        events.push({ at: (steps + 1) * tick, fn: up(x0) })
        return schedule(events)
    },
    // Taps on a step button (cell.button) every 120 ms for 3 s: one seek a tap.
    async seek(page, cdp, cell, profile) {
        const button = page.getByRole('button', { name: cell.button, exact: true }).first()
        const b = await button.boundingBox()
        if (!b) throw new Error('No step button')
        const x = b.x + b.width / 2
        const y = b.y + b.height / 2
        const events = []
        for (let t = 0; t < 3000; t += 120) {
            if (profile.hasTouch) {
                events.push({ at: t, fn: touch(cdp, 'touchStart', x, y) })
                events.push({ at: t + 40, fn: touch(cdp, 'touchEnd', x, y) })
            } else {
                events.push({ at: t, fn: mouse(cdp, 'mousePressed', x, y) })
                events.push({ at: t + 40, fn: mouse(cdp, 'mouseReleased', x, y) })
            }
        }
        return schedule(events)
    },
    // The cursor set to a new time every 120 ms for 3 s, as clicks on the chart or minimap do.
    async cursorjumps(page) {
        return page.evaluate(async () => {
            const P = window.nsePerf
            const end = P.chartEnd()
            let seed = 7
            for (let i = 0; i < 25; i++) {
                seed = (seed * 16807) % 2147483647
                P.view.cursorTime = (seed / 2147483647) * end
                await new Promise((d) => setTimeout(d, 120))
            }
        })
    },
    // The note speed changed every frame for 240 frames, as a slider drag does.
    async notespeed(page) {
        return page.evaluate(async () => {
            const P = window.nsePerf
            const start = P.settings.previewNoteSpeed
            for (let i = 0; i < 240; i++) {
                await new Promise((d) => requestAnimationFrame(d))
                P.settings.previewNoteSpeed =
                    Math.round((6 + 4 * Math.abs(Math.sin(i / 40))) * 100) / 100
            }
            P.settings.previewNoteSpeed = start
            for (let i = 0; i < 10; i++) await new Promise((d) => requestAnimationFrame(d))
        })
    },
    // The chart opened again over itself: the first frames after an open.
    async reopen(page, cdp, cell, profile, prep, group) {
        await page.evaluate(() => performance.mark('nse-open'))
        const opening = page.waitForEvent('filechooser')
        await page.mouse.move(5, 5)
        await page.keyboard.press('o')
        await (
            await opening
        ).setFiles({
            name: 'level.json',
            mimeType: 'application/json',
            buffer: readFileSync(resolve(root, group.chart)),
        })
        await page
            .locator('.notification, .notification-pill')
            .filter({ hasText: /^Opened level/ })
            .last()
            .waitFor({ timeout: 120_000 })
        await page.evaluate(() => performance.mark('nse-opened'))
        await page
            .getByRole('dialog')
            .getByRole('button', { name: 'OK' })
            .click({ timeout: 1500 })
            .catch(() => {})
        await sleep(cell.wait ?? 3000)
    },
    // The main thread's heap and each worker's after a forced GC: opened, then after `seconds`
    // (60) of playback from the cell's start.
    async heaps(page, cdp, cell) {
        const snap = async (label) => {
            await cdp.send('HeapProfiler.collectGarbage')
            const workers = await workerHeaps(cdp, true)
            await sleep(300)
            await cdp.send('HeapProfiler.collectGarbage')
            const heap = await cdp.send('Runtime.getHeapUsage')
            return { label, main: heap.usedSize, workers }
        }
        const out = [await snap('opened')]
        await scenarios.play(page, cdp, { ...cell, seconds: cell.seconds ?? 60 })
        out.push(await snap('played'))
        log('heaps', JSON.stringify(out))
        return out
    },
    // Nothing for `seconds` (5): what the editor does while idle.
    async idle(page, cdp, cell) {
        const before = procs()
        await sleep((cell.seconds ?? 5) * 1000)
        return { before, after: procs() }
    },
    // One wheel notch after an 800 ms pause, then 1.2 s still: the activity flip and its return.
    async notch(page, cdp) {
        const c = await pane(page)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
        await sleep(800)
        await page.evaluate(() => performance.mark('nse-notch'))
        wheel(cdp, c.x, c.y, -120)()
        await sleep(1200)
    },
    // Flip the selection (prepared), wait for its flush, undo, wait again.
    async editflip(page, cdp, cell) {
        await page.evaluate(() => performance.mark('nse-edit'))
        await page.keyboard.press('u')
        await sleep(cell.wait ?? 2500)
        await page.evaluate(() => performance.mark('nse-undo'))
        await page.keyboard.press('z')
        await sleep(cell.wait ?? 2500)
    },
    // Drag the prepared selection by one of its notes, `dx` px over 1 s; then undo.
    async drag(page, cdp, cell, profile, prep) {
        const at = prep?.[0]
        if (!at) throw new Error('Nothing selected to drag')
        const dx = cell.dx ?? 60
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
        await sleep(300)
        await page.evaluate(() => performance.mark('nse-drag'))
        const steps = Math.round(1000 / tick)
        const events = [{ at: 0, fn: mouse(cdp, 'mousePressed', at.x, at.y) }]
        for (let i = 1; i <= steps; i++)
            events.push({
                at: i * tick,
                fn: mouse(cdp, 'mouseMoved', at.x + (dx * i) / steps, at.y),
            })
        events.push({ at: (steps + 2) * tick, fn: mouse(cdp, 'mouseReleased', at.x + dx, at.y) })
        const input = await schedule(events)
        await page.evaluate(() => performance.mark('nse-drop'))
        await sleep(cell.wait ?? 2500)
        await page.evaluate(() => performance.mark('nse-undo'))
        await page.keyboard.press('z')
        await sleep(cell.wait ?? 2500)
        return input
    },
    // An edit, `after` ms, then another tab in front (the page hidden) and back; then undo.
    async hide(page, cdp, cell) {
        await page.evaluate(() => performance.mark('nse-edit'))
        await page.keyboard.press('u')
        await sleep(cell.after ?? 2000)
        // Playwright keeps a background tab visible, so the hide is simulated: the page reports
        // hidden and gets visibilitychange, which is the path the app's lifecycle handler takes.
        const hidden = await page.evaluate(() => {
            const set = (state) => {
                Object.defineProperty(document, 'visibilityState', {
                    configurable: true,
                    get: () => state,
                })
                Object.defineProperty(document, 'hidden', {
                    configurable: true,
                    get: () => state === 'hidden',
                })
            }
            performance.mark('nse-hide')
            set('hidden')
            const start = performance.now()
            document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
            window.nseShow = () => {
                set('visible')
                document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
            }
            return performance.now() - start
        })
        await sleep(2000)
        await page.evaluate(() => window.nseShow())
        await sleep(1500)
        await page.keyboard.press('z')
        await sleep(2500)
        return { hiddenMs: hidden }
    },
    // Storage unavailable: an edit, then scrolling back and forth for `seconds` (with a second
    // edit halfway), across the 10 s journal ticks.
    async journal(page, cdp, cell) {
        const c = await pane(page)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
        await page.keyboard.press('u')
        const seconds = cell.seconds ?? 22
        const events = []
        for (let s = 0; s < seconds * 1000; s += tick) {
            const dir = Math.floor(s / 2000) % 2 ? 1 : -1
            events.push({ at: s, fn: wheel(cdp, c.x, c.y, dir * (cell.step ?? 12)) })
        }
        events.push({ at: (seconds * 1000) / 2, fn: () => void page.keyboard.press('u') })
        return schedule(events)
    },
    // A user action (`action`, scripts/perf/actions.mjs): input to the frame that shows its result.
    async act(page, cdp, cell) {
        if (!actionStates.has(cell)) actionStates.set(cell, { rep: 0 })
        const state = actionStates.get(cell)
        const result = await runAction(page, cdp, cell, state, async () => {
            // What the page showed when the result never came.
            await page.screenshot({ path: `${runDir}/timeout-${cell.action}-${state.rep}.png` })
        })
        return result
    },
    // A reload: the startup gate, the chart and the session it continues (a group's `boot`).
    async startup(page) {
        await page.reload()
        await page.waitForFunction(() => window.nseBoot?.done !== undefined, null, {
            timeout: 300_000,
            polling: 100,
        })
        await sleep(1500)
        const boot = await page.evaluate(() => window.nseBoot)
        // The reload ended the collector's run; a new one for runOnce to stop.
        await page.evaluate(() => window.nsePerfRun.start(true))
        return boot
    },
    // Memory over a long scroll, a long playback, then New and Open again.
    async memory(page, cdp, cell, profile, prep, group) {
        const out = []
        const notes = () =>
            page.evaluate(
                () => [...window.nsePerf.state.value.store.slides.note.values()].flat().length,
            )
        const snap = async (label) => {
            await cdp.send('HeapProfiler.collectGarbage')
            await sleep(300)
            await cdp.send('HeapProfiler.collectGarbage')
            await sleep(700)
            const heap = await cdp.send('Runtime.getHeapUsage')
            const dom = await cdp.send('Memory.getDOMCounters').catch(() => ({}))
            const n = await notes()
            const caches = await pathCaches(page)
            out.push({
                label,
                at: Date.now(),
                notes: n,
                heapUsed: heap.usedSize,
                heapTotal: heap.totalSize,
                dom,
                pathCaches: caches,
                procs: procs(),
            })
            log(
                'memory',
                label,
                (heap.usedSize / 2 ** 20).toFixed(1),
                'MiB',
                'notes',
                n,
                'dom',
                JSON.stringify(dom),
                'path cache',
                ((caches.chart?.bytes ?? 0) / 2 ** 20).toFixed(1),
                'MiB',
            )
        }
        const profileTo = async (label) => {
            const { profile } = await cdp.send('HeapProfiler.getSamplingProfile')
            writeFileSync(`${runDir}/heap-${label}.json`, JSON.stringify(profile))
        }
        const sweep = (pps, layout) =>
            page.evaluate(
                async ({ pps, layout }) => {
                    const P = window.nsePerf
                    P.settings.pps = pps
                    P.view.layout = layout
                    const end = P.chartEnd()
                    const step = P.view.h / P.settings.pps / 3
                    for (let t = 0; t <= end; t += step) {
                        P.view.time = t
                        await new Promise((d) => requestAnimationFrame(d))
                    }
                    for (let t = end; t >= 0; t -= step * 2) {
                        P.view.time = t
                        await new Promise((d) => requestAnimationFrame(d))
                    }
                    return { end }
                },
                { pps, layout },
            )
        await cdp.send('HeapProfiler.enable')
        await cdp.send('HeapProfiler.startSampling', { samplingInterval: 65536 })
        await snap('opened')
        for (const [pps, layout, label] of [
            [1000, 'composed', 'sweep composed pps1000'],
            [1000, 'composed', 'sweep composed pps1000 again'],
            [100, 'composed', 'sweep composed pps100'],
            [1000, 'basic', 'sweep basic pps1000'],
            [1000, 'composed', 'sweep composed pps1000 third'],
        ]) {
            await sweep(pps, layout)
            await snap(`after ${label}`)
        }
        await profileTo('swept')
        await page.evaluate(() => {
            const P = window.nsePerf
            P.view.layout = 'composed'
            P.settings.pps = 1000
            P.view.time = P.view.cursorTime = 0
        })
        await sleep(500)
        const playSeconds = cell.seconds ?? 200
        const speedSteps = { 1: 0, 1.5: 1, 2: 2 }[cell.speed ?? 1] ?? 0
        await page.evaluate((steps) => {
            const P = window.nsePerf
            for (let i = 0; i < steps; i++) P.changePlayerSpeed(1)
            P.startOrStopPlayer()
        }, speedSteps)
        const every = cell.sampleEvery ?? 40
        for (let s = every; s <= playSeconds; s += every) {
            await sleep(every * 1000)
            const heap = await cdp.send('Runtime.getHeapUsage')
            out.push({
                label: `playing ${s}s`,
                at: Date.now(),
                heapUsed: heap.usedSize,
                procs: procs(),
            })
            log('memory', `playing ${s}s`, (heap.usedSize / 2 ** 20).toFixed(1), 'MiB (no GC)')
        }
        await page.evaluate((steps) => {
            const P = window.nsePerf
            if (P.isPlaying.value) P.startOrStopPlayer()
            for (let i = 0; i < steps; i++) P.changePlayerSpeed(-1)
        }, speedSteps)
        await snap('after playback')
        await profileTo('played')
        // New, then the same chart opened again.
        await page.mouse.move(5, 5)
        await page.keyboard.press('n')
        const dialog = page.getByRole('dialog')
        await dialog.waitFor({ timeout: 5000 }).catch(() => {})
        await sleep(1000)
        log('memory New dialog', JSON.stringify(await dialog.allInnerTexts().catch(() => [])))
        await dialog
            .getByRole('button', { name: 'New', exact: true })
            .click({ timeout: 5000 })
            .catch((error) => log('memory New click failed', String(error)))
        await sleep(3000)
        await page.screenshot({ path: `${runDir}/after-new.png` })
        await snap('after New')
        await profileTo('new')
        const opening = page.waitForEvent('filechooser')
        await page.keyboard.press('o')
        await (
            await opening
        ).setFiles({
            name: 'level.json',
            mimeType: 'application/json',
            buffer: readFileSync(resolve(root, group.chart)),
        })
        await page
            .locator('.notification, .notification-pill')
            .filter({ hasText: /^Opened level/ })
            .last()
            .waitFor({ timeout: 120_000 })
        await page
            .getByRole('dialog')
            .getByRole('button', { name: 'OK' })
            .click({ timeout: 3000 })
            .catch(() => {})
        await sleep(3000)
        await snap('after Open again')
        await sweep(1000, 'composed')
        await snap('after sweep composed pps1000 on the reopened chart')
        await profileTo('reopened')
        await cdp.send('HeapProfiler.stopSampling').catch(() => {})
        return out
    },
}

// The process tree's CPU, memory and GPU memory (Windows), from proc.ps1.
const procScript = resolve(root, 'scripts/perf/proc.ps1')
const procs = () => {
    try {
        return JSON.parse(
            execFileSync(
                'powershell',
                [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    procScript,
                    '-Root',
                    String(process.pid),
                ],
                { encoding: 'utf8' },
            ) || '[]',
        )
    } catch (error) {
        log('procs failed', String(error))
        return []
    }
}

// What a scenario needs before the run starts.
const selectNear = (page, count) =>
    page.evaluate(async (count) => {
        const P = window.nsePerf
        const picked = P.selectNear(P.view.time, count)
        for (let i = 0; i < 10; i++) await new Promise((done) => requestAnimationFrame(done))
        return picked
    }, count)
const prepares = {
    edits: (page, cell) => selectNear(page, cell.count ?? 50),
    editflip: (page, cell) => selectNear(page, cell.count ?? 50),
    drag: (page, cell) => selectNear(page, cell.count ?? 50),
    hide: (page, cell) => selectNear(page, cell.count ?? 20),
    journal: (page, cell) => selectNear(page, cell.count ?? 20),
}
const customKeys = [
    'idle',
    'resizedrag',
    'notch',
    'editflip',
    'drag',
    'hide',
    'journal',
    'memory',
    'edits',
    'scrub',
    'seek',
    'notespeed',
    'reopen',
    'cursorjumps',
    'act',
    'startup',
    'heaps',
]
const actionStates = new WeakMap()

// The boot probe (a group's `boot`): first paint, the startup gate, the chart, and startup's end.
const bootProbe = () => {
    const boot = (window.nseBoot = {})
    const loop = () => {
        const t = performance.now()
        boot.paint ??= performance.getEntriesByName('first-contentful-paint')[0]?.startTime
        if (boot.gate === undefined && document.querySelector('dialog[open]')) boot.gate = t
        if (boot.chart === undefined && document.querySelector('canvas.editor-chart'))
            boot.chart = t
        if (window.nsePerf?.startup() === 'done') {
            boot.done = t
            return
        }
        if (t < 300_000) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
}

// ---- the page's workers

// Each dedicated worker of the page, through the page's session (flatten: false, so it relays
// their messages), for their heaps.
const workerSessions = new WeakMap()
const watchWorkers = async (cdp) => {
    const sessions = new Map()
    const pending = new Map()
    let nextId = 0
    cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
        if (targetInfo.type === 'worker') sessions.set(sessionId, targetInfo)
    })
    cdp.on('Target.detachedFromTarget', ({ sessionId }) => sessions.delete(sessionId))
    cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
        const reply = JSON.parse(message)
        pending.get(reply.id)?.(reply)
        pending.delete(reply.id)
    })
    await cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
    })
    const send = (sessionId, method, params = {}) =>
        new Promise((resolve) => {
            const id = ++nextId
            pending.set(id, resolve)
            cdp.send('Target.sendMessageToTarget', {
                sessionId,
                message: JSON.stringify({ id, method, params }),
            }).catch(() => resolve({}))
        })
    workerSessions.set(cdp, { sessions, send })
}
/** Each worker's used heap in bytes, by its name, after a forced GC when `gc`. */
const workerHeaps = async (cdp, gc) => {
    const workers = workerSessions.get(cdp)
    const out = {}
    if (!workers) return out
    for (const [sessionId, info] of workers.sessions) {
        if (gc) await workers.send(sessionId, 'HeapProfiler.collectGarbage')
        const reply = await workers.send(sessionId, 'Runtime.getHeapUsage')
        out[info.title || info.url] = reply.result?.usedSize
    }
    return out
}

// ---- runs

const openChart = async (page, group) => {
    if (group.seed) {
        // A dump seeded into the empty profile (src/local/seed.ts); the page reloads without it.
        const file = resolve(root, group.seed)
        const name = basename(file).replace(/\.json$/, '')
        await page.route(`**/samples/${name}.json`, (route) =>
            route.fulfill({ path: file, contentType: 'application/json' }),
        )
        let refused
        const refusal = new Promise((_, reject) => (refused = reject))
        refusal.catch(() => {})
        page.on('console', (m) => {
            if (!m.text().startsWith('[seedSample]')) return
            log(m.text())
            if (/Refused|Failed/.test(m.text())) refused(new Error(m.text()))
        })
        await page.goto(`${baseUrl}?seedSample=${name}`)
        await Promise.race([
            page.waitForURL((url) => !url.search.includes('seedSample'), { timeout: 600_000 }),
            refusal,
        ])
    } else await page.goto(baseUrl)
    await page.locator('canvas.editor-chart').waitFor({ state: 'visible', timeout: 60_000 })
    await page.waitForFunction(() => window.nsePerf?.startup() === 'done', null, {
        timeout: 300_000,
    })
    // A run never measures behind the agreement dialog, which opens as the gate lifts.
    const agreement = await page.evaluate(
        () =>
            new Promise((resolve) =>
                requestAnimationFrame(() =>
                    resolve(document.querySelector('[data-agreement]') !== null),
                ),
            ),
    )
    if (agreement)
        throw new Error(
            'The agreement dialog is open: seed sonolus-next-sekai-editor.agreement = {"terms":999,"privacy":999}',
        )
    await page.mouse.move(5, 5)
    await page.waitForTimeout(1000)
    if (group.chart) await openLevel(page, group)
    await page.waitForTimeout(1500)
    return page.evaluate(() => {
        const P = window.nsePerf
        const gl = document.createElement('canvas').getContext('webgl2')
        const debug = gl?.getExtension('WEBGL_debug_renderer_info')
        const s = P.state.value
        return {
            renderer: debug
                ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
                : gl?.getParameter(gl.RENDERER),
            notes: [...s.store.slides.note.values()].flat().length,
            isDynamicStages: s.isDynamicStages,
            bgm: !!s.bgm.buffer,
            dpr: devicePixelRatio,
            userAgent: navigator.userAgent,
        }
    })
}

const openLevel = async (page, group) => {
    const chart = resolve(root, group.chart)
    const opening = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await opening
    ).setFiles({ name: 'level.json', mimeType: 'application/json', buffer: readFileSync(chart) })
    await page
        .locator('.notification, .notification-pill')
        .filter({ hasText: /^Opened level/ })
        .waitFor({ timeout: 120_000 })
    // Level data from an older engine revision opens with a warning.
    await page
        .getByRole('dialog')
        .getByRole('button', { name: 'OK' })
        .click({ timeout: 5000 })
        .catch(() => {})
    if (group.bgm) {
        await page.waitForTimeout(500)
        await page.keyboard.press('m')
        const modal = page.getByRole('dialog')
        const field = modal.locator('input[type="button"]')
        const choosing = page.waitForEvent('filechooser')
        await field.click()
        await (
            await choosing
        ).setFiles({
            name: 'bgm.mp3',
            mimeType: 'audio/mpeg',
            buffer: readFileSync(resolve(root, group.bgm)),
        })
        for (let i = 0; i < 600 && !/^\d\d:/.test(await field.inputValue()); i++)
            await page.waitForTimeout(100)
        await modal.getByRole('button', { name: 'Confirm', exact: true }).click()
        await modal.waitFor({ state: 'detached', timeout: 30_000 })
    }
}

const configure = (page, cell, group) =>
    page.evaluate(
        async (cell) => {
            const P = window.nsePerf
            if (P.isPlaying.value) P.startOrStopPlayer()
            // The group's and the cell's app settings; they stay set for later cells.
            for (const [key, value] of Object.entries(cell.settings ?? {})) P.settings[key] = value
            P.settings.showMinimap = cell.minimap ?? true
            P.settings.showPreview = cell.preview ?? true
            P.settings.pps = cell.pps ?? 1000
            P.view.layout = cell.layout ?? 'basic'
            // Beside the chart when open, whatever the width.
            P.settings.elevationEditorSideBySide = cell.elevation ? 'allow' : 'auto'
            if (cell.elevation && !P.isElevationEditorOpen.value) P.openElevationEditor()
            if (!cell.elevation && P.isElevationEditorOpen.value) P.closeElevationEditor()
            const selected = P.selectNotes(!!cell.selection)
            for (let i = 0; i < 40; i++) await new Promise((done) => requestAnimationFrame(done))
            const canvas = document.querySelector('.preview-viewport canvas')
            const rect = canvas?.getBoundingClientRect()
            return {
                selected,
                w: P.view.w,
                h: P.view.h,
                pps: P.settings.pps,
                preview: canvas && {
                    width: canvas.width,
                    height: canvas.height,
                    cssWidth: rect.width,
                    cssHeight: rect.height,
                },
            }
        },
        { ...cell, settings: { ...group.settings, ...cell.settings } },
    )

const settle = (page, start) =>
    page.evaluate(async (start) => {
        const { view } = window.nsePerf
        view.scrollingY = view.scrollingX = undefined
        view.time = view.cursorTime = start
        for (let i = 0; i < 30; i++) await new Promise((done) => requestAnimationFrame(done))
    }, start)

const waitStill = (page) =>
    page.evaluate(async () => {
        const { view } = window.nsePerf
        let still = 0
        let last = view.time
        for (let i = 0; i < 2000 && still < 20; i++) {
            await new Promise((done) => requestAnimationFrame(done))
            still = view.time === last && !view.scrollingY ? still + 1 : 0
            last = view.time
        }
    })

let allocCount
const runOnce = async (page, cdp, cell, profile, hz, label, light, group) => {
    const scenario = cell.scenario.startsWith('play') ? 'play' : cell.scenario
    if (scenario !== 'memory') await settle(page, cell.start ?? (scenario === 'play' ? 0 : 40))
    const prep = await prepares[scenario]?.(page, cell)
    const caches = await pathCaches(page)
    const startedAt = new Date().toISOString()
    await page.evaluate((noLoop) => window.nsePerfRun.start(noLoop), !!cell.noLoop)
    let sync
    if (label) {
        await startTrace(cdp, light)
        sync = await page.evaluate(() => performance.mark('nse-perf-sync').startTime)
    }
    if (cell.allocProfile && label === undefined) {
        await cdp.send('HeapProfiler.enable')
        await cdp.send('HeapProfiler.startSampling', {
            samplingInterval: cell.allocInterval ?? 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
        })
    }
    const input = await scenarios[scenario](page, cdp, cell, profile, prep, group)
    if (cell.allocProfile && label === undefined) {
        const { profile: heap } = await cdp.send('HeapProfiler.getSamplingProfile')
        await cdp.send('HeapProfiler.stopSampling')
        allocCount = (allocCount ?? 0) + 1
        writeFileSync(
            `${runDir}/alloc-${cellId(group, cell)}-${allocCount}.json`,
            JSON.stringify(heap),
        )
    }
    if (!['play', ...customKeys].includes(scenario)) await waitStill(page)
    await page.waitForTimeout(150)
    let trace
    if (label) {
        trace = `${traceDir}/${label}.json.gz`
        writeFileSync(trace, gzipSync(await endTrace(cdp)))
    }
    const raw = await page.evaluate(() => window.nsePerfRun.stop())
    const pathCache = cacheDelta(caches, await pathCaches(page))
    const key = scenario === 'play' ? 'cursor' : customKeys.includes(scenario) ? 'all' : 'view'
    const frames = summarizeFrames(raw.frames, key, hz)
    return {
        raw: cell.keepRaw
            ? { probes: raw.probes, longtasks: raw.longtasks, loaf: raw.loaf, vis: raw.vis }
            : { vis: raw.vis, longtasks: raw.longtasks },
        input,
        frames,
        probes: summarizeProbes(raw.probes, profile.throttle > 1 ? 1000 / 120 : 1000 / 240),
        longFrames: summarizeLongFrames(raw.loaf, frames),
        longTasks: {
            count: raw.longtasks.length,
            maxMs: Math.max(0, ...raw.longtasks.map((e) => e.duration)),
        },
        minimapPaints: raw.paints + raw.annotationPaints,
        startedAt,
        endedAt: new Date().toISOString(),
        pathCache,
        visibility: raw.visibility,
        trace,
        sync,
    }
}

const cellId = (group, cell) =>
    [
        group.id,
        cell.layout ?? 'basic',
        cell.scenario === 'act' ? cell.action : cell.scenario,
        cell.pps && cell.pps !== 1000 ? `pps${cell.pps}` : '',
        cell.minimap === false ? 'nomm' : '',
        cell.preview === false ? 'nopv' : '',
        cell.elevation ? 'el' : '',
        cell.selection ? 'sel' : '',
        cell.tag,
    ]
        .filter(Boolean)
        .join('-')

// ---- main

const children = []
const contexts = new Set()
/** Closes every browser the run started, then the servers. */
const shutDown = async (code) => {
    for (const context of contexts) await context.close().catch(() => {})
    stopChildren()
    if (code !== undefined) process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => void shutDown(130))
// A run that outlives `--timeout` minutes (240) is stuck: its browsers close and it exits.
setTimeout(
    () => {
        log('run timed out')
        void shutDown(1)
    },
    Number(args.timeout ?? 240) * 60_000,
).unref()
class CellTimeout extends Error {}
/** A cell longer than `cellTimeout` s (900) is stuck: its group's browser closes. */
const withinCell = (cell, run) => {
    let timer
    return Promise.race([
        run(),
        new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new CellTimeout(`Timed out after ${cell.cellTimeout ?? 900} s`)),
                (cell.cellTimeout ?? 900) * 1000,
            )
        }),
    ]).finally(() => clearTimeout(timer))
}
let baseUrl = args.url
if (!baseUrl) {
    if (!args.noBuild) {
        await stageDevPreviewAssets(root)
        const assets = await previewAssetsMode(root)
        if (!assets.included)
            throw new Error(`The perf build needs the Next SEKAI packages: ${assets.reason}.`)
        log('building', dist)
        execFileSync(
            process.execPath,
            [
                'node_modules/vite/bin/vite.js',
                'build',
                '--sourcemap',
                '--outDir',
                dist,
                '--emptyOutDir',
            ],
            {
                cwd: root,
                env: { ...process.env, NSE_PERF: '1' },
                stdio: 'inherit',
            },
        )
    }
    const server = spawn(
        process.execPath,
        [
            'node_modules/vite/bin/vite.js',
            'preview',
            '--outDir',
            dist,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--strictPort',
        ],
        { cwd: root, stdio: 'ignore' },
    )
    children.push(server)
    baseUrl = `http://127.0.0.1:${port}/`
    for (let i = 0; i < 100; i++) {
        if (
            await fetch(baseUrl).then(
                (r) => r.ok,
                () => false,
            )
        )
            break
        await sleep(200)
    }
}
const stopChildren = () => {
    for (const child of children) if (child.exitCode === null) child.kill()
}
process.on('exit', stopChildren)
writeFileSync(
    `${runDir}/meta.json`,
    JSON.stringify(
        {
            plan: resolve(planPath),
            dist,
            baseUrl,
            affinity: expectedAffinity,
            priority,
            site: process.env.NSE_SITE ?? 'production',
        },
        null,
        1,
    ),
)
log('run', name, 'pinned', pin([process.pid, ...children.map((c) => c.pid)]).length)

try {
    for (const group of plan.groups.filter(
        (g) => !args.groups || new RegExp(args.groups).test(g.id),
    )) {
        const profile = typeof group.profile === 'string' ? PROFILES[group.profile] : group.profile
        if (!profile) throw new Error(`Unknown profile ${group.profile}`)
        const hz = group.hz === 'native' ? 240 : (group.hz ?? 60)
        const userDataDir = `${out}/profiles/${name}-${group.id}`
        rmSync(userDataDir, { recursive: true, force: true })
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            viewport: profile.viewport,
            deviceScaleFactor: profile.deviceScaleFactor,
            hasTouch: !!profile.hasTouch,
            isMobile: !!profile.isMobile,
            locale: 'en-US',
            acceptDownloads: true,
            args: [
                '--autoplay-policy=no-user-gesture-required',
                // Moving the cursor plays a moment of BGM, and the tab's audio indicator then
                // animates the browser window for about a second.
                '--mute-audio',
                ...(group.browserArgs ?? []),
                `--window-size=${profile.viewport.width + 40},${profile.viewport.height + 160}`,
            ],
        })
        contexts.add(context)
        try {
            const page = context.pages()[0] ?? (await context.newPage())
            // No run may open a native dialog. It blocks the run and shows on the screen of whoever uses the machine.
            // The pickers are off (Open takes the file input, Save downloads, or the app's test
            // pickers under a group's `platform`), JS dialogs are dismissed, and Playwright takes
            // every download (`acceptDownloads`; a scenario saves one it keeps).
            // A beforeunload prompt is accepted, so a reload goes through.
            page.on(
                'dialog',
                (dialog) =>
                    void (
                        dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()
                    ).catch(() => {}),
            )
            await page.addInitScript(() => {
                for (const picker of [
                    'showOpenFilePicker',
                    'showSaveFilePicker',
                    'showDirectoryPicker',
                ])
                    Object.defineProperty(window, picker, { configurable: true, value: undefined })
                localStorage.setItem(
                    'nse.test.version',
                    JSON.stringify({ appVersion: '0.6.0', atTag: true }),
                )
                localStorage.setItem(
                    'sonolus-next-sekai-editor.lastAppVersion',
                    JSON.stringify('0.6.0'),
                )
                // The agreement counts as given.
                localStorage.setItem(
                    'sonolus-next-sekai-editor.agreement',
                    '{"terms":999,"privacy":999}',
                )
            })
            // A seeded group continues the seeded session; the others start blank.
            if (!group.seed)
                await page.addInitScript(() => localStorage.setItem('nse.test.startBlank', 'true'))
            // The platform override (`nse.test.platform`; a build with NSE_SITE=test reads it) and
            // other keys.
            for (const [key, value] of Object.entries({
                ...(group.platform && { 'nse.test.platform': JSON.stringify(group.platform) }),
                ...group.local,
            }))
                await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, value])
            await page.addInitScript(installCollector)
            await page.addInitScript(installActionProbe)
            if (group.boot) await page.addInitScript(bootProbe)
            // The preview's host: perf builds read its test key.
            const previewHost = group.previewHost ?? args['preview-host']
            if (previewHost)
                await page.addInitScript(
                    (v) => localStorage.setItem('nse.test.previewHost', v),
                    previewHost,
                )
            // Storage test flags, and the first lifecycle listeners, before the app's.
            if (group.storage)
                await page.addInitScript(
                    (v) => localStorage.setItem('nse.test.storage', v),
                    JSON.stringify(group.storage),
                )
            await page.addInitScript(() => {
                for (const type of ['visibilitychange', 'pagehide', 'freeze'])
                    (type === 'freeze' ? document : window).addEventListener(
                        type,
                        () =>
                            (window.nseVis ??= []).push({
                                type,
                                phase: 'first',
                                state: document.visibilityState,
                                t: performance.now(),
                            }),
                        true,
                    )
            })
            if (group.hz !== 'native') await page.addInitScript(gateFrames, hz)
            page.on('pageerror', (error) => log('pageerror', error.message))
            const info = await openChart(page, group)
            info.previewHost = await page.evaluate(() => window.nsePerf.previewHost())
            log('group', group.id, info, 'pinned', pin([process.pid]).length)
            const cdp = await context.newCDPSession(page)
            await watchWorkers(cdp)
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.throttle })
            for (const base of group.cells) {
                const cell = { ...plan.defaults, ...group.defaults, ...base }
                const id = cellId(group, cell)
                try {
                    await withinCell(cell, async () => {
                        const config = await configure(page, cell, group)
                        await page.screenshot({ path: `${runDir}/${id}.png` })
                        const runs = []
                        let cold
                        for (let i = 0; i < (cell.warmup ?? 1); i++) {
                            const r = await runOnce(
                                page,
                                cdp,
                                cell,
                                profile,
                                hz,
                                i === 0 && cell.traceCold ? `${id}-cold` : undefined,
                                false,
                                group,
                            )
                            cold ??= r
                        }
                        for (let i = 0; i < (cell.reps ?? 5); i++)
                            runs.push(
                                await runOnce(
                                    page,
                                    cdp,
                                    cell,
                                    profile,
                                    hz,
                                    cell.traceEach ? `${id}-r${i}` : undefined,
                                    true,
                                    group,
                                ),
                            )
                        const traced = cell.trace
                            ? await runOnce(page, cdp, cell, profile, hz, id, false, group)
                            : undefined
                        const pinned = pin([process.pid])
                        appendFileSync(
                            `${runDir}/results.jsonl`,
                            JSON.stringify({
                                id,
                                group: group.id,
                                profile: group.profile,
                                hz,
                                chart: group.chart,
                                cell,
                                config,
                                info,
                                cold,
                                runs,
                                traced,
                                procs: pinned.length,
                                offPin: offPin(pinned),
                            }) + '\n',
                        )
                        const med = (fn) => runs.map(fn).sort((a, b) => a - b)[runs.length >> 1]
                        if (cell.scenario === 'act')
                            log('cell', id, {
                                response: [
                                    med((r) => r.input.response ?? Infinity),
                                    Math.max(...runs.map((r) => r.input.response ?? Infinity)),
                                ],
                                longestTask: Math.max(...runs.map((r) => r.input.longestTask)),
                                marks: runs.map((r) => r.input.marks),
                                cold: cold?.input?.response,
                            })
                        else
                            log('cell', id, {
                                chart: [
                                    med((r) => r.probes.chartDraw?.p50),
                                    med((r) => r.probes.chartDraw?.p95),
                                ],
                                clock: [
                                    med((r) => r.probes.clockFrame?.p50),
                                    med((r) => r.probes.clockFrame?.p95),
                                ],
                                interval: [
                                    med((r) => r.frames.p50),
                                    med((r) => r.frames.p95),
                                    med((r) => r.frames.max),
                                ],
                            })
                    })
                } catch (error) {
                    log('cell failed', id, String(error.stack ?? error))
                    // The page may be stuck. Close the group's browser and run the next group.
                    if (error instanceof CellTimeout) break
                    await page.keyboard.press('Escape').catch(() => {})
                }
            }
        } finally {
            contexts.delete(context)
            await context.close().catch(() => {})
        }
    }
} finally {
    await shutDown()
}
log('done')
