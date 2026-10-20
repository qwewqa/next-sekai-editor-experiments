import type { NoteObject } from '../../chart/note'
import { clipboardEntry } from '../../clipboard'
import { ease } from '../../ease'
import { pushState, state } from '../../history'
import { createHistoryOperation } from '../../history/createHistoryOperation'
import { previewEdit } from '../../preview/edit'
import type { State } from '../../state'
import { createSlideId } from '../../state/entities/slides'
import { sameBeatAttachmentFraction } from '../../state/entities/slides/attachment'
import type { NoteEntity } from '../../state/entities/slides/note'
import { isInteriorTick, toNoteEntity } from '../../state/entities/slides/note'
import { attachFraction } from '../../state/mutations/slides'
import { addNote } from '../../state/mutations/slides/note'
import { countNativeEntities } from '../../state/operations/historyReceipts'
import { createTransaction } from '../../state/transaction'
import { alignComputed, lerp, shiftComputed } from '../../utils/math'
import { getComposedLayout } from '../composedView'
import type { Modifiers } from '../controls/gestures/pointer'
import { constrainLaneObject, minimumNoteSize } from '../laneLimits'
import { notify } from '../notification'
import { revealAuthoringTarget } from '../scope'
import { getNotePropertiesFromSelection } from '../tools/note'
import {
    getComposedPasteDelta,
    getPasteFocus,
    getPasteNoteEntities,
    pasteAtPosition,
    showNoteGhost,
    toMovedNoteObject,
    toPasteBeatOffset,
} from '../tools/paste'
import {
    getSelectedSlideId,
    getSlideInsertAnchor,
    getSlidePropertiesFromSelection,
} from '../tools/slide'
import { previewSlideAdd, showSlideAdd } from '../tools/slide/addPreview'
import { alignLane, toMovedBeat, view } from '../view'
import { sameBeat, type ElevationNote } from './layout'
import { elevationState, getElevationStageProps } from './scene'

const getElevationProperties = (beat: number, asSlide: boolean) =>
    asSlide ? getSlidePropertiesFromSelection(beat) : getNotePropertiesFromSelection()

/** The narrowest note a drag adds, by the Zero-Width Notes setting. */
export const elevationNoteMinimum = (beat: number, asSlide: boolean) =>
    minimumNoteSize(getElevationProperties(beat, asSlide).noteType)

/** Displayed lane of the lattice new notes snap to: their stage's, shown at its offset. */
export const elevationAddOrigin = (beat: number, asSlide: boolean) => {
    const stage = getElevationStageProps(getElevationProperties(beat, asSlide).stageId, beat)
    return stage.laneOffset + stage.gridOffset
}

export const previewElevationNote = (
    lane: number,
    elevation: number,
    beat: number,
    asSlide: boolean,
    size?: number,
) => {
    const properties = getElevationProperties(beat, asSlide)
    const stage = getElevationStageProps(properties.stageId, beat)
    return toNoteEntity(
        asSlide ? (getSelectedSlideId() ?? createSlideId()) : createSlideId(),
        constrainLaneObject(
            {
                ...properties,
                beat,
                left: alignLane(lane - stage.laneOffset - stage.gridOffset) + stage.gridOffset,
                elevation: elevation - stage.elevation,
                size: size ?? properties.size,
            },
            { resizing: size !== undefined },
        ),
    )
}

// A Slide add at the selected note's beat goes right after it, at its beat exactly.
const elevationAdd = (
    source: State,
    lane: number,
    elevation: number,
    beat: number,
    asSlide: boolean,
    size?: number,
) => {
    const after = asSlide ? getSlideInsertAnchor(source, beat) : undefined
    return {
        note: previewElevationNote(lane, elevation, after?.beat ?? beat, asSlide, size),
        after,
    }
}

/**
 * The add ghost's row; an add inside a slide shows with the pieces it changes, and an attached
 * note on its path, where it lands.
 */
export const previewElevationNoteRow = (
    lane: number,
    elevation: number,
    beat: number,
    asSlide: boolean,
    size?: number,
): ElevationNote => {
    const source = previewEdit.value?.isDraft ? elevationState.value : state.value
    const { note, after } = elevationAdd(source, lane, elevation, beat, asSlide, size)
    const { laneOffset } = getElevationStageProps(note.stageId, beat)
    const shown = (point: NoteEntity) =>
        point.elevation + getElevationStageProps(point.stageId, beat).elevation
    const row = {
        note,
        lane: note.left + note.size / 2 + laneOffset,
        size: note.size,
        elevation: shown(note),
        attached: false,
        order: 0,
    }
    // As the chart's Slide ghost: placed by a throwaway add, on a pending draft's path, as drawn.
    const preview = previewSlideAdd(source, note.slideId, note, after)
    if (!preview) return row
    if (!note.isAttached) {
        showSlideAdd(preview, note)
        return row
    }
    const { landed } = preview
    const slide = preview.infos.get(note.slideId) ?? []
    const index = slide.findIndex((info) => info.note === landed)
    const info = index > 0 && index < slide.length - 1 ? slide[index] : undefined
    const position =
        getComposedLayout(elevationState.value)?.notePosition(landed, landed.beat, {
            slideInfos: slide,
        }) ?? landed
    return {
        // Its own stage's offset puts it there on the chart too.
        note: showSlideAdd(
            preview,
            toNoteEntity(note.slideId, {
                ...note,
                left: position.left - laneOffset,
                size: position.size,
            }),
        ),
        lane: position.left + position.size / 2,
        size: position.size,
        elevation: info
            ? attachedElevation(landed, info.attachHead, info.attachTail, 0, shown)
            : shown(landed),
        attached: !!info,
        order: 0,
    }
}

export const createElevationNote = (
    lane: number,
    elevation: number,
    beat: number,
    asSlide: boolean,
    size?: number,
) => {
    const { note, after } = elevationAdd(state.value, lane, elevation, beat, asSlide, size)
    // Authoring reveals its target so the new note never vanishes.
    revealAuthoringTarget(note)
    const transaction = createTransaction(state.value)
    const entities = addNote(transaction, note.slideId, note, after)
    const operation = createHistoryOperation({
        id: 'nse.note.add',
        data: { created: countNativeEntities(entities).note ?? 0 },
    })
    const pushed = pushState(operation, transaction.commit(entities))
    view.entities = { hovered: [], creating: [] }
    if (pushed) notify(() => operation.fallback.text)
}

// A pasted note's shown elevation before the change; an attached one follows its pasted head and tail.
const pastedElevation = (note: NoteEntity, notes: NoteEntity[], beatOffset: number) => {
    const beat = toMovedBeat(note.beat, beatOffset)
    const shown = (point: NoteEntity) =>
        point.elevation + getElevationStageProps(view.stageId ?? point.stageId, beat).elevation
    const slide = notes.filter((other) => other.slideId === note.slideId)
    const index = slide.indexOf(note)
    // As the store attaches: to the nearest unattached notes, or the slide's ends.
    const isEnd = (other: NoteEntity) =>
        !other.isAttached || other === slide[0] || other === slide.at(-1)
    const head = slide.slice(0, index).reverse().find(isEnd)
    const tail = slide.slice(index + 1).find(isEnd)
    if (!note.isAttached || !head || !tail) return shown(note)
    return attachedElevation(note, head, tail, beatOffset, shown)
}

// An attached note's shown elevation between its head and tail, as the editor draws it.
const attachedElevation = (
    note: NoteEntity,
    head: NoteEntity,
    tail: NoteEntity,
    beatOffset: number,
    shown: (point: NoteEntity) => number,
) =>
    lerp(
        shown(head),
        shown(tail),
        sameBeatAttachmentFraction(head, tail, note) ??
            ease(
                head.connectorEase,
                attachFraction(
                    state.value.bpms,
                    toMovedBeat(head.beat, beatOffset),
                    toMovedBeat(tail.beat, beatOffset),
                    toMovedBeat(note.beat, beatOffset),
                ),
            ),
    )

const getElevationPaste = (lane: number, elevation: number, beat: number, modifiers: Modifiers) => {
    const data = clipboardEntry.value?.data
    const notes = getPasteNoteEntities()
    // The chart paste's focus lands under the pointer.
    const focus = data && getPasteFocus(notes, data.lane, data.anchor, data.beat)
    if (!data || !focus) return
    const beatOffset = toPasteBeatOffset(notes, beat - data.beat)
    // Every note takes one authored elevation change, landing the focus at the pointer.
    const elevationDelta = elevation - pastedElevation(focus, notes, beatOffset)
    // In Composed every note takes the chart paste's one authored lane delta.
    const delta = getComposedLayout(elevationState.value)
        ? (getComposedPasteDelta(
              notes,
              data.lane,
              lane,
              beatOffset,
              modifiers.shift,
              data.anchor,
              data.beat,
          ) ?? 0)
        : undefined
    const mapNote = (note: NoteEntity, destinationBeat: number) => {
        const moved = toMovedNoteObject(
            note,
            data.lane,
            lane,
            destinationBeat,
            modifiers.shift,
            false,
        )
        return constrainLaneObject({
            ...moved,
            ...(delta !== undefined && {
                left: modifiers.shift
                    ? alignComputed(2 * data.lane - note.left - note.size + delta)
                    : shiftComputed(note.left, delta),
                size: note.size,
            }),
            elevation: note.elevation + elevationDelta,
        })
    }
    return { notes, mapNote, beatOffset, startLane: data.lane }
}

export const previewElevationPaste = (
    lane: number,
    elevation: number,
    beat: number,
    modifiers: Modifiers,
) => {
    const paste = getElevationPaste(lane, elevation, beat, modifiers)
    if (!paste) return { notes: [], infos: undefined }
    const slides = new Map<NoteEntity['slideId'], NoteObject[]>()
    for (const note of paste.notes) {
        const object = paste.mapNote(note, toMovedBeat(note.beat, paste.beatOffset))
        const slide = slides.get(note.slideId)
        if (slide) slide.push(object)
        else slides.set(note.slideId, [object])
    }
    // Built as the store will place it, so attached notes show where they land.
    return showNoteGhost([...slides.values()])
}

/** The paste ghost's rows at a beat: lanes and elevations as they will show once pasted. */
export const previewElevationPasteRows = (
    lane: number,
    elevation: number,
    beat: number,
    modifiers: Modifiers,
): ElevationNote[] => {
    const { notes, infos } = previewElevationPaste(lane, elevation, beat, modifiers)
    const composed = getComposedLayout(elevationState.value)
    return notes
        .filter((note) => sameBeat(note.beat, beat))
        .map((note, order) => {
            const slide = infos?.get(note.slideId) ?? []
            const index = slide.findIndex((info) => info.note === note)
            const info = isInteriorTick(note, index, slide) && slide[index]
            const shown = (point: NoteEntity) =>
                point.elevation + getElevationStageProps(point.stageId, note.beat).elevation
            const position = composed?.notePosition(note, note.beat, { slideInfos: slide }) ?? note
            return {
                note,
                lane: position.left + position.size / 2,
                size: position.size,
                elevation: info
                    ? attachedElevation(note, info.attachHead, info.attachTail, 0, shown)
                    : shown(note),
                attached: !!info,
                order,
            }
        })
}

export const pasteElevationNotes = async (
    lane: number,
    elevation: number,
    beat: number,
    modifiers: Modifiers,
    at: 'pointer' | 'position' = 'position',
) => {
    const paste = getElevationPaste(lane, elevation, beat, modifiers)
    if (!paste) return
    await pasteAtPosition(lane, paste.beatOffset, modifiers, {
        notesOnly: true,
        mapNote: paste.mapNote,
        at,
    })
}
