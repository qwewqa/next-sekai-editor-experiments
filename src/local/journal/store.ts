import type { JournalFound, JournalLike, JournalStore } from '../../platform/types'

// `JournalStore` over localStorage (§1.6.4 #7, §1.6.11.3): one key per session, overwritten on
// each write and verified by reading it back; a write that would pass the size limits isn't
// made. The mock runs the same code over an in-memory Storage.

/** One key's most characters (§1.6.4: about 1 MB; coconut's journal is under 100 KB). */
export const JOURNAL_KEY_LIMIT = 1024 * 1024
/** All `journal.*` and `legacyRecovery` keys together, which leaves room for settings. */
export const JOURNAL_TOTAL_LIMIT = 4 * 1024 * 1024

const JOURNAL = 'journal.'
const LEGACY = 'legacyRecovery'

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

    /** Characters the other journals and the legacy slot hold, with their keys. */
    const othersSize = (store: JournalStorage, own: string) => {
        let total = 0
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i)
            if (key === null || key === own) continue
            if (!key.startsWith(prefix + JOURNAL) && key !== prefix + LEGACY) continue
            total += key.length + (store.getItem(key)?.length ?? 0)
        }
        return total
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
                const text = JSON.stringify(journal)
                if (text.length > JOURNAL_KEY_LIMIT) return false
                if (othersSize(store, key) + key.length + text.length > JOURNAL_TOTAL_LIMIT)
                    return false
                store.setItem(key, text)
                // Only a write read back intact counts (§1.6.4): the same length and characters.
                const back = store.getItem(key)
                return back !== null && back.length === text.length && back === text
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
                if (text === null) return
                const seq = seqOf(text)
                // A key this build can't read is replay's to keep, never a flush's to drop.
                if (seq !== undefined && seq <= coveredSeq) store.removeItem(key)
            } catch {
                // Left for the next load's replay, which finds it covered.
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
