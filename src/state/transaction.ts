import type { State } from '.'
import { nearlyEqual } from '../utils/math'
import type { Entity } from './entities'
import type { SlideId } from './entities/slides'
import type { SlideInfos } from './entities/slides/hiddenTicks'
import { isInteriorTick, slideEnds, toNoteEntity, type NoteEntity } from './entities/slides/note'
import { beatToTime, calculateBpms, type BpmIntegral } from './integrals/bpms'
import { rebuildSlide } from './mutations/slides'
import { getDetachedNotePositions } from './operations/notePositions'
import { addToStoreGrid, createStoreGridOwnership, removeFromStoreGrid } from './store/grid'
import { createSlideNoteDrafts } from './store/slideNoteDrafts'

export type Transaction = ReturnType<typeof createTransaction>

export const createTransaction = (state: State) => {
    let currentState = state
    const grid = createMapObjectTransaction(state.store.grid)
    const gridOwnership = createStoreGridOwnership(grid.accessor)
    const globalEventRanges = { ...state.store.globalEventRanges }
    const stageEventRanges = createMapObjectTransaction(state.store.stageEventRanges)
    const slides = createMapObjectTransaction(state.store.slides)
    const noteDrafts = createSlideNoteDrafts(() => slides.accessor.note)
    const dirtySlideIds = new Set<SlideId>()
    const origins = new Map<NoteEntity, NoteOrigin>()

    let bpms: BpmIntegral[] | undefined

    return {
        store: {
            grid: grid.accessor,
            globalEventRanges,
            stageEventRanges: stageEventRanges.accessor,
            slides: {
                get note() {
                    return noteDrafts.readMap()
                },
                get info() {
                    return slides.accessor.info
                },
                get connector() {
                    return slides.accessor.connector
                },
            },
            noteDrafts,

            markDirty(slideId: SlideId) {
                dirtySlideIds.add(slideId)
            },

            /** A note made from an interior attached tick keeps its place if it ends up non-interior. */
            setOrigin(note: NoteEntity, origin: NoteEntity, explicit: NoteOrigin['explicit'] = {}) {
                origins.set(note, { note: origins.get(origin)?.note ?? origin, explicit })
            },
        },

        get bpms() {
            return (bpms ??= [...currentState.bpms])
        },

        commit(selectedEntities: Entity[]): State {
            // Rebuilding can replace attached selections. The caller may pass a
            // published state's selection, which must remain part of its history.
            const selection = [...selectedEntities]
            if (bpms) {
                bpms = calculateBpms(bpms)
                // Attached notes sit at their time fraction, which BPM changes may move.
                const newBpms = bpms
                const fraction = (
                    bpms: BpmIntegral[],
                    { note, attachHead, attachTail }: SlideInfos[number],
                ) => {
                    const head = beatToTime(bpms, attachHead.beat)
                    return (
                        (beatToTime(bpms, note.beat) - head) /
                        (beatToTime(bpms, attachTail.beat) - head)
                    )
                }
                for (const [slideId, infos] of currentState.store.slides.info) {
                    if (dirtySlideIds.has(slideId)) continue
                    if (
                        !infos.some(
                            (info) =>
                                info.note !== info.attachHead &&
                                info.note !== info.attachTail &&
                                !nearlyEqual(
                                    fraction(currentState.bpms, info),
                                    fraction(newBpms, info),
                                ),
                        )
                    )
                        continue
                    const notes = slides.accessor.note.get(slideId)
                    if (!notes) continue
                    // prepare() acquires an owned array before rebuilding.
                    dirtySlideIds.add(slideId)
                }
            }

            for (const slideId of dirtySlideIds) noteDrafts.prepare(slideId)
            keepDetachedTicks(currentState, this.store, dirtySlideIds, origins, selection)

            for (const slideId of dirtySlideIds) {
                rebuildSlide(this.store, slideId, selection, bpms ?? currentState.bpms)
            }

            const result: State = {
                ...currentState,
                store: {
                    grid: {
                        ...currentState.store.grid,
                        ...grid.value,
                    },
                    globalEventRanges: { ...globalEventRanges },
                    stageEventRanges: {
                        ...currentState.store.stageEventRanges,
                        ...stageEventRanges.value,
                    },
                    slides: {
                        ...currentState.store.slides,
                        ...slides.value,
                    },
                },
                bpms: bpms ?? currentState.bpms,
                selectedEntities: selection,
            }

            // Published maps, buckets, and arrays become shared history. A later
            // edit through this transaction must acquire fresh ownership.
            currentState = result
            noteDrafts.reset()
            slides.checkpoint()
            stageEventRanges.checkpoint()
            grid.checkpoint()
            gridOwnership.reset()
            dirtySlideIds.clear()
            origins.clear()
            bpms = undefined
            return result
        },
    }
}

type NoteOrigin = {
    note: NoteEntity
    explicit: Partial<Record<'left' | 'size' | 'elevation', boolean>>
}

// Ticks that stop being interior attached ticks keep their gameplay place, as Split Slide does.
const keepDetachedTicks = (
    source: State,
    store: Transaction['store'],
    slideIds: Set<SlideId>,
    origins: Map<NoteEntity, NoteOrigin>,
    selection: Entity[],
) => {
    const interiors = new Map<SlideId, Set<NoteEntity>>()
    const isInterior = (note: NoteEntity) => {
        if (!note.isAttached) return false
        let interior = interiors.get(note.slideId)
        if (!interior) {
            const notes = source.store.slides.note.get(note.slideId) ?? []
            interior = new Set(notes.filter(isInteriorTick))
            interiors.set(note.slideId, interior)
        }
        return interior.has(note)
    }
    // Unedited ticks can only end up first or last, as rebuildSlide's stable sort orders them.
    const ends = new Set<NoteEntity>()
    for (const slideId of slideIds) {
        const { first, last } = slideEnds(store.slides.note.get(slideId) ?? [])
        if (first) ends.add(first)
        if (last) ends.add(last)
    }
    const candidates: { note: NoteEntity; origin: NoteOrigin }[] = []
    for (const note of ends) {
        const origin = origins.get(note) ?? { note, explicit: {} }
        if (isInterior(origin.note)) candidates.push({ note, origin })
    }
    for (const [note, origin] of origins) {
        if (!ends.has(note) && !note.isAttached && isInterior(origin.note))
            candidates.push({ note, origin })
    }
    if (!candidates.length) return
    const positions = getDetachedNotePositions(
        source,
        candidates.map(({ origin }) => origin.note),
    )
    for (const { note, origin } of candidates) {
        const position = positions.get(origin.note)
        if (!position) continue
        const { explicit } = origin
        const left = explicit.left ? note.left : position.left
        const size = explicit.size ? note.size : position.size
        const elevation = explicit.elevation ? note.elevation : position.elevation
        if (
            nearlyEqual(left, note.left) &&
            nearlyEqual(size, note.size) &&
            nearlyEqual(elevation, note.elevation)
        )
            continue
        const notes = store.slides.note.get(note.slideId)
        const index = notes?.indexOf(note) ?? -1
        if (!notes || index === -1) continue
        const replacement = toNoteEntity(note.slideId, { ...note, left, size, elevation })
        notes[index] = replacement
        removeFromStoreGrid(store.grid, note, note.beat)
        addToStoreGrid(store.grid, replacement, replacement.beat)
        const selected = selection.indexOf(note)
        if (selected !== -1) selection[selected] = replacement
    }
}

const createMapObjectTransaction = <T extends Record<string, Map<unknown, unknown>>>(object: T) => {
    let sources = object
    const value: Record<string, Map<unknown, unknown>> = {}

    return {
        accessor: Object.defineProperties(
            {},
            Object.fromEntries(
                Object.keys(object).map((k) => [
                    k,
                    {
                        get: () => (value[k] ??= new Map(sources[k])),
                    },
                ]),
            ),
        ) as T,

        value: value as Partial<T>,
        checkpoint() {
            sources = { ...sources, ...value }
            for (const key of Object.keys(value)) Reflect.deleteProperty(value, key)
        },
    }
}
