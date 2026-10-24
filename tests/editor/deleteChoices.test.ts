import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DEFAULT_RANGE,
    NAMES_SHOWN,
    chosen,
    confirmLines,
    inRange,
    rangeCounts,
    type ConfirmTexts,
} from '../../src/editor/settings/deleteChoices'
import en from '../../src/i18n/en/index.json'

// Delete Sessions…' pure view: the counts the dialog shows are what
// the confirm names and what is deleted, so they come from one `chosen`.

type Row = { ageDays: number; notSaved: boolean; readable: 'yes' | 'newer'; name: string }

const row = (ageDays: number, name: string, extra: Partial<Row> = {}): Row => ({
    ageDays,
    name,
    notSaved: false,
    readable: 'yes',
    ...extra,
})

const texts: ConfirmTexts = {
    confirm: en.settings.localData.deleteConfirm,
    notSaved: en.settings.localData.notSaved,
    namesMore: en.settings.localData.namesMore,
    newer: en.settings.localData.newer,
    listJoin: en.modals.form.listJoin,
    quoted: en.history.quoted,
}
const lines = (rows: Row[]) => confirmLines(rows, (chain) => chain.name, texts)

/** Ages 2, 8, 40 and 100 days; the 8 and the 100 are not saved to a file. */
const profile = [
    row(2, 'Fresh'),
    row(8, 'Week', { notSaved: true }),
    row(40, 'Month'),
    row(100, 'Old', { notSaved: true }),
]

test('a range holds the chains last edited over that many days ago; All holds every one', () => {
    assert.equal(DEFAULT_RANGE, 90)
    const edge = row(7, 'Edge')
    assert.equal(inRange(edge, 7), false)
    assert.equal(inRange(row(8, 'Next'), 7), true)
    assert.equal(inRange(row(0, 'Today'), 'all'), true)
})

test('each count follows the box', () => {
    const counts = (box: boolean) =>
        Object.fromEntries(rangeCounts(profile, box).map(({ range, count }) => [range, count]))
    // Unticked: work not saved to a file is never counted, so it is never deleted.
    assert.deepEqual(counts(false), { 1: 2, 7: 1, 30: 1, 90: 0, all: 2 })
    assert.deepEqual(counts(true), { 1: 4, 7: 3, 30: 2, 90: 1, all: 4 })
    // The counts are what is chosen.
    for (const box of [false, true])
        for (const { range, count } of rangeCounts(profile, box))
            assert.equal(chosen(profile, range, box).length, count)
})

test('a newer chain is counted like any other (it counts as not saved)', () => {
    const newer = row(50, 'Later', { notSaved: true, readable: 'newer' })
    assert.equal(chosen([newer], 30, false).length, 0)
    assert.equal(chosen([newer], 30, true).length, 1)
})

test('the confirm asks first, with the singular and the plural by count', () => {
    assert.deepEqual(lines([row(100, 'A')]), ['Delete 1 session?'])
    assert.deepEqual(lines([row(100, 'A'), row(100, 'B')]), ['Delete 2 sessions?'])
})

test('the confirm names the not-saved chains it deletes, and no others', () => {
    // Box unticked: the chosen set has none, so there is no line and no name.
    assert.deepEqual(lines(chosen(profile, 'all', false)), ['Delete 2 sessions?'])
    // Ticked: the 8 and 100 day chains are named, the saved ones are not.
    assert.deepEqual(lines(chosen(profile, 'all', true)), [
        'Delete 4 sessions?',
        '2 sessions are not saved to a file: "Week", "Old".',
    ])
    assert.deepEqual(lines([row(100, 'Old', { notSaved: true })]), [
        'Delete 1 session?',
        '1 session is not saved to a file: "Old".',
    ])
})

test('more than three not-saved names end with "and N more"', () => {
    const many = ['A', 'B', 'C', 'D', 'E'].map((name) => row(100, name, { notSaved: true }))
    assert.equal(NAMES_SHOWN, 3)
    assert.deepEqual(
        lines(many.slice(0, 3)).at(-1),
        '3 sessions are not saved to a file: "A", "B", "C".',
    )
    assert.deepEqual(lines(many), [
        'Delete 5 sessions?',
        '5 sessions are not saved to a file: "A", "B", "C" and 2 more.',
    ])
})

test('the newer line shows only when the chosen set holds a newer chain, singular for one session', () => {
    const newer = row(100, 'Later', { readable: 'newer', notSaved: true })
    assert.equal(
        lines([row(100, 'A'), row(100, 'B')]).some((line) => line.includes('newer version')),
        false,
    )
    assert.equal(lines([newer]).at(-1), 'This session needs a newer version of the editor.')
    assert.equal(
        lines([row(100, 'A'), newer]).at(-1),
        'Some of these sessions need a newer version of the editor.',
    )
    // The not-saved line comes before the newer line.
    assert.deepEqual(lines([newer]), [
        'Delete 1 session?',
        '1 session is not saved to a file: "Later".',
        'This session needs a newer version of the editor.',
    ])
})
