// Markdown tables from a perf run (docs/performance-testing.md).
//   npm run perf:report -- <run dir> frames [cell filter]   per-frame work and frame intervals
//   npm run perf:report -- <run dir> work [cell filter]     traced runs: work per frame by kind
//   npm run perf:report -- <run dir> long <trace> [min ms]  the longest tasks and their functions
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { analyzeTrace, longTasks } from './trace.mjs'

const [dir, mode = 'frames', filter = '', min] = process.argv.slice(2)
if (!dir) throw new Error('Usage: npm run perf:report -- <run dir> [frames|work|long] [filter]')
const run = resolve(dir)
const { dist } = JSON.parse(readFileSync(`${run}/meta.json`, 'utf8'))
const rows = readFileSync(`${run}/results.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => !filter || new RegExp(filter).test(row.id))

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

if (mode === 'frames') {
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
} else throw new Error(`Unknown mode ${mode}`)
