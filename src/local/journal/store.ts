import type { JournalFound, JournalLike, JournalStore } from '../../platform/types'

// `JournalStore` over localStorage (§1.6.4 #7, §1.6.11.3): one key per session, overwritten on
// each write and verified by reading it back; a write that would pass the size limits isn't
// made. A store is one page load's: it never replaces or clears a key whose text it neither wrote
// nor loaded (§1.6.7's backstop). The mock runs the same code over an in-memory Storage.

/** One key's most characters (§1.6.4: about 1 MB; coconut's journal is under 100 KB). */
export const JOURNAL_KEY_LIMIT = 1024 * 1024
/**
 * All `journal.*` and `legacyRecovery` keys together, and until the migration retires it today's
 * auto save, which leaves room for settings.
 */
export const JOURNAL_TOTAL_LIMIT = 4 * 1024 * 1024

const JOURNAL = 'journal.'
const LEGACY = 'legacyRecovery'
/** Today's auto save (`autoSave.levelData`, `autoSave.unreadable`), which Step 4 migrates. */
const AUTO_SAVE = 'autoSave.'
const AUTO_SAVE_SLOT = 'autoSave.levelData'

/** The part of Storage the journal uses. */
export type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

/**
 * A journal store over a Storage, under the editor's key prefix. `storage` is read on each call,
 * since localStorage can be unavailable (it throws in some private modes).
 */
export const storageJournalStore = (
    storage: () => JournalStorage,
    prefix: string,
): JournalStore => {
    const keyOf = (sessionId: string) => `${prefix}${JOURNAL}${sessionId}`
    /** The text this page last wrote or loaded, by key: the only text it may replace. */
    const owned = new Map<string, string>()
    const ours = (store: JournalStorage, key: string) => {
        const text = store.getItem(key)
        return text === null || text === owned.get(key)
    }

    /**
     * Characters the other journals, the legacy slot and the auto save hold, with their keys, and
     * room for the auto save to grow to this journal's size: it holds the same chart, so journals
     * never push its next write over the browser's quota.
     */
    const othersSize = (store: JournalStorage, own: string, size: number, skip?: string) => {
        let total = 0
        let autoSave = 0
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i)
            if (key === null || key === own || key === skip) continue
            const counted =
                key.startsWith(prefix + JOURNAL) ||
                key === prefix + LEGACY ||
                key.startsWith(prefix + AUTO_SAVE)
            if (!counted) continue
            const length = store.getItem(key)?.length ?? 0
            if (key === prefix + AUTO_SAVE_SLOT) autoSave = length
            total += key.length + length
        }
        return total + Math.max(0, size - autoSave)
    }

    const seqOf = (text: string) => {
        try {
            const seq = (JSON.parse(text) as { seq?: unknown }).seq
            return typeof seq === 'number' ? seq : undefined
        } catch {
            return
        }
    }

    return {
        writeWhole: (journal: JournalLike) => {
            try {
                const store = storage()
                const key = keyOf(journal.sessionId)
                // Another page's journal of this session (a crash's, a copied tab's) stays.
                if (!ours(store, key)) return false
                const text = JSON.stringify(journal)
                if (text.length > JOURNAL_KEY_LIMIT) return false
                const fits = (skip?: string) =>
                    othersSize(store, key, text.length, skip) + key.length + text.length <=
                    JOURNAL_TOTAL_LIMIT
                if (!fits()) {
                    // The legacy slot is the one left out first when space is short (§1.6.4),
                    // only when that makes room.
                    if (store.getItem(prefix + LEGACY) === null || !fits(prefix + LEGACY))
                        return false
                    store.removeItem(prefix + LEGACY)
                }
                store.setItem(key, text)
                // Only a write read back intact counts (§1.6.4): the same length and characters.
                const back = store.getItem(key)
                const verified = back !== null && back.length === text.length && back === text
                owned.set(key, text)
                return verified
            } catch {
                return false
            }
        },
        read: () => {
            try {
                const store = storage()
                const found: JournalFound[] = []
                for (let i = 0; i < store.length; i++) {
                    const key = store.key(i)
                    if (!key?.startsWith(prefix + JOURNAL)) continue
                    const text = store.getItem(key)
                    if (text === null) continue
                    const from = key.slice(prefix.length)
                    found.push({ sessionId: from.slice(JOURNAL.length), text, from })
                }
                return Promise.resolve(found)
            } catch {
                return Promise.resolve([])
            }
        },
        clear: (sessionId, coveredSeq) => {
            try {
                const store = storage()
                const key = keyOf(sessionId)
                const text = store.getItem(key)
                if (text === null || text !== owned.get(key)) return
                const seq = seqOf(text)
                // A key this build can't read is replay's to keep, never a flush's to drop.
                if (seq !== undefined && seq <= coveredSeq) {
                    store.removeItem(key)
                    owned.delete(key)
                }
            } catch {
                // Left for the next load's replay, which finds it covered.
            }
        },
        adopt: (found) => {
            owned.set(prefix + found.from, found.text)
        },
        holds: (sessionId) => {
            try {
                const key = keyOf(sessionId)
                const text = storage().getItem(key)
                return text !== null && text === owned.get(key)
            } catch {
                return false
            }
        },
        remove: (found) => {
            try {
                const store = storage()
                const key = prefix + found.from
                if (store.getItem(key) === found.text) store.removeItem(key)
            } catch {
                // Left in place: the next load finds it again.
            }
        },
    }
}

/** An in-memory Storage, with a quota in characters for tests of a full localStorage. */
export class MemoryStorage implements JournalStorage {
    private readonly items = new Map<string, string>()
    /** When set, a write that would hold more characters throws QuotaExceededError. */
    quota: number | undefined

    get length() {
        return this.items.size
    }

    key(index: number) {
        return [...this.items.keys()][index] ?? null
    }

    getItem(key: string) {
        return this.items.get(key) ?? null
    }

    setItem(key: string, value: string) {
        if (this.quota !== undefined) {
            let used = key.length + value.length
            for (const [other, text] of this.items)
                if (other !== key) used += other.length + text.length
            if (used > this.quota)
                throw new DOMException('The quota was exceeded', 'QuotaExceededError')
        }
        this.items.set(key, value)
    }

    removeItem(key: string) {
        this.items.delete(key)
    }
}
