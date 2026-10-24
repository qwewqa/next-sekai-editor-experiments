import type { PreviewChart, PreviewNote } from './model'
import {
    createTimeIndex,
    createTimeIndexOfEntries,
    queryTimeIndex,
    type TimeIndex,
    type TimeIndexEntry,
} from './timeIndex'

export const CONNECTOR_THROUGH_JUDGE_LINE_DESPAWN_DELAY = 5
export const SLIDE_EFFECT_DESPAWN_DELAY = 0.6
export const MAX_HIT_EFFECT_DURATION = 1

// Attached notes interpolate their endpoints' progress. Either endpoint can
// bring them into view well before the attached note's own approach window.
const earliestTarget = (note: PreviewNote) =>
    note.isAttached && note.attachHead && note.attachTail
        ? Math.min(note.targetTime, note.attachHead.targetTime, note.attachTail.targetTime)
        : note.targetTime

const progressGroups = (note: PreviewNote) =>
    note.isAttached && note.attachHead && note.attachTail
        ? [note.attachHead.groupIndex, note.attachTail.groupIndex]
        : [note.groupIndex]

type GroupTimeIndex<T> = Map<number, TimeIndex<T>>

// A special group must not disable lookahead for the rest of the chart. An
// attached note or connector can depend on several groups; index it under each
// endpoint group, then union the candidates without changing submission order.
// Each item has one entry, shared by its groups' partitions, whose `index` is the
// item's position in the chart.
const createGroupTimeIndex = <T>(
    items: T[],
    groups: (item: T) => number[],
    start: (item: T) => number,
    end: (item: T) => number,
): GroupTimeIndex<T> => {
    const partitions = new Map<number, TimeIndexEntry<T>[]>()
    items.forEach((item, index) => {
        const entry: TimeIndexEntry<T> = { item, index, start: start(item), end: end(item) }
        for (const group of groups(item)) {
            let partition = partitions.get(group)
            if (!partition) {
                partition = []
                partitions.set(group, partition)
            }
            // All of this item's endpoint groups are processed together. A
            // repeated group already has this entry last, so no per-item Set
            // is needed when rebuilding the indexes after an edit.
            if (partition[partition.length - 1] !== entry) partition.push(entry)
        }
    })
    return new Map(
        [...partitions].map(([group, entries]) => [group, createTimeIndexOfEntries(entries)]),
    )
}

export const queryGroupTimeIndex = <T>(
    index: GroupTimeIndex<T>,
    now: number,
    latestTargets: readonly number[],
    fallbackLatestTarget = Infinity,
    leftLimit = false,
) => {
    // Partition insertion order follows global input order. A single group
    // cannot duplicate an entry, so the time index already gives the final order.
    if (index.size === 1)
        for (const [group, partition] of index)
            return queryTimeIndex(
                partition,
                now,
                latestTargets[group] ?? fallbackLatestTarget,
                leftLimit,
            )

    // An entry indexed under several groups is the same object in each, so
    // equal neighbours after the index sort are its repeats.
    const matches: TimeIndexEntry<T>[] = []
    for (const [group, partition] of index) {
        for (const entry of queryTimeIndex(
            partition,
            now,
            latestTargets[group] ?? fallbackLatestTarget,
            leftLimit,
            false,
        )) {
            matches.push(entry)
        }
    }
    matches.sort((a, b) => a.index - b.index)
    return matches.filter((entry, position) => entry !== matches[position - 1])
}

const createFrameIndex = (chart: PreviewChart) => {
    const notes = createGroupTimeIndex(
        chart.notes,
        progressGroups,
        earliestTarget,
        (note) => note.targetTime,
    )
    const connectors = createGroupTimeIndex(
        chart.connectors,
        ({ head, tail }) => [...progressGroups(head), ...progressGroups(tail)],
        (connector) => Math.min(earliestTarget(connector.head), earliestTarget(connector.tail)),
        (connector) =>
            Math.min(
                Math.max(connector.head.targetTime, connector.tail.targetTime) +
                    (connector.throughJudgeLine ? CONNECTOR_THROUGH_JUDGE_LINE_DESPAWN_DELAY : 0),
                connector.activeTail?.targetTime ?? Infinity,
            ),
    )
    const simLines = createGroupTimeIndex(
        chart.simLines,
        ({ left, right }) => [...progressGroups(left), ...progressGroups(right)],
        ({ left, right }) => Math.min(earliestTarget(left), earliestTarget(right)),
        ({ left, right }) => Math.min(left.targetTime, right.targetTime),
    )
    return {
        // Groups whose bound a frame needs; tests clear `cull` to traverse every future entry.
        usedGroups: [...new Set([...notes.keys(), ...connectors.keys(), ...simLines.keys()])],
        cull: true,
        notes,
        effects: createTimeIndex(
            chart.notes,
            (note) => note.targetTime,
            (note) => note.targetTime + MAX_HIT_EFFECT_DURATION,
        ),
        connectors,
        simLines,
        slides: createTimeIndex(
            chart.slides,
            (slide) => slide.activeHead.targetTime,
            (slide) => slide.activeTail.targetTime + SLIDE_EFFECT_DESPAWN_DELAY,
        ),
    }
}

type CachedFrameIndex = {
    groups: PreviewChart['groups']
    connectors: PreviewChart['connectors']
    simLines: PreviewChart['simLines']
    slides: PreviewChart['slides']
    index: ReturnType<typeof createFrameIndex>
}

// Stage and camera edits retain the note arrays. Their transforms affect the
// per-frame query bounds, not these chart-time intervals. Weak keys allow old
// note graphs and drag snapshots to be collected rather than retaining history.
const sharedIndexes = new WeakMap<PreviewChart['notes'], CachedFrameIndex>()
const indexes = new WeakMap<PreviewChart, ReturnType<typeof createFrameIndex>>()

export const getFrameIndex = (chart: PreviewChart) => {
    const retained = indexes.get(chart)
    if (retained) return retained

    const cached = sharedIndexes.get(chart.notes)
    if (
        cached?.groups === chart.groups &&
        cached.connectors === chart.connectors &&
        cached.simLines === chart.simLines &&
        cached.slides === chart.slides
    ) {
        indexes.set(chart, cached.index)
        return cached.index
    }

    const index = createFrameIndex(chart)
    sharedIndexes.set(chart.notes, {
        groups: chart.groups,
        connectors: chart.connectors,
        simLines: chart.simLines,
        slides: chart.slides,
        index,
    })
    indexes.set(chart, index)
    return index
}

// The farthest a note can be from the judge line and still be in view: its
// approach window, extended by the lowest stage offset.
export const visibleDistance = (preempt: number, progressStart: number, minimumYOffset: number) =>
    preempt * Math.max(0, 1 - progressStart - minimumYOffset)
