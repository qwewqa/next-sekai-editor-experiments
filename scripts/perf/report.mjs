// Markdown tables from a perf run (docs/performance-testing.md).
//   npm run perf:report -- <run dir> frames [cell filter]   per-frame work and frame intervals
//   npm run perf:report -- <run dir> work [cell filter]     traced runs: work per frame by kind
//   npm run perf:report -- <run dir> ui [cell filter]       `act` and `startup` cells: response, busy state, marks, longest task
//   npm run perf:report -- <run dir> long <trace> [min ms]  the longest tasks and their functions
//   npm run perf:report -- <run dir> tasks [trace filter] [min ms]  tasks over min ms (4) after each mark, by what ran in them
//   npm run perf:report -- <run dir> idle [trace filter]    main-thread counts, busy threads and frames in an idle trace
//   npm run perf:report -- <run dir> edit [trace filter]    the cost of each edit, undo, drop and hide, and the flush after it
//   npm run perf:report -- <run dir> callers <trace> <pattern> [depth]  the caller chains of matching functions
//   npm run perf:report -- <run dir> inside <trace> <pattern>           the src/ frames running inside matching functions
//   npm run perf:report -- <run dir> heap <heap-*.json>     a memory run's sampled live bytes by module and allocator
// tasks, idle and edit read the light traces of `traceEach` cells; filters are regular expressions.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { analyzeTrace, createResolver, loadTrace, longTasks } from './trace.mjs'

const [dir, mode = 'frames', filter = '', min, extra] = process.argv.slice(2)
if (!dir) throw new Error('Usage: npm run perf:report -- <run dir> <mode> [filter]')
const run = resolve(dir)
const { dist } = JSON.parse(readFileSync(`${run}/meta.json`, 'utf8'))
const rows = ['frames', 'work', 'ui'].includes(mode)
    ? readFileSync(`${run}/results.jsonl`, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((row) => !filter || new RegExp(filter).test(row.id))
    : []

const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    return sorted.length ? sorted[sorted.length >> 1] : NaN
}
const fixed = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '–')
const table = (head, lines) =>
    [
        `| ${head.join(' | ')} |`,
        `|${head.map(() => '---').join('|')}|`,
        ...lines.map((cells) => `| ${cells.join(' | ')} |`),
    ].join('\n')
const skip = /^\((idle|root)\)/

if (mode === 'ui') {
    // Each action's repeats: its response (input to the frame that shows the result) and the rest.
    const pct = (values, p) => {
        const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
        return sorted.length
            ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
            : NaN
    }
    const spread = (values, digits = 0) =>
        values.some(Number.isFinite)
            ? `${fixed(pct(values, 50), digits)}/${fixed(pct(values, 95), digits)}/${fixed(Math.max(...values.filter(Number.isFinite)), digits)}`
            : '–'
    const lines = rows
        .filter((row) => ['act', 'startup'].includes(row.cell.scenario))
        .map((row) => {
            const results = row.runs.map((r) => r.input ?? {})
            const pick = (key) => results.map((r) => r[key])
            const marks = [...new Set(results.flatMap((r) => Object.keys(r.marks ?? {})))]
            const extra = [
                'imported',
                'bytes',
                'first',
                'hit',
                'extend',
                'paint',
                'gate',
                'chart',
                'done',
            ]
                .filter((key) => results.some((r) => r[key] !== undefined))
                .map((key) => `${key} ${spread(pick(key))}`)
            return [
                row.id,
                results.length,
                `${spread(pick('response'))}${results.some((r) => r.timedOut) ? ' (timed out)' : ''}`,
                fixed(row.cold?.input?.response, 0),
                spread(pick('busy')),
                marks.map((m) => `${m} ${spread(results.map((r) => r.marks?.[m]))}`).join('; ') ||
                    '–',
                fixed(Math.max(0, ...pick('eventMax').filter(Number.isFinite)), 0),
                fixed(Math.max(0, ...pick('longestTask').filter(Number.isFinite)), 0),
                fixed(Math.max(0, ...pick('longestLoaf').filter(Number.isFinite)), 0),
                results.some((r) => r.keyEvents)
                    ? spread(results.map((r) => r.keyEvents?.p95))
                    : '–',
                `${fixed(pct(pick('frameP95'), 50))}/${fixed(Math.max(0, ...pick('frameMax').filter(Number.isFinite)))}`,
                `${fixed(Math.max(0, ...pick('afterMax').filter(Number.isFinite)), 0)}/${fixed(Math.max(0, ...pick('tailTask').filter(Number.isFinite)), 0)}`,
                extra.join('; ') || '–',
            ]
        })
    console.log(
        table(
            [
                'cell',
                'n',
                'response p50/p95/max',
                'cold',
                'busy',
                'marks',
                'event max',
                'longest task',
                'longest LoAF',
                'key event p95',
                'frame p95/max',
                'after: frame/task',
                'other',
            ],
            lines,
        ),
    )
} else if (mode === 'frames') {
    const lines = rows.map((row) => {
        const m = (fn) => median(row.runs.map(fn))
        const probe = (name, ...keys) =>
            keys.map((key) => fixed(m((r) => r.probes[name]?.[key]))).join('/')
        const counts = (name) =>
            ['overBudget', 'over2x', 'over4x']
                .map((key) =>
                    fixed(
                        m((r) => r.probes[name]?.[key]),
                        0,
                    ),
                )
                .join('/')
        return [
            row.id,
            probe('chartDraw', 'p50', 'p95', 'p99', 'max'),
            counts('chartDraw'),
            probe('clockFrame', 'p50', 'p95', 'p99'),
            counts('clockFrame'),
            probe('previewDraw', 'p50', 'p95'),
            // The worker host: its draw, and its frames a second against the clock's.
            `${probe('previewWorkerDraw', 'p50', 'p95')} (${fixed(
                m((r) => ((r.probes.previewWorkerDraw?.n ?? NaN) / r.frames.spanMs) * 1000),
                0,
            )}/${fixed(
                m((r) => r.frames.fps),
                0,
            )} fps, ${fixed(
                m((r) => r.probes.previewReplaced?.n ?? 0),
                0,
            )} replaced)`,
            `${fixed(
                m((r) => (r.probes.stageTile?.n ?? 0) / r.probes.chartDraw?.n),
                2,
            )} (${probe('stageTile', 'p50', 'p95', 'max')})`,
            `${['p50', 'p95', 'p99', 'max'].map((key) => fixed(m((r) => r.frames[key]))).join('/')} (${fixed(
                m((r) => r.frames.frames),
                0,
            )})`,
            `${fixed(
                m((r) => r.frames.over2x),
                0,
            )}/${fixed(
                m((r) => r.frames.over4x),
                0,
            )}`,
            fixed(
                m((r) => r.frames.sd),
                2,
            ),
            `${fixed(m((r) => r.frames.jumps * 100))}%`,
            fixed(row.cold?.frames.max),
            fixed(
                m((r) => r.minimapPaints),
                0,
            ),
            row.offPin,
        ]
    })
    console.log(
        table(
            [
                'cell',
                'chart draw p50/p95/p99/max',
                'chart > budget/2x/4x',
                'clock p50/p95/p99',
                'clock > budget/2x/4x',
                'preview p50/p95',
                'worker draw p50/p95 (fps/clock fps, replaced)',
                'stage tiles per draw (build p50/p95/max)',
                'interval p50/p95/p99/max (n)',
                'intervals > 2x/4x',
                'interval SD',
                'jumps',
                'cold max',
                'minimap paints',
                'off pin',
            ],
            lines,
        ),
    )
} else if (mode === 'work') {
    const lines = []
    for (const row of rows) {
        const traced = row.traced
        if (!traced?.trace || !existsSync(traced.trace)) continue
        const cache = traced.trace.replace(/\.json\.gz$/, '.analysis.json')
        const analysis = existsSync(cache)
            ? JSON.parse(readFileSync(cache, 'utf8'))
            : analyzeTrace(traced.trace, {
                  dist,
                  window: { start: traced.frames.windowStart, end: traced.frames.windowEnd },
                  sync: traced.sync,
              })
        writeFileSync(cache, JSON.stringify(analysis))
        const n = traced.frames.frames || 1
        const kind = (name) => fixed((analysis.mainByKind[name] ?? 0) / n, 2)
        const modules = analysis.profile.selfByModule
            .filter(([name]) => !skip.test(name))
            .slice(0, 5)
            .map(([name, ms]) => `${name} ${(ms / n).toFixed(2)}`)
        lines.push([
            row.id,
            n,
            fixed(analysis.busyMs.main / n, 2),
            kind('scripting'),
            fixed(((analysis.mainByKind.style ?? 0) + (analysis.mainByKind.layout ?? 0)) / n, 2),
            kind('paint/commit'),
            kind('GC'),
            fixed(analysis.busyMs.gpu / n, 2),
            modules.join('; '),
        ])
    }
    console.log(
        table(
            [
                'cell',
                'frames',
                'main busy',
                'scripting',
                'style+layout',
                'paint/commit',
                'GC',
                'GPU main',
                'top modules, self',
            ],
            lines,
        ),
    )
    console.log('\nms per frame from the traced run; tracing adds about 1.5x.')
} else if (mode === 'long') {
    for (const task of longTasks(resolve(filter), { dist, minMs: Number(min ?? 16) })) {
        const heaviest = task.profile.totalByFunction
            .filter(
                ([name]) =>
                    !skip.test(name) &&
                    !/runtime-core|reactivity|frame\.ts|time\.ts|perf\/probe\.ts|surface\.ts:60/.test(
                        name,
                    ),
            )
            .slice(0, 8)
            .map(([name, ms]) => `${ms} ${name}`)
        console.log(`@${task.atMs} ms, ${task.durMs} ms: ${heaviest.join(' | ')}`)
    }
} else if (['tasks', 'idle', 'edit'].includes(mode)) {
    const traces = readdirSync(`${run}/traces`)
        .filter((f) => f.endsWith('.json.gz') && (!filter || new RegExp(filter).test(f)))
        .sort()
    const resolver = createResolver(dist)
    const fnName = (data) => {
        if (!data?.url) return data?.functionName || '?'
        const out = resolver({
            url: data.url,
            lineNumber: (data.lineNumber ?? 1) - 1,
            columnNumber: (data.columnNumber ?? 1) - 1,
            functionName: data.functionName,
        })
        return `${out.name} (${out.source}:${out.line})`
    }

    /** The direct children of a task worth naming. */
    const describe = (events, task) => {
        const inside = events.filter(
            (e) => e !== task && e.ts >= task.ts && e.ts + (e.dur ?? 0) <= task.ts + task.dur + 1,
        )
        const parts = []
        const gc = inside
            .filter((e) => /^(MajorGC|MinorGC|V8\.GC_MC|V8\.GC_SCAVENGER|BlinkGC)/.test(e.name))
            .reduce((a, e) => a + (e.dur ?? 0), 0)
        for (const e of inside) {
            if (e.dur < 300) continue
            if (e.name === 'EventDispatch') parts.push([e.dur, `Event ${e.args?.data?.type}`])
            else if (e.name === 'FireAnimationFrame') parts.push([e.dur, 'rAF'])
            else if (e.name === 'TimerFire') parts.push([e.dur, 'timer'])
            else if (e.name === 'FireIdleCallback') parts.push([e.dur, 'idle callback'])
            else if (e.name === 'FunctionCall') parts.push([e.dur, `fn ${fnName(e.args?.data)}`])
            else if (/^(UpdateLayoutTree|Layout|Paint|PrePaint|Commit|Layerize)$/.test(e.name))
                parts.push([e.dur, e.name])
            else if (e.name === 'RunMicrotasks') parts.push([e.dur, 'microtasks'])
        }
        parts.sort((a, b) => b[0] - a[0])
        const seen = new Set()
        const named = []
        for (const [dur, name] of parts) {
            if (seen.has(name)) continue
            seen.add(name)
            named.push(`${name} ${(dur / 1000).toFixed(1)}`)
            if (named.length >= 5) break
        }
        if (gc > 300) named.push(`GC ${(gc / 1000).toFixed(1)}`)
        return named.join('; ')
    }

    if (mode === 'tasks') {
        const minMs = Number(min ?? 4)
        for (const file of traces) {
            const { events, pid, tid } = loadTrace(`${run}/traces/${file}`)
            const marks = events
                .filter(
                    (e) =>
                        e.cat?.includes('user_timing') &&
                        /^nse-/.test(e.name) &&
                        e.name !== 'nse-perf-sync',
                )
                .sort((a, b) => a.ts - b.ts)
            const sync = events.find(
                (e) => e.name === 'nse-perf-sync' && e.cat?.includes('user_timing'),
            )
            const origin = sync?.ts ?? 0
            const main = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X')
            const tasks = main.filter((e) => e.name === 'RunTask' && e.dur >= minMs * 1000)
            const busy = main
                .filter((e) => e.name === 'RunTask' && e.ts >= origin)
                .reduce((a, e) => a + e.dur, 0)
            console.log(`\n## ${file}  (main busy ${(busy / 1000).toFixed(0)} ms)`)
            console.log(
                'marks: ' +
                    marks.map((m) => `${m.name}@${((m.ts - origin) / 1000).toFixed(0)}`).join(' '),
            )
            for (const task of tasks.sort((a, b) => a.ts - b.ts)) {
                if (task.ts < origin) continue
                const mark = marks.filter((m) => m.ts <= task.ts).at(-1)
                const rel = mark ? `${mark.name}+${((task.ts - mark.ts) / 1000).toFixed(0)}` : ''
                console.log(
                    `@${((task.ts - origin) / 1000).toFixed(0)} ${rel} ${(task.dur / 1000).toFixed(1)} ms: ${describe(main, task)}`,
                )
            }
        }
    } else if (mode === 'idle') {
        for (const file of traces) {
            const { events, pid, tid, gpu, viz, compositor } = loadTrace(`${run}/traces/${file}`)
            const sync = events.find(
                (e) => e.name === 'nse-perf-sync' && e.cat?.includes('user_timing'),
            )
            const lo = sync?.ts ?? 0
            const hi = events.reduce((m, e) => (e.ts ? Math.max(m, e.ts + (e.dur ?? 0)) : m), 0)
            const span = (hi - lo) / 1e6
            const on = (thread) =>
                events.filter((e) => `${e.pid}:${e.tid}` === thread && e.ph === 'X' && e.ts >= lo)
            const main = on(`${pid}:${tid}`)
            const count = (name) => main.filter((e) => e.name === name).length
            const sum = (list) => list.reduce((a, e) => a + (e.dur ?? 0), 0) / 1000
            const timers = {}
            for (const e of main.filter((e) => e.name === 'TimerFire')) {
                const fc = main.find(
                    (f) => f.name === 'FunctionCall' && f.ts >= e.ts && f.ts <= e.ts + e.dur,
                )
                const key = fc ? fnName(fc.args?.data) : '?'
                timers[key] = (timers[key] ?? 0) + 1
            }
            const rafs = {}
            for (const e of main.filter((e) => e.name === 'FireAnimationFrame')) {
                const fcs = main.filter(
                    (f) => f.name === 'FunctionCall' && f.ts >= e.ts && f.ts <= e.ts + e.dur,
                )
                for (const fc of fcs) {
                    const key = fnName(fc.args?.data)
                    rafs[key] = (rafs[key] ?? 0) + 1
                }
            }
            const idles = {}
            for (const e of main.filter((e) => e.name === 'FireIdleCallback')) {
                const fc = main.find(
                    (f) => f.name === 'FunctionCall' && f.ts >= e.ts && f.ts <= e.ts + e.dur,
                )
                const key = fc ? fnName(fc.args?.data) : '?'
                idles[key] = (idles[key] ?? 0) + 1
            }
            const all = (name) => events.filter((e) => e.name === name && e.ts >= lo).length
            console.log(`\n## ${file}: ${span.toFixed(1)} s`)
            console.log(
                `main: RunTask ${count('RunTask')} (${sum(main.filter((e) => e.name === 'RunTask')).toFixed(0)} ms), rAF ${count('FireAnimationFrame')}, timers ${count('TimerFire')}, idle callbacks ${count('FireIdleCallback')}, events ${count('EventDispatch')}, GC ${count('MinorGC') + count('MajorGC')}`,
            )
            console.log(
                `threads busy ms: compositor ${compositor ? sum(on(compositor).filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask')).toFixed(0) : '-'}, gpu ${gpu ? sum(on(gpu).filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask')).toFixed(0) : '-'}, viz ${viz ? sum(on(viz).filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask')).toFixed(0) : '-'}`,
            )
            console.log(
                `frames: BeginFrame ${all('BeginFrame')}, DrawFrame ${all('DrawFrame')}, Swap ${all('Graphics.Pipeline.DrawAndSwap') || all('DisplayScheduler::DrawAndSwap')}`,
            )
            console.log('rAF callbacks: ' + JSON.stringify(rafs))
            console.log('timers: ' + JSON.stringify(timers))
            console.log('idle callbacks: ' + JSON.stringify(idles))
        }
    } else {
        const rows = []
        for (const file of traces) {
            const { events, pid, tid } = loadTrace(`${run}/traces/${file}`)
            const marks = events
                .filter(
                    (e) =>
                        e.cat?.includes('user_timing') &&
                        /^nse-(edit|undo|drop|hide)$/.test(e.name),
                )
                .sort((a, b) => a.ts - b.ts)
            const main = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X')
            const tasks = main.filter((e) => e.name === 'RunTask').sort((a, b) => a.ts - b.ts)
            const inside = (task, name) =>
                main.filter((e) => e.name === name && e.ts >= task.ts && e.ts <= task.ts + task.dur)
            for (const [i, mark] of marks.entries()) {
                const next = marks[i + 1]?.ts ?? Infinity
                const end = Math.min(next, mark.ts + 2600e3)
                const win = (a, b) =>
                    tasks.filter(
                        (t) =>
                            t.ts >= mark.ts + a * 1000 && t.ts < Math.min(end, mark.ts + b * 1000),
                    )
                const response = win(0, 400)
                const longest = response.reduce((a, t) => Math.max(a, t.dur), 0) / 1000
                const busy = response.reduce((a, t) => a + t.dur, 0) / 1000
                const later = win(400, 2600)
                const idle = later.filter(
                    (t) => inside(t, 'FireIdleCallback').length || inside(t, 'TimerFire').length,
                )
                const big = later.filter((t) => t.dur >= 4000)
                rows.push(
                    `${file.replace('.json.gz', '')} ${mark.name}: response busy ${busy.toFixed(0)} ms, longest task ${longest.toFixed(1)} ms; 0.4–2.6 s: idle/timer tasks ${idle.length} totalling ${(idle.reduce((a, t) => a + t.dur, 0) / 1000).toFixed(0)} ms (max ${(idle.reduce((a, t) => Math.max(a, t.dur), 0) / 1000).toFixed(1)}), tasks >= 4 ms: ${big.map((t) => (t.dur / 1000).toFixed(1)).join(' ')}`,
                )
            }
        }
        console.log(rows.join('\n'))
    }
} else if (mode === 'callers' || mode === 'inside') {
    const { nodes, samples } = loadTrace(resolve(filter))
    const resolveFrame = createResolver(dist)
    const re = new RegExp(min)
    const depth = Number(extra ?? 8)
    const by = {}
    let total = 0
    for (let i = 0; i < samples.length; i++) {
        const [id, ts] = samples[i]
        const ms = Math.min(Math.max(0, (samples[i + 1]?.[1] ?? ts) - ts), 5000) / 1000
        const stack = []
        for (
            let node = nodes.get(id);
            node;
            node = node.parent ? nodes.get(node.parent) : undefined
        ) {
            const f = resolveFrame(node.callFrame)
            stack.push(`${f.name} (${f.source}:${f.line})`)
        }
        const at = stack.findIndex((entry) => re.test(entry))
        if (at < 0) continue
        total += ms
        // callers: the chain above the match. inside: the src/ frame closest to the match below it.
        const key =
            mode === 'callers'
                ? stack.slice(at, at + depth).join(' <- ')
                : (stack
                      .slice(0, at)
                      .reverse()
                      .find((entry) => entry.includes('(src/')) ?? stack[0])
        by[key] = (by[key] ?? 0) + ms
    }
    console.log(`total ${total.toFixed(1)} ms`)
    for (const [key, ms] of Object.entries(by)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15))
        console.log(ms.toFixed(1), key)
} else if (mode === 'heap') {
    const resolveFrame = createResolver(dist)
    const profile = JSON.parse(readFileSync(resolve(filter), 'utf8'))
    const byModule = {}
    const bySrc = {}
    let total = 0
    const walk = (node, stack) => {
        const f = resolveFrame(node.callFrame)
        const here = [...stack, f]
        if (node.selfSize) {
            total += node.selfSize
            byModule[f.module] = (byModule[f.module] ?? 0) + node.selfSize
            // The innermost src/ frame on the stack: who asked for it.
            const src = [...here].reverse().find((x) => x.source.startsWith('src/'))
            const key = src ? `${src.name} (${src.source}:${src.line})` : '(no src frame)'
            bySrc[key] = (bySrc[key] ?? 0) + node.selfSize
        }
        for (const child of node.children ?? []) walk(child, here)
    }
    walk(profile.head, [])
    const mb = (bytes) => (bytes / 2 ** 20).toFixed(1)
    console.log(`sampled live ${mb(total)} MiB\nby module:`)
    for (const [k, v] of Object.entries(byModule)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12))
        console.log(' ', mb(v), k)
    console.log('by innermost src frame:')
    for (const [k, v] of Object.entries(bySrc)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25))
        console.log(' ', mb(v), k)
} else throw new Error(`Unknown mode ${mode}`)
