import assert from 'node:assert/strict'
import test from 'node:test'
import { heightOf, isCountedParent, presentRow } from '../../src/editor/history/rowPresentation'
import { buildRows, type Entry, type EntryRow } from '../../src/editor/history/rows'

const strings = {
    edits: '{0} edits',
    undidSteps: 'Undid {0} steps',
    redidSteps: 'Redid {0} steps',
    undo: 'Undo',
    redo: 'Redo',
}
const rows = (labels: string[], extra: Partial<Entry> = {}, more = false) =>
    buildRows(
        labels.map((label, i) => ({
            sessionId: 's',
            seq: labels.length - i,
            time: 0,
            kind: 'edit',
            label,
            kept: true,
            ...extra,
        })),
        { filter: 'all', expanded: new Set(), damaged: new Set(), more, now: 0 },
    ).filter((row): row is EntryRow => row.type === 'entry')

test('equal record counts retain distinct action descriptions and embedded quantities', () => {
    const [added, moved] = rows(['Added 1 note', 'Added 1 note', 'Moved 3 notes', 'Moved 3 notes'])
    assert.deepEqual(presentRow(added!, strings), {
        main: 'Added 1 note',
        count: '2 edits',
        full: 'Added 1 note · 2 edits',
    })
    assert.deepEqual(presentRow(moved!, strings), {
        main: 'Moved 3 notes',
        count: '2 edits',
        full: 'Moved 3 notes · 2 edits',
    })
})

test('foreign action text remains verbatim and blank fallback never normalizes grouping', () => {
    const [foreign, blank, whitespace] = rows(['ノーツを追加', 'ノーツを追加', '', '', ' ', ' '])
    assert.equal(presentRow(foreign!, strings).full, 'ノーツを追加 · 2 edits')
    for (const row of [blank!, whitespace!])
        assert.deepEqual(presentRow(row, strings), {
            main: '2 edits',
            count: undefined,
            full: '2 edits',
        })
    assert.equal(rows(['A', ' A']).length, 2)
})

test('directional groups name recorded steps instead of any member action', () => {
    for (const [kind, title, command] of [
        ['undo', 'Undid', 'Undo'],
        ['redo', 'Redid', 'Redo'],
    ]) {
        const [row] = rows(['Renamed', 'Added 100 notes'], { kind })
        assert.deepEqual(presentRow(row!, strings), {
            main: `${title} 2 steps`,
            count: undefined,
            full: `${title} 2 steps`,
        })
        assert.equal(
            presentRow({ ...row!, child: true, members: [row!.entry] }, strings).main,
            `${command} · Renamed`,
        )
    }
})

test('a partial singleton has a counted scope while ordinary singles and children do not', () => {
    const [partial] = rows(['Added 100 notes'], {}, true)
    assert.equal(isCountedParent(partial!), true)
    assert.equal(presentRow(partial!, strings).full, 'Added 100 notes · 1+ edits')
    assert.equal(presentRow(rows(['Added 100 notes'])[0]!, strings).full, 'Added 100 notes')
    assert.equal(isCountedParent({ ...partial!, child: true }), false)
    const [group] = rows(['A', 'A'], {}, true)
    assert.equal(presentRow(group!, strings).count, '2+ edits')
    const [undo] = rows(['A'], { kind: 'undo' }, true)
    assert.equal(presentRow(undo!, strings).full, 'Undid 1+ steps')
})

test('only unavailable counted parents reserve the full reason geometry', () => {
    for (const partial of [false, true]) {
        const [row] = rows(partial ? ['A'] : ['A', 'A'], { kept: false }, partial)
        assert.equal(heightOf(row!), 80)
        assert.equal(heightOf({ ...row!, flags: { damaged: true, removed: false } }), 80)
        assert.equal(heightOf({ ...row!, child: true }), 44)
        assert.equal(heightOf({ ...row!, selectable: true }), 44)
    }
    assert.equal(heightOf(rows(['A'], { kept: false })[0]!), 44)
    assert.equal(heightOf({ type: 'now', id: 'now' }), 44)
    assert.equal(heightOf({ type: 'gap', id: 'gap', count: 4 }), 44)
    assert.equal(heightOf({ type: 'header', id: 'h', level: 'day', withDay: false, time: 0 }), 28)
})
