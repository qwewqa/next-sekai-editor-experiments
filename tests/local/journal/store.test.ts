import assert from 'node:assert/strict'
import test from 'node:test'
import {
    JOURNAL_KEY_LIMIT,
    JOURNAL_TOTAL_LIMIT,
    MemoryStorage,
    storageJournalStore,
} from '../../../src/local/journal/store'

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
