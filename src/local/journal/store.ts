import type { JournalFound, JournalLike, JournalStore } from '../../platform/types'
import { trimOptionalJournalContext } from './format'

// `JournalStore` over localStorage: one key per session, overwritten on
// each write and verified by reading it back; a write that would pass the size limits isn't
// made. A store is one page load's: it never replaces or clears a key whose text it neither wrote
// nor loaded (the backstop). The mock runs the same code over an in-memory Storage.

/** One key's most characters (about 1 MB; coconut's journal is under 100 KB). */
export const JOURNAL_KEY_LIMIT = 1024 * 1024
/**
 * All `journal.*` keys together, plus the old auto save until the migration retires it. The
 * limit leaves room for settings.
 */
export const JOURNAL_TOTAL_LIMIT = 4 * 1024 * 1024

const JOURNAL = 'journal.'
/** The old auto save (`autoSave.levelData`, `autoSave.unreadable`). */
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
     * Characters the other journals and the auto save hold, with their keys, and room for the
     * auto save to grow to this journal's size: it holds the same chart, so journals never push
     * its next write over the browser's quota.
     */
    const othersSize = (store: JournalStorage, own: string, size: number) => {
        let total = 0
        let autoSave = 0
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i)
            if (key === null || key === own) continue
            if (!key.startsWith(prefix + JOURNAL) && !key.startsWith(prefix + AUTO_SAVE)) continue
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
                let candidate = journal
                let text = JSON.stringify(candidate)
                const fits = () =>
                    othersSize(store, key, text.length) + key.length + text.length <=
                    JOURNAL_TOTAL_LIMIT
                while (text.length > JOURNAL_KEY_LIMIT || !fits()) {
                    const trimmed = trimOptionalJournalContext(candidate)
                    if (!trimmed) return false
                    candidate = trimmed
                    text = JSON.stringify(candidate)
                }
                store.setItem(key, text)
                // Only a write read back intact counts: the same length and characters.
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
