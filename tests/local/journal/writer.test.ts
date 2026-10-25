import assert from 'node:assert/strict'
import test from 'node:test'
import { equalJson, type JsonValue } from '../../../src/history/operations'
import type { Journal } from '../../../src/local/journal/format'
import {
    JOURNAL_KEY_LIMIT,
    JOURNAL_TOTAL_LIMIT,
    MemoryStorage,
} from '../../../src/local/journal/store'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, nativeOperation } from '../../helpers/historySteps'
import { rows, workerCore } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { append, beginSession, openJournalPage, replayAll } from './harness'

const same = (a: unknown, b: unknown) => assert(equalJson(a as JsonValue, b as JsonValue))

// The journal's writer: when it writes, what it writes, when it's cleared, and the
// size limits.

/** Counts writes to a storage. */
const counting = (storage: MemoryStorage) => {
    let writes = 0
    const setItem = storage.setItem.bind(storage)
    storage.setItem = (key, value) => {
        writes++
        setItem(key, value)
    }
    return () => writes
}

const journalIn = (storage: MemoryStorage, sessionId: string) => {
    const text = storage.getItem(`nse.journal.${sessionId}`)
    return text === null ? undefined : (JSON.parse(text) as Journal)
}

const start = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    return { world, page, session, a }
}

test('nothing is written while every entry is committed', async () => {
    const { page } = await start(1)
    const writes = counting(page.storage)
    assert.equal(page.writer.write(), true)
    assert.equal(writes(), 0)
})

test('a hide after a committed relaxed flush writes no journal', async () => {
    const { page, session, a } = await start(13)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    // The routine flush about 1 s after the edit, relaxed.
    await page.flusher.flush()
    assert.equal(page.flusher.unflushed(session), false)
    const writes = counting(page.storage)
    assert.equal(page.writer.write(), true)
    assert.equal(writes(), 0)
    assert.equal(journalIn(page.storage, session.id), undefined)
})

test('a second trigger for the same seq writes nothing; a new entry writes again', async () => {
    const { page, session, a } = await start(2)
    const writes = counting(page.storage)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    assert.equal(page.writer.write(), true)
    assert.equal(page.writer.write(), true)
    assert.equal(writes(), 1)
    append(page, { kind: 'undo', step: editStep(futureFixtureOperation('Changed note')) }, a)
    assert.equal(page.writer.write(), true)
    assert.equal(writes(), 2)
    const journal = journalIn(page.storage, session.id)
    // An undo onto a committed slot: the head is that slot, nothing pushed or dropped.
    same(journal?.stack, {
        keep: 1,
        lastKept: journal?.stack.lastKept,
        context: {
            head: session.stack.committed.at(0)!.step,
            headIndex: 0,
            dropped: [editStep(futureFixtureOperation('Changed note'))],
            omitted: 0,
        },
        head: false,
        index: 0,
    })
})

test('a relaxed commit covering a key’s seq clears it', async () => {
    const { page, session, a } = await start(3)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    assert.equal(page.writer.write(), true)
    assert.equal(journalIn(page.storage, session.id)?.seq, 2)
    await page.flusher.flush()
    assert.equal(journalIn(page.storage, session.id), undefined)
    assert.equal(page.flusher.unflushed(session), false)
})

test('a commit short of a key’s seq leaves it', async () => {
    const { page, session, a } = await start(14)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    // A Save holds 3: the edit after it waits, so the next flush commits 2 only.
    const reservation = page.flusher.reserveSave()!
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(a, 1),
    )
    assert.equal(page.writer.write(), true)
    assert.equal(journalIn(page.storage, session.id)?.seq, 4)
    await page.flusher.flush()
    assert.equal(session.ackedSeq, 2)
    assert.equal(journalIn(page.storage, session.id)?.seq, 4)
    assert.equal(page.flusher.unflushed(session), true)
    // The Save lets 3 go; the commit of 4 clears the key.
    await page.flusher.endSave(reservation)
    assert.equal(journalIn(page.storage, session.id), undefined)
    assert.equal(page.flusher.unflushed(session), false)
})

test('a journal for a session the tab no longer has open is never written', async () => {
    const { page, session, a } = await start(4)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    const next = beginSession(page, stateOf(goldenChart()), 'new')
    page.writer.write()
    assert.equal(journalIn(page.storage, session.id), undefined)
    assert.equal(journalIn(page.storage, next.id), undefined)
})

test('the descriptor carries the chain as stored, the session’s fields and its flags', async () => {
    const { page, session, a } = await start(5)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    page.writer.write()
    const journal = journalIn(page.storage, session.id)
    assert.ok(journal)
    assert.deepEqual(Object.keys(journal), [
        'journalVersion',
        'kind',
        'recordsV',
        'appVersion',
        'writtenAt',
        'sessionId',
        'seq',
        'descriptor',
        'levelDataGz',
        'editorMetadata',
        'header',
        'stack',
    ])
    const { descriptor } = journal
    assert.equal(descriptor.origin, 'import')
    assert.equal(descriptor.chainId, session.chainId)
    assert.equal(descriptor.docId, session.docId)
    assert.equal(descriptor.lineageId, session.lineageId)
    assert.equal(descriptor.edited, true)
    assert.equal(descriptor.hasContent, true)
    // The stored summary rides along; the record's own fields don't.
    assert.equal(typeof descriptor.summary, 'object')
    assert.equal(descriptor.head, undefined)
    assert.equal(descriptor.updatedAt, undefined)
    assert.ok(journal.header.bgm)
})

test('a write that would pass a size limit isn’t made, and doesn’t verify', async () => {
    const { page, session, a } = await start(6)
    // Other journals already hold nearly all of the 4 MB.
    page.storage.setItem('nse.journal.other', 'x'.repeat(JOURNAL_TOTAL_LIMIT - 1000))
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    assert.equal(page.writer.write(), false)
    assert.equal(page.writer.verified(session.id, 2), false)
    assert.equal(journalIn(page.storage, session.id), undefined)
    page.storage.removeItem('nse.journal.other')
    assert.equal(page.writer.write(), true)
    assert.ok(JOURNAL_KEY_LIMIT < JOURNAL_TOTAL_LIMIT)
})

test('localStorage full: the write fails, and the session isn’t covered', async () => {
    const { page, session, a } = await start(7)
    page.storage.quota = 100
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    assert.equal(page.writer.write(), false)
    assert.equal(page.writer.verified(session.id, 2), false)
})

test('a BGM change is journalled with its metadata, and recovers with it', async () => {
    const { world, page, session, a } = await start(8)
    const meta = { hash: 'ab'.repeat(16), filename: 'new.mp3', size: 1234, type: 'audio/mpeg' }
    const changed: State = { ...widen(a), bgm: { ...a.bgm, filename: 'new.mp3', meta } }
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed BGM')) }, changed)
    page.writer.write()
    const journal = journalIn(page.storage, session.id)
    assert.deepEqual(journal?.header.bgm, [meta.hash, meta.filename, meta.size, meta.type])
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    assert.deepEqual(checkStored(world.memory), [])
})

test('a replaced session is committed strictly before it goes', async () => {
    const world = createWorld({ seed: 9 })
    const page = await openJournalPage(world, 'a')
    const released: string[] = []
    const a = stateOf(goldenChart())
    const session = beginSession(page, a, 'import', { done: () => released.push('first') })
    await page.flusher.flush({ strict: true })
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    // A hide's journal, then a routine relaxed flush, whose commit clears it.
    assert.equal(page.writer.write(), true)
    await page.flusher.flush()
    assert.equal(journalIn(page.storage, session.id), undefined)
    assert.ok(session.ackedSeq > session.strictSeq)
    // New replaces it: the outgoing session is committed strictly first.
    beginSession(page, stateOf(goldenChart()), 'new')
    // Its outcome, for the switch prompt: committed in the database.
    assert.equal(await page.flusher.outgoing, true)
    assert.equal(session.strictSeq, session.ackedSeq)
    assert.deepEqual(released, ['first'])
})

test('a replaced session whose strict sync fails is let go: its entries are committed', async () => {
    const world = createWorld({ seed: 20 })
    const page = await openJournalPage(world, 'a')
    const released: string[] = []
    const a = stateOf(goldenChart())
    const session = beginSession(page, a, 'import', { done: () => released.push('first') })
    await page.flusher.flush({ strict: true })
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    await page.flusher.flush()
    page.sync.fails = 1
    beginSession(page, widen(a, 3), 'new')
    assert.equal(await page.flusher.outgoing, true)
    assert.equal(page.flusher.syncFailed, true)
    assert.ok(session.ackedSeq > session.strictSeq)
    assert.deepEqual(released, ['first'])
    assert.equal(journalIn(page.storage, session.id), undefined)
})

test('a fork’s journal takes over its old session’s key, with the old chain’s fields', async () => {
    const world = createWorld({ seed: 10 })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    const other = world.tab('other')
    const core = workerCore(world, other)
    await other.run(() => core.start())
    const changeChain = (fields: Record<string, unknown>) =>
        other.run(() =>
            core.write(['chains'], async (tx) => {
                const chain = (await tx.get('chains', session.chainId)) as Record<string, unknown>
                await tx.put('chains', { ...chain, ...fields })
            }),
        )
    // The chain is named, and holds a field from a newer build; this tab flushes once more.
    await changeChain({ name: 'Coconut (Master)', future: { kept: 1 } })
    const b = widen(a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, b)
    await page.flusher.flush({ strict: true })
    // Another tab continues the chain; this tab's next edit is journalled, then forks.
    await changeChain({ head: 'a-continuation' })
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Moved notes')) },
        widen(b, 1),
    )
    assert.equal(page.writer.write(), true)
    assert.equal(journalIn(page.storage, session.id)?.seq, 3)
    // The journals written from here on, by key.
    const written = new Map<string, string>()
    const setItem = page.storage.setItem.bind(page.storage)
    page.storage.setItem = (key, value) => {
        written.set(key, value)
        setItem(key, value)
    }
    await page.flusher.flush()
    const fork = page.flusher.session
    assert.ok(fork && fork.id !== session.id)
    // The fork's journal, written as it took the entries over, carries the old chain's fields
    // from the start.
    const text = written.get(`nse.journal.${fork.id}`)
    assert.ok(text)
    const journal = JSON.parse(text) as Journal
    assert.equal(journal.descriptor.chainId, fork.chainId)
    assert.equal(journal.descriptor.name, 'Coconut (Master)')
    assert.deepEqual(journal.descriptor.future, { kept: 1 })
    assert.deepEqual(journal.descriptor.parent, { id: session.id, uptoSeq: 2 })
    // The old key went with it, and the fork's commit cleared its own.
    assert.equal(journalIn(page.storage, session.id), undefined)
    assert.equal(journalIn(page.storage, fork.id), undefined)
    // The next load makes no recovery chain duplicating the fork.
    const { outcomes } = await replayAll(world, page.storage)
    assert.deepEqual(outcomes, [])
})

test('the budget counts today’s auto save, and leaves it room to grow to the journal’s size', async () => {
    const { page, session, a } = await start(11)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    // Today's auto save holds most of the budget: no journal is written over it.
    page.storage.setItem('nse.autoSave.levelData', 'x'.repeat(JOURNAL_TOTAL_LIMIT - 1000))
    assert.equal(page.writer.write(), false)
    page.storage.removeItem('nse.autoSave.levelData')
    assert.equal(page.writer.write(), true)
    const size = page.storage.getItem(`nse.journal.${session.id}`)?.length ?? 0
    // Earlier visits' journals leave room for this one, but not for the auto save beside it.
    page.storage.setItem('nse.journal.earlier', 'x'.repeat(JOURNAL_TOTAL_LIMIT - 1.5 * size))
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(a, 1),
    )
    assert.equal(page.writer.write(), false)
    // With the auto save already that large, it fits.
    page.storage.removeItem('nse.journal.earlier')
    page.storage.setItem('nse.autoSave.levelData', 'x'.repeat(size))
    page.storage.setItem('nse.journal.earlier', 'x'.repeat(JOURNAL_TOTAL_LIMIT - 2.5 * size))
    assert.equal(page.writer.write(), true)
})

test('each commit covering a key clears it, one per session, and a later load finds none', async () => {
    // The same where IndexedDB has no `durability` option (Firefox before 126).
    const world = createWorld({ seed: 12 })
    const page = await openJournalPage(world, 'a')
    let state = stateOf(goldenChart())
    const session = beginSession(page, state)
    await page.flusher.flush({ strict: true })
    for (let i = 0; i < 3; i++) {
        state = widen(state, i)
        append(
            page,
            { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
            state,
        )
        assert.equal(page.writer.write(), true)
        assert.equal(journalIn(page.storage, session.id)?.seq, i + 2)
        await page.flusher.flush({ strict: i % 2 === 0 })
        assert.equal(page.flusher.unflushed(session), false)
        assert.equal(page.storage.length, 0)
    }
    // A second session's journal, cleared by its own commit.
    const next = beginSession(page, stateOf(goldenChart()), 'new')
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(state, 5),
    )
    assert.equal(page.writer.write(), true)
    assert.ok(journalIn(page.storage, next.id))
    await page.flusher.flush()
    assert.equal(page.storage.length, 0)
    const { outcomes } = await replayAll(world, page.storage)
    assert.deepEqual(outcomes, [])
})

test('a long stack journalled with keep 0 names its newest dropped steps and counts them all', async () => {
    const world = createWorld({ seed: 22 })
    const page = await openJournalPage(world, 'a')
    let state = stateOf(goldenChart())
    // A session never flushed: its journal keeps nothing.
    const session = beginSession(page, state, 'new')
    for (let i = 0; i < 100; i++) {
        state = { ...state, initialLife: 100 + i }
        append(page, { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) }, state)
    }
    assert.equal(page.writer.write(), true)
    const journal = journalIn(page.storage, session.id)
    assert.equal(journal?.stack.keep, 0)
    assert.equal(journal?.stack.context.dropped.length, 64)
    same(journal?.stack.context.dropped.at(-1), editStep(futureFixtureOperation('Edit 98')))
    assert.equal(journal!.stack.context.dropped.length + journal!.stack.context.omitted, 100)
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    const [recovered] = [...rows(world, 'entries').values()].filter(
        (entry) => entry.sessionId === session.id,
    )
    same(
        recovered?.operation,
        nativeOperation(
            { id: 'nse.recovery', data: { droppedSteps: 100 } },
            'Recovered last change',
        ),
    )
})
