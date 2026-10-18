// The Timeline's rows from a chain's entries (Part 1 §1.4.10.5): flags, ×N groups, dividers and
// minute or day headers. Pure, so Node tests run it without the page.

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
    /** Dropped from the redo branch: undo and redo cannot reach it. */
    notInUndo: boolean
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
    | { type: 'now'; id: 'now' }
    | EntryRow
    | { type: 'divider'; id: string; entry: Entry }
    | { type: 'header'; id: string; level: 'day' | 'minute'; time: number }

const PUSHES = ['edit', 'restore']

/**
 * Which entries are dropped from the redo branch, by the entries newest first. A push at a stack
 * position is dropped when a later push began at or below it; positions are counted from the
 * newest entry's, which is all that matters. A recovered entry replaces the stack, so entries
 * before it are left unflagged.
 */
export const droppedEntries = (newestFirst: readonly Entry[]) => {
    const dropped = new Set<string>()
    let index = 0
    let cut = Infinity
    for (const entry of newestFirst) {
        if (entry.kind === 'recovered') break
        if (entry.kind === 'undo') index++
        else if (entry.kind === 'redo') index--
        else if (PUSHES.includes(entry.kind)) {
            if (index >= cut) dropped.add(entryId(entry))
            cut = Math.min(cut, index)
            index--
        }
    }
    return dropped
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

const minuteOf = (time: number) => Math.floor(time / 60_000)

/** Entries that collapse into a ×N group when next to each other: the same label, or a run of undo or redo. */
const groupKey = (entry: Entry, flags: Flags) => {
    const flag = `${flags.notInUndo ? 1 : 0}${flags.removed ? 1 : 0}${flags.damaged ? 1 : 0}`
    if (entry.kind === 'undo' || entry.kind === 'redo') return `${entry.kind}:${flag}`
    if (entry.kind === 'edit') return `edit:${flag}:${entry.label}`
}

export type BuildOptions = {
    filter: Filter
    /** The groups shown open, by their newest entry's id. */
    expanded: ReadonlySet<string>
    /** Entries found unreadable when loaded, by id. */
    damaged: ReadonlySet<string>
}

/** The rows to show for a chain's entries, newest first. */
export const buildRows = (
    newestFirst: readonly Entry[],
    { filter, expanded, damaged }: BuildOptions,
): Row[] => {
    const dropped = droppedEntries(newestFirst)
    const flagsOf = (entry: Entry): Flags => ({
        notInUndo: dropped.has(entryId(entry)),
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
                    delta: delta ? delta : undefined,
                    child: true,
                    selectable: !memberFlags.removed && !memberFlags.damaged,
                })
            }
    }

    // Headers: a minute's, and a day's once the timeline spans days.
    const times = shown.map((entry) => entry.time)
    const spansDays = times.length > 1 && !sameDay(Math.max(...times), Math.min(...times)) // eslint-disable-line
    const rows: Row[] = [{ type: 'now', id: 'now' }]
    let previous: Entry | undefined
    for (const item of items) {
        const { time } = item.entry
        if (item.type === 'entry' && item.child) {
            rows.push(item)
            continue
        }
        if (spansDays && (!previous || !sameDay(previous.time, time)))
            rows.push({
                type: 'header',
                id: `day:${new Date(time).toDateString()}`,
                level: 'day',
                time,
            })
        if (item.type === 'entry' && (!previous || minuteOf(previous.time) !== minuteOf(time)))
            rows.push({ type: 'header', id: `minute:${minuteOf(time)}`, level: 'minute', time })
        rows.push(item)
        previous = item.entry
    }
    return rows
}

/** Rows that can hold the cursor, in order: Now, entries not removed or damaged. */
export const selectableRows = (rows: readonly Row[]) =>
    rows.filter((row) => row.type === 'now' || (row.type === 'entry' && row.selectable))
