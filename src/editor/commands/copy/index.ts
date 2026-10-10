import type { LevelDataEntity } from '@sonolus/core'
import type { Command } from '..'
import { setClipboardData } from '../../../clipboard/index.ts'
import { state } from '../../../history'
import { chartSessionId } from '../../../history/chartSession'
import { isDynamicStages } from '../../../history/dynamicStages.ts'
import { groups } from '../../../history/groups'
import { initialLife } from '../../../history/initialLife'
import { selectedEntities } from '../../../history/selectedEntities'
import { stages } from '../../../history/stages'
import { store } from '../../../history/store'
import { i18n } from '../../../i18n'
import { serializeEditorMetadata } from '../../../levelData/editorMetadata'
import { serializeToLevelDataEntities } from '../../../levelData/entities/serialize'
import type { Entity, EntityOfType, EntityType } from '../../../state/entities'
import type { NoteEntity } from '../../../state/entities/slides/note'
import { getDetachedNotePositions } from '../../../state/operations/notePositions'
import { inStoredOrder } from '../../../state/operations/transformSelection'
import { createStore } from '../../../state/store/creates'
import { interpolate } from '../../../utils/interpolate'
import { createComposedLayout } from '../../composed'
import { notify } from '../../notification'
import { hitAllEntitiesAtPoint } from '../../tools/utils'
import { view, yToValidBeat } from '../../view'
import CopyIcon from './CopyIcon.vue'

export const copy: Command = {
    title: () => i18n.value.commands.copy.title,
    icon: {
        is: CopyIcon,
    },

    execute() {
        const entities = selectedEntities.value

        if (!entities.length) {
            notify(() => i18n.value.commands.copy.noSelected)
            return
        }

        const copied = getCopiedSlides(entities)
        const copiedStore = createStore(
            {
                initialLife: initialLife.value,
                isDynamicStages: isDynamicStages.value,
                bpms: getEntities(entities, 'bpm'),
                timeScales: getEntities(entities, 'timeScale'),
                cameraEvents: getEntities(entities, 'cameraEventJoint'),
                stageMaskEvents: getEntities(entities, 'stageMaskEventJoint'),
                stagePivotEvents: getEntities(entities, 'stagePivotEventJoint'),
                stageStyleEvents: getEntities(entities, 'stageStyleEventJoint'),
                stageTransformEvents: getEntities(entities, 'stageTransformEventJoint'),
                groups: groups.value,
                stages: stages.value,
                slides: copied.slides,
            },
            // The selection may hold no BPM; attached notes keep their document places.
            state.value.bpms,
        )
        const copiedEntities = serializeToLevelDataEntities(
            initialLife.value,
            isDynamicStages.value,
            copiedStore,
            groups.value,
            stages.value,
        )

        const anchor = getAnchor(entities, view.pointer.x, view.pointer.y)
        const kept = anchor.note && copied.positions.get(anchor.note)
        setClipboardData({
            lane: kept ? kept.left + kept.size / 2 : anchor.lane,
            beat: anchor.beat,
            anchor: getClipboardAnchor(entities, copiedEntities, anchor.note),
            entities: copiedEntities,
            ...serializeEditorMetadata(copiedEntities, copiedStore),
            source: clipboardSource(),
        })

        notify(interpolate(() => i18n.value.commands.copy.copied, `${entities.length}`))
    },
}

/** Lets a paste into the same chart keep each object's own group and stage. */
export const clipboardSource = () => ({
    chart: chartSessionId(),
    groups: [...groups.value.keys()],
    // Stages are listed only with dynamic stages.
    ...(isDynamicStages.value ? { stages: [...stages.value.keys()] } : {}),
})

const getAnchor = (entities: Entity[], x: number, y: number) => {
    const hitEntities = hitAllEntitiesAtPoint(x, y)
        .filter((entity) => entities.includes(entity))
        .sort((a, b) => a.beat - b.beat)
    const sortedEntities = [...entities].sort((a, b) => a.beat - b.beat)

    const note =
        hitEntities.find((entity) => entity.type === 'note') ??
        sortedEntities.find((entity) => entity.type === 'note')
    if (note)
        return {
            lane: note.left + note.size / 2,
            beat: note.beat,
            note,
        }

    const entity = hitEntities[0] ?? sortedEntities[0]
    return {
        lane: 0,
        beat: entity?.beat ?? yToValidBeat(y),
        note: undefined,
    }
}

/** A cut keeps its free pointer anchor in both the authored and displayed layouts, in either pane. */
export const getComposedClipboardOffset = (
    entities: Entity[],
    x: number,
    y: number,
    kept?: ReadonlyMap<NoteEntity, { left: number }>,
) => {
    const { note } = getAnchor(entities, x, y)
    if (!note) return 0
    const drawn =
        view.layout === 'composed' && state.value.isDynamicStages
            ? createComposedLayout(state.value).notePosition(note).left
            : note.left
    // A kept tick is copied at its gameplay place, not where it is drawn.
    return drawn - (kept?.get(note)?.left ?? note.left)
}

/** Keep the chosen note's identity even when raw lanes and beats overlap across stages. */
export const getClipboardAnchor = (
    entities: Entity[],
    serialized: LevelDataEntity[],
    note: NoteEntity | undefined = getAnchor(entities, view.pointer.x, view.pointer.y).note,
) => {
    if (!note) return
    const ordinal = getSlides(entities).flat().indexOf(note)
    let index = 0
    for (const [entityIndex, entity] of serialized.entries()) {
        if (
            !entity.data.some((property) => property.name === '#TIMESCALE_GROUP') ||
            !entity.data.some((property) => property.name === 'lane')
        )
            continue
        if (index++ === ordinal) return entityIndex
    }
}

// A same-beat pair keeps its stored order, whatever the selection order.
const getEntities = <T extends EntityType>(entities: Entity[], type: T) =>
    inStoredOrder(
        state.value,
        entities.filter((entity): entity is EntityOfType<T> => entity.type === type),
        (entity) => entity,
    )

/** Copied slides, where a part's end that was an interior attached tick keeps its gameplay place. */
export const getCopiedSlides = (entities: Entity[]) => {
    const slides = getSlides(entities)
    const positions = getDetachedNotePositions(
        state.value,
        slides.flatMap((notes) => [notes[0], notes.at(-1)]).filter((note) => note !== undefined),
    )
    return {
        slides: slides.map((notes) =>
            notes.map((note) => {
                const position = (note === notes[0] || note === notes.at(-1)) && positions.get(note)
                return position ? { ...note, ...position } : note
            }),
        ),
        positions,
    }
}

/** Each touched slide's selected notes, in the slide's own order. */
export const getSlides = (entities: Entity[]) => {
    const selectedNotes = entities.filter((entity) => entity.type === 'note')
    const selectedNotesSet = new Set(selectedNotes)

    return [...new Set(selectedNotes.map((note) => note.slideId))].map((slideId) => {
        const notes = store.value.slides.note.get(slideId)
        if (!notes) throw new Error('Unexpected notes not found')

        return notes.filter((note) => selectedNotesSet.has(note))
    })
}
