import assert from 'node:assert/strict'
import test from 'node:test'
import type { FlushSession } from '../../../src/local/flush'
import {
    JOURNAL_KEY_LIMIT,
    JOURNAL_TOTAL_LIMIT,
    MemoryStorage,
    storageJournalStore,
} from '../../../src/local/journal/store'
import { JournalWriter } from '../../../src/local/journal/writer'

// The journal store's budget (Part 1 §1.6.4): all journals and the legacy slot together, the
// legacy slot left out first, and only when that makes room.

const journal = (sessionId: string, size: number) => ({
    sessionId,
    seq: 1,
    pad: 'x'.repeat(size),
})

test('the legacy slot is left out to make room, and kept when leaving it out wouldn’t', () => {
    const storage = new MemoryStorage()
    const store = storageJournalStore(() => storage, 'nse.')
    const size = JOURNAL_KEY_LIMIT - 1000
    const legacy = 'y'.repeat(JOURNAL_TOTAL_LIMIT / 4)
    storage.setItem('nse.legacyRecovery', legacy)
    for (const other of ['a', 'b', 'c']) storage.setItem(`nse.journal.${other}`, 'z'.repeat(size))

    // Too large even without the legacy slot (room is kept for the auto save to grow to it): not
    // written, and the slot stays.
    assert.equal(store.writeWhole(journal('new', size - 100)), false)
    assert.equal(storage.getItem('nse.legacyRecovery'), legacy)

    // Fits once the legacy slot is left out.
    storage.removeItem('nse.journal.c')
    assert.equal(store.writeWhole(journal('new', size - 100)), true)
    assert.equal(storage.getItem('nse.legacyRecovery'), null)
})

test('a key retired to a session that forks goes once the fork holds the entries it took', () => {
    const storage = new MemoryStorage()
    const store = storageJournalStore(() => storage, 'nse.')
    storage.setItem('nse.journal.S', '{"seq":4}')
    const writer = new JournalWriter({
        store,
        flusher: () => undefined,
        state: () => undefined as never,
        pausedForSpace: () => false,
        appVersion: '0.6.0',
    })
    writer.retire({ sessionId: 'S', text: '{"seq":4}', from: 'journal.S' }, 'C', 5)
    // C's entries moved to a fork, numbered 1 and 2 there.
    writer.forked({ id: 'C' } as FlushSession, { id: 'F', nextSeq: 3, entrySeq: 2 } as FlushSession)
    // Entry 1 of 2 committed: the key still holds work the fork has not stored.
    writer.committed('F', 1, true)
    assert.equal(storage.getItem('nse.journal.S'), '{"seq":4}')
    writer.committed('F', 2, true)
    assert.equal(storage.getItem('nse.journal.S'), null)
})
