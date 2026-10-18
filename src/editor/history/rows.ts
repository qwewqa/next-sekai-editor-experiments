// The Timeline's rows from a chain's entries (Part 1 §1.4.10.5): flags, ×N groups, dividers and
// minute, hour or day headers by age. Pure, so Node tests run it without the page.

/** One entry as the Timeline reads it, from storage or still waiting to be stored. */
export type Entry = {
    sessionId: string
    seq: number
    /** When it was made, in ms. */
    time: number
    kind: string
    label: string
    /** Absent while the entry is only in memory. */
    noteCount?: number
    /** False for a snapshot removed to save space (§1.6.8). */
    kept: boolean
    /** A `continue` entry's time of the entry it continues, for its divider. */
    from?: number
    /** A save's device, when the revision came from another one (§1.3.7). */
    device?: { id: string; name?: string }
    pending?: boolean
}

export const entryId = (entry: Pick<Entry, 'sessionId' | 'seq'>) =>
    `${entry.sessionId}:${entry.seq}`

export type Filter = 'all' | 'saves'

export type Flags = {
    removed: boolean
    damaged: boolean
}

export type EntryRow = {
    type: 'entry'
    id: string
    /** The newest entry of the row; a group's others are `members`. */
    entry: Entry
    /** Every entry a ×N group holds, newest first (one for a plain row). */
    members: Entry[]
    flags: Flags
    /** The change in notes the row made, when known and not zero. */
    delta: number | undefined
    /** An entry shown under its expanded group. */
    child: boolean
    /** Whether it can be peeked: not removed, not damaged. */
    selectable: boolean
}

export type Row =
    { type: 'now'; id: 'now' } | EntryRow | { type: 'divider'; id: string; entry: Entry } | Header

/**
 * A label for the rows under it: a minute (this hour), an hour (earlier today, and the days just
 * before), or a day (older). The hour of a new recent day shares its row with the day.
 */
export type Header = {
    type: 'header'
    id: string
    level: 'minute' | 'hour' | 'day'
    /** An hour or minute that also names its day: "Yesterday · 9 PM". A day header names itself. */
    withDay: boolean
    /** A time in what it labels. */
    time: number
}

const minuteOf = (time: number) => Math.floor(time / 60_000)

const hourStart = (time: number) => new Date(time).setMinutes(0, 0, 0)

const dayStart = (time: number) => new Date(time).setHours(0, 0, 0, 0)

/** Whole local days from `time` to `now`. */
const daysBefore = (time: number, now: number) =>
    Math.round((dayStart(now) - dayStart(time)) / 86_400_000)

/** The days before today that still get hour headers (Part 1 §1.4.10.5). */
const HOUR_DAYS = 6

/** The finest header an entry's age earns, and the key of the span it labels. */
const tierOf = (time: number, now: number) => {
    const ago = daysBefore(time, now)
    if (ago > HOUR_DAYS) return { level: 'day' as const, key: `d:${dayStart(time)}` }
    if (ago <= 0 && hourStart(time) === hourStart(now))
        return { level: 'minute' as const, key: `m:${minuteOf(time)}` }
    return { level: 'hour' as const, key: `h:${hourStart(time)}` }
}

/** Entries that collapse into a ×N group when next to each other: the same label, or a run of undo or redo. */
const groupKey = (entry: Entry, flags: Flags) => {
    const flag = `${flags.removed ? 1 : 0}${flags.damaged ? 1 : 0}`
    if (entry.kind === 'undo' || entry.kind === 'redo') return `${entry.kind}:${flag}`
    if (entry.kind === 'edit') return `edit:${flag}:${entry.label}`
}

export type BuildOptions = {
    filter: Filter
    /** The groups shown open, by their newest entry's id. */
    expanded: ReadonlySet<string>
    /** Entries found unreadable when loaded, by id. */
    damaged: ReadonlySet<string>
    /** The clock the headers' ages are measured against. */
    now?: number
}

/** The rows to show for a chain's entries, newest first. */
export const buildRows = (
    newestFirst: readonly Entry[],
    { filter, expanded, damaged, now = Date.now() }: BuildOptions,
): Row[] => {
    const flagsOf = (entry: Entry): Flags => ({
        removed: !entry.kept && !damaged.has(entryId(entry)),
        damaged: damaged.has(entryId(entry)),
    })
    // The change each entry made: its notes against the next older entry's.
    const deltas = new Map<string, number>()
    for (const [i, entry] of newestFirst.entries()) {
        const older = newestFirst[i + 1]
        if (
            entry.noteCount !== undefined &&
            older?.noteCount !== undefined &&
            entry.kind !== 'continue' &&
            entry.kind !== 'init'
        )
            deltas.set(entryId(entry), entry.noteCount - older.noteCount)
    }

    const items: (EntryRow | { type: 'divider'; id: string; entry: Entry })[] = []
    const shown = newestFirst.filter(
        (entry) =>
            entry.kind === 'continue' ||
            filter === 'all' ||
            entry.kind === 'save' ||
            entry.kind === 'export',
    )
    for (let i = 0; i < shown.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const entry = shown[i]!
        if (entry.kind === 'continue') {
            items.push({ type: 'divider', id: entryId(entry), entry })
            continue
        }
        const flags = flagsOf(entry)
        const key = filter === 'all' ? groupKey(entry, flags) : undefined
        const members = [entry]
        while (key !== undefined) {
            const next = shown[i + 1]
            if (!next || groupKey(next, flagsOf(next)) !== key) break
            members.push(next)
            i++
        }
        const sum = members.reduce((total, member) => total + (deltas.get(entryId(member)) ?? 0), 0)
        const known = members.some((member) => deltas.has(entryId(member)))
        const row: EntryRow = {
            type: 'entry',
            id: entryId(entry),
            entry,
            members,
            flags,
            delta: known && sum !== 0 ? sum : undefined,
            child: false,
            selectable: !flags.removed && !flags.damaged,
        }
        items.push(row)
        if (members.length > 1 && expanded.has(row.id))
            for (const member of members) {
                const memberFlags = flagsOf(member)
                const delta = deltas.get(entryId(member))
                items.push({
                    ...row,
                    id: `${row.id}/${entryId(member)}`,
                    entry: member,
                    members: [member],
                    flags: memberFlags,
                    delta: delta === 0 ? undefined : delta,
                    child: true,
                    selectable: !memberFlags.removed && !memberFlags.damaged,
                })
            }
    }

    const rows: Row[] = [{ type: 'now', id: 'now' }]
    let previous: Entry | undefined
    let previousKey: string | undefined
    for (const item of items) {
        const { time } = item.entry
        if (item.type === 'entry' && item.child) {
            rows.push(item)
            continue
        }
        if (item.type === 'entry') {
            const { level, key } = tierOf(time, now)
            if (key !== previousKey) {
                // A day not yet named, past today, names itself with its first hour or minute.
                const newDay = !previous || dayStart(previous.time) !== dayStart(time)
                const withDay = level !== 'day' && newDay && daysBefore(time, now) > 0
                const id = withDay ? `${key}|${dayStart(time)}` : key
                rows.push({ type: 'header', id, level, withDay, time })
            }
            previousKey = key
            previous = item.entry
        }
        rows.push(item)
    }
    return rows
}

/** Rows that can hold the cursor, in order: Now, entries not removed or damaged. */
export const selectableRows = (rows: readonly Row[]) =>
    rows.filter((row) => row.type === 'now' || (row.type === 'entry' && row.selectable))
