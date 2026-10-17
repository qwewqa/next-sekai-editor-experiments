import type { LevelDataEntity } from '@sonolus/core'

// D4's oracle: the order in which level data plays its events, BPMs and time-scale changes, read
// from the raw entities as the engine reads them (events and time scales along `next` from their
// track's first ref, BPMs in entity order), with no editor code. Values are what the engine and
// the editor read of each event, defaults filled, so two spellings of one event compare equal.

type Values = Record<string, number>

export type PlayEvent = { beat: number; values: Values }

/** Every track's events in play order: `bpm`, `camera`, `<kind>:<stage index>`, `timeScale:<group index>`. */
export type PlayOrder = {
    tracks: Map<string, PlayEvent[]>
    /** Events and time-scale changes no chain reaches, which the engine never plays. */
    unreached: number
    /** Tracks whose chain goes back in beat, which the engine refuses or misplays. */
    unsorted: string[]
}

const valueOf = (entity: LevelDataEntity, name: string) => {
    const data = entity.data.find((data) => data.name === name)
    return data && 'value' in data ? data.value : undefined
}

const refOf = (entity: LevelDataEntity, name: string) => {
    const data = entity.data.find((data) => data.name === name)
    return data && 'ref' in data ? data.ref : undefined
}

const reader = (entity: LevelDataEntity) => ({
    v: (name: string, fallback?: number) => {
        const value = valueOf(entity, name) ?? fallback
        if (value === undefined) throw new Error(`${entity.archetype} has no ${name}`)
        return value
    },
    flag: (name: string) => +!!valueOf(entity, name),
})

const decoders: Record<string, (entity: LevelDataEntity) => Values> = {
    '#BPM_CHANGE': (e) => {
        const { v } = reader(e)
        return { bpm: v('#BPM'), meter: v('meter', 4) }
    },
    '#TIMESCALE_CHANGE': (e) => {
        const { v, flag } = reader(e)
        return {
            editorLane: v('editorLane', -6),
            timeScale: v('#TIMESCALE'),
            skip: v('#TIMESCALE_SKIP'),
            ease: v('#TIMESCALE_EASE'),
            transitionStyle: v('transitionStyle', 0),
            hideNotes: flag('hideNotes'),
        }
    },
    CameraChange: (e) => {
        const { v } = reader(e)
        return {
            lane: v('lane'),
            size: v('size'),
            zoom: v('zoom', 1),
            zoomTargetLane: v('zoomTargetLane', 0),
            zoomTargetY: v('zoomTargetY', 0),
            zoomVerticalAlign: v('zoomVerticalAlign', 0),
            rotate: v('rotate', 0),
            stageTilt: v('stageTilt', 1),
            ease: v('ease'),
        }
    },
    StageMaskChange: (e) => {
        const { v, flag } = reader(e)
        return { lane: v('lane'), size: v('size'), maskNotes: flag('maskNotes'), ease: v('ease') }
    },
    StagePivotChange: (e) => {
        const { v } = reader(e)
        return {
            lane: v('lane'),
            divisionSize: v('divisionSize'),
            divisionParity: v('divisionParity'),
            yOffset: v('yOffset'),
            yBeatOffset: v('yBeatOffset'),
            ease: v('ease'),
        }
    },
    StageStyleChange: (e) => {
        const { v, flag } = reader(e)
        const alpha = v('alpha', 1)
        return {
            editorLane: v('editorLane', 0),
            judgeLineColor: v('judgeLineColor'),
            judgeLineStyle: v('judgeLineStyle', 0),
            leftBorderStyle: v('leftBorderStyle'),
            rightBorderStyle: v('rightBorderStyle'),
            fullWidth: flag('fullWidth'),
            noteAlpha: v('noteAlpha', 1),
            laneAlpha: v('laneAlpha') * alpha,
            judgeLineAlpha: v('judgeLineAlpha') * alpha,
            divisionLineAlpha: v('divisionLineAlpha', 1),
            ease: v('ease'),
        }
    },
    StageTransformChange: (e) => {
        const { v } = reader(e)
        return {
            rotate: v('rotate'),
            xLaneTranslate: v('xLaneTranslate'),
            yLaneTranslate: v('yLaneTranslate'),
            elevation: v('elevation', 0),
            anchor: v('anchor'),
            ease: v('ease'),
        }
    },
}

const playEvent = (entity: LevelDataEntity): PlayEvent => {
    const decode = decoders[entity.archetype]
    if (!decode) throw new Error(`No decoder for ${entity.archetype}`)
    return { beat: reader(entity).v('#BEAT'), values: decode(entity) }
}

const stageChains = [
    ['mask', 'firstMaskChange', 'StageMaskChange'],
    ['pivot', 'firstPivotChange', 'StagePivotChange'],
    ['style', 'firstStyleChange', 'StageStyleChange'],
    ['transform', 'firstTransformChange', 'StageTransformChange'],
] as const

/** The play order of level data's entities (D4). */
export const playOrder = (entities: readonly LevelDataEntity[]): PlayOrder => {
    const byName = new Map<string, LevelDataEntity>()
    for (const entity of entities) if (entity.name !== undefined) byName.set(entity.name, entity)

    const tracks = new Map<string, PlayEvent[]>()
    const reached = new Set<LevelDataEntity>()
    const unsorted: string[] = []
    const walk = (key: string, first: string | undefined, archetype: string) => {
        const events: PlayEvent[] = []
        for (let ref = first; ref !== undefined;) {
            const entity = byName.get(ref)
            if (!entity || entity.archetype !== archetype || reached.has(entity)) break
            reached.add(entity)
            events.push(playEvent(entity))
            ref = refOf(entity, 'next')
        }
        if (events.some((event, i) => i > 0 && event.beat < (events[i - 1]?.beat ?? 0)))
            unsorted.push(key)
        if (events.length) tracks.set(key, events)
    }

    const bpms = entities.filter((entity) => entity.archetype === '#BPM_CHANGE').map(playEvent)
    if (bpms.length) tracks.set('bpm', bpms)

    const initialization = entities[0]
    if (initialization?.archetype === 'Initialization')
        walk('camera', refOf(initialization, 'firstCamera'), 'CameraChange')

    for (const [index, stage] of entities
        .filter((entity) => entity.archetype === 'Stage')
        .entries())
        for (const [kind, first, archetype] of stageChains)
            walk(`${kind}:${index}`, refOf(stage, first), archetype)

    for (const [index, group] of entities
        .filter((entity) => entity.archetype === '#TIMESCALE_GROUP')
        .entries())
        walk(`timeScale:${index}`, refOf(group, 'first'), '#TIMESCALE_CHANGE')

    const unreached = entities.filter(
        (entity) =>
            entity.archetype !== '#BPM_CHANGE' &&
            entity.archetype in decoders &&
            !reached.has(entity),
    ).length

    return { tracks, unreached, unsorted }
}

/** A track's beats that hold two or more events, each with its events in play order. */
export const sameBeatGroups = (events: readonly PlayEvent[]) => {
    const groups = new Map<number, PlayEvent[]>()
    for (const event of events) {
        const group = groups.get(event.beat)
        if (group) group.push(event)
        else groups.set(event.beat, [event])
    }
    return [...groups].filter(([, group]) => group.length > 1)
}

/** Every track's same-beat groups, as `[track, beat, events]`. */
export const allSameBeatGroups = ({ tracks }: PlayOrder) =>
    [...tracks].flatMap(([track, events]) =>
        sameBeatGroups(events).map(([beat, group]) => [track, beat, group] as const),
    )

/** Same-beat groups by kind (`bpm`, `camera`, `mask`, …, `timeScale`). */
export const sameBeatCounts = (order: PlayOrder) => {
    const counts: Record<string, number> = {}
    for (const [track] of allSameBeatGroups(order)) {
        const kind = track.split(':')[0] ?? track
        counts[kind] = (counts[kind] ?? 0) + 1
    }
    return counts
}

// Lane and size are written back from the editor's left and size, so they may differ by rounding.
const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

const sameEvent = (a: PlayEvent, b: PlayEvent) =>
    a.beat === b.beat &&
    Object.keys(a.values).length === Object.keys(b.values).length &&
    Object.entries(a.values).every(([name, value]) => {
        const other = b.values[name]
        return other !== undefined && close(value, other)
    })

const text = (events: readonly PlayEvent[]) =>
    events.map((event) => JSON.stringify(event.values)).join(' ')

/**
 * Where two play orders differ in a same-beat group: a track's groups must hold the same events
 * in the same order. With `whole`, every track's events must match one for one, in play order.
 */
export const playOrderDifferences = (a: PlayOrder, b: PlayOrder, { whole = false } = {}) => {
    const differences: string[] = []
    for (const track of new Set([...a.tracks.keys(), ...b.tracks.keys()])) {
        const before = a.tracks.get(track) ?? []
        const after = b.tracks.get(track) ?? []
        if (whole) {
            if (
                before.length !== after.length ||
                before.some((event, i) => !sameEvent(event, after[i] ?? { beat: NaN, values: {} }))
            )
                differences.push(`${track}: the track differs`)
            continue
        }
        const groupsAfter = new Map(sameBeatGroups(after))
        const groupsBefore = sameBeatGroups(before)
        if (groupsBefore.length !== groupsAfter.size)
            differences.push(
                `${track}: ${groupsBefore.length} same-beat groups, then ${groupsAfter.size}`,
            )
        for (const [beat, group] of groupsBefore) {
            const other = groupsAfter.get(beat) ?? []
            if (
                group.length !== other.length ||
                group.some((event, i) => !sameEvent(event, other[i]!))
            )
                differences.push(`${track} at beat ${beat}: ${text(group)} became ${text(other)}`)
        }
    }
    return differences
}
