import assert from 'node:assert/strict'
import test from 'node:test'

// Headers are cut by local hour and day, so the host's zone matters. New York has the two daylight
// saving changes of 2026 (March 8 and November 1). node:test runs each file in its own process.
process.env.TZ = 'America/New_York'
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
assert.equal(
    zone,
    'America/New_York',
    `This platform ignores TZ (the resolved zone is ${zone}); the DST cases cannot run`,
)

const { buildRows } = await import('../../src/editor/history/rows')
const { hostCalendar, calendarIn } = await import('../helpers/calendar')
const { dayKey, resolveZone } = await import('../../src/calendar/calendar')
const newYork = resolveZone('America/New_York')
type Entry = import('../../src/editor/history/rows').Entry
type Row = import('../../src/editor/history/rows').Row
type Header = Extract<Row, { type: 'header' }>
type EntryDescription = import('../../src/history/operations').EntryDescription
const { editStep, futureFixtureOperation, noteAdd } = await import('../helpers/historySteps')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const at = (month: number, day: number, hour: number, minute = 0, year = 2026) =>
    new Date(year, month - 1, day, hour, minute).getTime()

let seq = 0
const entry = (description: EntryDescription, time: number, extra: Partial<Entry> = {}): Entry =>
    ({
        sessionId: 's',
        seq: ++seq,
        time,
        noteCount: 0,
        kept: true,
        ...description,
        ...extra,
    }) as Entry
// A Save is never put in a ×N group, so each one is a row of its own under the header of its hour.
const event = (kind: 'save' | 'export', time: number) =>
    entry({ kind, operation: futureFixtureOperation(kind) }, time)
const edit = (time: number) => event('save', time)
const plainEdit = (time: number) =>
    entry({ kind: 'edit', step: editStep(noteAdd(1)) }, time, { noteCount: 1 })

const rowsOf = (entries: Entry[], now: number, filter: 'all' | 'saves' = 'all') =>
    buildRows([...entries].reverse(), {
        filter,
        expanded: new Set(),
        damaged: new Set(),
        calendar: hostCalendar(now),
    })
const headers = (rows: Row[]) => rows.filter((row): row is Header => row.type === 'header')
const ids = (rows: Row[]) => rows.map((row) => row.id)
/** The entries under each header, by the order they were made in (their `time`). */
const under = (rows: Row[]) => {
    const groups: number[][] = []
    for (const row of rows) {
        if (row.type === 'header') groups.push([])
        else if (row.type === 'entry') groups.at(-1)?.push(row.entry.time)
    }
    return groups
}
const assertUnique = (rows: Row[]) => {
    const seen = new Set<string>()
    for (const id of ids(rows)) {
        assert.equal(seen.has(id), false, `row id ${id} appears twice`)
        seen.add(id)
    }
}

test('entry times that run backwards give every row a unique id', () => {
    // Made in this order (by seq): 5 hours ago, 3 hours ago, 5 hours ago again. An imported file
    // keeps another device's times, and a corrected clock can step back.
    const now = at(10, 16, 18, 30)
    const a = edit(now - 5 * HOUR)
    const b = edit(now - 3 * HOUR)
    const c = edit(now - 5 * HOUR + MINUTE)
    const rows = rowsOf([a, b, c], now)
    assertUnique(rows)
    // The headers stay by adjacency: the 5 hours span reappears below the 3 hours span.
    assert.equal(headers(rows).length, 3)
    assert.deepEqual(under(rows), [[c.time], [b.time], [a.time]])
})

test('day headers repeat without repeating an id when the days are out of order', () => {
    const now = at(10, 16, 18, 30)
    const old1 = edit(at(9, 1, 10))
    const old2 = edit(at(8, 1, 10))
    const old3 = edit(at(9, 1, 11))
    const rows = rowsOf([old1, old2, old3], now)
    assertUnique(rows)
    assert.deepEqual(
        headers(rows).map((header) => header.level),
        ['day', 'day', 'day'],
    )
    assert.deepEqual(under(rows), [[old3.time], [old2.time], [old1.time]])
})

test('a list without repeats keeps the plain ids, and the same entries give the same ids', () => {
    const now = at(10, 16, 18, 30)
    const entries = [edit(now - 5 * HOUR), edit(now - 3 * HOUR), edit(at(10, 15, 9))]
    const first = headers(rowsOf(entries, now)).map((header) => header.id)
    assert.equal(first.length, 3)
    for (const id of first) assert.match(id, /^[hd]:\d+(\|\d+)?$/)
    assert.deepEqual(
        headers(rowsOf(entries, now)).map((header) => header.id),
        first,
    )
})

test('at a daylight saving fall-back, the two 1 AM hours are two headers over their own entries', () => {
    // 2026-11-01: 01:00 to 01:59 EDT, then the clock goes back and 01:00 to 01:59 EST follows.
    const now = at(11, 1, 6)
    const early = edit(Date.parse('2026-11-01T04:50:00Z')) // 00:50 EDT
    const firstOne = edit(Date.parse('2026-11-01T05:10:00Z')) // 01:10 EDT
    const secondOne = edit(Date.parse('2026-11-01T06:10:00Z')) // 01:10 EST
    const late = edit(Date.parse('2026-11-01T07:05:00Z')) // 02:05 EST
    assert.equal(new Date(firstOne.time).getHours(), 1)
    assert.equal(new Date(secondOne.time).getHours(), 1)
    assert.equal(secondOne.time - firstOne.time, HOUR)
    const rows = rowsOf([early, firstOne, secondOne, late], now)
    assertUnique(rows)
    assert.deepEqual(under(rows), [[late.time], [secondOne.time], [firstOne.time], [early.time]])
})

test('a spring-forward day keeps its day boundaries', () => {
    // 2026-03-08 has 23 hours: 02:00 EST becomes 03:00 EDT. Seven days on, it is a day header.
    const now = at(3, 20, 12)
    const before = edit(at(3, 8, 1, 30)) // 01:30 EST
    const after = edit(at(3, 8, 3, 30)) // 03:30 EDT
    const previousDay = edit(at(3, 7, 23, 30))
    const nextDay = edit(at(3, 9, 0, 10))
    const rows = rowsOf([previousDay, before, after, nextDay], now)
    assertUnique(rows)
    assert.deepEqual(
        headers(rows).map((header) => header.level),
        ['day', 'day', 'day'],
    )
    assert.deepEqual(under(rows), [[nextDay.time], [after.time, before.time], [previousDay.time]])
})

test('an hour at a spring-forward jump has a header, and the skipped hour has none', () => {
    const now = at(3, 8, 12)
    const before = edit(Date.parse('2026-03-08T06:30:00Z')) // 01:30 EST
    const after = edit(Date.parse('2026-03-08T07:30:00Z')) // 03:30 EDT
    const rows = rowsOf([before, after], now)
    assertUnique(rows)
    assert.deepEqual(
        headers(rows).map((header) => new Date(header.time).getHours()),
        [3, 1],
    )
    assert.deepEqual(under(rows), [[after.time], [before.time]])
})

test('an entry dated after now gets an hour header and does not break the list', () => {
    // A device whose clock ran ahead: the entry is two hours in the future.
    const now = at(10, 16, 12, 30)
    const ahead = edit(now + 2 * HOUR)
    const normal = edit(now - 10 * MINUTE)
    const rows = rowsOf([normal, ahead], now)
    assertUnique(rows)
    const first = headers(rows)[0]
    assert.equal(first?.level, 'hour')
    assert.deepEqual(under(rows), [[ahead.time], [normal.time]])
    // Far ahead: still a header, and still no crash.
    const farAhead = edit(at(10, 20, 9))
    assert.doesNotThrow(() => rowsOf([normal, farAhead], now))
    assertUnique(rowsOf([normal, farAhead], now))
})

test('the sixth day back has hour headers and the seventh has day headers, in every season', () => {
    const cases = [
        // Across the spring-forward change, in both directions.
        { name: 'spring', now: at(3, 9, 12), six: at(3, 3, 9), seven: at(3, 2, 9) },
        // Across the fall-back change.
        { name: 'fall', now: at(11, 5, 12), six: at(10, 30, 9), seven: at(10, 29, 9) },
        // Late at night, when the day length is most likely to tip the rounding.
        {
            name: 'late spring',
            now: at(3, 9, 23, 59),
            six: at(3, 3, 0, 1),
            seven: at(3, 2, 23, 59),
        },
        {
            name: 'late fall',
            now: at(11, 5, 23, 59),
            six: at(10, 30, 0, 1),
            seven: at(10, 29, 23, 59),
        },
        { name: 'no change', now: at(10, 16, 12), six: at(10, 10, 9), seven: at(10, 9, 9) },
    ]
    for (const { name, now, six, seven } of cases) {
        const levels = headers(rowsOf([edit(seven), edit(six)], now)).map((header) => header.level)
        assert.deepEqual(levels, ['hour', 'day'], name)
    }
})

test('Saves and Exports with skewed times stay in the order they were made', () => {
    const now = at(10, 16, 18, 30)
    const save = event('save', now - 4 * HOUR)
    const exported = event('export', now - 6 * HOUR) // a later step with an earlier time
    const laterSave = event('save', now - 2 * HOUR)
    const rows = rowsOf([save, plainEdit(now - 3 * HOUR), exported, laterSave], now, 'saves')
    assertUnique(rows)
    const kinds = rows.flatMap((row) => (row.type === 'entry' ? [row.entry.seq] : []))
    assert.deepEqual(kinds, [laterSave.seq, exported.seq, save.seq])
    assert.deepEqual(under(rows).flat(), [laterSave.time, exported.time, save.time])
})

test('every new day names itself with its first header, except a today that opens the list', () => {
    const now = at(10, 16, 18, 30)
    const withDay = (rows: Row[]) => headers(rows).map((header) => header.withDay)

    // A today at the top of the list is unnamed: the list says Today by being at Now.
    assert.deepEqual(withDay(rowsOf([edit(now - 40 * MINUTE)], now)), [false])
    assert.deepEqual(withDay(rowsOf([edit(now - 5 * MINUTE)], now)), [false])

    // A later date names itself (a device whose clock ran ahead): "Oct 17 · 3 PM".
    const tomorrow = edit(at(10, 17, 15))
    const rows = rowsOf([tomorrow], now)
    assert.deepEqual(withDay(rows), [true])
    assert.equal(headers(rows)[0]?.level, 'hour')
    assert.equal(headers(rows)[0]?.day, dayKey(tomorrow.time, newYork))

    // A today below another day names itself: "Today · 8 AM" under tomorrow's rows.
    const morning = edit(at(10, 16, 8, 5))
    assert.deepEqual(withDay(rowsOf([morning, tomorrow], now)), [true, true])
    // Two rows of the same day share the one name.
    assert.deepEqual(withDay(rowsOf([edit(at(10, 17, 9)), tomorrow], now)), [true, false])
    // Yesterday opens the list: named, as before.
    assert.deepEqual(withDay(rowsOf([edit(at(10, 15, 21))], now)), [true])
    // Yesterday below today: the newer today is unnamed, and the older day names itself.
    assert.deepEqual(withDay(rowsOf([edit(at(10, 15, 21)), edit(now - 10 * MINUTE)], now)), [
        false,
        true,
    ])
})

test('headers carry the local day of their time', () => {
    const now = at(10, 16, 18, 30)
    const old = edit(at(9, 1, 10))
    const [header] = headers(rowsOf([old], now))
    assert.equal(header?.level, 'day')
    assert.equal(header?.day, dayKey(old.time, newYork))
    assert.equal(header?.time, old.time)
})

test('rows are cut by the calendar’s zone, not the host’s', () => {
    // 18:10Z and 18:20Z are the same New York hour (14:10 and 14:20). In Kathmandu (+5:45) they
    // are 23:55 on the 16th and 00:05 on the 17th: two days, two hours, two rows.
    const now = Date.UTC(2026, 9, 17, 3)
    const first = plainEdit(Date.UTC(2026, 9, 16, 18, 10))
    const second = plainEdit(Date.UTC(2026, 9, 16, 18, 20))
    const sizes = (zone: string) =>
        buildRows([second, first], {
            filter: 'all',
            expanded: new Set(),
            damaged: new Set(),
            calendar: calendarIn(now, zone),
        })
            .filter((row): row is Extract<Row, { type: 'entry' }> => row.type === 'entry')
            .map((row) => row.members.length)
    assert.deepEqual(sizes('America/New_York'), [2])
    assert.deepEqual(sizes('Asia/Kathmandu'), [1, 1])
    const kathmanduHeaders = headers(
        buildRows([second, first], {
            filter: 'all',
            expanded: new Set(),
            damaged: new Set(),
            calendar: calendarIn(now, 'Asia/Kathmandu'),
        }),
    )
    assert.equal(kathmanduHeaders.length, 2)
    assert.notEqual(kathmanduHeaders[0]?.day, kathmanduHeaders[1]?.day)
})
