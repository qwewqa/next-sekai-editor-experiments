import { computed, shallowRef, watch } from 'vue'
import { isPeeking } from '../../history'
import {
    entryKey,
    loadEntryState,
    parseEntryKey,
    peekedKey,
    type EntryKey,
} from '../../history/peek'
import { peek } from '../../history/stack'
import { i18n } from '../../i18n'
import { languageTag } from '../../i18n/plural'
import {
    MARK_LIMIT,
    diffChanges,
    isMoved,
    type ChangeSet,
    type ChangeTotals,
    type ChangedObject,
} from '../../local/changes/diff'
import { joints, stateCandidates, totalsOf } from '../../local/changes/states'
import type { RecordValue } from '../../local/records/canonical'
import { entitiesOf } from '../../local/records/extract'
import { noteObject, noteRecord } from '../../local/records/records'
import type { KindName } from '../../local/records/schema'
import { storageWorker } from '../../local/start'
import { settings } from '../../settings'
import { createState, type State } from '../../state'
import type { Entity, EntityType } from '../../state/entities'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime } from '../../state/integrals/bpms'
import { time } from '../../time'
import { interpolateRaw } from '../../utils/interpolate'
import { view } from '../view'
import {
    countOff,
    nearestStop,
    nextStop,
    stopToward,
    stopsOf,
    type Place,
    type Stop,
} from './changeStops'
import { peekedInfo, type PeekedInfo } from './selection'

// The change view (Part 1 §1.4.11): what the peeked entry changed against the entry before it on
// the Timeline, from the worker by roots, or diffed here from states in memory for entries not
// stored yet. The chart never scrolls on its own: the bar counts, the edge arrows and Show Change
// bring the changes into view when asked.

type Rec = readonly RecordValue[]

/** The peeked entry's change, once known, with the state it was diffed for. */
export type ChangeView = { key: EntryKey; set: ChangeSet; totals: ChangeTotals; state: State }

export const peekChange = shallowRef<ChangeView>()

/** The entry whose change is settled: known, or found unknown. */
const settledKey = shallowRef<EntryKey>()

let generation = 0

/** The entry before one on the chain, when the list didn't have it loaded. */
const previousOf = async (key: EntryKey) => {
    const worker = storageWorker
    if (!worker) return
    const { sessionId, seq } = parseEntryKey(key)
    const page = await worker.call('readTimeline', { sessionId, before: seq, limit: 1 })
    const entry = page.entries[0]
    return entry && { key: entryKey(entry.sessionId, entry.seq), snapshot: entry.snapshot }
}

const compute = async (info: PeekedInfo): Promise<ChangeView | undefined> => {
    const after = await loadEntryState(info.key)
    const totals = totalsOf(after)
    const previous = info.previous ?? (await previousOf(info.key))
    // The chain's first entry has nothing before it.
    if (!previous) return
    let set: ChangeSet | undefined
    const worker = storageWorker
    if (info.snapshot && previous.snapshot && worker) {
        set = await worker.call('readChanges', {
            before: previous.snapshot,
            after: info.snapshot,
            totals,
        })
    } else {
        // Not stored yet: both states are in memory, sharing what the edit left untouched.
        const before = await loadEntryState(previous.key)
        set = diffChanges(stateCandidates(before, after), totals)
    }
    return set && { key: info.key, set, totals, state: after }
}

watch(
    peekedInfo,
    (info) => {
        const at = ++generation
        peekChange.value = undefined
        if (!info) return
        compute(info).then(
            (result) => {
                if (at !== generation) return
                peekChange.value = result
                settledKey.value = info.key
            },
            () => {
                // Unknown: the label alone, nothing drawn.
                if (at === generation) settledKey.value = info.key
            },
        )
    },
    { immediate: true },
)

/** The change while the peeked state is the one it was diffed for. */
export const shownChange = computed(() => {
    const change = peekChange.value
    if (!change || !isPeeking.value || peekedKey.value !== change.key) return
    if (peek.value?.state.store !== change.state.store) return
    return change
})

// --- What the bar says.

const count = (value: number) => new Intl.NumberFormat(languageTag(settings.locale)).format(value)

const eventKinds: KindName[] = [
    'cameraEvents',
    'stageMaskEvents',
    'stagePivotEvents',
    'stageStyleEvents',
    'stageTransformEvents',
]

const eventCount = (counts: Record<KindName, number>) =>
    eventKinds.reduce((sum, kind) => sum + counts[kind], 0)

/** "8 changes", "Changed 282 notes · 10 events", "Changed 1,684 of 1,945 notes", "No changes". */
export const changeText = (change: Pick<ChangeView, 'set' | 'totals'>) => {
    const strings = i18n.value.peek
    const { set, totals } = change
    if (set.layout === 'none') return set.header ? undefined : strings.noChanges
    if (set.layout === 'small')
        return interpolateRaw(strings.changeCount, count(set.objects.length))
    const fragments: string[] = []
    const { counts } = set
    const events = eventCount(counts) + counts.bpms + counts.timeScales
    if (set.layout === 'most') {
        if (counts.slides)
            fragments.push(
                interpolateRaw(strings.notesOf, count(counts.slides), count(totals.notes)),
            )
        if (events)
            fragments.push(interpolateRaw(strings.eventsOf, count(events), count(totals.events)))
    } else {
        if (counts.slides) fragments.push(interpolateRaw(strings.notes, count(counts.slides)))
        if (counts.bpms) fragments.push(interpolateRaw(strings.bpms, count(counts.bpms)))
        if (counts.timeScales)
            fragments.push(interpolateRaw(strings.timeScales, count(counts.timeScales)))
        const others = eventCount(counts)
        if (others) fragments.push(interpolateRaw(strings.events, count(others)))
    }
    return interpolateRaw(strings.changedLarge, fragments.join(' · '))
}

/** The bar's second line; undefined while loading, when unknown, or for a header-only change. */
export const changeLine = computed(() => {
    const change = shownChange.value
    return change && changeText(change)
})

/** Whether the change has objects to draw and bring into view. */
export const hasPlaces = computed(() => {
    const layout = shownChange.value?.set.layout
    return layout === 'small' || layout === 'large'
})

// --- Marks on the chart: the peeked state's entities that changed, and ghosts of the old ones.

type EventType = EntityType

export type ChangeMarks = {
    /** Drawn at full strength while the rest dims: changed objects, their connectors. */
    changed: ReadonlySet<Entity>
    /** Rings: changed and added objects; added ones get a `+`. */
    rings: { entity: Entity; added: boolean }[]
    /** Old notes: removed ones (`−`) and where moved ones were. */
    ghosts: { entity: NoteEntity; removed: boolean }[]
    /** The state ghosts are drawn through: the old slides, on the peeked tempo. */
    ghostState?: State
    /** Removed events: dashed lines at their beats. */
    ghostLines: { beat: number; kind: KindName }[]
}

const textOf = (record: Rec) => JSON.stringify(record)

const jointOf = joints as Record<KindName, [EventType, (entity: never) => Rec] | undefined>

/** The entity of a record in a state: the first not yet taken at its beat. */
const findEntity = (
    target: State,
    kind: KindName,
    record: Rec,
    beat: number,
    taken: Set<Entity>,
): Entity | undefined => {
    const text = textOf(record)
    if (kind === 'slides') {
        for (const entity of target.store.grid.note.get(Math.floor(beat)) ?? [])
            if (!taken.has(entity) && textOf(noteRecord(entity)) === text) return entity
        return
    }
    const joint = jointOf[kind]
    if (!joint) return
    const [type, encode] = joint
    for (const entity of target.store.grid[type].get(Math.floor(beat)) ?? [])
        if (!taken.has(entity) && textOf(encode(entity as never)) === text) return entity
}

/** The old slides of removed and moved notes, on the peeked state's tempo and header. */
const ghostStateOf = (shown: State, slides: Rec[]) =>
    createState(
        {
            initialLife: shown.initialLife,
            isDynamicStages: shown.isDynamicStages,
            bpms: entitiesOf(shown.store.grid.bpm).map(({ beat, bpm, meter }) => ({
                beat,
                bpm,
                meter,
            })),
            groups: shown.groups,
            stages: shown.stages,
            groupFolders: shown.groupFolders,
            stageFolders: shown.stageFolders,
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
            slides: slides.map((slide) => (slide as readonly Rec[]).map(noteObject)),
        },
        0,
    )

const connectionTypes: Partial<Record<EntityType, EntityType>> = {
    cameraEventJoint: 'cameraEventConnection',
    stageMaskEventJoint: 'stageMaskEventConnection',
    stagePivotEventJoint: 'stagePivotEventConnection',
    stageStyleEventJoint: 'stageStyleEventConnection',
    stageTransformEventJoint: 'stageTransformEventConnection',
}

const marksOf = (shown: State, objects: readonly ChangedObject[]): ChangeMarks => {
    const changed = new Set<Entity>()
    const rings: ChangeMarks['rings'] = []
    const ghostObjects: { object: ChangedObject; record: Rec; removed: boolean }[] = []
    const ghostLines: ChangeMarks['ghostLines'] = []
    for (const object of objects) {
        if (object.status === 'removed') {
            if (object.kind === 'slides')
                ghostObjects.push({ object, record: object.record, removed: true })
            else ghostLines.push({ beat: object.beat, kind: object.kind })
            continue
        }
        const entity = findEntity(shown, object.kind, object.record, object.beat, changed)
        if (entity) {
            changed.add(entity)
            rings.push({ entity, added: object.status === 'added' })
        }
        if (object.kind === 'slides' && object.from && isMoved(object))
            ghostObjects.push({ object, record: object.from, removed: false })
    }
    // Connectors of changed notes, and event lines from changed joints, keep full strength.
    for (const entity of [...changed]) {
        if (entity.type === 'note') {
            for (const connector of shown.store.slides.connector.get(entity.slideId) ?? [])
                if (changed.has(connector.head) || changed.has(connector.tail))
                    changed.add(connector)
            continue
        }
        const type = connectionTypes[entity.type]
        if (!type) continue
        for (const bucket of shown.store.grid[type].values())
            for (const connection of bucket) {
                const { min, max } = connection as unknown as { min: Entity; max: Entity }
                if (min === entity || max === entity) changed.add(connection)
            }
    }
    const ghosts: ChangeMarks['ghosts'] = []
    if (!ghostObjects.length) return { changed, rings, ghosts, ghostLines }
    const slides = [
        ...new Set(ghostObjects.flatMap(({ object }) => (object.slide ? [object.slide] : []))),
    ]
    const ghostState = ghostStateOf(shown, slides)
    const taken = new Set<Entity>()
    for (const { record, removed } of ghostObjects) {
        const beat = record[2] as number
        const entity = findEntity(ghostState, 'slides', record, beat, taken)
        if (entity?.type !== 'note') continue
        taken.add(entity)
        ghosts.push({ entity, removed })
    }
    return { changed, rings, ghosts, ghostState, ghostLines }
}

/** What the chart draws for the change; none for a change told in words or unknown. */
export const changeMarks = computed((): ChangeMarks | undefined => {
    const change = shownChange.value
    if (!change || !hasPlaces.value) return
    return marksOf(change.state, change.set.objects)
})

/** The entities the chart keeps at full strength while the rest dims; undefined dims nothing. */
export const undimmed = computed((): ReadonlySet<Entity> | undefined => {
    if (!settings.dimUnchangedObjects || !isPeeking.value) return
    const marks = changeMarks.value
    if (marks) return marks.changed
    // The next entry's change still loading: the dim holds, so arrowing never flashes.
    const loading = settledKey.value !== peekedKey.value || !shownChange.value
    return loading && dimHeld.value ? nothing : undefined
})

const nothing: ReadonlySet<Entity> = new Set()

/** Whether the last settled change dimmed the chart. */
const dimHeld = shallowRef(false)
watch([changeMarks, settledKey, isPeeking], () => {
    if (!isPeeking.value) dimHeld.value = false
    else if (changeMarks.value) dimHeld.value = true
    else if (settledKey.value === peekedKey.value && shownChange.value) dimHeld.value = false
    else if (settledKey.value === peekedKey.value && !peekChange.value) dimHeld.value = false
})

// --- Where the changes are, and bringing them into view.

/** The chart pane's band clear of the peek bar above and the toolbar or sheet below, in px. */
export const changeBand = shallowRef({ top: 0, bottom: 0 })

/** Pane y to chart time. */
const timeAt = (y: number) => (0.5 * view.h - y) / settings.pps + view.time

/** The visible band's times: `top` is later than `bottom`, as time runs up. */
export const bandTimes = () => {
    const { top, bottom } = changeBand.value
    return { top: timeAt(top), bottom: timeAt(Math.max(top, view.h - bottom)) }
}

/** Each changed object's time and lanes, on the peeked tempo, in chart order. */
const places = computed((): Place[] => {
    const change = shownChange.value
    if (!change || !hasPlaces.value) return []
    const bpms = change.state.bpms
    return change.set.objects
        .map((object) => ({
            time: beatToTime(bpms, object.beat),
            left: object.left ?? 0,
            right: (object.left ?? 0) + (object.size ?? 0),
        }))
        .sort((a, b) => a.time - b.time)
})

/** Changes beyond the band's top and bottom edges. */
export const offBand = computed(() => countOff(places.value, bandTimes()))

/** Whether the arrows carry counts: not past the limit. */
export const countsShown = computed(
    () => (shownChange.value?.set.objects.length ?? 0) <= MARK_LIMIT,
)

const scrollTo = (stop: Stop) => {
    const { top, bottom } = changeBand.value
    const middle = (top + Math.max(top, view.h - bottom)) / 2
    const target = Math.max(0, (stop.from + stop.to) / 2 - (0.5 * view.h - middle) / settings.pps)
    const span = view.h / settings.pps
    // Far jumps skip what lies between, as a focus does.
    if (Math.abs(target - view.time) > 2 * span) {
        view.scrollingY = undefined
        view.time = target
    } else {
        view.scrollingY = {
            type: 'ease',
            from: { time: time.value.now, viewTime: view.time },
            to: { time: time.value.now + 0.25, viewTime: target },
        }
    }
    // Lanes pan when the stop lies off the lanes in view.
    const half = settings.width / 2
    if (stop.right < view.lane - half || stop.left > view.lane + half) {
        const lane = (stop.left + stop.right) / 2
        view.scrollingX = undefined
        view.lane = Math.max(-settings.maxScrollX, Math.min(settings.maxScrollX, lane))
    }
}

const currentStops = () => {
    const band = bandTimes()
    return { band, stops: stopsOf(places.value, band.top - band.bottom) }
}

/** Show Change: the next stop above the band's middle, wrapping to the lowest. */
export const showNextChange = () => {
    const { band, stops } = currentStops()
    const stop = nextStop(stops, band)
    if (stop) scrollTo(stop)
}

/** An edge arrow: the nearest stop wholly beyond the band that way. */
export const showChangeToward = (direction: 'up' | 'down') => {
    const { band, stops } = currentStops()
    const stop = stopToward(stops, band, direction)
    if (stop) scrollTo(stop)
}

/** The stop nearest the band's middle, when not every change is in view: the row menu's. */
export const showNearestChange = () => {
    const { band, stops } = currentStops()
    const stop = nearestStop(stops, band)
    if (stop) scrollTo(stop)
}

/** Once the change of `key` is shown, its nearest stop; nothing if it never comes. */
export const showChangeOf = (key: EntryKey) => {
    const stop = watch(shownChange, (change) => {
        if (change?.key !== key) return
        stop()
        clearTimeout(timer)
        showNearestChange()
    })
    const timer = setTimeout(stop, 5000)
    // Already shown: at once.
    if (shownChange.value?.key === key) {
        stop()
        clearTimeout(timer)
        showNearestChange()
    }
}
