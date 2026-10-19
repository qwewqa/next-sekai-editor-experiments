import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRows, previousOf, selectableRows, type Entry, type EntryRow, type Row } from '../../src/editor/history/rows'
import { type EntryDescription, type NativeOperationInput } from '../../src/history/operations'
import { editStep, futureFixtureOperation, nativeOperation, noteAdd, originOperation, restoreStep } from '../helpers/historySteps'

const MINUTE = 60_000
const noon = new Date(2026, 9, 16, 12).getTime()
let seq = 0
const entry = (description: EntryDescription, time = noon, extra: Partial<Entry> = {}): Entry =>
    ({ sessionId: 's', seq: ++seq, time, noteCount: 0, kept: true, ...description, ...extra }) as Entry
const add = (created = 1): EntryDescription => ({ kind: 'edit', step: editStep(noteAdd(created)) })
const operation = (input: NativeOperationInput): EntryDescription => ({ kind: 'edit', step: editStep(nativeOperation(input, 'Same captured text')) })
const move = operation({ id: 'nse.object.move', data: { subject: 'note', targets: 1 } })
const opaque = (id: string): EntryDescription => ({ kind: 'edit', step: editStep(futureFixtureOperation(id)) })
const event = (kind: 'init' | 'continue' | 'save' | 'export'): EntryDescription => ({ kind, operation: futureFixtureOperation(kind) })
const newestFirst = (...entries: Entry[]) => entries.reverse()
const options = { filter: 'all' as const, expanded: new Set<string>(), damaged: new Set<string>(), now: noon + 30 * MINUTE }
const entryRows = (rows: Row[]) => rows.filter((row): row is EntryRow => row.type === 'entry')

test('only available entries and Now can become the peek cursor', () => {
    const removed = entry(add(), noon, { kept: false })
    const available = entry(add())
    const damaged = entry(add())
    const rows = buildRows(newestFirst(removed, available, damaged), { ...options, damaged: new Set([`s:${damaged.seq}`]) })
    assert.deepEqual(entryRows(rows).map((row) => [row.flags, row.selectable]), [
        [{ removed: false, damaged: true }, false],
        [{ removed: false, damaged: false }, true],
        [{ removed: true, damaged: false }, false],
    ])
    assert.deepEqual(selectableRows(rows).map((row) => row.id), ['now', `s:${available.seq}`])
})

test('semantic families group different receipts, while unknown identical text stays individual', () => {
    const unknown = opaque('identical')
    const rows = entryRows(buildRows(newestFirst(entry(add(1)), entry(add(12)), entry(move), entry(move), entry(unknown), entry(unknown)), options))
    assert.deepEqual(rows.map((row) => row.members.length), [1, 1, 2, 2])
})

test('direction groups retain complete mixed crossed steps and never cross direction', () => {
    const restored = restoreStep(noon)
    const unknown = editStep(futureFixtureOperation('future', { extension: true }))
    const rows = entryRows(buildRows(newestFirst(entry({ kind: 'undo', step: restored }), entry({ kind: 'undo', step: unknown }), entry({ kind: 'redo', step: unknown })), options))
    assert.deepEqual(rows.map((row) => [row.entry.kind, row.members.length]), [['redo', 1], ['undo', 2]])
    assert.equal(rows[1]?.members[1]?.step, restored)
})

test('session, file, Restore, initial, continuation and recovery preserve boundaries', () => {
    const head = { kind: 'init' as const, operation: originOperation() }
    const barriers: EntryDescription[] = [event('save'), event('export'), event('init'), event('continue'), { kind: 'restore', step: restoreStep(noon) }, { kind: 'recovered', operation: futureFixtureOperation('recovered'), recoveryContext: { head, headIndex: 0, dropped: [], omitted: 0 } }]
    for (const barrier of barriers) {
        const rows = entryRows(buildRows(newestFirst(entry(add()), entry(barrier), entry(add())), options))
        assert.ok(rows.every((row) => row.members.length === 1), barrier.kind)
    }
    assert.equal(entryRows(buildRows([entry(add(), noon, { sessionId: 'b' }), entry(add())], options)).length, 2)
})

test('property field and manager typed target distinguish groups despite matching captured text', () => {
    const property = (field: 'beat' | 'left'): EntryDescription => operation({ id: 'nse.property.set', data: { subject: 'note', targets: 1, assignments: [{ field, value: { mode: 'uniform', value: 2 } }] } })
    const rename = (id: number): EntryDescription => operation({ id: 'nse.owner.rename', data: { target: { kind: 'group', id, name: { text: 'Same' } }, before: { text: 'Before' }, after: { text: 'Same' } } })
    const rows = entryRows(buildRows(newestFirst(entry(property('beat')), entry(property('left')), entry(rename(1)), entry(rename(2))), options))
    assert.deepEqual(rows.map((row) => row.members.length), [1, 1, 1, 1])
})

test('expanded edits have passive counts before children; direction groups do not', () => {
    for (const kind of ['edit', 'undo'] as const) {
        const list = newestFirst(entry({ kind, step: editStep(noteAdd(1)) }), entry({ kind, step: editStep(noteAdd(2)) }))
        const parent = entryRows(buildRows(list, options))[0]!
        const rows = buildRows(list, { ...options, expanded: new Set([parent.id]) })
        assert.deepEqual(entryRows(rows).map((row) => row.child), [false, true, true])
        assert.equal(rows.filter((row) => row.type === 'count').length, kind === 'edit' ? 1 : 0)
        assert.equal(selectableRows(rows).length, 4)
    }
})

test('actual note deltas require every real transition and remain distinct from operation counts', () => {
    const rows = entryRows(buildRows(newestFirst(entry(event('init'), noon, { noteCount: 10 }), entry(add(2), noon, { noteCount: 12 }), entry(add(3), noon, { noteCount: 15 }), entry(move, noon, { noteCount: 15 }), entry(event('save'), noon, { noteCount: 15 })), options))
    assert.deepEqual(rows.map((row) => row.delta), [undefined, undefined, 5, undefined])
})

test('Saves and Exports keeps file events and continuation dividers', () => {
    const rows = buildRows(newestFirst(entry(event('init')), entry(add()), entry(event('save')), entry(event('continue')), entry(add()), entry(event('export'))), { ...options, filter: 'saves' })
    assert.deepEqual(rows.filter((row) => row.type !== 'header').map((row) => row.type === 'entry' ? row.entry.kind : row.type), ['now', 'export', 'divider', 'save'])
})

const headers = (rows: Row[]) => rows.flatMap((row) => row.type === 'header' ? [`${row.level}${row.withDay ? '+day' : ''}`] : [])
test('headers become coarser with age independently of operation descriptions', () => {
    const at = (days: number, hour: number, minute = 0) => new Date(2026, 9, 16 - days, hour, minute).getTime()
    const dates = [at(9, 10), at(9, 9), at(7, 15), at(6, 21), at(6, 21, 30), at(1, 9), at(1, 22), at(0, 9), at(0, 12, 5), at(0, 12, 7)]
    assert.deepEqual(headers(buildRows(newestFirst(...dates.map((time) => entry(opaque('header'), time))), options)), ['minute', 'minute', 'hour', 'hour+day', 'hour', 'hour+day', 'day', 'day'])
})

test('continuation keeps its own rule and is never a peek target', () => {
    const divider = entry(event('continue'), noon, { from: noon - 99 })
    const rows = buildRows(newestFirst(entry(add(), noon - 24 * 60 * MINUTE), divider, entry(add(), noon + 2 * MINUTE)), options)
    assert.deepEqual(rows.map((row) => row.type), ['now', 'header', 'entry', 'divider', 'header', 'entry'])
    assert.ok(!selectableRows(rows).some((row) => row.id === `s:${divider.seq}`))
})

test('jump gaps are passive and do not fabricate entries before a loaded window', () => {
    const rows = buildRows([entry(add())], { ...options, gap: 1206 })
    assert.deepEqual(rows.map((row) => row.type), ['now', 'gap', 'header', 'entry'])
    assert.deepEqual(selectableRows(rows).map((row) => row.type), ['now', 'entry'])
    assert.ok(!buildRows([], options).some((row) => row.type === 'gap'))
})

test('Edits Here proves chronological adjacency and never derives note delta from filtered matches', () => {
    const at = (pos: number) => entry(move, noon, { noteCount: pos * 10, pos, previous: { sessionId: 's', seq: 0, snapshot: '' } })
    const rows = entryRows(buildRows([at(1), at(2), at(4), at(5)], { ...options, filter: 'here' }))
    assert.deepEqual(rows.map((row) => row.members.length), [2, 2])
    assert.ok(rows.every((row) => row.delta === undefined))
    assert.equal(entryRows(buildRows([entry(move), entry(move)], { ...options, filter: 'here' })).length, 2)
})

test('comparison predecessor is the chronological neighbor or Edits Here explicit predecessor', () => {
    const a = entry(add())
    const b = entry(add())
    const c = entry(add(), noon, { previous: { sessionId: 's', seq: 99, snapshot: 'x' } })
    const list = newestFirst(a, b, c)
    assert.equal(previousOf(list, b), a)
    assert.equal(previousOf(list, a), undefined)
    assert.deepEqual(previousOf(list, c), c.previous)
})

test('exact pinned membership survives page arrival at either side of a partial group', () => {
    const oldest = entry(add(), noon, { noteCount: 1 })
    const middle = entry(add(), noon, { noteCount: 2 })
    const newest = entry(add(), noon, { noteCount: 3 })
    const partial = entryRows(buildRows([newest, middle], { ...options, more: true }))[0]!
    assert.equal(partial.delta, undefined)
    assert.equal(partial.partial, true)
    const pinned = partial.members.map((member) => `s:${member.seq}`)
    const grown = entryRows(buildRows([entry(add()), newest, middle, oldest], { ...options, pinned, more: true }))
    assert.deepEqual(grown.map((row) => row.members.length), [1, 2, 1])
    assert.deepEqual(grown[1]?.members, [newest, middle])
    assert.equal(grown[1]?.delta, 2)
    const singleton = entryRows(buildRows([newest], { ...options, more: true }))[0]!
    assert.equal(buildRows([newest], { ...options, more: true, expanded: new Set([singleton.id]) }).filter((row) => row.type === 'count').length, 0)
})
