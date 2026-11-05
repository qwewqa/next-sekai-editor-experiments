import type { RecordValue } from '../records/canonical'
import { kindNames, type KindName } from '../records/schema'

// What a History entry changed: the records two snapshots differ in, as objects
// added, removed or changed. One core for the storage worker, which narrows the records by hash,
// and the page, which narrows them by identity: supersets give the same answer, as the shared
// records cancel in the multiset difference. A shared record whose place in its same-beat stack,
// or whose neighbour in its slide, changed is a change too.

type Rec = readonly RecordValue[]

/** Over this many changed objects the bar counts by kind and the arrows lose their counts. */
export const MARK_LIMIT = 150
/** A change past the limit covering this share of the objects is told in words alone. */
export const MOST_SHARE = 0.8
/** A removed and an added object pair as a move only within this many beats. */
export const MOVE_BEATS = 8
export const PAIR_BUDGET = 65_536

/** A kind's candidate records on each side; records on both sides cancel. */
export type KindCandidates = { kind: KindName; before: readonly Rec[]; after: readonly Rec[] }

export type DiffInput = { header: boolean; kinds: readonly KindCandidates[] }

/** The entry's objects: notes, and events of every kind. */
export type ChangeTotals = { notes: number; events: number }

export type ChangeStatus = 'added' | 'removed' | 'changed'

export type ChangedObject = {
    kind: KindName
    status: ChangeStatus
    /** Where it is: the entry's place, or a removed object's old one. */
    beat: number
    /** A note's left lane and size. */
    left?: number
    size?: number
    /** The entry's record; a removed object's old one. */
    record: Rec
    /** A changed object's old record. */
    from?: Rec
    /** The old slide a removed or changed note was in, for its ghost's artwork. */
    slide?: Rec
}

export type ChangeLayout = 'none' | 'small' | 'large' | 'most'

export type ChangeSet = {
    /** In chart order; in the `most` layout, unpaired additions/removals and moved shared ones. */
    objects: ChangedObject[]
    /** Objects changed per kind; in `most`, at least this many. */
    counts: Record<KindName, number>
    /** Whether the header differs: settings, level info, groups or stages. */
    header: boolean
    layout: ChangeLayout
}

/** The beats an entry changed, for Edits Here: changed objects' old and new beats, sorted. */
export type ChangeSummary = { beats: number[]; header: boolean }

const NOTE_BEAT = 2
const NOTE_LEFT = 8
const NOTE_SIZE = 9
const NOTE_FLICK = 11

const eventBeat: Record<KindName, number> = {
    slides: NOTE_BEAT,
    bpms: 0,
    timeScales: 1,
    cameraEvents: 0,
    stageMaskEvents: 1,
    stagePivotEvents: 1,
    stageStyleEvents: 1,
    stageTransformEvents: 1,
}

/** An event's track: its stage, a time scale's group, or the one track of BPMs and camera. */
const trackOf = (kind: KindName, record: Rec) =>
    kind === 'bpms' || kind === 'cameraEvents' ? 0 : (record[0] as number)

const textOf = (record: Rec) => JSON.stringify(record)

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

type Item = {
    kind: KindName
    record: Rec
    text: string
    beat: number
    lane: number
    slide?: Rec
    paired: boolean
}

const itemOf = (kind: KindName, record: Rec, text = textOf(record), slide?: Rec): Item => ({
    kind,
    record,
    text,
    beat: record[eventBeat[kind]] as number,
    lane: kind === 'slides' ? (record[NOTE_LEFT] as number) : 0,
    ...(slide ? { slide } : {}),
    paired: false,
})

const compareItems = (a: Item, b: Item) =>
    a.beat - b.beat || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)

/** The records only on one side, with their multiplicity: `[removed, added]`. */
const difference = <T>(
    before: readonly T[],
    after: readonly T[],
    text: (value: T) => string,
): [T[], T[]] => {
    const counts = new Map<string, T[]>()
    for (const value of before) {
        const key = text(value)
        const list = counts.get(key)
        if (list) list.push(value)
        else counts.set(key, [value])
    }
    const added: T[] = []
    for (const value of after) {
        const list = counts.get(text(value))
        if (list?.length) list.pop()
        else added.push(value)
    }
    const removed: T[] = []
    for (const list of counts.values()) removed.push(...list)
    return [removed, added]
}

type Entry = { record: Rec; text: string }

/** Per text, each side's first `min(before, after)` occurrences: the records on both sides. */
const commonOf = <T extends Entry>(before: readonly T[], after: readonly T[]): [T[], T[]] => {
    const countOf = (list: readonly T[]) => {
        const counts = new Map<string, number>()
        for (const { text } of list) counts.set(text, (counts.get(text) ?? 0) + 1)
        return counts
    }
    const keep = (list: readonly T[], other: Map<string, number>) =>
        list.filter(({ text }) => {
            const left = other.get(text) ?? 0
            if (left) other.set(text, left - 1)
            return left > 0
        })
    return [keep(before, countOf(after)), keep(after, countOf(before))]
}

/** Shared records whose place in their same-beat stack changed: the after side's. */
const restacked = (kind: KindName, before: readonly Entry[], after: readonly Entry[]) => {
    // Equal texts share a beat and a track, so a stack holds the same records on both sides.
    const stacksOf = (entries: readonly Entry[]) => {
        const stacks = new Map<string, Entry[]>()
        for (const entry of entries) {
            const key = `${trackOf(kind, entry.record)}|${String(entry.record[eventBeat[kind]])}`
            const stack = stacks.get(key)
            if (stack) stack.push(entry)
            else stacks.set(key, [entry])
        }
        return stacks
    }
    const [old, next] = commonOf(before, after)
    const was = stacksOf(old)
    const marked: Entry[] = []
    for (const [key, stack] of stacksOf(next))
        for (const [i, entry] of stack.entries())
            if (was.get(key)?.[i]?.text !== entry.text) marked.push(entry)
    return marked
}

type SlideNote = Entry & { slide: Rec }

/** Shared notes whose predecessor or successor in their slide changed: the after side's. */
const reconnected = (before: readonly SlideNote[][], after: readonly SlideNote[][]) => {
    const keyOf = (notes: readonly SlideNote[]) => notes.map(({ text }) => text).join('\n')
    const sequencesOf = (slides: readonly SlideNote[][]) =>
        slides
            .map((notes) => ({ key: keyOf(notes), notes }))
            .sort((a, b) => compareText(a.key, b.key))
    // Sorted first, so both paths keep the same occurrences of a note.
    const [oldShared, nextShared] = commonOf(
        sequencesOf(before).flatMap(({ notes }) => notes),
        sequencesOf(after).flatMap(({ notes }) => notes),
    )
    const sharedOf = (slides: readonly SlideNote[][], notes: readonly SlideNote[]) => {
        const shared = new Set(notes)
        return slides
            .map((slide) => slide.filter((note) => shared.has(note)))
            .filter((slide) => slide.length)
            .map((slide) => ({ key: keyOf(slide), notes: slide }))
    }
    // Equal sequences cancel; the k-th occurrence of a note before is its k-th after.
    // Identical notes on two slides can swap partners, and a mark finds any note with its record.
    const [gone, come] = difference(
        sharedOf(before, oldShared),
        sharedOf(after, nextShared),
        ({ key }) => key,
    )
    const linksOf = (sequences: { key: string; notes: readonly SlideNote[] }[]) => {
        sequences.sort((a, b) => compareText(a.key, b.key))
        const links = new Map<string, { note: SlideNote; link: string }[]>()
        for (const { notes } of sequences)
            for (const [i, note] of notes.entries()) {
                const link = `${notes[i - 1]?.text ?? ''}\n${notes[i + 1]?.text ?? ''}`
                const occurrences = links.get(note.text)
                if (occurrences) occurrences.push({ note, link })
                else links.set(note.text, [{ note, link }])
            }
        return links
    }
    const old = linksOf(gone)
    const marked: SlideNote[] = []
    for (const [text, occurrences] of linksOf(come))
        for (const [k, { note, link }] of occurrences.entries())
            if (old.get(text)?.[k]?.link !== link) marked.push(note)
    return marked
}

type Sides = { removed: Item[]; added: Item[]; reordered: Item[] }

/**
 * Each kind's removed and added objects, slides flattened to notes, which cancel again; and the
 * shared objects whose place in a stack or neighbours in a slide changed.
 */
const sidesOf = (input: DiffInput): Map<KindName, Sides> => {
    const sides = new Map<KindName, Sides>()
    for (const { kind, before, after } of input.kinds) {
        const side = sides.get(kind) ?? { removed: [], added: [], reordered: [] }
        sides.set(kind, side)
        if (kind === 'slides') {
            const [removed, added] = difference(before, after, textOf)
            const notesOf = (slides: Rec[]) =>
                slides.map((slide) =>
                    (slide as readonly Rec[]).map((record) => ({
                        record,
                        slide,
                        text: textOf(record),
                    })),
                )
            const old = notesOf(removed)
            const next = notesOf(added)
            const [gone, come] = difference(old.flat(), next.flat(), (note) => note.text)
            side.removed.push(...gone.map((n) => itemOf(kind, n.record, n.text, n.slide)))
            side.added.push(...come.map((n) => itemOf(kind, n.record, n.text)))
            for (const n of reconnected(old, next))
                side.reordered.push(itemOf(kind, n.record, n.text))
        } else {
            const entriesOf = (records: readonly Rec[]): Entry[] =>
                records.map((record) => ({ record, text: textOf(record) }))
            const old = entriesOf(before)
            const next = entriesOf(after)
            const [gone, come] = difference(old, next, (entry) => entry.text)
            side.removed.push(...gone.map((e) => itemOf(kind, e.record, e.text)))
            side.added.push(...come.map((e) => itemOf(kind, e.record, e.text)))
            for (const e of restacked(kind, old, next))
                side.reordered.push(itemOf(kind, e.record, e.text))
        }
    }
    for (const side of sides.values()) {
        side.removed.sort(compareItems)
        side.added.sort(compareItems)
    }
    return sides
}

/** The changed beats and whether the header differs: no pairing and no records kept. */
export const summarizeChanges = (input: DiffInput): ChangeSummary => {
    const beats = new Set<number>()
    for (const { removed, added, reordered } of sidesOf(input).values())
        for (const item of [...removed, ...added, ...reordered]) beats.add(item.beat)
    return { beats: [...beats].sort((a, b) => a - b), header: input.header }
}

/** Whether a summary's beats reach into `[from, to]`. */
export const touchesBeats = (beats: readonly number[], from: number, to: number) => {
    let low = 0
    let high = beats.length
    while (low < high) {
        const mid = (low + high) >> 1
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (beats[mid]! < from) low = mid + 1
        else high = mid
    }
    return low < beats.length && (beats[low] ?? Infinity) <= to
}

/** A record with some positions blanked: what two records share besides those. */
const shapeOf = (record: Rec, blank: readonly number[]) =>
    JSON.stringify(record.map((value, i) => (blank.includes(i) ? null : value)))

type Pair = { removed: Item; added: Item }

const pairWhere = (sides: Sides, key: (item: Item) => string | undefined, pairs: Pair[]) => {
    const groups = new Map<string, Item[]>()
    for (const item of sides.added) {
        if (item.paired) continue
        const k = key(item)
        if (k === undefined) continue
        const list = groups.get(k)
        if (list) list.push(item)
        else groups.set(k, [item])
    }
    for (const removed of sides.removed) {
        if (removed.paired) continue
        const k = key(removed)
        const list = k === undefined ? undefined : groups.get(k)
        const added = list?.find((item) => !item.paired)
        if (!added) continue
        removed.paired = added.paired = true
        pairs.push({ removed, added })
    }
}

const flipped: Record<string, string> = {
    upLeft: 'upRight',
    upRight: 'upLeft',
    downLeft: 'downRight',
    downRight: 'downLeft',
}

/** Notes a flip mirrored: the same beat and size, mirrored about lane 0, flick mirrored too. */
const pairMirrored = (sides: Sides, pairs: Pair[]) => {
    const blank = [NOTE_LEFT, NOTE_FLICK]
    const groups = new Map<string, Item[]>()
    for (const item of sides.added) {
        if (item.paired) continue
        const k = shapeOf(item.record, blank)
        const list = groups.get(k)
        if (list) list.push(item)
        else groups.set(k, [item])
    }
    for (const removed of sides.removed) {
        if (removed.paired) continue
        const left = removed.record[NOTE_LEFT] as number
        const size = removed.record[NOTE_SIZE] as number
        const flick = removed.record[NOTE_FLICK] as string
        const mirror = -(left + size)
        const added = groups
            .get(shapeOf(removed.record, blank))
            ?.find(
                (item) =>
                    !item.paired &&
                    Math.abs((item.record[NOTE_LEFT] as number) - mirror) < 1e-6 &&
                    item.record[NOTE_FLICK] === (flipped[flick] ?? flick),
            )
        if (!added) continue
        removed.paired = added.paired = true
        pairs.push({ removed, added })
    }
}

/** Moves: the same record but its place, the nearest within `MOVE_BEATS`, closest first. */
const pairNearest = (sides: Sides, blank: readonly number[], pairs: Pair[]) => {
    const groups = new Map<string, { removed: Item[]; added: Item[] }>()
    const groupOf = (item: Item) => {
        const k = shapeOf(item.record, blank)
        let group = groups.get(k)
        if (!group) groups.set(k, (group = { removed: [], added: [] }))
        return group
    }
    for (const item of sides.removed) if (!item.paired) groupOf(item).removed.push(item)
    for (const item of sides.added) if (!item.paired) groupOf(item).added.push(item)
    const candidates: { removed: Item; added: Item; beats: number; lanes: number; at: number }[] =
        []
    for (const group of groups.values()) {
        if (!group.removed.length || !group.added.length) continue
        // Both sorted by beat: a window over the added ones.
        let start = 0
        for (const removed of group.removed) {
            while (
                start < group.added.length &&
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                group.added[start]!.beat < removed.beat - MOVE_BEATS
            )
                start++
            for (let i = start; i < group.added.length; i++) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const added = group.added[i]!
                if (added.beat > removed.beat + MOVE_BEATS) break
                candidates.push({
                    removed,
                    added,
                    beats: Math.abs(added.beat - removed.beat),
                    lanes: Math.abs(added.lane - removed.lane),
                    at: candidates.length,
                })
            }
        }
    }
    candidates.sort((a, b) => a.beats - b.beats || a.lanes - b.lanes || a.at - b.at)
    for (const { removed, added } of candidates) {
        if (removed.paired || added.paired) continue
        removed.paired = added.paired = true
        pairs.push({ removed, added })
    }
}

const objectOf = (item: Item, status: ChangeStatus, from?: Item): ChangedObject => ({
    kind: item.kind,
    status,
    ...placeOf(item.kind, item.record),
    record: item.record,
    ...(from ? { from: from.record } : {}),
    ...(from?.slide ? { slide: from.slide } : item.slide ? { slide: item.slide } : {}),
})

const emptyCounts = (): Record<KindName, number> =>
    Object.fromEntries(kindNames.map((kind) => [kind, 0])) as Record<KindName, number>

const kindOrder = new Map(kindNames.map((kind, i) => [kind, i]))

/** Chart order: by beat, kind and lane, then by record, so equal inputs sort alike. */
const compareObjects = (a: ChangedObject, b: ChangedObject) =>
    a.beat - b.beat ||
    (kindOrder.get(a.kind) ?? 0) - (kindOrder.get(b.kind) ?? 0) ||
    (a.left ?? 0) - (b.left ?? 0) ||
    compareText(a.status, b.status) ||
    compareText(textOf(a.record), textOf(b.record))

/**
 * What changed from the candidates' before to their after. Pairing makes one changed object of
 * a removed and an added one: in place, a flip's mirror, then the nearest move. A change past
 * `MARK_LIMIT` covering `MOST_SHARE` of `totals` skips pairing: it is told in words alone.
 */
export const diffChanges = (input: DiffInput, totals?: ChangeTotals): ChangeSet => {
    const sides = sidesOf(input)
    const counts = emptyCounts()
    let least = 0
    for (const [kind, side] of sides) {
        counts[kind] = Math.max(side.removed.length, side.added.length)
        least += counts[kind]
    }
    const total = totals ? totals.notes + totals.events : 0
    if (
        (least > MARK_LIMIT && total > 0 && least >= MOST_SHARE * total) ||
        [...sides.values()].reduce(
            (sum, side) => sum + side.removed.length * side.added.length,
            0,
        ) > PAIR_BUDGET
    ) {
        const objects: ChangedObject[] = []
        for (const [kind, side] of sides) {
            objects.push(
                ...side.removed.map((item) => objectOf(item, 'removed')),
                ...side.added.map((item) => objectOf(item, 'added')),
                ...side.reordered.map((item) => objectOf(item, 'changed', item)),
            )
            counts[kind] = side.removed.length + side.added.length + side.reordered.length
        }
        objects.sort(compareObjects)
        return { objects, counts, header: input.header, layout: 'most' }
    }

    const objects: ChangedObject[] = []
    for (const [kind, side] of sides) {
        const pairs: Pair[] = []
        if (kind === 'slides') {
            pairWhere(
                side,
                (item) =>
                    `${item.beat}|${String(item.record[NOTE_LEFT])}|${String(item.record[NOTE_SIZE])}`,
                pairs,
            )
            pairMirrored(side, pairs)
            pairNearest(side, [NOTE_BEAT, NOTE_LEFT, NOTE_SIZE, NOTE_FLICK], pairs)
        } else {
            pairWhere(side, (item) => `${trackOf(kind, item.record)}|${item.beat}`, pairs)
            pairNearest(side, [eventBeat[kind]], pairs)
        }
        for (const { removed, added } of pairs) objects.push(objectOf(added, 'changed', removed))
        for (const item of side.removed) if (!item.paired) objects.push(objectOf(item, 'removed'))
        for (const item of side.added) if (!item.paired) objects.push(objectOf(item, 'added'))
        for (const item of side.reordered) objects.push(objectOf(item, 'changed', item))
        counts[kind] =
            side.removed.length + side.added.length - pairs.length + side.reordered.length
    }
    objects.sort(compareObjects)
    const layout = !objects.length ? 'none' : objects.length > MARK_LIMIT ? 'large' : 'small'
    return { objects, counts, header: input.header, layout }
}

/** Whether a changed object's place differs from its old one: a move, which leaves a ghost. */
export const isMoved = (object: ChangedObject) => {
    if (!object.from) return false
    const before = placeOf(object.kind, object.from)
    const after = placeOf(object.kind, object.record)
    return (
        before.beat !== after.beat ||
        before.left !== after.left ||
        before.size !== after.size ||
        trackOf(object.kind, object.from) !== trackOf(object.kind, object.record) ||
        (object.kind === 'slides' && object.from[1] !== object.record[1])
    )
}

/** Where an old record was: its beat, and a note's left lane and size. */
export const placeOf = (kind: KindName, record: Rec) => {
    const lane =
        kind === 'slides'
            ? NOTE_LEFT
            : kind === 'cameraEvents'
              ? 1
              : kind === 'stageTransformEvents'
                ? 3
                : 2
    return {
        beat: record[eventBeat[kind]] as number,
        left: kind === 'bpms' ? 6.1 : (record[lane] as number),
        size:
            kind === 'slides'
                ? (record[NOTE_SIZE] as number)
                : kind === 'cameraEvents'
                  ? (record[2] as number)
                  : kind === 'stageMaskEvents'
                    ? (record[3] as number)
                    : 0,
    }
}
