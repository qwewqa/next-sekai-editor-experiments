import assert from 'node:assert/strict'
import test from 'node:test'
import {
    captureEntryDescription,
    captureOperation,
    createRecoveryContext,
    equalJson,
    type JsonValue,
} from '../../../src/history/operations'
import { KeyRange } from '../../../src/local/kv/types'
import { readNxsp } from '../../../src/local/nxsp/read'
import type { SaveStore } from '../../../src/local/save/bodies'
import { buildSave } from '../../../src/local/save/execute'
import { openHandlers } from '../../../src/local/worker/openHandlers'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import {
    editStep,
    futureFixtureOperation,
    nativeOperation,
    originOperation,
} from '../../helpers/historySteps'
import { openPage } from '../flush/harness'
import { readOpen } from '../startup/harness'
import { Fixture, heldRows, save, saveOptions, sourceOf } from './fixture'

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

test('event-only recovered context survives keep-first, append, import, reload and another Save without changing slots', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, raw)
    const slots = fixture.session.slots.map((slot) => slot.step)
    const context = createRecoveryContext(
        editStep(raw),
        [
            editStep(futureFixtureOperation('dropped-before', { opaque: [1, 2] })),
            editStep(futureFixtureOperation('dropped-redo', { opaque: { newEnum: 'future' } })),
        ],
        1,
    )
    fixture.recoverContext(
        nativeOperation(
            { id: 'nse.recovery', data: { source: 'journal', droppedSteps: 2 } },
            'Recovered work',
        ),
        context,
    )
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert(first.file, JSON.stringify(first.built))
    const replaced = await save(
        fixture,
        { kind: 'replace', replaces: 'other-revision' },
        { binds: false },
    )
    assert(replaced.file, JSON.stringify(replaced.built))
    const appended = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { binds: false, files: [await sourceOf(first.file)] },
    )
    assert(appended.file, JSON.stringify(appended.built))
    for (const file of [first.file, replaced.file, appended.file]) {
        const saved = await heldRows(file)
        const entry = saved.history.entries.find((row) => row.kind === 'recovered')
        assert(entry?.kind === 'recovered')
        assert(equalJson(entry.recoveryContext, context))
        assert(
            equalJson(
                saved.history.undoStack.slots.map((slot) => slot.step),
                slots,
            ),
        )
        assert.equal(entry.stack?.push.length, 0)
    }

    const page = await openPage(fixture.world, fixture.world.tab('import-recovery'))
    const open = openHandlers(
        { core: page.core, test: true, emit: () => undefined },
        page.tab.waiter,
    )
    const read = await page.tab.run(() => open.openRead(appended.file))
    assert(read.kind === 'nxsp')
    const imported = await page.tab.run(() =>
        open.openStore({
            id: read.id,
            ids: {
                chainId: 'imported-chain',
                sessionId: 'imported-session',
                docId: 'imported-doc',
                lineageId: 'lineage',
            },
            chain: {},
            operations: {
                opened: originOperation('import'),
                changedOutside: nativeOperation(
                    { id: 'nse.externalChange', data: {} },
                    'Changed outside',
                ),
            },
            wall: 3000000,
            appVersion: '0.6.0',
        }),
    )
    assert(imported.kind === 'stored')
    for (let n = 0; n < imported.batches; n++)
        await page.tab.run(() => open.openBatch({ id: read.id, n }))
    const reloadedPage = await openPage(fixture.world, fixture.world.tab('reload-recovery'))
    const reloaded = await readOpen(reloadedPage, 'imported-session')
    assert(
        equalJson(
            reloaded.stack.slots.map((slot) => slot.step),
            slots,
        ),
    )
    const store: SaveStore = {
        read: (stores, fn) => reloadedPage.tab.run(() => reloadedPage.core.read(stores, fn)),
        write: (stores, fn, options) =>
            reloadedPage.tab.run(() => reloadedPage.core.write(stores, fn, options)),
    }
    const savedAgain = await buildSave(
        store,
        'imported-chain',
        { kind: 'copy' },
        saveOptions(fixture).options,
    )
    assert(!('refused' in savedAgain), JSON.stringify(savedAgain))
    const after = await heldRows(savedAgain.blob)
    const event = after.history.entries.find((row) => row.kind === 'recovered')
    assert(event?.kind === 'recovered')
    assert(
        equalJson(
            captureOperation(captureEntryDescription(event)),
            captureOperation(
                captureEntryDescription(
                    (await heldRows(first.file)).history.entries.find(
                        (row) => row.kind === 'recovered',
                    ),
                ),
            ),
        ),
    )
    assert(
        equalJson(
            after.history.undoStack.slots.map((slot) => slot.step),
            slots,
        ),
    )
})
