import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { onHistoryAction } from '../../history/actions'
import { session } from '../../history/session'
import { storageWorker } from '../../local/start'
import { flusher } from '../../local/storing'
import type { TimelineEntry } from '../../local/worker/timelineHandlers'
import { entryId, type Entry } from './rows'

// The chain's entries for the Timeline (Part 1 §1.4.10.5): a page at a time from storage, newest
// first, with the open session's entries still waiting to be stored on top.

const PAGE = 100

type Cursor = { sessionId: string; before: number }

/** The newest stored entries, and the older pages loaded so far. */
const stored = shallowRef<readonly Entry[]>([])
/** The session the stored entries were read for. */
const loadedFor = ref<string>()
let cursor: Cursor | undefined
/** Whether older entries remain in storage. */
export const canLoadMore = ref(false)
let loading: Promise<void> | undefined
/** Bumped by every change of the undo stack, so the entries waiting to be stored are read again. */
const version = ref(0)

const entryOf = (entry: TimelineEntry): Entry => ({
    sessionId: entry.sessionId,
    seq: entry.seq,
    time: entry.time,
    kind: entry.kind,
    label: entry.label,
    noteCount: entry.noteCount,
    kept: entry.kept,
    ...(entry.from === undefined ? {} : { from: entry.from }),
})

/** The open session's entries the worker has not acknowledged, newest first. */
const pendingEntries = (): Entry[] => {
    void version.value
    const open = flusher?.session
    if (!open) return []
    return open.pending
        .map((entry): Entry => ({
            sessionId: open.id,
            seq: entry.seq,
            time: entry.wall,
            kind: entry.kind,
            label: entry.label(),
            kept: true,
            pending: true,
        }))
        .reverse()
}

/** Every entry newest first: those waiting to be stored, then the stored ones. */
export const entries = computed((): Entry[] => {
    const read = loadedFor.value === session.value.sessionId ? stored.value : []
    const have = new Set(read.map(entryId))
    const all = [...pendingEntries().filter((entry) => !have.has(entryId(entry))), ...read]
    // A continuation not stored yet divides from the entry it continues: the next older one.
    return all.map((entry, i) =>
        entry.pending && entry.kind === 'continue' && entry.from === undefined && all[i + 1]
            ? { ...entry, from: all[i + 1]?.time }
            : entry,
    )
})

/** Where the open session's chain is read from: a session not stored yet reads its parent's. */
const startOf = (id: string) => {
    const open = flusher?.session
    return open?.id === id && !open.stored && open.parent
        ? { sessionId: open.parent.id, before: open.parent.uptoSeq + 1 }
        : { sessionId: id }
}

/** Reads the newest page again, keeping the older pages already loaded. */
export const refresh = async () => {
    const worker = storageWorker
    const id = session.value.sessionId
    if (!worker) return
    let page
    try {
        page = await worker.call('readTimeline', { ...startOf(id), limit: PAGE })
    } catch {
        return
    }
    // The session changed meanwhile: its own refresh follows.
    if (session.value.sessionId !== id) return
    const fresh = page.entries.map(entryOf)
    const oldest = fresh.at(-1)
    const at = oldest ? stored.value.findIndex((entry) => entryId(entry) === entryId(oldest)) : -1
    if (loadedFor.value === id && at !== -1) {
        stored.value = [...fresh, ...stored.value.slice(at + 1)]
    } else {
        stored.value = fresh
        cursor = page.next
    }
    loadedFor.value = id
    canLoadMore.value = !!cursor
}

/** Loads the next older page. */
export const loadMore = () => {
    const worker = storageWorker
    const at = cursor
    if (!worker || !at || loading) return loading
    const id = session.value.sessionId
    loading = (async () => {
        try {
            const page = await worker.call('readTimeline', { ...at, limit: PAGE })
            if (session.value.sessionId !== id || cursor !== at) return
            stored.value = [...stored.value, ...page.entries.map(entryOf)]
            cursor = page.next
            canLoadMore.value = !!cursor
        } catch {
            // The next scroll tries again.
        } finally {
            loading = undefined
        }
    })()
    return loading
}

/** Entries waiting for the worker. */
const waiting = () => flusher?.session?.pending.length ?? 0

/**
 * Follows the undo stack while the panel is shown: reads at once, and about 1 s after each
 * change, when the flush has stored it. Call in a component's setup.
 */
export const followEntries = () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    const follow = () => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
            const before = waiting()
            await refresh()
            if (waiting() && tries++ < 8) follow()
            else {
                tries = 0
                // Stored while the read was out: read what it stored.
                if (before) await refresh()
            }
        }, 1300)
    }
    void refresh()
    const stop = onHistoryAction((action) => {
        if (action.kind === 'reset') {
            stored.value = []
            cursor = undefined
            loadedFor.value = undefined
            canLoadMore.value = false
        }
        version.value++
        follow()
    })
    watch(
        () => session.value.sessionId,
        () => {
            void refresh()
        },
    )
    onScopeDispose(() => {
        stop()
        clearTimeout(timer)
    })
}
