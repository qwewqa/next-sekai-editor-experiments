// Reads a perf run's traces (docs/performance-testing.md): renderer main-thread time by kind,
// GPU and compositor busy time, and the sampled CPU profile by function and module, mapped
// through the perf build's sourcemaps.
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

/** Maps profile call frames to source files and lines through `<dist>/assets/*.map`. */
export const createResolver = (dist) => {
    const maps = new Map()
    const mapFor = (url) => {
        const file = url?.split('/assets/')[1]
        if (!file) return
        if (!maps.has(file)) {
            const path = `${dist}/assets/${file}.map`
            maps.set(file, existsSync(path) ? new TraceMap(readFileSync(path, 'utf8')) : undefined)
        }
        return maps.get(file)
    }
    const cache = new Map()
    return (frame) => {
        const key = `${frame.url}|${frame.lineNumber}|${frame.columnNumber}|${frame.functionName}`
        let out = cache.get(key)
        if (out) return out
        const map = mapFor(frame.url)
        const position =
            map && frame.lineNumber >= 0
                ? originalPositionFor(map, {
                      line: frame.lineNumber + 1,
                      column: frame.columnNumber ?? 0,
                  })
                : undefined
        if (position?.source) {
            const source = position.source.replace(/\\/g, '/')
            const modules = source.lastIndexOf('node_modules/')
            const src = source.lastIndexOf('/src/')
            out = {
                source:
                    modules >= 0
                        ? source.slice(modules)
                        : src >= 0
                          ? source.slice(src + 1)
                          : source,
                line: position.line,
                name: position.name || frame.functionName || '(anonymous)',
            }
        } else
            out = {
                source: frame.url ? new URL(frame.url).pathname.slice(1) : '(native)',
                line: frame.lineNumber + 1,
                name: frame.functionName || '(anonymous)',
            }
        out.module = moduleOf(out.source, out.name)
        cache.set(key, out)
        return out
    }
}

/** The area a source file belongs to, for the by-module tables. */
export const moduleOf = (source, name) => {
    if (name === '(garbage collector)') return 'GC'
    if (/^\((program|idle|root)\)$/.test(name)) return name
    if (/node_modules\/(pixi\.js|@pixi)/.test(source)) return 'Pixi'
    if (/node_modules\/(@vue|vue\/)/.test(source)) return 'Vue runtime'
    if (source.includes('node_modules/'))
        return `deps: ${source.split('node_modules/')[1].split('/')[0]}`
    const areas = [
        ['src/editor/canvas/', 'chart draw'],
        ['src/rendering/', 'renderer'],
        ['src/editor/minimap/', 'minimap'],
        ['src/preview/', 'preview'],
        ['src/editor/elevation/', 'Elevation Editor'],
        ['src/editor/controls/', 'input'],
        ['src/editor/workspace/', 'workspace UI'],
        ['src/state/', 'state'],
        ['src/history/', 'state'],
    ]
    for (const [prefix, area] of areas) if (source.startsWith(prefix)) return area
    if (source.startsWith('src/')) return `src: ${source.slice(4).split('/')[0]}`
    return source
}

// Main-thread trace events by what they spend time on.
const kindOf = (name) => {
    if (/^(MinorGC|MajorGC|BlinkGC|CppGC|V8\.GC|ThreadState::|V8\.ConcurrentMark)|GC_/.test(name))
        return 'GC'
    if (
        /^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|Document::UpdateStyle)/.test(
            name,
        )
    )
        return 'style'
    if (
        /^(Layout|UpdateLayerTree|HitTest|InlineNode::|LocalFrameView::(UpdateStyleAndLayout|UpdateLayout))/.test(
            name,
        )
    )
        return 'layout'
    if (
        /^(PrePaint|Paint|Layerize|Commit|UpdateLayer|LocalFrameView::Run(PrePaint|Paint)|PaintArtifactCompositor)/.test(
            name,
        )
    )
        return 'paint/commit'
    if (/WebGL|Graphics\.Pipeline|CommandBuffer|GpuChannel|RasterImplementation/.test(name))
        return 'GL client'
    if (
        /^(FunctionCall|EvaluateScript|v8\.|V8\.|TimerFire|FireAnimationFrame|EventDispatch|RunMicrotasks|BlinkScheduler_PerformMicrotaskCheckpoint|FireIdleCallback|ResizeObserver)/.test(
            name,
        )
    )
        return 'scripting'
    return 'other'
}

const top = (totals, count) =>
    Object.entries(totals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([key, ms]) => [key, +ms.toFixed(1)])

/** Self and total time by function and module over samples ([node id, µs]) in [lo, hi]. */
export const aggregateProfile = (resolve, nodes, samples, lo = -Infinity, hi = Infinity) => {
    const selfFunction = {}
    const totalFunction = {}
    const selfModule = {}
    const totalModule = {}
    let sampled = 0
    const add = (totals, key, ms) => (totals[key] = (totals[key] ?? 0) + ms)
    for (let i = 0; i < samples.length; i++) {
        const [id, ts] = samples[i]
        if (ts < lo || ts > hi) continue
        const ms = Math.min(Math.max(0, (samples[i + 1]?.[1] ?? ts) - ts), 5000) / 1000
        sampled += ms
        let node = nodes.get(id)
        if (!node) continue
        const leaf = resolve(node.callFrame)
        // A native leaf (a DOM or GL call) is shown with its nearest script caller.
        let caller = node
        while (caller && !caller.callFrame.url && caller.parent) caller = nodes.get(caller.parent)
        const from = caller && caller !== node ? resolve(caller.callFrame) : undefined
        add(
            selfFunction,
            from
                ? `${leaf.name} <- ${from.name} (${from.source}:${from.line})`
                : `${leaf.name} (${leaf.source}:${leaf.line})`,
            ms,
        )
        add(
            selfModule,
            from && leaf.module === '(native)' ? `${from.module} [native]` : leaf.module,
            ms,
        )
        const seen = new Set()
        for (; node; node = node.parent ? nodes.get(node.parent) : undefined) {
            const frame = resolve(node.callFrame)
            const key = `${frame.name} (${frame.source}:${frame.line})`
            if (!seen.has(key)) add(totalFunction, key, ms)
            if (!seen.has(frame.module)) add(totalModule, frame.module, ms)
            seen.add(key).add(frame.module)
        }
    }
    return {
        sampledMs: +sampled.toFixed(1),
        selfByModule: top(selfModule, 30),
        totalByModule: top(totalModule, 30),
        selfByFunction: top(selfFunction, 200),
        totalByFunction: top(totalFunction, 200),
    }
}

/** A trace's events, its renderer main thread and that thread's CPU profile. */
export const loadTrace = (path) => {
    // Chromium writes one event per line, so a trace past the string limit (about 512 MB,
    // seen in native-rate playback) is parsed line by line.
    const buffer = gunzipSync(readFileSync(path))
    let events
    if (buffer.length < 0x1fffffe8) {
        const raw = JSON.parse(buffer)
        events = raw.traceEvents ?? raw
    } else {
        events = []
        for (let start = 0; start < buffer.length;) {
            let end = buffer.indexOf(10, start)
            if (end < 0) end = buffer.length
            let line = buffer.toString('utf8', start, end).trim()
            start = end + 1
            // The last event shares its line with the trailing metadata.
            const tail = line.indexOf('}],"metadata"')
            if (tail >= 0) line = line.slice(0, tail + 1)
            if (line.endsWith(',')) line = line.slice(0, -1)
            if (!line.startsWith('{')) continue
            try {
                events.push(JSON.parse(line))
            } catch {
                // the wrapper's opening line
            }
        }
    }
    const threads = {}
    const counts = {}
    for (const e of events) {
        const key = `${e.pid}:${e.tid}`
        counts[key] = (counts[key] ?? 0) + 1
        if (e.ph === 'M' && e.name === 'thread_name') threads[key] = e.args.name
    }
    const named = (name) => Object.keys(threads).filter((key) => threads[key] === name)
    const main = named('CrRendererMain').sort((a, b) => counts[b] - counts[a])[0]
    const [pid, tid] = main.split(':').map(Number)
    // The main thread's profile; workers in the same renderer have their own ids.
    const profiles = events.filter((e) => e.name === 'Profile' && e.pid === pid)
    const ids = new Set(profiles.filter((e) => e.tid === tid).map((e) => e.id))
    const starts = Object.fromEntries(profiles.map((e) => [e.id, e.args.data.startTime]))
    const nodes = new Map()
    const samples = []
    const cursors = {}
    for (const chunk of events
        .filter((e) => e.name === 'ProfileChunk' && e.pid === pid)
        .sort((a, b) => a.ts - b.ts)) {
        if (ids.size && !ids.has(chunk.id)) continue
        const { cpuProfile, timeDeltas = [] } = chunk.args.data
        for (const node of cpuProfile?.nodes ?? []) nodes.set(node.id, node)
        cursors[chunk.id] ??= starts[chunk.id]
        for (const [i, id] of (cpuProfile?.samples ?? []).entries()) {
            cursors[chunk.id] += timeDeltas[i] ?? 0
            samples.push([id, cursors[chunk.id]])
        }
    }
    samples.sort((a, b) => a[1] - b[1])
    return {
        events,
        main,
        pid,
        tid,
        compositor: named('Compositor').find((key) => key.startsWith(`${pid}:`)),
        gpu: named('CrGpuMain')[0],
        viz: named('VizCompositorThread')[0],
        nodes,
        samples,
    }
}

/** Busy time of a thread's top-level events in [lo, hi], in ms. */
const busy = (events, thread, lo, hi) => {
    let end = -Infinity
    let total = 0
    const list = events
        .filter(
            (e) =>
                `${e.pid}:${e.tid}` === thread &&
                e.ph === 'X' &&
                e.dur &&
                e.ts + e.dur >= lo &&
                e.ts <= hi,
        )
        .sort((a, b) => a.ts - b.ts)
    for (const e of list) {
        const from = Math.max(e.ts, end, lo)
        const to = Math.min(e.ts + e.dur, hi)
        if (to > from) total += to - from
        end = Math.max(end, e.ts + e.dur)
    }
    return +(total / 1000).toFixed(1)
}

/**
 * One traced run: `window` is the page-clock range ({ start, end }) and `sync` the page time of
 * the `nse-perf-sync` mark, which ties the page clock to the trace's.
 */
export const analyzeTrace = (path, { dist, window, sync } = {}) => {
    const trace = loadTrace(path)
    const { events, main } = trace
    const mark = events.find((e) => e.name === 'nse-perf-sync' && e.cat?.includes('user_timing'))
    const [lo, hi] =
        window && mark && sync !== undefined
            ? [mark.ts + (window.start - sync) * 1000, mark.ts + (window.end - sync) * 1000]
            : [-Infinity, Infinity]
    // Self time of nested main-thread events, by kind.
    const self = new Map()
    const stack = []
    const list = events
        .filter(
            (e) =>
                `${e.pid}:${e.tid}` === main &&
                e.ph === 'X' &&
                e.dur !== undefined &&
                e.ts + e.dur >= lo &&
                e.ts <= hi,
        )
        .sort((a, b) => a.ts - b.ts || b.dur - a.dur)
    for (const e of list) {
        while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop()
        self.set(e, e.dur)
        if (stack.length) self.set(stack.at(-1), self.get(stack.at(-1)) - e.dur)
        stack.push(e)
    }
    const byKind = {}
    for (const [e, us] of self)
        byKind[kindOf(e.name)] = (byKind[kindOf(e.name)] ?? 0) + Math.max(0, us) / 1000
    return {
        windowMs: Number.isFinite(lo) ? (hi - lo) / 1000 : undefined,
        busyMs: {
            main: busy(events, main, lo, hi),
            compositor: trace.compositor && busy(events, trace.compositor, lo, hi),
            gpu: trace.gpu && busy(events, trace.gpu, lo, hi),
            viz: trace.viz && busy(events, trace.viz, lo, hi),
        },
        mainByKind: Object.fromEntries(
            Object.entries(byKind).map(([kind, ms]) => [kind, +ms.toFixed(1)]),
        ),
        profile: aggregateProfile(createResolver(dist), trace.nodes, trace.samples, lo, hi),
    }
}

/** Top-level main-thread tasks of at least `minMs`, each with its heaviest functions. */
export const longTasks = (path, { dist, minMs = 30 } = {}) => {
    const { events, pid, tid, nodes, samples } = loadTrace(path)
    const resolve = createResolver(dist)
    const tasks = []
    for (const e of events
        .filter(
            (e) =>
                e.pid === pid &&
                e.tid === tid &&
                e.ph === 'X' &&
                e.name === 'RunTask' &&
                e.dur >= minMs * 1000,
        )
        .sort((a, b) => a.ts - b.ts)) {
        const last = tasks.at(-1)
        if (!last || e.ts >= last.ts + last.dur) tasks.push(e)
    }
    const first = samples[0]?.[1] ?? tasks[0]?.ts ?? 0
    return tasks.map((task) => ({
        atMs: Math.round((task.ts - first) / 1000),
        durMs: +(task.dur / 1000).toFixed(1),
        profile: aggregateProfile(resolve, nodes, samples, task.ts, task.ts + task.dur),
    }))
}
