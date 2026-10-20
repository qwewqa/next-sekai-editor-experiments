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

// The journal's writer (§1.6.4 #7): when it writes, what it writes, when it's cleared, and the
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

test('nothing is written while every entry is committed strictly', async () => {
    const { page } = await start(1)
    const writes = counting(page.storage)
    assert.equal(page.writer.write(), true)
    assert.equal(writes(), 0)
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

test('a key is cleared only after a strict commit covering its seq', async () => {
    const { page, session, a } = await start(3)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    page.writer.write()
    // A routine relaxed flush leaves the key for the next strict one.
    await page.flusher.flush()
    assert.ok(journalIn(page.storage, session.id))
    assert.ok(page.flusher.unflushed(session))
    // A strict flush with nothing new commits strictly what the relaxed one stored.
    await page.flusher.flush({ strict: true })
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

test('a replaced session is committed strictly before it goes, and its journal is cleared', async () => {
    const world = createWorld({ seed: 9 })
    const page = await openJournalPage(world, 'a')
    const released: string[] = []
    const a = stateOf(goldenChart())
    const session = beginSession(page, a, 'import', { done: () => released.push('first') })
    await page.flusher.flush({ strict: true })
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    // A hide's journal, then a routine relaxed flush: the key stays for a strict commit.
    page.writer.write()
    await page.flusher.flush()
    assert.ok(journalIn(page.storage, session.id))
    // New replaces it (§1.3.8): the outgoing session is committed strictly first.
    beginSession(page, stateOf(goldenChart()), 'new')
    // Its outcome, for Step 4's switch prompt: committed strictly in the database.
    assert.equal(await page.flusher.outgoing, true)
    assert.equal(journalIn(page.storage, session.id), undefined)
    assert.deepEqual(released, ['first'])
})

/** A session committed relaxed after its journal, as a hide then a routine flush leave it. */
const relaxedAfterJournal = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openJournalPage(world, 'a')
    const released: string[] = []
    const a = stateOf(goldenChart())
    const session = beginSession(page, a, 'import', { done: () => released.push('first') })
    await page.flusher.flush({ strict: true })
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    page.writer.write()
    await page.flusher.flush()
    return { world, page, session, released, a }
}

test('a replaced session whose strict commit fails is kept with its lock and key, and retried', async () => {
    const { page, session, released, a } = await relaxedAfterJournal(20)
    page.sync.fails = 1
    const next = beginSession(page, widen(a, 3), 'new')
    assert.equal(await page.flusher.outgoing, false)
    assert.equal(page.flusher.syncFailed, true)
    assert.deepEqual(released, [])
    assert.ok(journalIn(page.storage, session.id))
    // The next strict flush (a hide) commits it, clears its key and lets it go.
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(a, 4),
    )
    await page.flusher.flush({ strict: true })
    assert.equal(journalIn(page.storage, session.id), undefined)
    assert.deepEqual(released, ['first'])
    assert.equal(page.flusher.unflushed(next), false)
})

test('where no database will answer any more, a replaced session is let go', async () => {
    const { page, released, a } = await relaxedAfterJournal(21)
    // A newer database opened read-only: no strict commit can land.
    page.flusher.withoutDatabase()
    page.sync.fails = Infinity
    beginSession(page, widen(a, 3), 'new')
    assert.equal(await page.flusher.outgoing, false)
    assert.deepEqual(released, ['first'])
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
    await page.flusher.flush()
    const fork = page.flusher.session
    assert.ok(fork && fork.id !== session.id)
    // The old key is gone, and the fork's journal carries the old chain's fields from the start.
    assert.equal(journalIn(page.storage, session.id), undefined)
    const journal = journalIn(page.storage, fork.id)
    assert.ok(journal)
    assert.equal(journal.descriptor.chainId, fork.chainId)
    assert.equal(journal.descriptor.name, 'Coconut (Master)')
    assert.deepEqual(journal.descriptor.future, { kept: 1 })
    assert.deepEqual(journal.descriptor.parent, { id: session.id, uptoSeq: 2 })
    // The next load makes no recovery chain duplicating the fork.
    const { outcomes } = await replayAll(world, page.storage)
    assert.deepEqual(
        outcomes.map((outcome) => outcome.kind),
        ['covered'],
    )
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

test('where a strict commit may not be on disk yet (D14), no commit clears a key; the next load does', async () => {
    const world = createWorld({ seed: 12 })
    const page = await openJournalPage(world, 'a', new MemoryStorage(), { strictCommits: false })
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
        await page.flusher.flush({ strict: true })
        // Committed strictly: the key stays, one per session, at its newest seq.
        assert.equal(page.flusher.unflushed(session), false)
        assert.equal(journalIn(page.storage, session.id)?.seq, i + 2)
        assert.equal(page.storage.length, 1)
    }
    // A second session's newer journal replaces the first's covered key: they don't pile up.
    const next = beginSession(page, stateOf(goldenChart()), 'new')
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(state, 5),
    )
    assert.equal(page.writer.write(), true)
    assert.equal(journalIn(page.storage, session.id), undefined)
    await page.flusher.flush({ strict: true })
    assert.equal(page.storage.length, 1)
    assert.ok(journalIn(page.storage, next.id))
    // The next load finds the last one covered by the stored history and deletes it.
    const { outcomes } = await replayAll(world, page.storage)
    assert.deepEqual(
        outcomes.map((outcome) => outcome.kind),
        ['covered'],
    )
    assert.equal(page.storage.length, 0)
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
