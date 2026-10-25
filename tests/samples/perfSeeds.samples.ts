import { test, type BrowserContext } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Editor, prefix, SampleClock, seedContext } from './driver'

// The perf seeds (`npm run perf:seeds`): long histories of coconut for the perf harness's `seed`
// groups (docs/performance-testing.md, "Seeds"). Each is made through the editor's own commands
// on a dev server, with the clock moved between steps, then dumped to perf-results/data/seeds/
// (`NSE_PERF_SEEDS` overrides the folder). `PERF_SEEDS=history-1800,chain-small` picks seeds.
//
// - history-1800: coconut with about 1,800 steps in two visits, yesterday and today.
// - history-20h: about 20,000 steps in ten visits of two hours over the last twelve days.
// - chain-small: coconut with a dozen edits, the chain `scripts/perf/seeds.mjs` copies into
//   500 or 2,000 chains.
//
// A visit mixes what charting does: runs of notes placed with the Note tool, small flips near a
// time that walks the chart, runs of undos (a new edit after them is a branch), runs of Initial
// Life steps (×N rows), and a flip of the whole chart every 400 steps, for the change view.

const root = resolve(import.meta.dirname, '../..')
const level = join(root, 'test_level_data/coconut-next-sekai-24887.json.gz')
const out = resolve(process.env.NSE_PERF_SEEDS ?? join(root, 'perf-results/data/seeds'))
const picked = process.env.PERF_SEEDS?.split(',')

const random = (() => {
    let seed = 20261024
    return () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
})()
const between = (min: number, max: number) => min + random() * (max - min)
const int = (min: number, max: number) => Math.floor(between(min, max + 1))

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

declare global {
    interface Window {
        perfSeed: {
            /** Flips the `count` plain notes nearest a beat; false when nothing changed. */
            flipNear: (beat: number, count: number) => boolean
            /** Flips every note and connector. */
            flipAll: () => boolean
            /** One Initial Life step. */
            life: () => void
            end: () => number
            entries: () => number
        }
    }
}

/** Installs `window.perfSeed`: the commands the seeds run, from the app's own modules. */
const installSeedApp = async () => {
    const urls = new Map(
        performance
            .getEntriesByType('resource')
            .map((entry) => [new URL(entry.name).pathname, entry.name]),
    )
    const appImport = <T>(pathname: string): Promise<T> => import(urls.get(pathname) ?? pathname)
    const history = await appImport<typeof import('../../src/history')>('/src/history/index.ts')
    const { getAllEntities } =
        await appImport<typeof import('../../src/history/store')>('/src/history/store.ts')
    const { flip } = await appImport<typeof import('../../src/editor/commands/flip')>(
        '/src/editor/commands/flip/index.ts',
    )
    const { createHistoryOperation } = await appImport<
        typeof import('../../src/history/createHistoryOperation')
    >('/src/history/createHistoryOperation.ts')
    const select = (entities: unknown[]) =>
        history.replaceState({ ...history.state.value, selectedEntities: entities as never })
    const flipped = (run: () => void) => {
        const before = history.state.value
        run()
        const changed = history.state.value !== before
        select([])
        return changed
    }
    window.perfSeed = {
        flipNear(beat, count) {
            const notes = [...getAllEntities()]
                .filter((e) => e.type === 'note' && !(e as { isAttached?: boolean }).isAttached)
                .sort((a, b) => Math.abs(a.beat - beat) - Math.abs(b.beat - beat))
                .slice(0, count)
            select(notes)
            return flipped(() => flip.execute())
        },
        flipAll() {
            select([...getAllEntities()].filter((e) => e.type === 'note' || e.type === 'connector'))
            return flipped(() => flip.execute())
        },
        life() {
            const before = history.state.value.initialLife
            const after = before + 1
            history.pushState(
                createHistoryOperation({
                    id: 'nse.header.set',
                    data: { field: 'initialLife', before, after },
                }),
                { ...history.state.value, initialLife: after },
            )
        },
        end() {
            let end = 0
            for (const e of getAllEntities()) end = Math.max(end, e.beat)
            return end
        },
        entries() {
            const flusher = window.nseFlushTest?.flusher
            const session = flusher?.session
            return flusher && session ? flusher.newestSeq(session) : 0
        },
    }
}

type Plan = { steps: number; start: number }

/** One visit: `steps` steps from `start`, each with a gap of a few seconds. */
const runVisit = async (
    context: BrowserContext,
    clock: SampleClock,
    plan: Plan,
    first: boolean,
    region: { next: number },
) => {
    await clock.passTo(plan.start)
    let made = 0
    const ed = await Editor.visit(context, clock)
    const page = ed.page
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) console.log(`navigated: ${frame.url()} after ${made}`)
    })
    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning')
            console.log(`console.${message.type()}: ${message.text()}`)
    })
    if (first) {
        const chooser = page.waitForEvent('filechooser')
        await ed.command('o')
        await (
            await chooser
        ).setFiles({
            name: 'coconut-next-sekai-24887.json.gz',
            mimeType: 'application/gzip',
            buffer: readFileSync(level),
        })
        await page.getByRole('button', { name: 'OK' }).click()
        for (let i = 0; i < 12; i++) await ed.command('-')
    }
    await page.evaluate(installSeedApp)
    const chartEnd = await page.evaluate(() => window.perfSeed.end())
    region.next = Math.max(region.next, chartEnd + 4)
    let walk = between(0, chartEnd)
    const walkEnd = chartEnd
    // Each step stored before the clock moves on: a call in flight across a few passes would
    // outlast the worker's 10 s timeout on the moved clock, and the tab would give up on it.
    const pass = async (ms: number) => {
        await ed.flush()
        await clock.pass(ms)
    }
    const gap = async () => {
        made++
        await pass(
            random() < 0.02 ? between(2 * MINUTE, 6 * MINUTE) : between(1 * SECOND, 5 * SECOND),
        )
        if (made % 400 === 0) {
            await page.evaluate(() => window.perfSeed.flipAll())
            made++
            await pass(between(3 * SECOND, 8 * SECOND))
        }
    }
    while (made < plan.steps) {
        const pick = random()
        if (pick < 0.12) {
            // Charting: a run of taps down a new stretch past the chart's end.
            await ed.command('Escape')
            await ed.command('f')
            await ed.command('a')
            const run = int(4, 8)
            await ed.focus(region.next + 2)
            for (let i = 0; i < run && made < plan.steps; i++) {
                const beat = region.next
                region.next += 0.5
                await ed.click(i % 2 ? 2 + (i % 4) : -6 + (i % 4), beat)
                await gap()
            }
        } else if (pick < 0.8) {
            const run = int(2, 8)
            for (let i = 0; i < run && made < plan.steps; i++) {
                walk = (walk + between(0.5, 4)) % walkEnd
                if (
                    await page.evaluate(
                        ([b, n]) => window.perfSeed.flipNear(b, n),
                        [walk, int(1, 3)],
                    )
                )
                    await gap()
            }
        } else if (pick < 0.92) {
            const run = int(1, 4)
            for (let i = 0; i < run && made < plan.steps; i++) {
                await ed.command('z')
                await gap()
            }
            if (random() < 0.3) {
                await ed.command('y')
                await gap()
            }
        } else {
            const run = int(3, 8)
            for (let i = 0; i < run && made < plan.steps; i++) {
                await page.evaluate(() => window.perfSeed.life())
                await gap()
            }
        }
    }
    await ed.flush()
    await ed.settled()
    const entries = await page.evaluate(() => window.perfSeed.entries())
    await page.close()
    return entries
}

/** Reads the database in a page that loads no editor code, through the dumper alone. */
const dump = async (context: BrowserContext) => {
    const page = await context.newPage()
    await page.route('**/__seed-dump', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>dump</title>' }),
    )
    await page.goto('/__seed-dump')
    const result = await page.evaluate(async (prefix) => {
        const { dumpDatabase, dumpLocalStorage } =
            (await import('/src/local/dump.ts')) as typeof import('../../src/local/dump')
        const { idbFactory } =
            (await import('/src/local/kv/idb.ts')) as typeof import('../../src/local/kv/idb')
        const { appVersion } =
            (await import('/src/platform/version.ts')) as typeof import('../../src/platform/version')
        const db = await idbFactory(indexedDB).open('nse-local-data', undefined)
        const storage = dumpLocalStorage(localStorage, prefix)
        delete storage[`${prefix}showPreview`]
        const dumped = await dumpDatabase(db, {
            appVersion: appVersion().appVersion,
            localStorage: storage,
        })
        db.close()
        return JSON.stringify(dumped)
    }, prefix)
    await page.close()
    return result
}

/** Visits of `steps` each, two hours apart in use, on the given days before today. */
const visits = (days: number[], steps: number, hour = 9): Plan[] => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return days.map((back, i) => ({
        steps,
        start: today.getTime() - back * DAY + (hour + (i % 3) * 3) * HOUR,
    }))
}

const SEEDS: Record<string, () => Plan[]> = {
    'history-1800': () => visits([1, 0], 900, 8),
    'history-20h': () => visits([12, 11, 10, 8, 7, 5, 4, 2, 1, 0], 2000, 6),
    'chain-small': () => visits([0], 12, 8),
    debug: () => visits([1, 0], 150, 8),
}

for (const [name, plans] of Object.entries(SEEDS))
    test(name, async ({ browser }) => {
        test.skip(!!picked && !picked.includes(name), 'Not picked')
        test.setTimeout(4 * HOUR)
        const plan = plans()
        // The last visit ends before now.
        const now = Date.now()
        const last = plan.at(-1)!
        last.start = Math.min(last.start, now - last.steps * 4 * SECOND - 30 * MINUTE)
        const context = await browser.newContext()
        const clock = new SampleClock(context, plan[0]!.start - MINUTE)
        await clock.install()
        await seedContext(context)
        await context.addInitScript((prefix) => {
            localStorage.setItem(`${prefix}showPreview`, 'false')
            localStorage.setItem(`${prefix}showMinimap`, 'false')
        }, prefix)
        const region = { next: 0 }
        for (const [i, visit] of plan.entries()) {
            const entries = await runVisit(context, clock, visit, i === 0, region)
            console.log(`${name}: visit ${i + 1}/${plan.length}, ${entries} entries`)
        }
        const text = await dump(context)
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, `${name}.json`), `${text}\n`)
        console.log(`${name}: ${(text.length / 2 ** 20).toFixed(1)} MiB`)
        await context.close()
    })
