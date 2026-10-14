import type { Entity } from '../../state/entities'
import type { SlideId } from '../../state/entities/slides'
import type { NoteEntity } from '../../state/entities/slides/note'

/** Whether extending selected slides would add an in-scope note. */
export const canSelectSlideNotes = (
    selection: readonly Entity[],
    slides: ReadonlyMap<SlideId, readonly NoteEntity[]>,
    isInScope: (note: NoteEntity) => boolean,
) => {
    const selected = new Set(selection)
    const visited = new Set<SlideId>()
    for (const entity of selection) {
        if (entity.type !== 'note' || visited.has(entity.slideId)) continue
        visited.add(entity.slideId)
        // Selection never extends into hidden or dimmed groups/stages.
        if (slides.get(entity.slideId)?.some((note) => !selected.has(note) && isInScope(note)))
            return true
    }
    return false
}
