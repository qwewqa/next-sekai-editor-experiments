import {
    dayKey,
    daysBetween,
    hourKey,
    minuteKey,
    spanKey,
    type DayKey,
} from '../../calendar/calendar'
import { decodeOperation, operationGroup, type EntryDescription } from '../../history/operations'
import type { Calendar } from './calendarClock'

// The Timeline's rows from a chain's entries (Part 1 §1.4.10.5): flags, ×N groups, dividers and
// minute, hour or day headers by age. Pure, so Node tests run it without the page.

/** One entry as the Timeline reads it, from storage or still waiting to be stored. */
export type Entry = EntryDescription & {
    sessionId: string
    seq: number
    /** When it was made, in ms. */
    time: number
    /** Absent while the entry is only in memory. */
    noteCount?: number
    /** False for a snapshot not kept (§1.6.8). */
    kept: boolean
    /** A `kept: false` entry whose snapshot reaches a part found bad: it reads damaged (§1.4.10.5). */
    damaged?: boolean
    /** Stored but not decodable: a newer build's (`newer`) or malformed (`damaged`); unavailable. */
    unreadable?: 'newer' | 'damaged'
    /** A `continue` entry's time of the entry it continues, for its divider. */
    from?: number
    /** A save's device, as stored (§1.3.3): named on its row when it is not this browser's. */
    device?: { id: string; label: string }
    pending?: boolean
    /** Its snapshot's root, as hex, once stored. */
    snapshot?: string
    /** Edits Here's match: the entry it was compared with, and its place along the chain. */
    previous?: { sessionId: string; seq: number; snapshot: string }
    pos?: number
}

export const entryId = (entry: Pick<Entry, 'sessionId' | 'seq'>) =>
    `${entry.sessionId}:${entry.seq}`

/** All, Saves and Exports, or Edits Here: the entries that changed a range of beats. */
export type Filter = 'all' | 'saves' | 'here'

export type Flags = {
    removed: boolean
    damaged: boolean
    /** Written by a newer version: unavailable, and never called damaged. */
    newer?: boolean
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
    partial?: boolean
}

/** After a jump: the entries between Now and the loaded window, not read yet. */
export type GapRow = { type: 'gap'; id: 'gap'; count: number }

export type Row =
    | { type: 'now'; id: 'now' }
    | GapRow
    | EntryRow
    | { type: 'divider'; id: string; entry: Entry }
    | Header

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
    /** The local day of that time, in the calendar's zone. */
    day: DayKey
}

/** The days before today that still get hour headers (Part 1 §1.4.10.5). */
const HOUR_DAYS = 6

/** The finest header an entry's age earns, and the key of the span it labels. */
const tierOf = (time: number, cal: Calendar, nowHour: number) => {
    const day = dayKey(time, cal.zone)
    const ago = daysBetween(day, cal.today)
    if (ago > HOUR_DAYS) return { level: 'day' as const, key: `d:${day}`, day }
    const hour = hourKey(time, cal.zone)
    if (ago <= 0 && hour === nowHour)
        return { level: 'minute' as const, key: `m:${minuteKey(time, cal.zone)}`, day }
    return { level: 'hour' as const, key: `h:${hour}`, day }
}

/** Supported semantic keys; availability and chronology are independent boundaries. */
const groupKey = (entry: Entry, flags: Flags) => {
    const flag = `${flags.removed ? 1 : 0}${flags.damaged ? 1 : 0}${flags.newer ? 1 : 0}`
    if (entry.kind === 'undo' || entry.kind === 'redo') return `${entry.kind}:${flag}`
    if (entry.kind !== 'edit') return
    const decoded = decodeOperation(entry.step.operation)
    if (decoded.status !== 'known') return
    const descriptor = operationGroup(decoded.operation)
    if (descriptor) return `edit:${flag}:${descriptor.key}`
}

export type BuildOptions = {
    filter: Filter
    /** The groups shown open, by their newest entry's id. */
    expanded: ReadonlySet<string>
    /** Entries found unreadable when loaded, by id. */
    damaged: ReadonlySet<string>
    /** Entries a newer version wrote, by id: unavailable, not damaged. */
    newer?: ReadonlySet<string>
    /** Entries a peek or Restore found removed, by id, though they were read as kept. */
    removed?: ReadonlySet<string>
    /** The History clock the headers' ages and zone come from. */
    calendar: Calendar
    /** After a jump: how many entries lie between Now and the first one given. */
    gap?: number
    more?: boolean
    pinned?: readonly string[]
}

/** The rows to show for a chain's entries, newest first. */
export const buildRows = (
    newestFirst: readonly Entry[],
    { filter, expanded, damaged, newer, removed, calendar, gap, more, pinned }: BuildOptions,
): Row[] => {
    // A `kept: false` entry is damaged when the worker found its snapshot reaching a bad part, or
    // when a peek or Restore of it failed in this tab; else it was not kept.
    // An entry a newer version wrote is neither: it is unavailable, and never called damaged.
    const flagsOf = (entry: Entry): Flags => {
        const isNewer = newer?.has(entryId(entry)) === true || entry.unreadable === 'newer'
        const gone = !entry.kept || removed?.has(entryId(entry)) === true
        const bad =
            !isNewer &&
            (damaged.has(entryId(entry)) ||
                entry.unreadable === 'damaged' ||
                (!entry.kept && entry.damaged === true))
        return {
            removed: gone && !bad && !isNewer,
            damaged: bad,
            ...(isNewer ? { newer: true } : {}),
        }
    }
    // The notes in an entry's state. An undo or redo not stored yet holds only the root it lands
    // on, whose count the entry that made that state has.
    const counts = new Map<string, number>()
    // An entry that cannot be read has no known count: it takes no part in a delta.
    for (const entry of newestFirst)
        if (entry.snapshot && entry.noteCount !== undefined && !entry.unreadable)
            counts.set(entry.snapshot, entry.noteCount)
    const noteCountOf = (entry: Entry) =>
        entry.unreadable
            ? undefined
            : (entry.noteCount ?? (entry.snapshot ? counts.get(entry.snapshot) : undefined))
    // The change each entry made: its notes against the next older entry's, which Edits Here's
    // matches are not.
    const deltas = new Map<string, number>()
    for (const [i, entry] of filter === 'here' ? [] : newestFirst.entries()) {
        const now = noteCountOf(entry)
        const older = newestFirst[i + 1]
        const before = older && noteCountOf(older)
        if (
            now !== undefined &&
            before !== undefined &&
            entry.kind !== 'continue' &&
            entry.kind !== 'init'
        )
            deltas.set(entryId(entry), now - before)
    }

    const items: (EntryRow | { type: 'divider'; id: string; entry: Entry })[] = []
    const shown = newestFirst.filter(
        (entry) =>
            entry.kind === 'continue' ||
            filter !== 'saves' ||
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
        const key = filter === 'saves' ? undefined : groupKey(entry, flags)
        const members = [entry]
        while (key !== undefined) {
            const next = shown[i + 1]
            if (!next || groupKey(next, flagsOf(next)) !== key) break
            if (next.sessionId !== entry.sessionId) break
            if (pinned?.includes(entryId(next)) !== pinned?.includes(entryId(entry))) break
            // X-1: a ×N row never crosses a local day or hour (`spanKey`), so it sits under the header
            // of its own day and hour, and Go To's days, which count each entry by its own day, agree
            // with the headers. It does not depend on the clock, so a row's members never change as
            // it ages. Minute headers in the current hour may be crossed.
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            if (spanKey(next.time, calendar.zone) !== spanKey(members.at(-1)!.time, calendar.zone))
                break
            // Edits Here collapses only matches next to each other on the chain.
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            if (filter === 'here' && next.pos !== members.at(-1)!.pos! + 1) break
            members.push(next)
            i++
        }
        const sum = members.reduce((total, member) => total + (deltas.get(entryId(member)) ?? 0), 0)
        const known = members.every((member) => deltas.has(entryId(member)))
        const row: EntryRow = {
            type: 'entry',
            id: entryId(entry),
            entry,
            members,
            flags,
            delta: known && sum !== 0 ? sum : undefined,
            child: false,
            selectable: !flags.removed && !flags.damaged && !flags.newer,
            partial: !!(key && more && i === shown.length - 1),
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
                    partial: false,
                    selectable: !memberFlags.removed && !memberFlags.damaged && !memberFlags.newer,
                })
            }
    }

    const rows: Row[] = [{ type: 'now', id: 'now' }]
    if (gap !== undefined) rows.push({ type: 'gap', id: 'gap', count: gap })
    let previous: Entry | undefined
    let previousKey: string | undefined
    let previousDay: DayKey | undefined
    const nowHour = hourKey(calendar.now, calendar.zone)
    const headerIds = new Set<string>()
    for (const item of items) {
        const { time } = item.entry
        if (item.type === 'entry' && item.child) {
            rows.push(item)
            continue
        }
        if (item.type === 'entry') {
            const { level, key, day } = tierOf(time, calendar, nowHour)
            if (key !== previousKey) {
                // Every new day names itself with its first hour or minute, except a today that
                // opens the list.
                const newDay = previousDay !== day
                const withDay =
                    level !== 'day' && newDay && (day !== calendar.today || previous !== undefined)
                const named = withDay ? `${key}|${day}` : key
                // Headers follow adjacency, so a span whose entries come back out of time order
                // (an imported file's clock, or a clock that was corrected) shows its header again.
                // The first keeps the plain id, and a repeat takes its first entry's, so every key
                // in the list is unique.
                const id = headerIds.has(named) ? `${named}@${item.id}` : named
                headerIds.add(id)
                rows.push({ type: 'header', id, level, withDay, time, day })
            }
            previousKey = key
            previousDay = day
            previous = item.entry
        }
        rows.push(item)
    }
    return rows
}

/** The entry an entry is compared with: Edits Here's, else the next older one loaded. */
export const previousOf = (newestFirst: readonly Entry[], entry: Entry) => {
    if (entry.previous) return entry.previous
    const at = newestFirst.findIndex(
        (other) => other.sessionId === entry.sessionId && other.seq === entry.seq,
    )
    return at === -1 ? undefined : newestFirst[at + 1]
}

/** Rows that can hold the cursor, in order: Now, entries not removed or damaged. */
export const selectableRows = (rows: readonly Row[]) =>
    rows.filter((row) => row.type === 'now' || (row.type === 'entry' && row.selectable))
