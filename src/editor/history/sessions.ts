import { shallowRef } from 'vue'
import { dayKey } from '../../calendar/calendar'
import type { RecentChain, RecentReadable } from '../../local/recent'
import type { StoredRead } from '../../local/storedRead'
import type { Calendar } from './calendarClock'
import type { Header } from './rows'

// Recent Sessions' list (Part 1 §1.4.10.6): the rows built from the chains' read, and the read's
// refresh rules. Pure and light (Vue refs only), so Node tests run it without the page; the tab
// (`RecentSessionsTab.vue`) draws it and `sessionActions.ts` acts on it.

/** At most one badge: this tab's chain, or one whose head another tab or window holds. */
export type Badge = 'thisTab' | 'elsewhere'

/** A chain's row. */
export type ChainRow = {
    type: 'chain'
    /** The chain's id: a row is followed by it through every refresh. */
    id: string
    chain: RecentChain
    /** This tab's chain: the open session stands for it, and the row is Back to Now. */
    thisTab: boolean
    badge?: Badge
    /** `newer` and `damaged` rows are shown but can be neither peeked nor restored. */
    readable: RecentReadable
}

/** What the list holds: day headers and chain rows. Package C adds the inline Undo row here. */
export type SessionRow = ChainRow
export type ListRow = Header | SessionRow

export type ListContext = {
    calendar: Calendar
    /** The chain this tab has open, when it is stored. */
    thisChain: string | undefined
    /** Sessions another tab or window holds. */
    elsewhere: ReadonlySet<string>
    /** Rows a peek or Restore found unreadable since the read, by chain. */
    failed: ReadonlyMap<string, 'damaged' | 'newer'>
}

/** The rows, newest chain first under a day header for each day. */
export const buildRows = (chains: readonly RecentChain[], context: ListContext): ListRow[] => {
    const rows: ListRow[] = []
    let day: number | undefined
    for (const chain of chains) {
        const own = dayKey(chain.updatedAt, context.calendar.zone)
        if (own !== day) {
            day = own
            rows.push({
                type: 'header',
                id: `day:${own}`,
                level: 'day',
                withDay: false,
                time: chain.updatedAt,
                day: own,
            })
        }
        const thisTab = chain.chainId === context.thisChain
        const badge: Badge | undefined = thisTab
            ? 'thisTab'
            : context.elsewhere.has(chain.head.sessionId)
              ? 'elsewhere'
              : undefined
        rows.push({
            type: 'chain',
            id: chain.chainId,
            chain,
            thisTab,
            ...(badge ? { badge } : {}),
            readable:
                chain.readable === 'yes'
                    ? (context.failed.get(chain.chainId) ?? 'yes')
                    : chain.readable,
        })
    }
    return rows
}

/** Whether the row can be peeked: readable, and not this tab's own (that one is Back to Now). */
export const peekable = (row: SessionRow) => row.readable === 'yes' && !row.thisTab

/**
 * What Restore does for the row: `restore` continues the session (or forks when it must),
 * `copy` is Restore as a Copy, as `?safe` always does and a head held elsewhere needs. None for
 * this tab's row and for a row that cannot be opened.
 */
export const restoreMode = (row: SessionRow, safe: boolean): 'restore' | 'copy' | undefined => {
    if (row.thisTab || row.readable !== 'yes') return
    return safe || row.badge === 'elsewhere' ? 'copy' : 'restore'
}

export type ListStatus = 'loading' | 'ready' | 'failed'

export type RecentDeps = {
    /** The list's read, through `storedRead`. */
    read: () => Promise<StoredRead<RecentChain[]>>
    /** The sessions other tabs or windows hold; empty where that cannot be known. */
    elsewhere: () => Promise<ReadonlySet<string>>
}

/**
 * The list's data and its refresh. Rows hold still: while the pointer is over the list or focus
 * is in it, a refresh is kept until both leave, and applied whole then. The user's own action
 * (`now`) and the first read are not kept. A read that fails shows as failed only while there is
 * nothing to show; behind a list already shown it is dropped, and the next refresh tries again.
 */
export const createRecentList = (deps: RecentDeps) => {
    const status = shallowRef<ListStatus>('loading')
    const chains = shallowRef<readonly RecentChain[]>([])
    const elsewhere = shallowRef<ReadonlySet<string>>(new Set())
    const holds = new Set<string>()
    let deferred = false
    let disposed = false
    let latest = 0

    const load = async (now: boolean) => {
        const at = ++latest
        const [read, held] = await Promise.all([
            deps.read().catch((error: unknown): StoredRead<RecentChain[]> => ({
                storedRead: 'failed',
                storedError: error,
            })),
            deps.elsewhere().catch((): ReadonlySet<string> => new Set()),
        ])
        // A later read decides; a list closed meanwhile has no one to show it to.
        if (disposed || at !== latest) return
        if (read.storedRead === 'failed') {
            if (status.value !== 'ready') status.value = 'failed'
            return
        }
        // A pointer or focus arrived while it was read: it lands when they leave.
        if (!now && status.value === 'ready' && holds.size) {
            deferred = true
            return
        }
        chains.value = read.storedValue
        elsewhere.value = held
        status.value = 'ready'
    }

    /** Reads again. `now` applies the result at once, whatever holds the rows still. */
    const refresh = ({ now = false }: { now?: boolean } = {}) => {
        if (disposed) return Promise.resolve()
        if (!now && status.value === 'ready' && holds.size) {
            deferred = true
            return Promise.resolve()
        }
        deferred = false
        if (status.value === 'failed') status.value = 'loading'
        return load(now)
    }

    /** The pointer or focus (`source`) is on the list, or has left it. */
    const hold = (source: string, on: boolean) => {
        if (on) holds.add(source)
        else holds.delete(source)
        if (!holds.size && deferred) void refresh()
    }

    return {
        status,
        chains,
        elsewhere,
        refresh,
        hold,
        /** Whether a refresh is waiting for the list to be left alone. */
        deferred: () => deferred,
        dispose: () => {
            disposed = true
        },
    }
}

export type RecentList = ReturnType<typeof createRecentList>
