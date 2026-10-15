import type { PreviewChart, PreviewNote } from './model'
import { createTimeIndex, queryTimeIndex, type TimeIndex } from './timeIndex'

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

type IndexedItem<T> = { item: T; index: number }
type GroupTimeIndex<T> = Map<number, TimeIndex<IndexedItem<T>>>

// A special group must not disable lookahead for the rest of the chart. An
// attached note or connector can depend on several groups; index it under each
// endpoint group, then union the candidates without changing submission order.
const createGroupTimeIndex = <T>(
    items: T[],
    groups: (item: T) => number[],
    start: (item: T) => number,
    end: (item: T) => number,
): GroupTimeIndex<T> => {
    const partitions = new Map<number, IndexedItem<T>[]>()
    items.forEach((item, index) => {
        const entry = { item, index }
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
        [...partitions].map(([group, entries]) => [
            group,
            createTimeIndex(
                entries,
                ({ item }) => start(item),
                ({ item }) => end(item),
            ),
        ]),
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
            ).map(({ item }) => item)

    const matches = new Set<IndexedItem<T>>()
    for (const [group, partition] of index) {
        for (const { item } of queryTimeIndex(
            partition,
            now,
            latestTargets[group] ?? fallbackLatestTarget,
            leftLimit,
            false,
        )) {
            matches.add(item)
        }
    }
    return [...matches].sort((a, b) => a.index - b.index)
}

const createFrameIndex = (chart: PreviewChart) => {
    const minimumTimescales = chart.groups.map((group) => {
        let minimumTimescale = 1
        for (const change of group.changes) {
            // Scroll, reversals, stops and backwards skips need the full future
            // range: target time alone cannot bound their visual position.
            if (change.transitionStyle === 1 || change.skipSeconds < 0 || !(change.timescale > 0)) {
                return 0
            }
            minimumTimescale = Math.min(minimumTimescale, change.timescale)
        }
        return minimumTimescale
    })
    return {
        minimumTimescales,
        notes: createGroupTimeIndex(
            chart.notes,
            progressGroups,
            earliestTarget,
            (note) => note.targetTime,
        ),
        effects: createTimeIndex(
            chart.notes,
            (note) => note.targetTime,
            (note) => note.targetTime + MAX_HIT_EFFECT_DURATION,
        ),
        connectors: createGroupTimeIndex(
            chart.connectors,
            ({ head, tail }) => [...progressGroups(head), ...progressGroups(tail)],
            (connector) => Math.min(earliestTarget(connector.head), earliestTarget(connector.tail)),
            (connector) =>
                Math.min(
                    Math.max(connector.head.targetTime, connector.tail.targetTime) +
                        (connector.throughJudgeLine
                            ? CONNECTOR_THROUGH_JUDGE_LINE_DESPAWN_DELAY
                            : 0),
                    connector.activeTail?.targetTime ?? Infinity,
                ),
        ),
        simLines: createGroupTimeIndex(
            chart.simLines,
            ({ left, right }) => [...progressGroups(left), ...progressGroups(right)],
            ({ left, right }) => Math.min(earliestTarget(left), earliestTarget(right)),
            ({ left, right }) => Math.min(left.targetTime, right.targetTime),
        ),
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

export const latestVisibleTarget = (
    now: number,
    minimumTimescale: number,
    maximumPreempt: number,
    progressStart: number,
    minimumYOffset: number,
) => {
    if (minimumTimescale <= 0 || !Number.isFinite(maximumPreempt)) return Infinity
    const distance = maximumPreempt * Math.max(0, 1 - progressStart - minimumYOffset)
    // noteDistance clamps its result, so that clamp is not an upper time bound.
    if (distance >= 1e20) return Infinity
    return now + distance / minimumTimescale + 1e-7
}
