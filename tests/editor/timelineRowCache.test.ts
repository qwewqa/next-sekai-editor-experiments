import assert from 'node:assert/strict'
import test from 'node:test'
import { createRecipeCache, recipeOfRow } from '../../src/editor/history/rowPresentation'
import {
    buildRows,
    entryId,
    pinnedIsRow,
    type BuildOptions,
    type Entry,
    type EntryRow,
    type Row,
} from '../../src/editor/history/rows'
import type { EntryDescription, NativeOperationInput } from '../../src/history/operations'
import { hostCalendar } from '../helpers/calendar'
import { editStep, futureFixtureOperation, nativeOperation, noteAdd } from '../helpers/historySteps'

// The Timeline builds its rows without the peek's pin and reuses row recipes across builds. Both
// must give exactly what a full build with the pin, and a fresh recipe, would.

const MINUTE = 60_000
const noon = new Date(2026, 9, 16, 12).getTime()

/** A small seeded generator, so a failure names its seed. */
const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed / 2 ** 31
}

const step = (input: NativeOperationInput, text: string): EntryDescription => ({
    kind: 'edit',
    step: editStep(nativeOperation(input, text)),
})
const move = (count: number) =>
    step({ id: 'nse.object.move', data: { subject: 'note', changed: { note: count } } }, 'Moved')
const descriptions: (() => EntryDescription)[] = [
    () => ({ kind: 'edit', step: editStep(noteAdd(1)) }),
    () => ({ kind: 'edit', step: editStep(noteAdd(2)) }),
    () => move(1),
    () => move(2),
    () => ({ kind: 'undo', step: editStep(noteAdd(1)) }),
    () => ({ kind: 'redo', step: editStep(noteAdd(1)) }),
    () => ({ kind: 'save', operation: futureFixtureOperation('save') }),
    () => ({ kind: 'edit', step: editStep(futureFixtureOperation('opaque')) }),
]

/** A chain's entries newest first: runs of alike steps over two sessions and a few hours. */
const chain = (next: () => number, count: number) => {
    const entries: Entry[] = []
    let time = noon - 5 * 60 * MINUTE
    let kind = 0
    for (let seq = 1; seq <= count; seq++) {
        if (next() < 0.3) kind = Math.floor(next() * descriptions.length)
        time += next() < 0.1 ? 50 * MINUTE : MINUTE
        entries.push({
            ...descriptions[kind]!(),
            sessionId: seq <= count / 2 ? 'a' : 'b',
            seq,
            time,
            noteCount: seq,
            kept: next() > 0.05,
        } as Entry)
    }
    return entries.reverse()
}

const options = (more = false, extra: Partial<BuildOptions> = {}): BuildOptions => ({
    filter: 'all',
    expanded: new Set(),
    damaged: new Set(),
    calendar: hostCalendar(noon),
    more,
    ...extra,
})
const entryRows = (rows: Row[]) => rows.filter((row): row is EntryRow => row.type === 'entry')
const keys = (row: EntryRow) => row.members.map(entryId)

test('a pin that is already one closed row builds the rows it was built without', () => {
    for (let seed = 1; seed <= 40; seed++) {
        const next = random(seed)
        const entries = chain(next, 120)
        const filter = seed % 5 === 0 ? 'saves' : 'all'
        const expanded = new Set(
            entryRows(buildRows(entries, options()))
                .filter(() => next() < 0.2)
                .map((row) => row.id),
        )
        const base = options(seed % 2 === 0, { filter, expanded })
        const unpinned = buildRows(entries, base)
        const rows = entryRows(unpinned)
        // Each row's own run, as a peek of that row pins it, and runs that are not one row (part of a
        // row, or entries from two rows).
        const pins = [
            ...rows.filter((row) => !row.child).map(keys),
            ...Array.from({ length: 30 }, () => {
                const start = Math.floor(next() * entries.length)
                return entries
                    .slice(start, start + 1 + Math.floor(next() * 6))
                    .map((entry) => entryId(entry))
            }),
        ]
        for (const pin of pins) {
            const pinned = buildRows(entries, { ...base, pinned: pin })
            if (pinnedIsRow(unpinned, pin))
                assert.deepEqual(unpinned, pinned, `seed ${seed}, pin ${pin.join()}`)
        }
        for (const row of rows.filter((each) => !each.child))
            assert.ok(pinnedIsRow(unpinned, keys(row)), `seed ${seed}, row ${row.id}`)
    }
})

test('a pin that splits a run is not taken for a row', () => {
    const entries = Array.from(
        { length: 4 },
        (_, i): Entry =>
            ({
                kind: 'edit',
                step: editStep(noteAdd(1)),
                sessionId: 's',
                seq: 4 - i,
                time: noon,
                kept: true,
            }) as Entry,
    )
    const unpinned = buildRows(entries, options())
    const [run] = entryRows(unpinned)
    assert.equal(run?.members.length, 4)
    assert.equal(pinnedIsRow(unpinned, ['s:4', 's:3']), false)
    assert.equal(pinnedIsRow(unpinned, ['s:3', 's:2', 's:1']), false)
    assert.notDeepEqual(buildRows(entries, { ...options(), pinned: ['s:4', 's:3'] }), unpinned)
})

test('kept recipes are always the ones the rows would get fresh', () => {
    for (let seed = 1; seed <= 25; seed++) {
        const next = random(seed)
        const all = chain(next, 300)
        // Half the seeds with a small limit, so the cache also drops rows it holds.
        const cache = createRecipeCache(seed % 2 ? 40 : undefined)
        const place = (entry: Entry) => all.findIndex((each) => entryId(each) === entryId(entry))
        // The Timeline's run as it changes: older pages arrive, new entries come in on top, a peek
        // pins a run, a group opens, the filter changes, and an entry read again comes back as a
        // new object with other content under the same id (a waiting entry once stored).
        let loaded = all.slice(100, 160)
        let more = true
        let pinned: string[] | undefined
        let expanded = new Set<string>()
        let filter: 'all' | 'saves' = 'all'
        for (let round = 0; round < 30; round++) {
            const change = Math.floor(next() * 7)
            if (change === 0 && more) {
                const end = place(loaded.at(-1)!) + 1
                loaded = [...loaded, ...all.slice(end, end + 25)]
                more = end + 25 < all.length
            } else if (change === 1) {
                const start = place(loaded[0]!)
                loaded = [...all.slice(Math.max(0, start - 10), start), ...loaded]
            } else if (change === 2) {
                const rows = entryRows(buildRows(loaded, options(more)))
                const row = rows[Math.floor(next() * rows.length)]
                pinned = row && keys(row).slice(0, 1 + Math.floor(next() * row.members.length))
            } else if (change === 3) {
                const rows = entryRows(buildRows(loaded, options(more, { pinned })))
                expanded = new Set(rows.filter(() => next() < 0.3).map((row) => row.id))
            } else if (change === 4) filter = filter === 'all' ? 'saves' : 'all'
            else if (change === 5) {
                const at = Math.floor(next() * loaded.length)
                const { sessionId, seq, time, kept } = loaded[at]!
                const again = { sessionId, seq, time, kept, ...move(3) } as Entry
                loaded = [...loaded.slice(0, at), again, ...loaded.slice(at + 1)]
            }
            const rows = buildRows(loaded, options(more, { pinned, expanded, filter }))
            const recipes = cache(rows)
            for (const row of entryRows(rows))
                assert.deepEqual(recipes.get(row.id), recipeOfRow(row), `seed ${seed}, ${row.id}`)
        }
    }
})

test('turning a filter off again reuses the recipes kept from before it', () => {
    const entries = chain(random(3), 200)
    const cache = createRecipeCache()
    const all = cache(buildRows(entries, options()))
    cache(buildRows(entries, options(false, { filter: 'saves' })))
    const again = cache(buildRows(entries, options()))
    assert.ok(all.size > 50)
    for (const [id, recipe] of all) assert.equal(again.get(id), recipe, id)
})
