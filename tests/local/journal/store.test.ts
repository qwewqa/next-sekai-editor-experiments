import assert from 'node:assert/strict'
import test from 'node:test'
import type { FlushSession } from '../../../src/local/flush'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import { JournalWriter } from '../../../src/local/journal/writer'
import '../../helpers/lockChecks'

// The journal store's keys under a fork (Part 1 §1.6.4 #7, §1.3.1).

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
