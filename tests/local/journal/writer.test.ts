import assert from 'node:assert/strict'
import test from 'node:test'
import type { JournalV1 } from '../../../src/local/journal/format'
import {
    JOURNAL_KEY_LIMIT,
    JOURNAL_TOTAL_LIMIT,
    MemoryStorage,
} from '../../../src/local/journal/store'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { append, beginSession, openJournalPage, replayAll } from './harness'

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
    return text === null ? undefined : (JSON.parse(text) as JournalV1)
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
    append(page, 'edit', 'Changed note', widen(a))
    assert.equal(page.writer.write(), true)
    assert.equal(page.writer.write(), true)
    assert.equal(writes(), 1)
    append(page, 'undo', 'Changed note', a)
    assert.equal(page.writer.write(), true)
    assert.equal(writes(), 2)
    const journal = journalIn(page.storage, session.id)
    // An undo onto a committed slot: the head is that slot, nothing pushed or dropped.
    assert.deepEqual(journal?.stack, {
        keep: 1,
        lastKept: journal?.stack.lastKept,
        dropped: ['Changed note'],
        head: null,
        index: 0,
    })
})

test('a key is cleared only after a strict commit covering its seq', async () => {
    const { page, session, a } = await start(3)
    append(page, 'edit', 'Changed note', widen(a))
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
    append(page, 'edit', 'Changed note', widen(a))
    const next = beginSession(page, stateOf(goldenChart()), 'new')
    page.writer.write()
    assert.equal(journalIn(page.storage, session.id), undefined)
    assert.equal(journalIn(page.storage, next.id), undefined)
})

test('the descriptor carries the chain as stored, the session’s fields and its flags', async () => {
    const { page, session, a } = await start(5)
    append(page, 'edit', 'Changed note', widen(a))
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
    append(page, 'edit', 'Changed note', widen(a))
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
    append(page, 'edit', 'Changed note', widen(a))
    assert.equal(page.writer.write(), false)
    assert.equal(page.writer.verified(session.id, 2), false)
})

test('a BGM change is journalled with its metadata, and recovers with it', async () => {
    const { world, page, session, a } = await start(8)
    const meta = { hash: 'ab'.repeat(16), filename: 'new.mp3', size: 1234, type: 'audio/mpeg' }
    const changed: State = { ...widen(a), bgm: { ...a.bgm, filename: 'new.mp3', meta } }
    append(page, 'edit', 'Changed BGM', changed)
    page.writer.write()
    const journal = journalIn(page.storage, session.id)
    assert.deepEqual(journal?.header.bgm, [meta.hash, meta.filename, meta.size, meta.type])
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    assert.deepEqual(checkStored(world.memory), [])
})
