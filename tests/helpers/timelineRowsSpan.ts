import assert from 'node:assert/strict'
import test from 'node:test'

// A ×N group never crosses a local day or a local hour: every
// row and every expanded member sits under the header of its own day and hour, so Go To's day
// counts, which count entries by their own day, agree with the headers. Run in one zone per file:
// the caller sets TZ before importing this.

export const runSpanTests = async (zone: string) => {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
    assert.equal(resolved, zone, `This platform ignores TZ (the resolved zone is ${resolved})`)

    const { buildRows } = await import('../../src/editor/history/rows')
    const { hostCalendar } = await import('./calendar')
    type Entry = import('../../src/editor/history/rows').Entry
    type Row = import('../../src/editor/history/rows').Row
    type EntryRow = Extract<Row, { type: 'entry' }>
    type Header = Extract<Row, { type: 'header' }>
    const { editStep, noteAdd } = await import('./historySteps')

    const MINUTE = 60_000
    const HOUR = 60 * MINUTE
    const at = (day: number, hour: number, minute = 0, second = 0) =>
        new Date(2026, 9, day, hour, minute, second).getTime()

    let seq = 0
    // Note adds group with each other: a run of them is one ×N row unless something ends it.
    const add = (time: number): Entry =>
        ({
            sessionId: 's',
            seq: ++seq,
            time,
            noteCount: 0,
            kept: true,
            kind: 'edit',
            step: editStep(noteAdd(1)),
        }) as Entry

    const build = (oldestFirst: Entry[], now: number, expandAll = false) => {
        const newestFirst = [...oldestFirst].reverse()
        const plain = buildRows(newestFirst, {
            filter: 'all',
            expanded: new Set(),
            damaged: new Set(),
            calendar: hostCalendar(now),
        })
        if (!expandAll) return plain
        const groups = plain.filter(
            (row): row is EntryRow => row.type === 'entry' && row.members.length > 1,
        )
        return buildRows(newestFirst, {
            filter: 'all',
            expanded: new Set(groups.map((row) => row.id)),
            damaged: new Set(),
            calendar: hostCalendar(now),
        })
    }

    const dayOf = (time: number) => new Date(time).setHours(0, 0, 0, 0)
    const hourOf = (time: number) => {
        const date = new Date(time)
        return time - (date.getMinutes() * MINUTE + date.getSeconds() * 1000)
    }

    /** Each entry, members too, against the header above its row: same day, and same hour. */
    const assertUnderOwnSpan = (rows: Row[]) => {
        let header: Header | undefined
        for (const row of rows) {
            if (row.type === 'header') header = row
            if (row.type !== 'entry' || !header) continue
            for (const member of row.members) {
                const what: string = `entry ${member.seq} (${new Date(member.time).toString()}) under ${new Date(header.time).toString()}`
                assert.equal(dayOf(member.time), dayOf(header.time), `day: ${what}`)
                if (header.level !== 'day')
                    assert.equal(hourOf(member.time), hourOf(header.time), `hour: ${what}`)
            }
        }
    }

    /** Entries under each day's headers, as Go To counts them: by each entry's own day. */
    const headerDayCounts = (rows: Row[]) => {
        const counts = new Map<number, number>()
        let header: Header | undefined
        for (const row of rows) {
            if (row.type === 'header') header = row
            else if (row.type === 'entry' && !row.child && header)
                counts.set(
                    dayOf(header.time),
                    (counts.get(dayOf(header.time)) ?? 0) + row.members.length,
                )
        }
        return counts
    }
    const entryDayCounts = (entries: Entry[]) => {
        const counts = new Map<number, number>()
        for (const entry of entries)
            counts.set(dayOf(entry.time), (counts.get(dayOf(entry.time)) ?? 0) + 1)
        return counts
    }
    const sizes = (rows: Row[]) =>
        rows
            .filter((row): row is EntryRow => row.type === 'entry' && !row.child)
            .map((row) => row.members.length)

    test(`${zone}: a run across midnight splits at the day`, () => {
        // The steps: 11:59:41 PM, then 12:00:26 AM, read at 12:01 AM.
        const entries = [add(at(20, 23, 55)), add(at(20, 23, 59, 41)), add(at(21, 0, 0, 26))]
        const now = at(21, 0, 1)
        for (const expandAll of [false, true]) {
            const rows = build(entries, now, expandAll)
            assertUnderOwnSpan(rows)
            assert.deepEqual(headerDayCounts(rows), entryDayCounts(entries))
        }
        assert.deepEqual(sizes(build(entries, now)), [1, 2])
        // Also once both days are past the hour headers.
        const later = at(29, 12)
        assertUnderOwnSpan(build(entries, later, true))
        assert.deepEqual(sizes(build(entries, later)), [1, 2])
    })

    test(`${zone}: a run splits at each local hour, and joins across minutes in the current hour`, () => {
        // The hour case: 12:41 AM and 2:41 AM, then a day later 4:41 AM.
        const entries = [add(at(21, 0, 41)), add(at(21, 2, 41)), add(at(22, 4, 41))]
        const now = at(22, 4, 42)
        for (const expandAll of [false, true]) {
            const rows = build(entries, now, expandAll)
            assertUnderOwnSpan(rows)
            assert.deepEqual(headerDayCounts(rows), entryDayCounts(entries))
        }
        assert.deepEqual(sizes(build(entries, now)), [1, 1, 1])
        // 1:59 and 2:00 are two hours.
        assert.deepEqual(
            sizes(build([add(at(21, 1, 59)), add(at(21, 2, 0))], at(22, 4, 42))),
            [1, 1],
        )
        // Minute headers inside the current hour may be crossed: one row of three.
        const minutes = [add(at(22, 4, 2)), add(at(22, 4, 20)), add(at(22, 4, 41))]
        assert.deepEqual(sizes(build(minutes, now)), [3])
        // Once that hour is past, the three still share one hour: still one row.
        assert.deepEqual(sizes(build(minutes, now + 2 * HOUR)), [3])
        // An hour more than a week back is still an hour of its own, so a row's members never
        // depend on when it is read.
        const old = [add(at(1, 9, 30)), add(at(1, 10, 30))]
        const rows = build(old, now, true)
        assertUnderOwnSpan(rows)
        assert.deepEqual(sizes(build(old, now)), [1, 1])
    })
}
