import type { State } from '../../state'
import type { Entity } from '../../state/entities'
import type { SlideId } from '../../state/entities/slides'
import type { StoreGrid } from '../../state/store/grid'
import type { StoreSlides } from '../../state/store/slides'
import type { PreviewChartSource } from '../engine/chart'

// The worker's copy of the part of a state that the preview's chart builder reads. The main
// thread sends what changed since the last state it sent, by identity, as transactions keep
// what they leave untouched. The worker then keeps the identity of every slide it was not
// sent, so the builder's per-slide caches work as they do on the main thread.

const gridKeys = [
    'timeScale',
    'stageMaskEventJoint',
    'stagePivotEventJoint',
    'stageStyleEventJoint',
    'stageTransformEventJoint',
    'cameraEventJoint',
] as const satisfies readonly (keyof PreviewChartSource['store']['grid'])[]
type GridKey = (typeof gridKeys)[number]

const fieldKeys = ['bpms', 'groups', 'stages', 'isDynamicStages'] as const
type FieldKey = (typeof fieldKeys)[number]

/** What the builder reads of a state; its type names every field the copy must carry. */
export type MirrorState = PreviewChartSource

type SlideInfos = NonNullable<ReturnType<StoreSlides['info']['get']>>
type SlideConnectors = NonNullable<ReturnType<StoreSlides['connector']['get']>>

export type MirrorDiff = {
    /** The first copy, at open or after a chart switch: start again from nothing. */
    reset?: true
    fields?: Partial<Pick<State, FieldKey>>
    grids?: Partial<Pick<StoreGrid, GridKey>>
    slides?: {
        /** Each slide sent with its connectors, in one clone so they share their notes. */
        changed: [SlideId, SlideInfos, SlideConnectors | undefined][]
        /** Every slide id in the info map's order, which sets the order of ties. */
        order: Int32Array
    }
}

/** The main thread's side: the changes since the last state it sent. */
export const createMirrorSender = () => {
    let sent: State | undefined
    return {
        /** The next diff is a first copy. */
        reset: () => {
            sent = undefined
        },
        /** What changed since the last state sent, or nothing; its order array can be transferred. */
        diff: (state: State): MirrorDiff | undefined => {
            const previous = sent
            sent = state
            const diff: MirrorDiff = previous ? {} : { reset: true }
            for (const key of fieldKeys)
                if (diff.reset || previous?.[key] !== state[key])
                    (diff.fields ??= {})[key] = state[key] as never
            for (const key of gridKeys)
                if (diff.reset || previous?.store.grid[key] !== state.store.grid[key])
                    (diff.grids ??= {})[key] = state.store.grid[key] as never
            const { info, connector } = state.store.slides
            const before = previous?.store.slides
            if (before?.info !== info || before.connector !== connector) {
                const changed: [SlideId, SlideInfos, SlideConnectors | undefined][] = []
                const order = new Int32Array(info.size)
                let i = 0
                for (const [id, infos] of info) {
                    order[i++] = id
                    const connectors = connector.get(id)
                    if (before?.info.get(id) !== infos || before.connector.get(id) !== connectors)
                        changed.push([id, infos, connectors])
                }
                diff.slides = { changed, order }
            }
            return diff.reset || diff.fields || diff.grids || diff.slides ? diff : undefined
        },
    }
}

/** The worker's side: the next state, sharing what the diff left unchanged. */
export const applyMirror = (previous: MirrorState | undefined, diff: MirrorDiff): MirrorState => {
    const base = diff.reset ? undefined : previous
    if (!base && !diff.reset) throw new Error('The preview mirror has no first copy')
    const field = <K extends FieldKey>(key: K) =>
        (diff.fields && key in diff.fields ? diff.fields[key] : base?.[key]) as State[K]
    let store = base?.store
    if (!store || diff.grids || diff.slides) {
        const grid = { ...base?.store.grid, ...diff.grids } as MirrorState['store']['grid']
        let slides = base?.store.slides
        if (diff.slides) {
            const changed = new Map(
                diff.slides.changed.map(([id, infos, connectors]) => [id, { infos, connectors }]),
            )
            const info: StoreSlides['info'] = new Map()
            const connector: StoreSlides['connector'] = new Map()
            for (const id of diff.slides.order as unknown as Iterable<SlideId>) {
                const sent = changed.get(id)
                const infos = sent ? sent.infos : base?.store.slides.info.get(id)
                if (!infos) throw new Error(`The preview mirror has no slide ${id}`)
                info.set(id, infos)
                const connectors = sent ? sent.connectors : base?.store.slides.connector.get(id)
                if (connectors) connector.set(id, connectors)
            }
            slides = { info, connector }
        }
        if (!slides) throw new Error('The preview mirror has no slides')
        store = { grid, slides }
    }
    return {
        bpms: field('bpms'),
        groups: field('groups'),
        stages: field('stages'),
        isDynamicStages: field('isDynamicStages'),
        store,
    }
}

/**
 * The selected notes and connectors as places in the slides: slide id, 0 for a note or 1 for
 * a connector, and its index in the slide's infos or connectors. Entities have no ids, and
 * the worker's copies are other objects.
 */
export const selectionPlaces = (state: State, objects: ReadonlySet<object>) => {
    const { info, connector } = state.store.slides
    const notes = new Map<SlideId, Map<object, number>>()
    const connectors = new Map<SlideId, Map<object, number>>()
    const indexOf = <T extends object>(
        cache: Map<SlideId, Map<object, number>>,
        id: SlideId,
        list: readonly T[] | undefined,
        key: (item: T) => object,
    ) => {
        let indexes = cache.get(id)
        if (!indexes) {
            indexes = new Map(list?.map((item, index) => [key(item), index]))
            cache.set(id, indexes)
        }
        return indexes
    }
    const places: number[] = []
    for (const object of objects) {
        const entity = object as Entity
        if (entity.type === 'note') {
            const index = indexOf(
                notes,
                entity.slideId,
                info.get(entity.slideId),
                (item) => item.note,
            ).get(entity)
            if (index !== undefined) places.push(entity.slideId, 0, index)
        } else if (entity.type === 'connector') {
            const id = entity.head.slideId
            const index = indexOf(connectors, id, connector.get(id), (item) => item).get(entity)
            if (index !== undefined) places.push(id, 1, index)
        }
    }
    return Int32Array.from(places)
}

/** The worker's copies of the selected notes and connectors. */
export const selectedObjects = (mirror: MirrorState, places: Int32Array) => {
    const objects = new Set<object>()
    for (let i = 0; i + 2 < places.length; i += 3) {
        const id = places[i] as SlideId
        const index = places[i + 2] ?? -1
        const object =
            places[i + 1] === 0
                ? mirror.store.slides.info.get(id)?.[index]?.note
                : mirror.store.slides.connector.get(id)?.[index]
        if (object) objects.add(object)
    }
    return objects
}
