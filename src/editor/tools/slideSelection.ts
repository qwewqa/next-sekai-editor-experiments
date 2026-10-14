import type { Entity } from '../../state/entities'
import type { SlideId } from '../../state/entities/slides'
import type { NoteEntity } from '../../state/entities/slides/note'

/** Keeps the selection's order, then appends in-scope siblings of each slide. */
export const extendSelectionToSlides = (
    entities: readonly Entity[],
    slides: ReadonlyMap<SlideId, readonly NoteEntity[]>,
    isInScope: (note: NoteEntity) => boolean,
) => {
    const selected = new Set(entities)
    const visited = new Set<SlideId>()
    for (const entity of entities) {
        if (entity.type !== 'note' || visited.has(entity.slideId)) continue
        visited.add(entity.slideId)
        // Slides can span groups and stages; only extend into editable ones.
        for (const note of slides.get(entity.slideId) ?? []) {
            if (isInScope(note)) selected.add(note)
        }
    }
    return [...selected]
}
