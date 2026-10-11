import type { NoteEntity } from './note'
import { getActiveNoteRole, type SlideNoteInfo } from './semantics'

type NoteInfo = SlideNoteInfo

/** The part a note plays as it is shown and hit: drawing and hit-testing both read it. */
export type NoteVisualType = 'anchor' | 'damage' | 'trace' | 'tick' | 'single' | 'head' | 'tail'

// Creation and paste ghosts can refer to a note in the existing slide or be a
// new insertion. Keep their role calculation identical to committed notes.
export const getNoteVisualType = (
    entity: NoteEntity,
    infos?: readonly NoteInfo[],
    lookup?: ReadonlyMap<NoteEntity, NoteInfo>,
): NoteVisualType => {
    if (entity.noteType === 'anchor') return 'anchor'
    if (entity.noteType === 'damage') return 'damage'
    if (entity.noteType === 'trace') return 'trace'
    if (entity.noteType === 'forceTick') return 'tick'
    if (!infos) return 'single'

    const infoEntity = entity.useInfoOf ?? entity
    const info = lookup ? lookup.get(infoEntity) : infos.find(({ note }) => note === infoEntity)
    if (info) {
        const activeRole = getActiveNoteRole(info)
        return activeRole === 'middle'
            ? infoEntity.noteType === 'default'
                ? 'tick'
                : 'single'
            : activeRole
    }
    if (!infos.length) return 'single'

    let isActive = false
    let i = 0
    for (; i < infos.length; i++) {
        const info = infos[i]
        if (!info) break
        if (entity.beat < info.note.beat) break
        if (i === 0 || info.note.isConnectorSeparator) {
            isActive = info.note.connectorType === 'active'
        }
    }

    if (isActive) {
        if (!infos[i]) return 'tail'
        if (entity.isConnectorSeparator && entity.connectorType !== 'active') return 'tail'
        return 'tick'
    }
    if (!infos[i - 1]) return entity.connectorType === 'active' ? 'head' : 'single'
    if (!infos[i]) return 'single'
    return entity.isConnectorSeparator && entity.connectorType === 'active' ? 'head' : 'single'
}
