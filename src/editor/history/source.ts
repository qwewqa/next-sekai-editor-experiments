import { computed, onScopeDispose, ref, shallowReactive, shallowRef, watch } from 'vue'
import { onHistoryAction } from '../../history/actions'
import { captureEntryDescription } from '../../history/operations'
import { session } from '../../history/session'
import { toHex } from '../../local/hash'
import { storageWorker } from '../../local/start'
import { flusher } from '../../local/storing'
import type { EditMatch, FindEditsCursor } from '../../local/worker/changeHandlers'
import type {
    PathStep,
    TimelineEntry,
    TimelineIndex,
    TimelinePage,
    TimelinePiece,
} from '../../local/worker/timelineHandlers'
import { entryId, type Entry, type Filter } from './rows'
import { hereRange, historyFilter } from './state'

// The chain's entries for the Timeline (Part 1 §1.4.10.5): a page at a time from storage, newest
// first, with the open session's entries still waiting to be stored on top. After a jump (Go To,
// End) the loaded run is a window read at the target: older pages load below it as before, and
// newer ones into the gap between it and Now, until it reaches the newest entries again.

const PAGE = 100

type Cursor = { sessionId: string; before: number }

/** An entry to jump to. */
export type Target = { sessionId: string; seq: number }

/** The newest stored entries, and the older pages loaded so far; after a jump, the window. */
const stored = shallowRef<readonly Entry[]>([])
/** The session the stored entries were read for. */
const loadedFor = ref<string>()
let cursor: Cursor | undefined
/** Where the next newer page starts after a jump, with the path it reads along. */
const newer = shallowRef<{ sessionId: string; after: number; path: readonly PathStep[] }>()
/** The stored entries newer than the window. */
const newerCount = ref(0)
/** Whether older entries remain in storage. */
export const canLoadMore = ref(false)
/** The first page's read: loading until it lands, failed when it could not be read. */
export const status = ref<'loading' | 'ready' | 'failed'>('loading')
/** An older page is being read. */
export const loadingMore = ref(false)
/** A newer page is being read into the gap. */
export const loadingNewer = ref(false)
let loading: Promise<void> | undefined
let loadingAbove: Promise<void> | undefined
/** Bumped by every change of the undo stack, so the entries waiting to be stored are read again. */
const version = ref(0)
/** Bumped when the loaded run is replaced: reads begun before it land nowhere. */
let epoch = 0
export const sourceGeneration = ref(0)
const replaceSource = () => {
    sourceGeneration.value++
    return ++epoch
}

const entryOf = (entry: TimelineEntry): Entry => ({
    sessionId: entry.sessionId,
    seq: entry.seq,
    time: entry.time,
    ...captureEntryDescription(entry),
    noteCount: entry.noteCount,
    kept: entry.kept,
    ...(entry.from === undefined ? {} : { from: entry.from }),
    ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
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
            ...captureEntryDescription(entry),
            kept: true,
            pending: true,
            ...(entry.snapshot && !entry.state ? { snapshot: toHex(entry.snapshot) } : {}),
        }))
        .reverse()
}

/** Every entry newest first: those waiting to be stored, then the stored ones; after a jump, the window. */
export const entries = computed((): Entry[] => {
    const read = loadedFor.value === session.value.sessionId ? stored.value : []
    if (newer.value) return [...read]
    const have = new Set(read.map(entryId))
    const all = [...pendingEntries().filter((entry) => !have.has(entryId(entry))), ...read]
    // A continuation not stored yet divides from the entry it continues: the next older one.
    return all.map((entry, i) =>
        entry.pending && entry.kind === 'continue' && entry.from === undefined && all[i + 1]
            ? { ...entry, from: all[i + 1]?.time }
            : entry,
    )
})

/** What the Timeline lists: Edits Here's matches while it filters, else every entry. */
export const listedEntries = computed((): Entry[] =>
    historyFilter.value === 'here' ? [...here.matches] : entries.value,
)

const isJumped = () => newer.value !== undefined

/** After a jump, the entries between Now and the window; undefined while the run reaches Now. */
export const gap = computed(() => {
    if (!newer.value || historyFilter.value === 'here') return undefined
    void version.value
    return newerCount.value + (flusher?.session?.pending.length ?? 0)
})

/** Where the open session's chain is read from: a session not stored yet reads its parent's. */
const startOf = (id: string) => {
    const open = flusher?.session
    return open?.id === id && !open.stored && open.parent
        ? { sessionId: open.parent.id, before: open.parent.uptoSeq + 1 }
        : { sessionId: id }
}

/** After a jump, counts the entries above the window again; joins Now when there are none. */
const recount = async () => {
    const worker = storageWorker
    const at = newer.value
    if (!worker || !at) return
    const mark = epoch
    let page: TimelinePage
    try {
        page = await worker.call('readTimeline', { ...at, limit: 0, path: [...at.path] })
    } catch {
        return
    }
    if (mark !== epoch || newer.value !== at) return
    if (page.newer) newerCount.value = page.newer.count
    else {
        newer.value = undefined
        await refresh()
    }
}

/** Reads the newest page again, keeping the older pages already loaded. */
export const refresh = async (): Promise<void> => {
    const worker = storageWorker
    const id = session.value.sessionId
    // Without storage the timeline holds what this tab made.
    if (!worker) {
        status.value = 'ready'
        return
    }
    if (newer.value) {
        if (loadedFor.value === id) return recount()
        // Another session's window: its chain is read from the top.
        replaceSource()
        newer.value = undefined
        newerCount.value = 0
    }
    const mark = epoch
    let page
    try {
        page = await worker.call('readTimeline', { ...startOf(id), limit: PAGE })
    } catch {
        if (loadedFor.value !== id) status.value = 'failed'
        return
    }
    // The session changed meanwhile: its own refresh follows. A jump replaced the run: it stays.
    if (session.value.sessionId !== id || mark !== epoch || isJumped()) return
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
    status.value = 'ready'
}

/** Reads the first page again after it failed. */
export const retry = () => {
    status.value = 'loading'
    void refresh()
}

/** Loads the next older page. */
export const loadMore = () => {
    const worker = storageWorker
    const at = cursor
    if (!worker || !at || loading) return loading
    const id = session.value.sessionId
    const mark = epoch
    loadingMore.value = true
    loading = (async () => {
        try {
            const page = await worker.call('readTimeline', { ...at, limit: PAGE })
            if (session.value.sessionId !== id || cursor !== at || mark !== epoch) return
            stored.value = [...stored.value, ...page.entries.map(entryOf)]
            cursor = page.next
            canLoadMore.value = !!cursor
        } catch {
            // The next scroll tries again.
        } finally {
            loading = undefined
            loadingMore.value = false
        }
    })()
    return loading
}

/** After a jump, loads the next newer page into the gap; the gap goes when it reaches the newest. */
export const loadNewer = () => {
    const worker = storageWorker
    const at = newer.value
    if (!worker || !at || loadingAbove) return loadingAbove
    const mark = epoch
    loadingNewer.value = true
    loadingAbove = (async () => {
        try {
            const page = await worker.call('readTimeline', {
                ...at,
                limit: PAGE,
                path: [...at.path],
            })
            if (mark !== epoch || newer.value !== at) return
            stored.value = [...page.entries.map(entryOf), ...stored.value]
            if (page.newer) {
                newer.value = { ...page.newer, path: at.path }
                newerCount.value = page.newer.count
            } else {
                newer.value = undefined
                newerCount.value = 0
                await refresh()
            }
        } catch {
            // The next scroll tries again.
        } finally {
            loadingAbove = undefined
            loadingNewer.value = false
        }
    })()
    return loadingAbove
}

// --- The index Go To lists, read when it opens and kept until the next history action.

const SAVES = ['save', 'export'] as const
const indexes = new Map<string, Promise<TimelineIndex>>()

/** The chain's pieces, each a session's entries on one day: saves and exports only while filtering. */
export const readIndex = (filter: Filter): Promise<TimelineIndex> => {
    if (filter === 'here') return Promise.resolve({ pieces: piecesOf(here.matches), path: [] })
    const worker = storageWorker
    if (!worker) return Promise.resolve({ pieces: [], path: [] })
    const start = startOf(session.value.sessionId)
    const key = `${start.sessionId}:${start.before ?? ''}:${filter}`
    let found = indexes.get(key)
    if (!found) {
        found = worker.call('readTimelineIndex', {
            ...start,
            ...(filter === 'saves' ? { kinds: [...SAVES] } : {}),
        })
        indexes.set(key, found)
        found.catch(() => indexes.delete(key))
    }
    return found
}

/**
 * Replaces the loaded run with a window at the target: from it down, and a page above it, with
 * the gap between that page and Now. Resolves with the target's entry once it is shown.
 */
export const jumpTo = async (target: Target, filter: Filter): Promise<Entry | undefined> => {
    // Edits Here holds all it has found.
    if (filter === 'here')
        return here.matches.find(
            (entry) => entry.sessionId === target.sessionId && entry.seq === target.seq,
        )
    const worker = storageWorker
    if (!worker) return
    const id = session.value.sessionId
    const mark = replaceSource()
    const { path } = await readIndex(filter)
    const [below, above] = await Promise.all([
        worker.call('readTimeline', {
            sessionId: target.sessionId,
            before: target.seq + 1,
            limit: PAGE,
        }),
        worker.call('readTimeline', {
            sessionId: target.sessionId,
            after: target.seq,
            limit: PAGE,
            path,
        }),
    ])
    if (mark !== epoch || session.value.sessionId !== id) return
    const window = [...above.entries, ...below.entries].map(entryOf)
    stored.value = window
    loadedFor.value = id
    cursor = below.next
    canLoadMore.value = !!cursor
    status.value = 'ready'
    if (above.newer) {
        newer.value = { ...above.newer, path }
        newerCount.value = above.newer.count
    } else {
        newer.value = undefined
        newerCount.value = 0
        await refresh()
    }
    return window.find((entry) => entry.sessionId === target.sessionId && entry.seq === target.seq)
}

/** Jumps to the oldest entry of the chain (shown with the filter): End. */
export const jumpToOldest = async (filter: Filter) => {
    const { pieces } = await readIndex(filter)
    const oldest = pieces.at(-1)
    if (!oldest) return
    return jumpTo({ sessionId: oldest.sessionId, seq: oldest.oldestSeq }, filter)
}

/** Back to the newest entries after a jump: Now, Home. */
export const resetToNewest = async () => {
    if (!newer.value) return
    replaceSource()
    newer.value = undefined
    newerCount.value = 0
    await refresh()
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
            void checkNewer()
            if (waiting() && tries++ < 8) follow()
            else {
                tries = 0
                // Stored while the read was out: read what it stored.
                if (before) await refresh()
            }
        }, 1300)
    }
    void refresh()
    watch(
        [historyFilter, hereRange, () => session.value.sessionId],
        () => {
            if (historyFilter.value !== 'here') stopHere()
            else if (hereFor === hereKey() && hereDone) void checkNewer()
            else void scanHere()
        },
        { immediate: true },
    )
    const stop = onHistoryAction((action) => {
        indexes.clear()
        if (action.kind === 'reset') {
            replaceSource()
            stored.value = []
            cursor = undefined
            newer.value = undefined
            newerCount.value = 0
            loadedFor.value = undefined
            canLoadMore.value = false
            status.value = 'loading'
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
        // A scan stopped part way starts again when the list shows once more.
        if (here.scanning) {
            stopHere()
            hereFor = undefined
        }
    })
}

// --- Edits Here (§1.4.10.5): the entries whose change touches a range of beats, found newest
// first by the worker's scan while the filter is on, and stopped when it goes off or the range
// changes. Entries stored later are checked on their own and join at the top.

/** Edits Here's matches so far, newest first, and the scan's progress. */
export const here = shallowReactive({
    matches: [] as readonly Entry[],
    scanning: false,
    /** Entries left out: their state, or the one before, could not be read. */
    unreadable: 0,
})

let hereToken = 0
/** The range and chain the matches are for, and whether their scan reached the start. */
let hereFor: string | undefined
let hereDone = false
/** The newest entry checked: newer ones are checked on their own. */
let hereTop: { sessionId: string; seq: number } | undefined

const hereKey = () => {
    const range = hereRange.value
    return range && `${session.value.sessionId}|${range.from}|${range.to}`
}

const matchOf = (match: EditMatch, shift = 0): Entry => ({
    ...entryOf(match),
    previous: match.previous,
    pos: match.pos - shift,
})

const stopHere = () => {
    hereToken++
    here.scanning = false
}

const scanHere = async () => {
    const mark = ++hereToken
    const worker = storageWorker
    const range = hereRange.value
    here.matches = []
    here.unreadable = 0
    hereTop = undefined
    hereDone = false
    hereFor = hereKey()
    if (!worker || !range) {
        here.scanning = false
        return
    }
    here.scanning = true
    const start = startOf(session.value.sessionId)
    let cursor: FindEditsCursor | undefined
    try {
        do {
            const page = await worker.call('findEdits', {
                ...start,
                ...range,
                ...(cursor ? { cursor } : {}),
            })
            if (mark !== hereToken) return
            hereTop ??= page.top
            if (page.matches.length)
                here.matches = [...here.matches, ...page.matches.map((match) => matchOf(match))]
            here.unreadable += page.unreadable
            cursor = page.cursor
        } while (cursor)
        hereDone = true
    } catch {
        // What was found stays; choosing Edits Here again scans afresh.
        hereFor = undefined
    } finally {
        if (mark === hereToken) here.scanning = false
    }
}

/** Entries stored since the scan began: checked down to where it started. */
const checkNewer = async () => {
    const worker = storageWorker
    const range = hereRange.value
    const until = hereTop
    if (!worker || !range || !until || here.scanning || historyFilter.value !== 'here') return
    const mark = hereToken
    const start = startOf(session.value.sessionId)
    const found: EditMatch[] = []
    let unreadable = 0
    let top: typeof hereTop
    let reached = 0
    let cursor: FindEditsCursor | undefined
    try {
        do {
            const page = await worker.call('findEdits', {
                ...start,
                ...range,
                until,
                ...(cursor ? { cursor } : {}),
            })
            if (mark !== hereToken) return
            top ??= page.top
            found.push(...page.matches)
            unreadable += page.unreadable
            reached = page.reached ?? reached
            cursor = page.cursor
        } while (cursor)
    } catch {
        return
    }
    if (top) hereTop = top
    // Places along the chain stay counted from the first scan's newest entry.
    if (found.length)
        here.matches = [...found.map((match) => matchOf(match, reached)), ...here.matches]
    here.unreadable += unreadable
}

/** Go To's pieces while filtering Edits Here: the matches found so far, by session and day. */
const piecesOf = (matches: readonly Entry[]): TimelinePiece[] => {
    const pieces: TimelinePiece[] = []
    const dayOf = (time: number) => new Date(time).setHours(0, 0, 0, 0)
    for (const entry of matches) {
        const last = pieces.at(-1)
        if (last?.sessionId === entry.sessionId && dayOf(last.oldest) === dayOf(entry.time)) {
            last.oldestSeq = entry.seq
            last.oldest = entry.time
            last.count++
        } else
            pieces.push({
                sessionId: entry.sessionId,
                newestSeq: entry.seq,
                oldestSeq: entry.seq,
                newest: entry.time,
                oldest: entry.time,
                count: 1,
            })
    }
    return pieces
}
