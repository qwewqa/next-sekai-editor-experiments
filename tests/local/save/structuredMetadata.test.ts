import assert from 'node:assert/strict'
import test from 'node:test'
import { captureOperation, equalJson, type JsonValue } from '../../../src/history/operations'
import { KeyRange } from '../../../src/local/kv/types'
import { readNxsp } from '../../../src/local/nxsp/read'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { Fixture, heldRows, save, sourceOf } from './fixture'

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

const raw = captureOperation({
    id: 'nse.note.add',
    version: 99,
    data: { created: 'future-count', next: { enum: 'new' } },
    fallback: { text: 'Future note action', locale: 'fr' },
    extension: { ['__proto__']: ['retained'] },
})

const assertRaw = (value: JsonValue) => assert(equalJson(value, raw))

test('unknown crossed operations survive stored and paused Save, append and current-state Undo', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, raw)
    fixture.undo()
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert(first.file, JSON.stringify(first.built))
    const original = await heldRows(first.file)
    assert.equal(original.read.report.length, 0)
    const undo = original.history.entries.find((entry) => entry.kind === 'undo')
    assert(undo?.kind === 'undo')
    assertRaw(undo.step.operation)
    const initial =
        original.history.undoStack.slots[
            original.history.undoStack.index - original.history.undoStack.base
        ]
    assert(initial)
    assert(
        !equalJson(initial.step.operation, raw),
        'Undo lands on the original baseline description',
    )
    const storedSeq = fixture.session.rows.at(-1)!.seq
    await fixture.edit(2, raw)
    const paused = await save(
        fixture,
        { kind: 'copy' },
        { binds: false, extra: { pending: fixture.pending(storedSeq) } },
    )
    assert(paused.file, JSON.stringify(paused.built))
    const pending = await heldRows(paused.file)
    assertRaw(pending.history.undoStack.slots.at(-1)!.step.operation)
    await fixture.flush()
    const appended = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(first.file)], binds: false },
    )
    assert(appended.file, JSON.stringify(appended.built))
    const reread = await heldRows(appended.file)
    for (const entry of reread.history.entries)
        if (entry.kind === 'edit' || entry.kind === 'undo') assertRaw(entry.step.operation)
})

test('broken structural replay refuses History but chart-only Save uses the verified last landed snapshot', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, raw)
    fixture.undo()
    await fixture.flush()
    const id = fixture.session.id
    await fixture.store.write(['sessions', 'entries', 'stackBlocks'], async (tx) => {
        const row = (await tx.get('sessions', id)) as Record<string, unknown>
        const { stack: _stack, ...rest } = row
        await tx.put('sessions', rest)
        await tx.delete('entries', [id, 2])
        await tx.delete('stackBlocks', KeyRange.bound([id, -Infinity], [id, Infinity]))
    })
    const history = await save(fixture, { kind: 'copy' }, { binds: false })
    assert('refused' in history.built)
    assert.equal(history.built.refused, 'unreadableHead')
    const chart = await save(fixture, { kind: 'copy' }, { binds: false, extra: { history: false } })
    assert(chart.file, JSON.stringify(chart.built))
    const opened = await readNxsp(chart.file)
    assert.equal(opened.kind, 'nxsp')
    if (opened.kind !== 'nxsp') throw new Error('No project')
    assert.equal(opened.history, undefined)
    assert(!('refused' in chart.built))
    assert.equal(chart.built.saveEntry.snapshot, fixture.head)
})
