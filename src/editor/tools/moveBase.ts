import type { NoteObject } from '../../chart/note'
import { state } from '../../history'
import { clearPreviewEdit, setPreviewEdit } from '../../preview/edit'
import type { State } from '../../state'
import type { Entity } from '../../state/entities'
import type { SlideId } from '../../state/entities/slides'
import { toNoteEntity, type NoteEntity } from '../../state/entities/slides/note'
import { getDetachedNotePositions } from '../../state/operations/notePositions'
import { createTransaction, type Transaction } from '../../state/transaction'
import {
    getComposedGridOffset,
    getComposedMoveOffset,
    getComposedNoteOffset,
    isComposedLatticeMoved,
} from '../composedView'
import { minimumNoteSize } from '../laneLimits'
import { xToLane } from '../view'
import { constrainMoved, constrainResized } from './toolMove'
import { moveLane, resize } from './utils'

type Place = { left: number; size: number; elevation: number }

const places = new WeakMap<State, Map<NoteEntity, Place | undefined>>()

// Gameplay places at the move's start, built once per state.
const placesOf = (source: State, notes: NoteEntity[]) => {
    let known = places.get(source)
    if (!known) places.set(source, (known = new Map<NoteEntity, Place | undefined>()))
    const missing = notes.filter((note) => !known.has(note))
    if (missing.length) {
        const positions = getDetachedNotePositions(source, missing)
        for (const note of missing) known.set(note, positions.get(note))
    }
    return known
}

/** Ticks a move takes past their slide's ends, as notes at their gameplay place. */
export const getMovedEndBases = (source: State, beats: ReadonlyMap<NoteEntity, number>) => {
    const bases = new Map<NoteEntity, NoteEntity>()
    const slideIds = new Set<SlideId>()
    for (const note of beats.keys()) if (note.isAttached) slideIds.add(note.slideId)
    const ends: NoteEntity[] = []
    for (const slideId of slideIds) {
        const notes = source.store.slides.note.get(slideId) ?? []
        const at = (note: NoteEntity) => beats.get(note) ?? note.beat
        // The slide's stable sort keeps stored order among equal beats.
        let first: NoteEntity | undefined
        let last: NoteEntity | undefined
        for (const note of notes) {
            if (!first || at(note) < at(first)) first = note
            if (!last || at(note) >= at(last)) last = note
        }
        for (const end of new Set([first, last])) {
            if (!end?.isAttached || !beats.has(end)) continue
            const index = notes.indexOf(end)
            if (index > 0 && index < notes.length - 1) ends.push(end)
        }
    }
    if (!ends.length) return bases
    const known = placesOf(source, ends)
    for (const note of ends) {
        const place = known.get(note)
        if (place)
            bases.set(note, toNoteEntity(note.slideId, { ...note, ...place, isAttached: false }))
    }
    return bases
}

/** A Note or Slide tool move; a tick taken past its slide's end moves from its gameplay place. */
export const toDraggedNoteObject = (
    entity: NoteEntity,
    pressLane: number,
    x: number,
    beat: number,
): NoteObject => {
    const from = getMovedEndBases(state.value, new Map([[entity, beat]])).get(entity) ?? entity
    const lane = xToLane(x) - getComposedMoveOffset(entity, beat)
    const pointerLane = xToLane(x) - getComposedNoteOffset(entity)
    return constrainMoved(
        {
            ...entity,
            beat,
            left: moveLane(
                from.left,
                pressLane + getComposedNoteOffset(entity) - getComposedNoteOffset(from),
                lane,
                from.left,
                getComposedGridOffset(from.stageId, beat),
                // A moved stage lattice snaps at once.
                isComposedLatticeMoved(from.stageId, entity.beat, beat)
                    ? Number.POSITIVE_INFINITY
                    : pointerLane - pressLane,
            ),
            size: from.size,
            elevation: from.elevation,
        },
        entity.beat,
        pressLane,
        pointerLane,
    )
}

/** A Note or Slide tool edge resize; `lane` is the fixed edge. */
export const toResizedNoteObject = (
    active: { entity: NoteEntity; lane: number; pressBeat: number; pressLane: number },
    x: number,
    y: number,
) => {
    const { entity } = active
    const lane = xToLane(x) - getComposedNoteOffset(entity)
    const edge = entity.left + (active.lane === entity.left ? entity.size : 0)
    const [left, size] = resize(
        active.lane,
        edge + (lane - active.pressLane),
        minimumNoteSize(entity.noteType),
        Number.POSITIVE_INFINITY,
        edge,
        [entity.left, entity.size],
        getComposedGridOffset(entity.stageId, entity.beat),
    )
    return constrainResized(
        { ...entity, left, size },
        entity.beat,
        active.pressBeat,
        active.pressLane,
        lane,
        y,
    )
}

/** A Note or Slide tool drag's preview; an attached note previews as edited, on its connector. */
export const createEditPreview = (
    edit: (transaction: Transaction, entity: NoteEntity, object: NoteObject) => Entity[],
) => {
    // The edited chart, built once per change of the preview's key.
    let built: { source: State; key: unknown[]; state: State } | undefined
    return {
        show: (entity: NoteEntity, object: NoteObject) => {
            const source = state.value
            const key = [entity, object.beat, object.left, object.size]
            const build = () => {
                const transaction = createTransaction(source)
                return transaction.commit(edit(transaction, entity, object))
            }
            if (
                entity.isAttached &&
                (built?.source !== source ||
                    key.some((value, index) => value !== built?.key[index]))
            )
                built = { source, key, state: build() }
            const edited = entity.isAttached ? built?.state : undefined
            setPreviewEdit(source, () => edited ?? build(), key, { isDrag: true })
            const note = edited?.selectedEntities[0]
            return note?.type === 'note' ? note : undefined
        },
        clear: () => {
            built = undefined
            clearPreviewEdit()
        },
    }
}
