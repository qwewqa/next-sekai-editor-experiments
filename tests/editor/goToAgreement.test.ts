import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// I-4, I-5: Go To's days are the Timeline's header days. Stored rows are read as the page reads
// them (`readTimeline`), cut into rows by `buildRows`, and compared with the days of the worker's
// index (`readTimelineIndex` → `daysOf`): entry for entry, in order, in counts (steps under the
// headers, every member of collapsed groups, dividers not counted) and in labels, in six zones, at
// two clocks, with and without the Saves filter. Sessions are every origin: one of its own rows,
// a continuation, a file's rows with shuffled times and a "Continued from" divider in its middle,
// and a continuation of that.

const here = (path: string) => new URL(path, import.meta.url).href
const stubs: Record<string, string> = {
    [here('../../src/i18n/localizations.ts')]: [
        ...['en', 'fr', 'ja'].map(
            (locale) =>
                `import ${locale} from ${JSON.stringify(here(`../../src/i18n/${locale}/index.json`))} with { type: 'json' }`,
        ),
        'export const localizations = { en, fr, ja }',
    ].join('\n'),
    [here('../../src/settings.ts')]: [
        "import { reactive } from 'vue'",
        "export const settings = reactive({ locale: 'en' })",
    ].join('\n'),
}
registerHooks({
    load: (url, context, next) =>
        url in stubs
            ? { format: 'module', shortCircuit: true, source: stubs[url] }
            : next(url, context),
})

const { dayKey, resolveZone } = await import('../../src/calendar/calendar')
const { daysOf } = await import('../../src/calendar/pieces')
const { calendarAt } = await import('../../src/editor/history/calendarClock')
const { dayLabel, headerText } = await import('../../src/editor/history/labels')
const { buildRows } = await import('../../src/editor/history/rows')
const { createIndexMemo, readTimeline, readTimelineIndex } =
    await import('../../src/local/worker/timelineHandlers')
const { createWorld } = await import('../../src/local/testing/world')
const { openPage } = await import('../local/flush/harness')
const { editStep, futureFixtureOperation, nativeOperation, noteAdd } =
    await import('../helpers/historySteps')
await import('../helpers/lockChecks')

type Entry = import('../../src/editor/history/rows').Entry
type Row = import('../../src/editor/history/rows').Row

const MINUTE = 60_000
const at = (days: number, hours: number, minutes = 0) => Date.UTC(2026, 9, 5 + days, hours, minutes)

const ZONES = [
    'UTC',
    'America/New_York',
    'Asia/Kathmandu',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'Europe/London',
]

type Synthetic = {
    id: string
    origin: string
    parent?: { id: string; uptoSeq: number }
    /** Row times by seq from 1; a string kind marks a row that is not an edit. */
    rows: { time: number; kind?: 'save' | 'continue' | 'add' }[]
}

/** Times `step` apart from `start`, every third and fourth row a groupable note add. */
const run = (start: number, count: number, step: number, offset = 0) =>
    Array.from({ length: count }, (_, i) => ({
        time: start + i * step,
        kind:
            (i + offset) % 5 === 0
                ? ('save' as const)
                : (i + offset) % 3 === 0
                  ? undefined
                  : ('add' as const),
    }))

/** Sessions in the shape of a real chain: see the header. */
const chain = (): Synthetic[] => [
    // Its own rows across three midnights, a Save every fifth row.
    { id: 'A', origin: 'new', rows: run(at(0, 20), 90, 50 * MINUTE) },
    // A continuation of A at its seq 60: the divider is its lowest row.
    {
        id: 'B',
        origin: 'continued',
        parent: { id: 'A', uptoSeq: 60 },
        rows: [{ time: at(4, 9), kind: 'continue' }, ...run(at(4, 9, 5), 40, 55 * MINUTE, 2)],
    },
    // A file's rows, times out of order across days, then the open's own rows with a divider in
    // the middle of the session.
    {
        id: 'F',
        origin: 'nxsp',
        rows: [
            { time: at(6, 10), kind: 'add' },
            { time: at(5, 22), kind: 'add' },
            { time: at(7, 1), kind: 'save' },
            { time: at(5, 23, 30), kind: 'add' },
            { time: at(6, 11) },
            { time: at(8, 9), kind: 'add' },
            { time: at(8, 9, 1), kind: 'continue' },
            { time: at(8, 9, 2), kind: 'add' },
            { time: at(8, 9, 3), kind: 'add' },
        ],
    },
    // A continuation of the opened session.
    {
        id: 'G',
        origin: 'continued',
        parent: { id: 'F', uptoSeq: 9 },
        rows: [{ time: at(9, 8), kind: 'continue' }, ...run(at(9, 8, 5), 30, 70 * MINUTE)],
    },
]

const seed = async (sessions: Synthetic[]) => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('first'))
    await page.tab.run(() =>
        page.core.write(['sessions', 'entries'], async (tx) => {
            for (const { id, origin, parent, rows } of sessions) {
                await tx.put('sessions', {
                    id,
                    chainId: 'chain',
                    origin,
                    lastSeq: rows.length,
                    entryCount: rows.length,
                    ...(parent ? { parent } : {}),
                })
                for (const [i, row] of rows.entries()) {
                    const body =
                        row.kind === 'save'
                            ? { kind: 'save', operation: futureFixtureOperation(`${id}${i}`) }
                            : row.kind === 'continue'
                              ? {
                                    kind: 'continue',
                                    operation: nativeOperation(
                                        { id: 'nse.continue', data: { fromTime: row.time - 1 } },
                                        'Continued',
                                    ),
                                }
                              : {
                                    kind: 'edit',
                                    step: editStep(
                                        row.kind === 'add'
                                            ? noteAdd(1)
                                            : futureFixtureOperation(`${id}${i}`),
                                    ),
                                }
                    await tx.put('entries', {
                        sessionId: id,
                        seq: i + 1,
                        time: row.time,
                        ...body,
                        snapshot: new Uint8Array(32),
                        noteCount: i,
                        kept: true,
                    })
                }
            }
        }),
    )
    return page
}

/** The days the headers show, from rows: a header on another day starts a day; steps are counted under it. */
const headerDays = (rows: Row[]) => {
    const days: { day: number; count: number; first: Extract<Row, { type: 'header' }> }[] = []
    for (const row of rows) {
        if (row.type === 'header') {
            if (days.at(-1)?.day !== row.day) days.push({ day: row.day, count: 0, first: row })
        } else if (row.type === 'entry' && !row.child) {
            // A header always precedes the first entry row.
            days.at(-1)!.count += row.members.length
        }
    }
    return days
}

// The rows are only read, so one world serves every test.
const page = await seed(chain())

test('the rows have collapsed groups, dividers and days that come back, so the comparison is not trivial', async () => {
    const zone = resolveZone('UTC')
    const read = await page.tab.run(() =>
        page.core.read(['sessions', 'entries', 'chains', 'nodes'], (tx) =>
            readTimeline(tx, { sessionId: 'G', limit: 100_000 }),
        ),
    )
    const rows = buildRows(read.entries as unknown as Entry[], {
        filter: 'all',
        expanded: new Set(),
        damaged: new Set(),
        calendar: calendarAt(at(9, 20), zone),
    })
    assert.ok(rows.some((row) => row.type === 'entry' && row.members.length > 1))
    assert.equal(rows.filter((row) => row.type === 'divider').length, 2)
    const days = headerDays(rows).map((day) => day.day)
    assert.ok(new Set(days).size < days.length)
})

for (const filter of ['all', 'saves'] as const)
    for (const zoneName of ZONES)
        for (const [label, now] of [
            ['recent', at(9, 20)],
            ['long after', at(60, 3)],
        ] as const)
            test(`Go To’s days are the Timeline’s header days (${filter}, ${zoneName}, ${label})`, async () => {
                const zone = resolveZone(zoneName)
                const cal = calendarAt(now, zone)
                const kinds = filter === 'saves' ? ['save', 'export'] : undefined
                for (const head of ['A', 'B', 'F', 'G']) {
                    const read = await page.tab.run(() =>
                        page.core.read(['sessions', 'entries', 'chains', 'nodes'], (tx) =>
                            readTimeline(tx, { sessionId: head, limit: 100_000 }),
                        ),
                    )
                    const entries = read.entries as unknown as Entry[]
                    const rows = buildRows(entries, {
                        filter,
                        expanded: new Set(),
                        damaged: new Set(),
                        calendar: cal,
                    })
                    const index = await page.tab.run(() =>
                        page.core.read(['sessions', 'entries'], (tx) =>
                            readTimelineIndex(
                                tx,
                                { sessionId: head, zone: zoneName, ...(kinds ? { kinds } : {}) },
                                createIndexMemo(),
                            ),
                        ),
                    )
                    const goTo = daysOf(index.pieces)
                    const headers = headerDays(rows)
                    const where = `${head} ${filter} ${zoneName} ${label}`
                    // Entry for entry, in order, in counts.
                    assert.deepEqual(
                        goTo.map((day) => [day.day, day.count]),
                        headers.map((day) => [day.day, day.count]),
                        where,
                    )
                    // In labels: a day's first header names it, or is the unnamed today that opens
                    // the list; Go To names it with the same function.
                    for (const [i, day] of headers.entries()) {
                        const { first } = day
                        const name = dayLabel(day.day as ReturnType<typeof dayKey>, cal)
                        assert.equal(goTo[i]?.day, day.day, where)
                        const text = headerText(first, cal)
                        if (first.level === 'day') assert.equal(text, name, where)
                        else if (first.withDay) assert.ok(text.startsWith(`${name} · `), where)
                        else assert.equal(day.day, cal.today, `${where}: only today opens unnamed`)
                    }
                    // Dividers are not steps: counts add up to the listed steps.
                    const steps = entries.filter(
                        (entry) =>
                            entry.kind !== 'continue' &&
                            (kinds === undefined || kinds.includes(entry.kind)),
                    ).length
                    assert.equal(
                        goTo.reduce((sum, day) => sum + day.count, 0),
                        steps,
                        where,
                    )
                    // Every entry sits under the header of its own day (X-1 for ×N groups).
                    for (const row of rows)
                        if (row.type === 'entry' && !row.child)
                            for (const member of row.members)
                                assert.equal(
                                    dayKey(member.time, zone),
                                    dayKey(row.entry.time, zone),
                                    `${where}: a ×N row spans two days`,
                                )
                }
            })

test('an opened file with skewed times is listed again where its rows come back to a day', async () => {
    const index = await page.tab.run(() =>
        page.core.read(['sessions', 'entries'], (tx) =>
            readTimelineIndex(tx, { sessionId: 'F', zone: 'UTC' }, createIndexMemo()),
        ),
    )
    const days = daysOf(index.pieces).map((day) => day.day)
    assert.equal(new Set(days).size < days.length, true)
})
