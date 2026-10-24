import { computed, onScopeDispose, ref, shallowReactive, shallowRef, watch } from 'vue'
import type { Zone } from '../../calendar/calendar'
import { composeGoTo } from '../../calendar/goTo'
import { piecesOf, type TimelinePiece } from '../../calendar/pieces'
import { onHistoryAction } from '../../history/actions'
import { captureEntryDescription } from '../../history/operations'
import { session } from '../../history/session'
import { toHex } from '../../local/hash'
import { storageWorker } from '../../local/start'
import { storedRead } from '../../local/storedRead'
import { flusher, onFlusherStart } from '../../local/storing'
import type { EditMatch, FindEditsCursor } from '../../local/worker/changeHandlers'
import type {
    PathStep,
    TimelineEntry,
    TimelineIndex,
    TimelinePage,
} from '../../local/worker/timelineHandlers'
import type { State } from '../../state'
import { historyCalendar } from './calendarClock'
import { createPlaces, singleFlight } from './hereChecks'
import { entryId, type Entry, type Filter } from './rows'
import { hereRange, historyFilter } from './state'

// The chain's entries for the Timeline (Part 1 §1.4.10.5): a page at a time from storage, newest
// first, with the open session's entries still waiting to be stored on top. After a jump (Go To,
// End) the loaded run is a window read at the target: older pages load below it as before, and
// newer ones into the gap between it and Now, until it reaches the newest entries again.

const PAGE = 100
/** Pages one refresh reads at most to join a burst of new entries to the loaded run. */
const MAX_BRIDGE_PAGES = 50

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
/** The oldest stored session continues one that is no longer stored: the Timeline ends there. */
export const earlierMissing = ref(false)
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
/** Bumped when a read lands in the loaded run (`refresh`, `recount`, `loadNewer`, `loadMore`). */
const landings = ref(0)
const replaceSource = () => {
    sourceGeneration.value++
    return ++epoch
}

const entryOf = (entry: TimelineEntry): Entry => ({
    sessionId: entry.sessionId,
    seq: entry.seq,
    time: entry.time,
    ...captureEntryDescription(entry),
    ...(entry.noteCount === undefined || entry.unreadable ? {} : { noteCount: entry.noteCount }),
    kept: entry.kept,
    ...(entry.damaged ? { damaged: true } : {}),
    ...(entry.unreadable ? { unreadable: entry.unreadable } : {}),
    ...(entry.device ? { device: entry.device } : {}),
    ...(entry.from === undefined ? {} : { from: entry.from }),
    ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
})

const notesIn = (state: State) => {
    let count = 0
    for (const notes of state.store.slides.note.values()) count += notes.length
    return count
}

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
            ...(entry.state ? { noteCount: notesIn(entry.state) } : {}),
            ...(entry.device ? { device: { id: entry.device.id, label: entry.device.label } } : {}),
            ...(entry.snapshot && !entry.state ? { snapshot: toHex(entry.snapshot) } : {}),
        }))
        .reverse()
}

/**
 * The open session's entries once shown as waiting, until a read returns them stored. The flusher
 * forgets an entry when it stores it, a moment before the next read: without these the list
 * would drop it for that moment.
 *
 * A carried entry keeps `pending: true` until a read returns it, so for up to about 1.3 s it says
 * "waiting" although it is stored. Only this file reads the flag, to give a continuation not read
 * yet its divider (`entries`); anything that shows "not stored yet" would have to use the
 * flusher's own list instead.
 */
const carried = new Map<string, Entry>()
let carriedFor: string | undefined

/** Every entry newest first: those waiting to be stored, then the stored ones; after a jump, the window. */
export const entries = computed((): Entry[] => {
    const read = loadedFor.value === session.value.sessionId ? stored.value : []
    if (newer.value) return [...read]
    const have = new Set(read.map(entryId))
    // What the flusher holds now joins what it held a moment ago, and what a read has returned,
    // or has passed, leaves. Only the computed's own memo changes, never a ref.
    const open = flusher?.session
    if (carriedFor !== open?.id) {
        carried.clear()
        carriedFor = open?.id
    }
    for (const entry of pendingEntries()) carried.set(entryId(entry), entry)
    const top = read.find((entry) => entry.sessionId === open?.id)?.seq ?? 0
    for (const [id, entry] of carried) if (have.has(id) || entry.seq < top) carried.delete(id)
    const waiting = [...carried.values()].sort((a, b) => b.seq - a.seq)
    const all = [...waiting, ...read]
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

/** Whether the loaded run reaches Now or is a window after a jump (spec-C invariant 11). */
const runState = computed(() => (isJumped() ? 'jumped' : 'joined'))

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
    landings.value++
    if (page.newer) newerCount.value = page.newer.count
    else {
        newer.value = undefined
        await refresh()
    }
}

/**
 * Where a fresh run, newest first, joins the entries loaded: the fresh run's oldest entry that is
 * loaded already, and its place among them. Undefined when none is.
 */
const joinOf = (fresh: readonly Entry[], loaded: readonly Entry[]) => {
    const places = new Map(loaded.map((entry, i) => [entryId(entry), i] as const))
    let found: { at: number; place: number } | undefined
    for (const [at, entry] of fresh.entries()) {
        const place = places.get(entryId(entry))
        if (place !== undefined) found = { at, place }
    }
    return found
}

/** Refreshes begun, and the last one that landed: an older one landing later is dropped. */
let started = 0
let landed = 0

/**
 * Reads the newest page again, keeping the older pages already loaded. With `replace` the loaded
 * run is dropped for the newest page (Now, Home after a jump).
 */
export const refresh = async ({ replace = false } = {}): Promise<void> => {
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
    const ticket = ++started
    const fresh: Entry[] = []
    let next: Cursor | undefined
    let missing: boolean
    try {
        const page = await worker.call('readTimeline', { ...startOf(id), limit: PAGE })
        fresh.push(...page.entries.map(entryOf))
        next = page.next
        missing = page.earlierMissing === true
        // More than a page can have come in since the last read (a held Undo key stores a burst
        // between two refreshes): read older pages until the run joins the loaded one, so the
        // older pages and the reader's place stay.
        for (let pages = 1; next && pages < MAX_BRIDGE_PAGES; pages++) {
            if (session.value.sessionId !== id || mark !== epoch || isJumped()) return
            if (replace || loadedFor.value !== id || !stored.value.length) break
            if (joinOf(fresh, stored.value)) break
            const older = await worker.call('readTimeline', { ...next, limit: PAGE })
            fresh.push(...older.entries.map(entryOf))
            next = older.next
            missing = older.earlierMissing === true
        }
    } catch {
        if (session.value.sessionId !== id || mark !== epoch || isJumped()) return
        if (loadedFor.value !== id) status.value = 'failed'
        return
    }
    // The session changed meanwhile: its own refresh follows. A jump replaced the run: it stays.
    // A refresh that began before one that has landed holds older entries: it is dropped.
    if (session.value.sessionId !== id || mark !== epoch || isJumped() || ticket < landed) return
    landed = ticket
    // The run joins the loaded one at the oldest fresh entry already loaded; its older pages follow.
    // A run that reached the chain's end is taken whole: a fork's parent chain may be gone since.
    const join =
        !replace && next && loadedFor.value === id ? joinOf(fresh, stored.value) : undefined
    if (join) {
        stored.value = [...fresh.slice(0, join.at + 1), ...stored.value.slice(join.place + 1)]
    } else {
        stored.value = fresh
        cursor = next
        earlierMissing.value = missing
    }
    loadedFor.value = id
    canLoadMore.value = !!cursor
    status.value = 'ready'
    landings.value++
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
            earlierMissing.value = page.earlierMissing === true
            canLoadMore.value = !!cursor
            landings.value++
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
            landings.value++
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

// --- The index Go To lists, read when it opens and again when the Timeline's entries move.

const SAVES = ['save', 'export'] as const
const indexes = new Map<string, Promise<TimelineIndex>>()

/** What a read landed: the index, with the filter and zone it was read for. */
type Landed = { index: TimelineIndex; filter: Filter; zone: Zone }
const indexLanded = shallowRef<Landed>()
let indexTicket = 0

/**
 * Names the Timeline entries an index read covers. In normal mode it is the newest stored entry of
 * the open session that is loaded (0 when none is), so a read is repeated when newer entries load.
 * After a jump the loaded run does not say what is stored: a read is repeated whenever the
 * Timeline's next read lands.
 */
export const goToStamp = () =>
    runState.value === 'joined'
        ? `t${stored.value.find((entry) => entry.sessionId === session.value.sessionId)?.seq ?? 0}`
        : `r${landings.value}`

/**
 * The chain's pieces, runs of a session's entries on one local day of `zone` (the History clock's):
 * saves and exports only while filtering.
 */
export const readIndex = (
    filter: Filter,
    zone: Zone = historyCalendar().zone,
): Promise<TimelineIndex> => {
    const open = session.value.sessionId
    if (filter === 'here')
        return Promise.resolve({
            pieces: piecesOf(here.matches, zone),
            path: [],
            topSession: open,
            importing: false,
        })
    const worker = storageWorker
    if (!worker)
        return Promise.resolve({ pieces: [], path: [], topSession: open, importing: false })
    const start = startOf(open)
    const key = `${start.sessionId}:${start.before ?? ''}:${filter}:${zone}:${goToStamp()}`
    let found = indexes.get(key)
    if (!found) {
        found = worker.call('readTimelineIndex', {
            ...start,
            zone,
            ...(filter === 'saves' ? { kinds: [...SAVES] } : {}),
        })
        indexes.set(key, found)
        // An index read while an import fills the path is read again next time Go To opens.
        found.then(
            (index) => index.importing && indexes.delete(key),
            () => indexes.delete(key),
        )
    }
    return found
}

/**
 * Reads Go To's index. With `keep` the list shown stays until the read lands; otherwise it is
 * dropped now. Edits Here's list is read once its scan is done. A read that lands is used whatever
 * has moved since: `goToPieces` adds the entries it does not cover.
 */
export const loadGoTo = async (filter: Filter, zone: Zone, keep: boolean) => {
    const mark = ++indexTicket
    if (!keep) indexLanded.value = undefined
    if (filter === 'here' && here.scanning) return
    const index = await readIndex(filter, zone)
    if (mark === indexTicket) indexLanded.value = { index, filter, zone }
}

/** Go To's pieces: the landed index with the Timeline's entries above what it covers. */
export const goToPieces = computed((): readonly TimelinePiece[] | undefined => {
    const at = indexLanded.value
    if (!at) return
    if (at.filter === 'here') return at.index.pieces
    // After a jump the loaded run is a window, so the open session's entries come from it and from
    // the flusher's waiting entries; spec-C invariant 11 deduplicates them.
    const listed =
        runState.value === 'jumped' ? [...pendingEntries(), ...stored.value] : entries.value
    return composeGoTo(
        listed,
        { ...at.index, zone: at.zone },
        session.value.sessionId,
        at.filter === 'saves' ? SAVES : undefined,
    )
})

/**
 * Replaces the loaded run with a window at the target: from it down, and a page above it, with
 * the gap between that page and Now. Resolves with the target's entry once it is shown.
 */
export const jumpTo = async (target: Target, filter: Filter): Promise<Entry | undefined> => {
    const id = session.value.sessionId
    // Edits Here holds all it has found: nothing is replaced, so no read in flight is dropped.
    if (filter === 'here')
        return here.matches.find(
            (entry) => entry.sessionId === target.sessionId && entry.seq === target.seq,
        )
    const mark = replaceSource()
    const worker = storageWorker
    if (!worker) return
    // An entry not stored yet is on the newest page: Go To lists it, and Now shows it.
    const open = flusher?.session
    if (open?.id === target.sessionId && open.pending.some((entry) => entry.seq === target.seq)) {
        await resetToNewest()
        return entries.value.find(
            (entry) => entry.sessionId === target.sessionId && entry.seq === target.seq,
        )
    }
    const { path } = await readIndex(filter)
    if (mark !== epoch || session.value.sessionId !== id || historyFilter.value !== filter) return
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
    if (mark !== epoch || session.value.sessionId !== id || historyFilter.value !== filter) return
    const window = [...above.entries, ...below.entries].map(entryOf)
    stored.value = window
    loadedFor.value = id
    cursor = below.next
    earlierMissing.value = below.earlierMissing === true
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
    if (mark !== epoch || session.value.sessionId !== id || historyFilter.value !== filter) return
    return window.find((entry) => entry.sessionId === target.sessionId && entry.seq === target.seq)
}

/** Jumps to the oldest entry of the chain (shown with the filter): End. */
export const jumpToOldest = async (filter: Filter) => {
    const id = session.value.sessionId
    const mark = replaceSource()
    const { pieces } = await readIndex(filter)
    if (mark !== epoch || session.value.sessionId !== id || historyFilter.value !== filter) return
    const oldest = pieces.at(-1)
    if (!oldest) return
    return jumpTo({ sessionId: oldest.sessionId, seq: oldest.oldestSeq }, filter)
}

/** Back to the newest entries after a jump: Now, Home. */
export const resetToNewest = async () => {
    const jumped = isJumped()
    replaceSource()
    newer.value = undefined
    newerCount.value = 0
    // After a jump the window is dropped for the newest page; without one, what is loaded stays.
    await refresh({ replace: jumped })
}

/** Entries waiting for the worker. */
const waiting = () => flusher?.session?.pending.length ?? 0

/**
 * The lists following the entries now (the docked panel's and the dialog's can both show). The
 * Edits Here scan, the loaded run and the stored entries are shared by all of them, so a list
 * going away stops the scan only when it was the last.
 */
let followers = 0

/**
 * Follows the undo stack while the panel is shown: reads at once, and about 1 s after each
 * change, when the flush has stored it. Call in a component's setup.
 */
export const followEntries = () => {
    followers++
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    // Set when the list goes away: a timer already running then neither reads nor re-arms.
    let disposed = false
    const follow = () => {
        if (disposed) return
        clearTimeout(timer)
        timer = setTimeout(async () => {
            const before = waiting()
            await refresh()
            if (disposed) return
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
            // A scan running for this range is shared, not started again.
            else if (hereFor === hereKey() && (hereDone || here.scanning)) void checkNewer()
            else void scanHere()
        },
        { immediate: true },
    )
    // Something changed what the Timeline lists: read the entries waiting now (they may be stored
    // before the next frame), and read the stored ones again soon.
    const changed = () => {
        indexes.clear()
        version.value++
        void entries.value
        follow()
    }
    const stop = onHistoryAction((action) => {
        if (action.kind === 'reset') {
            carried.clear()
            replaceSource()
            indexLanded.value = undefined
            stored.value = []
            cursor = undefined
            newer.value = undefined
            newerCount.value = 0
            loadedFor.value = undefined
            canLoadMore.value = false
            earlierMissing.value = false
            status.value = 'loading'
        }
        changed()
    })
    // Every entry joins the flusher's pending list, whether a history action made it or not (a
    // Save's entry does not): following that list cannot miss a kind of entry added later.
    // Storing may start after this list sets up: subscribe then, and read what is stored.
    let stopEntries: (() => void) | undefined
    const subscribe = () => {
        stopEntries?.()
        stopEntries = flusher?.onEntry(changed)
    }
    subscribe()
    const stopStart = flusher
        ? undefined
        : onFlusherStart(() => {
              subscribe()
              void refresh()
              changed()
          })
    watch(
        () => session.value.sessionId,
        () => {
            void refresh()
        },
    )
    onScopeDispose(() => {
        disposed = true
        stop()
        stopEntries?.()
        stopStart?.()
        clearTimeout(timer)
        // A scan stopped part way starts again when a list shows once more; while another list
        // shows, it goes on.
        if (--followers === 0 && here.scanning) {
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
    /** The scan, or the check of newer entries, could not be done: what is listed may be partial. */
    failed: false,
    /** Whether Try Again can help: not without a storage worker, where nothing can be searched. */
    canRetry: true,
})

let hereToken = 0
/** The range and chain the matches are for, and whether their scan reached the start. */
let hereFor: string | undefined
let hereDone = false
/** The newest entry checked: newer ones are checked on their own. */
let hereTop: { sessionId: string; seq: number } | undefined
/** Places along the chain for all the checks: the first scan's newest entry is place 0. */
const herePlaces = createPlaces()

const hereKey = () => {
    const range = hereRange.value
    return range && `${session.value.sessionId}|${range.from}|${range.to}`
}

const matchOf = (match: EditMatch, pos = match.pos): Entry => ({
    ...entryOf(match),
    previous: match.previous,
    pos,
})

const stopHere = () => {
    hereToken++
    here.scanning = false
}

/** Scans again after a failure: Try Again. */
export const retryHere = () => {
    hereFor = undefined
    void scanHere()
}

const scanHere = async () => {
    const mark = ++hereToken
    const worker = storageWorker
    const range = hereRange.value
    here.matches = []
    here.unreadable = 0
    here.failed = false
    here.canRetry = !!worker
    hereTop = undefined
    herePlaces.reset()
    hereDone = false
    hereFor = hereKey()
    if (!worker || !range) {
        here.scanning = false
        // Without storage nothing can be searched: that is not "no edits".
        here.failed = !worker && !!range
        return
    }
    here.scanning = true
    const start = startOf(session.value.sessionId)
    let cursor: FindEditsCursor | undefined
    // What was found stays, marked as partial; Try Again, or choosing Edits Here again, scans
    // afresh.
    const scanFailed = () => {
        if (mark === hereToken) {
            hereFor = undefined
            here.failed = true
        }
    }
    try {
        do {
            const read = await storedRead(worker, 'findEdits', {
                ...start,
                ...range,
                ...(cursor ? { cursor } : {}),
            })
            if (mark !== hereToken) return
            if (read.storedRead === 'failed') {
                scanFailed()
                return
            }
            const page = read.storedValue
            hereTop ??= page.top
            if (page.matches.length)
                here.matches = [...here.matches, ...page.matches.map((match) => matchOf(match))]
            here.unreadable += page.unreadable
            cursor = page.cursor
        } while (cursor)
        hereDone = true
        // Entries stored while the scan ran lie above its newest entry: check them now, as a
        // check during the scan returned without looking.
        here.scanning = false
        void checkNewer()
    } catch {
        // An error other than the read's own.
        scanFailed()
    } finally {
        if (mark === hereToken) here.scanning = false
    }
}

/**
 * Entries stored since the scan began: checked down to where it started. One check runs at a time,
 * for all the lists following (their timers and watches coincide); a request during a check runs
 * once more after it, so what was stored meanwhile is not missed. Every caller's promise covers
 * the checks it asked for.
 */
const checkNewer = singleFlight(() => checkNewerOnce())

const checkNewerOnce = async () => {
    const worker = storageWorker
    const range = hereRange.value
    // Absent when the scan found no entries at all: then every entry stored since is newer.
    const until = hereTop
    if (!worker || !range || here.scanning || !hereDone || historyFilter.value !== 'here') return
    const mark = hereToken
    const start = startOf(session.value.sessionId)
    const found: EditMatch[] = []
    let unreadable = 0
    let top: typeof hereTop
    let reached = 0
    let cursor: FindEditsCursor | undefined
    try {
        do {
            const read = await storedRead(worker, 'findEdits', {
                ...start,
                ...range,
                ...(until ? { until } : {}),
                ...(cursor ? { cursor } : {}),
            })
            if (mark !== hereToken) return
            if (read.storedRead === 'failed') {
                // The newest entries went unchecked: say so until a check succeeds.
                here.failed = true
                return
            }
            const page = read.storedValue
            top ??= page.top
            found.push(...page.matches)
            unreadable += page.unreadable
            reached = page.reached ?? reached
            cursor = page.cursor
        } while (cursor)
    } catch {
        // The newest entries went unchecked: say so until a check succeeds.
        if (mark === hereToken) here.failed = true
        return
    }
    here.failed = false
    // Places along the chain stay counted from the first scan's newest entry.
    const places = found.map((match) => herePlaces.of(match.pos, reached))
    if (top) {
        hereTop = top
        herePlaces.advance(reached)
    }
    const known = new Set(here.matches.map(entryId))
    const fresh = found
        .map((match, i) => matchOf(match, places[i]))
        .filter((entry) => !known.has(entryId(entry)))
    if (fresh.length) here.matches = [...fresh, ...here.matches]
    here.unreadable += unreadable
}
