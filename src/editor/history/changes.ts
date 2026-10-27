import { computed, shallowRef, watch } from 'vue'
import { isPeeking } from '../../history'
import {
    displayedPeekKey,
    entryKey,
    loadEntryState,
    parseEntryKey,
    peekedKey,
    type EntryKey,
} from '../../history/peek'
import { onResetState } from '../../history/resetHooks'
import { peek } from '../../history/stack'
import { i18n } from '../../i18n'
import {
    MARK_LIMIT,
    diffChanges,
    isMoved,
    placeOf,
    type ChangeSet,
    type ChangeTotals,
    type ChangedObject,
} from '../../local/changes/diff'
import { joints, stateCandidates, totalsOf } from '../../local/changes/states'
import type { RecordValue } from '../../local/records/canonical'
import { entitiesOf } from '../../local/records/extract'
import {
    bpmObject,
    cameraEventObject,
    noteObject,
    noteRecord,
    stageMaskEventObject,
    stagePivotEventObject,
    stageStyleEventObject,
    stageTransformEventObject,
    timeScaleObject,
} from '../../local/records/records'
import type { KindName } from '../../local/records/schema'
import { storageWorker } from '../../local/start'
import { testKeysOpen, testWindowMs } from '../../platform/testKeys'
import { settings } from '../../settings'
import { createState, type State } from '../../state'
import type { Entity, EntityType } from '../../state/entities'
import { beatToTime } from '../../state/integrals/bpms'
import { clockNow } from '../../time'
import { interpolateRaw } from '../../utils/interpolate'
import { formatCount } from '../../utils/size'
import { getComposedLayout } from '../composedView'
import { view } from '../view'
import { historyCalendar } from './calendarClock'
import {
    countOff,
    nearestStop,
    nextStop,
    reachable,
    stopToward,
    stopsOf,
    type Place,
    type Stop,
} from './changeStops'
import { historyOperationContext } from './historyOperationContext'
import { createChangePaint, createPropertyInspection, createShowEdits } from './inspection'
import { peekedInfo, peekedLabel, setPeekReady, type ChainKey, type PeekedInfo } from './selection'

// The change view: what the peeked entry changed against the entry before it on
// the Timeline, from the worker by roots, or diffed here from states in memory for entries not
// stored yet. The chart never scrolls on its own: the bar counts, the edge arrows and Show Change
// bring the changes into view when asked.

type Rec = readonly RecordValue[]

/** The peeked entry's change, once known, with the state it was diffed for. */
export type ChangeView = {
    key: EntryKey
    request: PeekedInfo
    previous: ChainKey
    set: ChangeSet
    totals: ChangeTotals
    state: State
}

export const peekChange = shallowRef<ChangeView>()

/** The entry whose change is settled: known, or found unknown. */
export const comparisonStatus = shallowRef<'loading' | 'known' | 'initial' | 'unavailable'>(
    'loading',
)

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
    const previous = info.previous ?? (await previousOf(info.oldest ?? info.key))
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
    return (
        set && {
            key: info.key,
            request: info,
            previous: { ...previous },
            set,
            totals,
            state: after,
        }
    )
}

/**
 * The last change that landed: the chart's marks and the minimap's ticks draw from it while its
 * state is the one displayed, until the next lands, so a step's switch never shows the chart
 * without them. Released when the peek ends. The bar and the inspection keep to `peekChange`.
 */
const lastChange = shallowRef<ChangeView>()

watch(
    peekedInfo,
    (info) => {
        generation++
        peekChange.value = undefined
        comparisonStatus.value = 'loading'
        if (!info) lastChange.value = undefined
    },
    { immediate: true, flush: 'sync' },
)

/**
 * Reads the requested step's change; a peek waits for it before it shows the step's state, so
 * the two land in one task. It also settles when the step is no longer the one requested.
 */
const readChange = (info: PeekedInfo): Promise<void> | undefined => {
    if (peekedInfo.value !== info) return
    const at = generation
    return compute(info).then(
        (result) => {
            if (at !== generation) return
            peekChange.value = result
            lastChange.value = result
            comparisonStatus.value = result ? 'known' : info.initial ? 'initial' : 'unavailable'
        },
        () => {
            // Unknown: the label alone, nothing drawn.
            if (at === generation) comparisonStatus.value = 'unavailable'
        },
    )
}
setPeekReady((info) => readChange(info))

/** The change while the displayed state is the one it was diffed for: what the chart draws. */
const drawnChange = computed(() => {
    const change = lastChange.value
    if (!change || !isPeeking.value || displayedPeekKey.value !== change.key) return
    if (peek.value?.state.store !== change.state.store) return
    return change
})

/** The change while the peeked state is the one it was diffed for. */
export const shownChange = computed(() => {
    const change = peekChange.value
    if (!change || !isPeeking.value || peekedKey.value !== change.key) return
    if (displayedPeekKey.value !== change.key) return
    if (peekedInfo.value !== change.request) return
    if (peek.value?.state.store !== change.state.store) return
    return change
})

const presentation = createShowEdits(isPeeking, () => settings.dimUnchangedObjects)
export const showEdits = presentation.showEdits
export const toggleShowEdits = presentation.toggle

const inspection = createPropertyInspection(shownChange, loadEntryState)
export const propertyInspection = inspection.inspection
export const canInspectProperties = inspection.available
export const openPropertyInspection = inspection.open
export const closePropertyInspection = inspection.close
onResetState(() => {
    inspection.close()
    presentation.reset()
})

// --- What the bar says.

/**
 * Every fixed line the capsule can show (anything else is live text: step labels and multi-part
 * counts), so the strip's fit (peekFit.ts) measures them all. Every such line goes through `fixedLine`, which
 * takes only these keys: a new one cannot be shown without being measured.
 */
export const fixedLines = {
    /** The passive line under 480 px panes (ChangeArrows' visibleLine). */
    short: ['loadingShort', 'unavailableShort', 'noChanges', 'initialState'],
    /** The passive line from 480 px panes. */
    wide: ['loadingChanges', 'unavailable', 'noChanges', 'initialState'],
    /** In the summary button at every width: a header-only change of several members. */
    summary: ['settingsChanged'],
} as const

export type FixedLine = (typeof fixedLines)[keyof typeof fixedLines][number]

export const fixedLine = (key: FixedLine) => i18n.value.peek[key]

const count = (value: number) => formatCount(value)

/**
 * The counted lines' usual widest forms: a count and one unit, with three digits (a large change is
 * over 150 objects). Built with `changeText`'s own strings and `count`, so the fit measures them
 * the way they are written; the strip widens for them where the pane has room (peekFit.ts).
 */
export const countedLines = () => {
    const strings = i18n.value.peek
    const digits = count(888)
    return [
        interpolateRaw(strings.changedLarge, interpolateRaw(strings.notes, digits)),
        interpolateRaw(strings.changeCount, digits),
    ]
}

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
    const { set } = change
    if (set.layout === 'none') return set.header ? undefined : fixedLine('noChanges')
    if (set.layout === 'small') {
        const text = interpolateRaw(strings.changeCount, count(set.objects.length))
        return set.header ? `${text} · ${strings.settingsChanged}` : text
    }
    const fragments: string[] = []
    const { counts } = set
    if (set.layout === 'most') {
        const added = set.objects.filter((object) => object.status === 'added').length
        const removed = set.objects.filter((object) => object.status === 'removed').length
        const text = interpolateRaw(strings.addedRemoved, count(added), count(removed))
        return set.header ? `${text} · ${strings.settingsChanged}` : text
    } else {
        if (counts.slides) fragments.push(interpolateRaw(strings.notes, count(counts.slides)))
        if (counts.bpms) fragments.push(interpolateRaw(strings.bpms, count(counts.bpms)))
        if (counts.timeScales)
            fragments.push(interpolateRaw(strings.timeScales, count(counts.timeScales)))
        const others = eventCount(counts)
        if (others) fragments.push(interpolateRaw(strings.events, count(others)))
    }
    const text = interpolateRaw(strings.changedLarge, fragments.join(' · '))
    return set.header ? `${text} · ${strings.settingsChanged}` : text
}

/** The bar's second line; undefined while loading, when unknown, or for a header-only change. */
export const changeLine = computed(() => {
    const change = shownChange.value
    if (change)
        return (
            changeText(change) ??
            ((peekedInfo.value?.members?.length ?? 1) > 1
                ? fixedLine('settingsChanged')
                : peekedInfo.value &&
                  peekedLabel(peekedInfo.value, historyOperationContext(historyCalendar())))
        )
    if (comparisonStatus.value === 'initial') return fixedLine('initialState')
    if (comparisonStatus.value === 'unavailable') return fixedLine('unavailable')
    return undefined
})

/**
 * True once the bar has been without a settled step for 250 ms: it then shows the new step's
 * loading state. The 250 ms runs from when the bar left a settled step, so further switches
 * before a read lands do not restart it, and it ends when a step settles or the peek does.
 */
export const slowRead = shallowRef(false)
const SLOW_READ_MS = 250
let slowTimer: ReturnType<typeof setTimeout> | undefined
watch(
    [comparisonStatus, peekedInfo],
    ([status, info]) => {
        if (status !== 'loading' || !info) {
            clearTimeout(slowTimer)
            slowTimer = undefined
            slowRead.value = false
        } else if (!slowTimer && !slowRead.value)
            slowTimer = setTimeout(
                () => {
                    slowTimer = undefined
                    slowRead.value = true
                },
                testKeysOpen ? testWindowMs('nse.test.slowRead', SLOW_READ_MS) : SLOW_READ_MS,
            )
    },
    { immediate: true, flush: 'sync' },
)

/** Whether the change has objects to draw and bring into view. */
const hasPlaces = computed(() => {
    const layout = drawnChange.value?.set.layout
    return layout === 'small' || layout === 'large' || layout === 'most'
})

// --- Marks on the chart: the peeked state's entities that changed, and ghosts of the old ones.

type EventType = EntityType

export type ChangeMarks = {
    /** Drawn at full strength while the rest dims: changed objects, their connectors. */
    changed: ReadonlySet<Entity>
    /** Rings: changed and added objects; added ones get a `+`. */
    rings: { entity: Entity; added: boolean; id: number }[]
    /** Old notes: removed ones (`−`) and where moved ones were. */
    ghosts: { entity: Entity; removed: boolean; id: number }[]
    /** The state ghosts are drawn through: the old slides, on the peeked tempo. */
    ghostState?: State
}

const textOf = (record: Rec) => JSON.stringify(record)

const jointOf = joints as Record<KindName, [EventType, (entity: never) => Rec] | undefined>

/** Record queues avoid repeatedly scanning dense same-beat buckets. */
const entityIndex = (target: State) => {
    const index = new Map<string, Entity[]>()
    const add = (kind: KindName, entity: Entity, record: Rec) => {
        const key = `${kind}:${textOf(record)}`
        const bucket = index.get(key)
        if (bucket) bucket.push(entity)
        else index.set(key, [entity])
    }
    for (const entity of entitiesOf(target.store.grid.note))
        add('slides', entity, noteRecord(entity))
    for (const [kind, joint] of Object.entries(jointOf)) {
        if (!joint) continue
        const [type, encode] = joint
        for (const entity of entitiesOf<Entity>(target.store.grid[type]))
            add(kind as KindName, entity, encode(entity as never))
    }
    return (kind: KindName, record: Rec) => index.get(`${kind}:${textOf(record)}`)?.pop()
}

/** The old slides of removed and moved notes, on the peeked state's tempo and header. */
const ghostStateOf = (shown: State, slides: Rec[], events: Map<KindName, Rec[]>) =>
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
            cameraEvents: (events.get('cameraEvents') ?? []).map(cameraEventObject),
            stageMaskEvents: (events.get('stageMaskEvents') ?? []).map(stageMaskEventObject),
            stagePivotEvents: (events.get('stagePivotEvents') ?? []).map(stagePivotEventObject),
            stageStyleEvents: (events.get('stageStyleEvents') ?? []).map(stageStyleEventObject),
            stageTransformEvents: (events.get('stageTransformEvents') ?? []).map(
                stageTransformEventObject,
            ),
            timeScales: (events.get('timeScales') ?? []).map(timeScaleObject),
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
    const ghostObjects: { object: ChangedObject; record: Rec; removed: boolean; id: number }[] = []
    const find = entityIndex(shown)
    for (const [id, object] of objects.entries()) {
        if (object.status === 'removed') {
            ghostObjects.push({ object, record: object.record, removed: true, id })
            continue
        }
        const entity = find(object.kind, object.record)
        if (entity) {
            changed.add(entity)
            rings.push({ entity, added: object.status === 'added', id })
        }
        if (object.from && isMoved(object))
            ghostObjects.push({ object, record: object.from, removed: false, id })
    }
    // One pass over connections keeps dense changes linear.
    for (const connectors of shown.store.slides.connector.values())
        for (const connector of connectors)
            if (changed.has(connector.head) || changed.has(connector.tail)) changed.add(connector)
    for (const type of Object.values(connectionTypes)) {
        for (const bucket of shown.store.grid[type].values())
            for (const connection of bucket) {
                const { min, max } = connection as unknown as { min: Entity; max: Entity }
                if (changed.has(min) || changed.has(max)) changed.add(connection)
            }
    }
    const ghosts: ChangeMarks['ghosts'] = []
    if (!ghostObjects.length) return { changed, rings, ghosts }
    const slides = [
        ...new Set(ghostObjects.flatMap(({ object }) => (object.slide ? [object.slide] : []))),
    ]
    const events = new Map<KindName, Rec[]>()
    for (const { object, record } of ghostObjects) {
        if (object.kind === 'slides' || object.kind === 'bpms') continue
        const list = events.get(object.kind)
        if (list) list.push(record)
        else events.set(object.kind, [record])
    }
    const ghostState = ghostStateOf(shown, slides, events)
    const findGhost = entityIndex(ghostState)
    for (const { object, record, removed, id } of ghostObjects) {
        const entity =
            object.kind === 'bpms'
                ? {
                      type: 'bpm' as const,
                      ...bpmObject(record),
                      meter: record[2] as number,
                      hitbox: undefined,
                  }
                : findGhost(object.kind, record)
        if (!entity) continue
        ghosts.push({ entity, removed, id })
    }
    rings.sort((a, b) => a.entity.beat - b.entity.beat)
    ghosts.sort((a, b) => a.entity.beat - b.entity.beat)
    return { changed, rings, ghosts, ghostState }
}

/** What the chart draws for the change; none for a change told in words or unknown. */
const rawChangeMarks = computed((): ChangeMarks | undefined => {
    const change = drawnChange.value
    if (!change || !hasPlaces.value) return
    return marksOf(change.state, change.set.objects)
})

// A step's peek, not a session's: a session's has no change, so it never dims.
const paint = createChangePaint<Entity, ChangeMarks>(
    rawChangeMarks,
    computed(() => isPeeking.value && !!peekedInfo.value),
    showEdits,
    comparisonStatus,
    computed(() => peekChange.value?.set.layout !== 'none'),
)
export const changeMarks = paint.marks

/** The entities the chart keeps at full strength while the rest dims; undefined dims nothing. */
export const undimmed = paint.undimmed

// --- Where the changes are, and bringing them into view.

/** The chart pane's band clear of the peek bar above and the toolbar or sheet below, in px. */
export const changeBand = shallowRef({ top: 0, bottom: 0 })

/** An edge arrow's distance from the band's edge, in px. */
export const ARROW_GAP = 4

/** Pointer-independent spacing keeps the navigation controls on the same geometry. */
export const arrowGap = computed(() => ARROW_GAP)

/** Pane y to chart time. */
const timeAt = (y: number) => (0.5 * view.h - y) / settings.pps + view.time

/** The visible band's times: `top` is later than `bottom`, as time runs up. */
export const bandTimes = () => {
    const { top, bottom } = changeBand.value
    const band = { top: timeAt(top), bottom: timeAt(Math.max(top, view.h - bottom)) }
    // The view never goes below the chart's start, so the band never shows less than this.
    return { ...band, floor: band.bottom - view.time }
}

/** Each changed object's time and lanes, on the peeked tempo, in chart order. */
const places = computed((): Place[] => {
    const change = drawnChange.value
    if (!change || !hasPlaces.value) return []
    const bpms = change.state.bpms
    const marks = rawChangeMarks.value
    const current = new Map(marks?.rings.map(({ id, entity }) => [id, entity]))
    const old = new Map(marks?.ghosts.map(({ id, entity }) => [id, entity]))
    const composed = getComposedLayout(change.state)
    const position = (kind: KindName, record: Rec, entity?: Entity, ghost = false) => {
        const place = placeOf(kind, record)
        if (composed && entity?.type === 'note') {
            const state = ghost ? marks?.ghostState : change.state
            const projected = composed.notePosition(entity, entity.beat, {
                slideInfos: state?.store.slides.info.get(entity.slideId),
            })
            return { ...place, left: projected.left, size: projected.size }
        }
        return place
    }
    return change.set.objects
        .flatMap((object, id) => {
            const from =
                object.status === 'removed'
                    ? position(object.kind, object.record, old.get(id), true)
                    : position(object.kind, object.record, current.get(id))
            const points = [
                from,
                ...(object.from && isMoved(object)
                    ? [position(object.kind, object.from, old.get(id), true)]
                    : []),
            ]
            return points.map((place) => ({
                id,
                time: beatToTime(bpms, place.beat),
                left: place.left,
                right: place.left + place.size,
            }))
        })
        .sort((a, b) => a.time - b.time)
})

/** The places the minimap marks: those of the change the chart marks, none when it marks none. */
export const minimapChangePlaces = computed(() => (changeMarks.value ? places.value : undefined))

/** Changes beyond the band's top and bottom edges. */
export const usableBand = computed(() => changeBand.value.top + changeBand.value.bottom < view.h)
export const offBand = computed(() =>
    usableBand.value ? countOff(places.value, bandTimes()) : { above: 0, below: 0 },
)

/** Whether the arrows carry counts: not past the limit. */
export const countsShown = computed(
    () =>
        shownChange.value?.set.layout !== 'most' &&
        (shownChange.value?.set.objects.length ?? 0) <= MARK_LIMIT,
)

/** Whether the arrows carry counts: the change is read and not past the limit. */
export const reportCounts = computed(
    () => !!shownChange.value && usableBand.value && countsShown.value,
)

/** What the bar shows of a read step: its name, line, arrows and summary. */
export type BarState = {
    info: PeekedInfo
    line: string
    reportCounts: boolean
    above: number
    below: number
    inspectable: boolean
}

const barNow = computed((): BarState | undefined => {
    const info = peekedInfo.value
    const line = changeLine.value
    if (!info || line === undefined || !isPeeking.value) return
    return {
        info,
        line,
        reportCounts: reportCounts.value,
        above: offBand.value.above,
        below: offBand.value.below,
        inspectable: canInspectProperties.value,
    }
})

/** The last step read, as the bar showed it; kept current as its arrows' counts follow the view. */
const settledBar = shallowRef<BarState>()

let pendingPress: { info: PeekedInfo; run: () => void } | undefined
/**
 * A press made while the bar holds the last step: kept (the latest only) and run once, when the
 * step the user is now on is read. Another step, or the peek ending, drops it.
 */
export const pressWhenRead = (run: () => void) => {
    const info = peekedInfo.value
    if (info) pendingPress = { info, run }
}

watch([barNow, peekedInfo, isPeeking], ([state, info, peeking]) => {
    if (!peeking || !info) {
        settledBar.value = undefined
        pendingPress = undefined
        return
    }
    if (pendingPress && pendingPress.info !== info) pendingPress = undefined
    if (!state) return
    settledBar.value = state
    const press = pendingPress
    pendingPress = undefined
    press?.run()
})

/**
 * While a new step's change is being read (for under 250 ms), the whole bar keeps the last step's
 * state: its date, line, counts, enabled arrows and summary, so one swap follows when the new
 * change lands and nothing shows blank, dashed or dimmed between. The first step of a peek has
 * none; after 250 ms the bar names the new step and says it is loading.
 */
export const heldBar = computed(() =>
    changeLine.value === undefined && !slowRead.value ? settledBar.value : undefined,
)

/** A peeked step's change is being read for under 250 ms: a press now waits for it. */
export const awaitingRead = computed(
    () =>
        isPeeking.value && !!peekedInfo.value && changeLine.value === undefined && !slowRead.value,
)

/**
 * The first step of a peek, read for under 250 ms: nothing is held, so the bar's date and change
 * strip stay hidden (in place) until its change is read or the loading state shows.
 */
export const firstRead = computed(() => awaitingRead.value && !settledBar.value)

/** The step the bar names. */
export const barInfo = computed(() => heldBar.value?.info ?? peekedInfo.value)

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
        const start = clockNow()
        view.scrollingY = {
            type: 'ease',
            from: { time: start, viewTime: view.time },
            to: { time: start + 0.25, viewTime: target },
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
    return {
        band,
        stops: usableBand.value
            ? stopsOf(reachable(places.value, band.floor), band.top - band.bottom)
            : [],
    }
}

const showLateralChange = () => {
    if (!usableBand.value) return false
    const band = bandTimes()
    const half = settings.width / 2
    const outside = places.value.filter(
        (place) =>
            place.time >= band.bottom &&
            place.time <= band.top &&
            (place.right < view.lane - half || place.left > view.lane + half),
    )
    outside.sort(
        (a, b) =>
            Math.abs((a.left + a.right) / 2 - view.lane) -
            Math.abs((b.left + b.right) / 2 - view.lane),
    )
    const place = outside[0]
    if (!place) return false
    scrollTo({ from: place.time, to: place.time, left: place.left, right: place.right })
    return true
}

/** Show Change: the next stop above the band's middle, wrapping to the lowest. */
export const showNextChange = () => {
    // While the new step's change is read, the press waits for it, as the arrows' do.
    if (awaitingRead.value) {
        pressWhenRead(showNextChange)
        return
    }
    if (showLateralChange()) return
    const { band, stops } = currentStops()
    const stop = nextStop(stops, band)
    if (stop) scrollTo(stop)
}

/** An edge arrow: the nearest stop wholly beyond the band that way. */
export const showChangeToward = (direction: 'up' | 'down') => {
    if (!usableBand.value) return
    const band = bandTimes()
    const stops = stopsOf(
        reachable(places.value, band.floor).filter(({ time }) =>
            direction === 'up' ? time > band.top : time < band.bottom,
        ),
        band.top - band.bottom,
    )
    const stop = stopToward(stops, band, direction)
    if (stop) scrollTo(stop)
}

/** The stop nearest the band's middle, when not every change is in view: the row menu's. */
export const showNearestChange = () => {
    if (showLateralChange()) return
    const { band, stops } = currentStops()
    const stop = nearestStop(stops, band)
    if (stop) scrollTo(stop)
}

/** Once the change of `key` is shown, its nearest stop; nothing if it never comes. */
export const showChangeOf = (request: PeekedInfo) => {
    if (shownChange.value?.request === request) {
        showNearestChange()
        return
    }
    const stop = watch(
        [shownChange, peekedInfo, isPeeking],
        ([change, selected, peeking], previous) => {
            if (selected !== request || (!peeking && previous[2])) {
                stop()
                clearTimeout(timer)
                return
            }
            if (change?.request !== request) return
            stop()
            clearTimeout(timer)
            showNearestChange()
        },
        { flush: 'sync' },
    )
    const timer = setTimeout(stop, 5000)
}
