import { slideRecord } from '../local/records/encode'
import { orderEvents, type EventKind } from '../local/records/extract'
import { headerRecord } from '../local/records/records'
import type { State } from '../state'
import type { EntityType } from '../state/entities'
import type { Store } from '../state/store'

// Whether two states hold the same chart: the same records in the same order, and the same header.
// An action whose result equals the chart it started from is no History step. The records are the
// stored chart (Part 1 §1.6.2), so equal records mean equal files, however the entities were
// rebuilt on the way. States along one undo stack share what an edit did not touch, so the check
// reads only the kinds and slides that differ by identity. The selection is not part of the chart.

/** The grid maps an event kind's order depends on: its joints and their connections. */
const gridTypes: Record<EventKind, readonly EntityType[]> = {
    bpms: ['bpm'],
    timeScales: ['timeScale'],
    cameraEvents: ['cameraEventJoint', 'cameraEventConnection'],
    stageMaskEvents: ['stageMaskEventJoint', 'stageMaskEventConnection'],
    stagePivotEvents: ['stagePivotEventJoint', 'stagePivotEventConnection'],
    stageStyleEvents: ['stageStyleEventJoint', 'stageStyleEventConnection'],
    stageTransformEvents: ['stageTransformEventJoint', 'stageTransformEventConnection'],
}

const eventKinds = Object.keys(gridTypes) as EventKind[]

const headerText = (state: State) =>
    JSON.stringify(
        headerRecord(state, {
            bgmOffset: state.bgm.offset,
            levelInfo: state.levelInfo,
            ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
        }),
    )

const sameHeader = (a: State, b: State) => {
    if (
        a.bgm.filename !== b.bgm.filename ||
        a.bgm.buffer !== b.bgm.buffer ||
        a.bgm.source !== b.bgm.source
    )
        return false
    if (
        a.initialLife === b.initialLife &&
        a.isDynamicStages === b.isDynamicStages &&
        a.bgm === b.bgm &&
        a.levelInfo === b.levelInfo &&
        a.groups === b.groups &&
        a.stages === b.stages &&
        a.groupFolders === b.groupFolders &&
        a.stageFolders === b.stageFolders
    )
        return true
    return headerText(a) === headerText(b)
}

/** Slides compare as a set: ids are not stored, and the file orders them by their records. */
const sameSlides = (a: Store['slides']['note'], b: Store['slides']['note']) => {
    if (a === b) return true
    const before: string[] = []
    const after: string[] = []
    for (const [id, notes] of a)
        if (b.get(id) !== notes && notes.length) before.push(JSON.stringify(slideRecord(notes)))
    for (const [id, notes] of b)
        if (a.get(id) !== notes && notes.length) after.push(JSON.stringify(slideRecord(notes)))
    if (before.length !== after.length) return false
    before.sort()
    after.sort()
    return before.every((text, i) => text === after[i])
}

/** An event kind compares in the order the file lists it, as same-beat order is state (D4). */
const sameEvents = (a: Store, b: Store, kind: EventKind) => {
    if (gridTypes[kind].every((type) => a.grid[type] === b.grid[type])) return true
    const before = orderEvents(a, kind)
    const after = orderEvents(b, kind)
    return (
        before.length === after.length &&
        before.every(({ record }, i) => JSON.stringify(record) === JSON.stringify(after[i]?.record))
    )
}

/**
 * Whether the two states hold the same chart. Anything it cannot decide counts as different, so
 * a step is never dropped on a doubt.
 */
export const sameChart = (a: State, b: State): boolean => {
    if (a === b) return true
    try {
        return (
            sameHeader(a, b) &&
            sameSlides(a.store.slides.note, b.store.slides.note) &&
            eventKinds.every((kind) => sameEvents(a.store, b.store, kind))
        )
    } catch {
        return false
    }
}
