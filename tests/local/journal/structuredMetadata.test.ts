import assert from 'node:assert/strict'
import test from 'node:test'
import {
    captureEntryDescription,
    captureName,
    captureStep,
    createRecoveryContext,
    equalJson,
    type JsonValue,
} from '../../../src/history/operations'
import { journalStack } from '../../../src/local/journal/build'
import { readJournal } from '../../../src/local/journal/format'
import {
    JOURNAL_KEY_LIMIT,
    MemoryStorage,
    storageJournalStore,
} from '../../../src/local/journal/store'
import type { PendingRecords, SaveStore } from '../../../src/local/save/bodies'
import { buildSave } from '../../../src/local/save/execute'
import { pendingFlushRow } from '../../../src/local/save/pending'
import { createWorld } from '../../../src/local/testing/world'
import { editStep, futureFixtureOperation, nativeOperation } from '../../helpers/historySteps'
import { openPage, rows } from '../flush/harness'
import { sampleState } from '../records/samples'
import { heldRows } from '../save/fixture'
import { storedEntries, storedStack, widen } from '../timeline/helpers'
import { append, beginSession, openJournalPage, replayAll } from './harness'

const same = (a: unknown, b: unknown) => assert(equalJson(a as JsonValue, b as JsonValue))
const operation = (n: number) =>
    futureFixtureOperation('journal-step', { n, extra: { version: 9 } })
const recoveredOperation = (droppedSteps: number) =>
    nativeOperation(
        { id: 'nse.recovery', data: { source: 'journal', droppedSteps } },
        'Recovered work',
    )

test('head=false recovery preserves event context and leaves retained slot metadata exact', async () => {
    const world = createWorld({ seed: 93701 })
    const page = await openJournalPage(world, 'structured')
    const a = sampleState('tests/fixtures/generated-large.json')
    const session = beginSession(page, a)
    await page.flusher.flush()
    const b = widen(a)
    const stepB = editStep(operation(1))
    append(page, { kind: 'edit', step: stepB }, b)
    await page.flusher.flush()
    const before = storedStack(world, session.id).slots
    const c = widen(b, 1)
    const stepC = editStep(operation(2))
    append(page, { kind: 'edit', step: stepC }, c)
    append(page, { kind: 'undo', step: stepC }, b)
    assert.equal(page.writer.write(), true)
    const text = page.storage.getItem('nse.journal.' + session.id)!
    const reading = readJournal(text, session.id)
    assert.equal(reading.kind, 'journal')
    if (reading.kind !== 'journal') throw new Error('No journal')
    assert.equal(reading.journal.stack.head, false)
    same(reading.journal.stack.context.head, stepB)
    same(reading.journal.stack.context.dropped, [stepC])
    const result = await replayAll(world, page.storage)
    assert.equal(result.outcomes[0]?.kind, 'applied', JSON.stringify(result.outcomes))
    const event = captureEntryDescription(storedEntries(world, session.id).at(-1))
    assert.equal(event.kind, 'recovered')
    if (event.kind !== 'recovered') throw new Error('No event')
    same(event.recoveryContext, reading.journal.stack.context)
    same(storedStack(world, session.id).slots, before)
    assert.equal(page.storage.getItem('nse.journal.' + session.id), null)
})

for (const existingPrefix of [false, true])
    test(`journal-only resume preserves one baseline and a ${existingPrefix ? 'stored' : 'missing'} prefix`, async () => {
        const world = createWorld({ seed: 93702 })
        const state = sampleState('tests/fixtures/generated-large.json')
        const previous = await openJournalPage(world, 'previous')
        const prior = existingPrefix ? beginSession(previous, state) : undefined
        if (prior) await previous.flusher.flush()
        const oldEntries = prior ? storedEntries(world, prior.id) : []
        const page = await openPage(world, world.tab('resume'))
        const recoveryContext = createRecoveryContext(
            editStep(operation(2)),
            [editStep(operation(1)), editStep(operation(3))],
            1,
        )
        let release!: () => void
        const ready = new Promise<void>((resolve) => {
            release = resolve
        })
        const session = page.flusher.resumeJournalled({
            id: prior?.id ?? 'resume',
            chainId: prior?.chainId ?? 'resume-chain',
            docId: prior?.docId ?? 'doc',
            lineageId: prior?.lineageId ?? 'lineage',
            origin: 'import',
            startedAt: prior?.startedAt ?? 100,
            seq: 7,
            chain: prior?.chain ?? {},
            state,
            operation: recoveredOperation(2),
            recoveryContext,
            ready,
        })
        const pending = page.flusher.unstored(session)
        assert.equal(pending.entries.length, 1)
        assert.equal(pending.entries[0]!.kind, 'recovered')
        assert.equal(pending.stack?.slots.length, 1)
        same(pending.stack?.slots[0]?.step.recoveryContext, recoveryContext)
        const records: PendingRecords = { roots: {}, nodes: {}, chunks: {} }
        const row = pendingFlushRow(pending.entries[0]!, records)!
        const store: SaveStore = {
            read: (stores, fn) => page.tab.run(() => page.core.read(stores, fn)),
            write: (stores, fn, options) =>
                page.tab.run(() => page.core.write(stores, fn, options)),
        }
        try {
            const built = await buildSave(
                store,
                session.chainId,
                { kind: 'copy' },
                {
                    history: true,
                    bgm: false,
                    fileName: 'recovery.nxsp',
                    sessionId: session.id,
                    unstored: {
                        chainId: session.chainId,
                        docId: session.docId,
                        lineageId: session.lineageId,
                    },
                    pending: {
                        entries: [row],
                        records,
                        startedAt: session.startedAt,
                        stack: {
                            base: 0,
                            slots: [
                                { snapshot: row.snapshot, step: pending.stack!.slots[0]!.step },
                            ],
                            index: 0,
                        },
                    },
                    save: {
                        time: 999,
                        operation: nativeOperation(
                            {
                                id: 'nse.file.save',
                                data: { file: captureName('recovery.nxsp'), delivery: 'file' },
                            },
                            'Saved recovery.nxsp',
                        ),
                    },
                    context: {
                        now: 1700000000000,
                        newId: () => '00000000-0000-4000-8000-000000000001',
                        device: { id: 'test', label: 'Test' },
                        appVersion: '0.6.0',
                    },
                },
            )
            assert(!('refused' in built), JSON.stringify(built))
            const { history } = await heldRows(built.blob)
            const event = history.entries.find((entry) => entry.kind === 'recovered')!
            assert.equal(event.kind, 'recovered')
            if (event.kind !== 'recovered') throw new Error('Missing saved recovery event')
            same(event.recoveryContext, recoveryContext)
            same(history.undoStack.slots[0]!.step.recoveryContext, recoveryContext)
            assert.equal(
                rows(world, 'entries').size,
                oldEntries.length,
                'Save uses the pending projection before a flush',
            )
        } finally {
            release()
        }
        await page.flusher.flush()
        assert.deepEqual(page.errors, [])
        const event = captureEntryDescription(storedEntries(world, session.id).at(-1))
        assert.equal(event.kind, 'recovered')
        if (event.kind !== 'recovered') throw new Error('No recovery event')
        same(event.recoveryContext, recoveryContext)
        const slots = storedStack(world, session.id)
        assert.equal(slots.window.length, 1)
        same(slots.slots?.[0]?.step.recoveryContext, recoveryContext)
        const journal = journalStack(session, page.flusher.liveStack(session)!)
        same(journal.context, recoveryContext)
        assert.equal(rows(world, 'entries').size, oldEntries.length + 1)
        same(storedEntries(world, session.id).slice(0, oldEntries.length), oldEntries)
    })

test('final journal cap trims optional whole descriptions and preserves last-good on essential overflow', () => {
    const storage = new MemoryStorage()
    const store = storageJournalStore(() => storage, 'nse.')
    const head = editStep(operation(100))
    const dropped = Array.from({ length: 20 }, (_, n) =>
        editStep(futureFixtureOperation('large', { n, text: 'x'.repeat(2000) })),
    )
    const context = createRecoveryContext(head, dropped, 10)
    const base = {
        sessionId: 'budget',
        seq: 1,
        journalVersion: 2,
        stack: { context },
        levelDataGz: '',
    }
    base.levelDataGz = 'z'.repeat(
        JOURNAL_KEY_LIMIT -
            JSON.stringify({ ...base, stack: { context: createRecoveryContext(head, [], 0) } })
                .length -
            4096,
    )
    assert.equal(store.writeWhole(base), true)
    const keptText = storage.getItem('nse.journal.budget')!
    assert(keptText.length <= JOURNAL_KEY_LIMIT)
    const kept = JSON.parse(keptText) as typeof base
    assert(kept.stack.context.dropped.length < dropped.length)
    same(kept.stack.context.head, head)
    assert.equal(kept.stack.context.omitted + kept.stack.context.dropped.length, dropped.length)
    assert.equal(kept.stack.context.headIndex, Math.max(0, 10 - kept.stack.context.omitted))
    const oversized = { ...base, seq: 2, levelDataGz: 'z'.repeat(JOURNAL_KEY_LIMIT) }
    assert.equal(store.writeWhole(oversized), false)
    assert.equal(storage.getItem('nse.journal.budget'), keptText)
    same(
        captureStep({
            kind: 'edit',
            operation: recoveredOperation(20),
            recoveryContext: kept.stack.context,
        }).recoveryContext?.head,
        head,
    )
})

test('persisted journal recovery demotes its original head in occurrence order before trimming a later redo tail', async () => {
    const world = createWorld({ seed: 93703 })
    const first = await openJournalPage(world, 'first-recovery')
    const state = sampleState('tests/fixtures/generated-large.json')
    const original = beginSession(first, state)
    const initial = first.flusher.liveStack(original)!.at(0)!.step
    const oldSteps = Array.from({ length: 60 }, (_, n) => editStep(operation(n + 1)))
    for (const step of oldSteps) append(first, { kind: 'edit', step }, state)
    for (const step of oldSteps.slice(30).reverse()) append(first, { kind: 'undo', step }, state)
    assert.equal(first.writer.write(), true)
    const saved = readJournal(first.storage.getItem('nse.journal.' + original.id)!, original.id)
    assert.equal(saved.kind, 'journal')
    if (saved.kind !== 'journal') throw new Error('Missing journal')
    const context = saved.journal.stack.context
    assert.equal(context.headIndex, 30)
    same(context.head, oldSteps[29])
    same(context.dropped, [initial, ...oldSteps.slice(0, 29), ...oldSteps.slice(30)])

    const next = await openJournalPage(world, 'second-recovery')
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
        release = resolve
    })
    const resumed = next.flusher.resumeJournalled({
        id: 'recovered-sequence',
        chainId: 'recovered-chain',
        docId: 'doc',
        lineageId: 'lineage',
        origin: 'import',
        startedAt: 100,
        seq: 100,
        chain: {},
        state,
        operation: recoveredOperation(60),
        recoveryContext: context,
        ready,
    })
    next.live.state = state
    const newer = Array.from({ length: 8 }, (_, n) => editStep(operation(n + 101)))
    try {
        for (const step of newer) append(next, { kind: 'edit', step }, state)
        append(next, { kind: 'undo', step: newer[7]! }, state)
        assert.equal(next.writer.write(), true)
        const reread = readJournal(next.storage.getItem('nse.journal.' + resumed.id)!, resumed.id)
        assert.equal(reread.kind, 'journal')
        if (reread.kind !== 'journal') throw new Error('Missing second journal')
        const expected = [initial, ...oldSteps, ...newer.slice(0, 6), newer[7]!]
        const actual = reread.journal.stack.context
        assert.equal(reread.journal.stack.keep, 0)
        same(actual.head, newer[6])
        same(actual.dropped, expected.slice(4))
        assert.equal(actual.omitted, 4)
        assert.equal(actual.headIndex, 63)
        assert(
            actual.dropped.some((step) => equalJson(step as JsonValue, oldSteps[29] as JsonValue)),
        )
    } finally {
        release()
    }
    await next.flusher.flush()
    assert.deepEqual(next.errors, [])
})
