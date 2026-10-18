import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildRows,
    selectableRows,
    type Entry,
    type EntryRow,
    type Row,
} from '../../src/editor/history/rows'

// The Timeline's rows (Part 1 §1.4.10.5): flags, ×N groups, headers by age and dividers.

const MINUTE = 60_000
const noon = new Date(2026, 9, 16, 12, 0, 0).getTime()

let seq = 0
const entry = (kind: string, label: string, at = noon, extra: Partial<Entry> = {}): Entry => ({
    sessionId: 's',
    seq: ++seq,
    time: at,
    kind,
    label,
    noteCount: 0,
    kept: true,
    ...extra,
})

/** The builder takes entries newest first; tests list them oldest first. */
const newestFirst = (...entries: Entry[]) => entries.reverse()

// Noon on the 16th is "now" unless a test says otherwise.
const options = {
    filter: 'all' as const,
    expanded: new Set<string>(),
    damaged: new Set<string>(),
    now: noon + 30 * MINUTE,
}

const entryRows = (rows: Row[]) => rows.filter((row): row is EntryRow => row.type === 'entry')

test('removed and damaged rows are greyed and cannot be selected', () => {
    seq = 0
    const a = entry('edit', 'A', noon, { kept: false })
    const b = entry('edit', 'B')
    const c = entry('edit', 'C')
    const rows = entryRows(
        buildRows(newestFirst(a, b, c), { ...options, damaged: new Set([`s:${c.seq}`]) }),
    )
    const byLabel = Object.fromEntries(rows.map((row) => [row.entry.label, row]))
    assert.equal(byLabel.A?.flags.removed, true)
    assert.equal(byLabel.A?.selectable, false)
    assert.equal(byLabel.C?.flags.damaged, true)
    assert.equal(byLabel.C?.selectable, false)
    assert.equal(byLabel.B?.selectable, true)
    const selectable = selectableRows(buildRows(newestFirst(a, b, c), options))
    assert.deepEqual(
        selectable.map((row) => row.id),
        ['now', `s:${c.seq}`, `s:${b.seq}`],
    )
})

test('consecutive entries with one label collapse into ×N, and so do runs of undo or redo', () => {
    seq = 0
    const rows = entryRows(
        buildRows(
            newestFirst(
                entry('edit', 'Scrub'),
                entry('edit', 'Scrub'),
                entry('edit', 'Scrub'),
                entry('edit', 'Other'),
                entry('undo', 'Other'),
                entry('undo', 'Scrub'),
                entry('redo', 'Scrub'),
            ),
            options,
        ),
    )
    assert.deepEqual(
        rows.map((row) => [row.entry.kind, row.members.length]),
        [
            ['redo', 1],
            ['undo', 2],
            ['edit', 1],
            ['edit', 3],
        ],
    )
})

test('an open group lists its members under it', () => {
    seq = 0
    const list = newestFirst(entry('edit', 'Scrub'), entry('edit', 'Scrub'))
    const group = entryRows(buildRows(list, options))[0]
    assert.ok(group)
    const open = entryRows(buildRows(list, { ...options, expanded: new Set([group.id]) }))
    assert.deepEqual(
        open.map((row) => row.child),
        [false, true, true],
    )
})

test('the note count change shows when known and not zero, and sums across a group', () => {
    seq = 0
    const rows = entryRows(
        buildRows(
            newestFirst(
                entry('init', 'Initialize', noon, { noteCount: 10 }),
                entry('edit', 'Add', noon, { noteCount: 12 }),
                entry('edit', 'Add', noon, { noteCount: 15 }),
                entry('edit', 'Move', noon, { noteCount: 15 }),
                entry('save', 'Saved', noon, { noteCount: 15 }),
            ),
            options,
        ),
    )
    assert.deepEqual(
        rows.map((row) => row.delta),
        [undefined, undefined, 5, undefined],
    )
})

test('the Saves and Exports filter keeps saves, exports and dividers', () => {
    seq = 0
    const rows = buildRows(
        newestFirst(
            entry('init', 'Initialize'),
            entry('edit', 'A'),
            entry('save', 'Saved a.nxsp'),
            entry('continue', 'Continued'),
            entry('edit', 'B'),
            entry('export', 'Exported a.nsld'),
        ),
        { ...options, filter: 'saves' },
    )
    assert.deepEqual(
        rows
            .filter((row) => row.type !== 'header')
            .map((row) => (row.type === 'entry' ? row.entry.label : row.type)),
        ['now', 'Exported a.nsld', 'divider', 'Saved a.nxsp'],
    )
})

const headers = (rows: Row[]) =>
    rows.flatMap((row) =>
        row.type === 'header' ? [`${row.level}${row.withDay ? '+day' : ''}`] : [],
    )

test('headers get coarser with age: minutes this hour, hours today, hours under a day for six days, days after', () => {
    seq = 0
    const at = (days: number, hour: number, minute = 0) =>
        new Date(2026, 9, 16 - days, hour, minute).getTime()
    const rows = buildRows(
        newestFirst(
            entry('edit', 'old', at(9, 10)),
            entry('edit', 'old too', at(9, 9)),
            entry('edit', 'older week', at(7, 15)),
            entry('edit', 'six days', at(6, 21)),
            entry('edit', 'six days later', at(6, 21, 30)),
            entry('edit', 'yesterday', at(1, 9)),
            entry('edit', 'yesterday 2', at(1, 22)),
            entry('edit', 'earlier today', at(0, 9)),
            entry('edit', 'this hour', at(0, 12, 5)),
            entry('edit', 'this hour 2', at(0, 12, 7)),
        ),
        options,
    )
    assert.deepEqual(headers(rows), [
        'minute', // 12:07
        'minute', // 12:05
        'hour', // 9 AM today
        'hour+day', // Yesterday · 10 PM
        'hour', // 9 AM
        'hour+day', // 6 days ago · 9 PM (both rows share the hour)
        'day', // 7 days ago
        'day', // 9 days ago, one header for both rows
    ])
})

test('a day and its first hour share one header, and one hour is one header', () => {
    seq = 0
    const rows = buildRows(
        newestFirst(
            entry('edit', 'A', new Date(2026, 9, 15, 21, 5).getTime()),
            entry('edit', 'B', new Date(2026, 9, 15, 21, 40).getTime()),
        ),
        options,
    )
    assert.deepEqual(headers(rows), ['hour+day'])
})

test('a divider keeps its own rule, and the rows after it get their own header', () => {
    seq = 0
    const rows = buildRows(
        newestFirst(
            entry('edit', 'A', new Date(2026, 9, 15, 21, 5).getTime()),
            entry('continue', 'Continued', noon, { from: noon - 99 }),
            entry('edit', 'B', noon + 2 * MINUTE),
        ),
        options,
    )
    assert.deepEqual(
        rows.map((row) => row.type),
        ['now', 'header', 'entry', 'divider', 'header', 'entry'],
    )
})

test('a continuation is a divider, never a peekable row', () => {
    seq = 0
    const rows = buildRows(
        newestFirst(
            entry('edit', 'A'),
            entry('continue', 'Continued', noon, { from: noon - 99 }),
            entry('edit', 'B'),
        ),
        options,
    )
    const divider = rows.find((row) => row.type === 'divider')
    assert.ok(divider && divider.type === 'divider')
    assert.equal(divider.entry.from, noon - 99)
    assert.equal(
        selectableRows(rows).some((row) => row.id === divider.id),
        false,
    )
})

test('a window after a jump: Now, the gap row, then the window’s rows under their own day', () => {
    seq = 0
    const at = (hour: number, minute: number) => new Date(2026, 9, 14, hour, minute).getTime()
    const rows = buildRows(
        newestFirst(entry('edit', 'Added notes', at(16, 40)), entry('save', 'Saved', at(17, 2))),
        { ...options, gap: 1206 },
    )
    assert.deepEqual(
        rows.map((row) => (row.type === 'gap' ? `gap ${row.count}` : row.type)),
        ['now', 'gap 1206', 'header', 'entry', 'header', 'entry'],
    )
    assert.deepEqual(headers(rows), ['hour+day', 'hour'])
    // The gap row never holds the cursor.
    assert.deepEqual(
        selectableRows(rows).map((row) => row.type),
        ['now', 'entry', 'entry'],
    )
    assert.ok(!buildRows([], options).some((row) => row.type === 'gap'))
})
