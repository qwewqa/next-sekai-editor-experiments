import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildRows,
    droppedEntries,
    selectableRows,
    type Entry,
    type EntryRow,
    type Row,
} from '../../src/editor/history/rows'

// The Timeline's rows (Part 1 §1.4.10.5): flags, ×N groups, headers and dividers.

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
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

const options = { filter: 'all' as const, expanded: new Set<string>(), damaged: new Set<string>() }

const entryRows = (rows: Row[]) => rows.filter((row): row is EntryRow => row.type === 'entry')

const levels = (rows: Row[]) => rows.flatMap((row) => (row.type === 'header' ? [row.level] : []))

test('an entry dropped from the redo branch is not in undo, as in the plan’s example', () => {
    seq = 0
    const init = entry('init', 'Initialize')
    const b = entry('edit', 'Added slide')
    const c = entry('edit', 'Moved notes')
    const undo1 = entry('undo', 'Moved notes')
    const d = entry('edit', 'Changed BPM')
    const undo2 = entry('undo', 'Changed BPM')
    const save = entry('save', 'Saved coconut.nxsp')
    const dropped = droppedEntries(newestFirst(init, b, c, undo1, d, undo2, save))
    // Moved notes (entry 3) was dropped by the edit after the undo; the others are reachable.
    assert.deepEqual([...dropped], [`s:${c.seq}`])
})

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

test('minute headers split the rows, and day headers appear once the timeline spans days', () => {
    seq = 0
    const sameDay = buildRows(
        newestFirst(
            entry('edit', 'A', noon),
            entry('edit', 'B', noon + 5000),
            entry('edit', 'C', noon + 2 * MINUTE),
        ),
        options,
    )
    assert.deepEqual(levels(sameDay), ['minute', 'minute'])
    const days = buildRows(
        newestFirst(
            entry('edit', 'A', noon - DAY),
            entry('edit', 'B', noon),
            entry('edit', 'C', noon + MINUTE),
        ),
        options,
    )
    assert.deepEqual(levels(days), ['day', 'minute', 'minute', 'day', 'minute'])
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
