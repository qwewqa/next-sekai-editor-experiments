import type { NoteObject } from '../../../chart/note'
import type { State } from '../../../state'
import type { Entity } from '../../../state/entities'
import type { SlideId } from '../../../state/entities/slides'
import type { ConnectorEntity } from '../../../state/entities/slides/connector'
import type { NoteEntity } from '../../../state/entities/slides/note'
import { addNote } from '../../../state/mutations/slides/note'
import type { StoreSlides } from '../../../state/store/slides'
import { createTransaction } from '../../../state/transaction'

/** An add into an existing slide, as a throwaway transaction lands it. */
export type SlideAddPreview = {
    /** The added note, as the store places it. */
    landed: NoteEntity
    result: State
    /** Pieces the slide lacks before the add. */
    connectors: ConnectorEntity[]
    /** Ticks the add re-attaches, at their new lanes. */
    ticks: NoteEntity[]
    infos: StoreSlides['info']
}

// The last add, so a hover within one snapped placement doesn't rebuild it.
let last: { keys: unknown[]; preview: SlideAddPreview } | undefined

// Object values are skipped: addNote reads only the primitives.
const toKeys = (source: State, slideId: SlideId, object: NoteObject): unknown[] => [
    source,
    slideId,
    ...Object.entries(object).flatMap((entry) => (typeof entry[1] === 'object' ? [] : entry)),
]

/** An add into the slide, if it exists in the source. */
export const previewSlideAdd = (source: State, slideId: SlideId, object: NoteObject) => {
    if (!source.store.slides.note.has(slideId)) return
    const keys = toKeys(source, slideId, object)
    if (last?.keys.length === keys.length && last.keys.every((key, i) => key === keys[i]))
        return last.preview
    const transaction = createTransaction(source)
    const result = transaction.commit(addNote(transaction, slideId, object))
    const landed = result.selectedEntities[0] as NoteEntity
    const kept = new Set(source.store.slides.note.get(slideId))
    // Pieces the slide lacks, as a drag's ghosts: the pair rule.
    const tails = new Map(
        (source.store.slides.connector.get(slideId) ?? []).map(({ head, tail }) => [head, tail]),
    )
    const preview = {
        landed,
        result,
        connectors: (result.store.slides.connector.get(slideId) ?? []).filter(
            (connector) => tails.get(connector.head) !== connector.tail,
        ),
        // A tick rebuildSlide moves is replaced.
        ticks: (result.store.slides.note.get(slideId) ?? []).filter(
            (note) => note !== landed && !kept.has(note),
        ),
        infos: result.store.slides.info,
    }
    last = { keys, preview }
    return preview
}

// The add ghost shown, in either pane, with its preview.
let shown: { ghost: NoteEntity; preview: SlideAddPreview } | undefined

/** Shows an add's ghost note with its preview's ribbons and ticks. */
export const showSlideAdd = (preview: SlideAddPreview, ghost: NoteEntity) => {
    shown = { ghost, preview }
    return ghost
}

/** The preview of the add ghost these ghosts are, if they are one. */
export const slideAddGhost = (ghosts: readonly Entity[]) =>
    shown && ghosts.length === 1 && ghosts[0] === shown.ghost ? shown.preview : undefined
