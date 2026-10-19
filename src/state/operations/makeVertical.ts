import type { State } from '..'
import type { Entity } from '../entities'
import { getMakeVerticalChanges } from './makeVerticalValues'
import { getMaterializedNotePositions } from './notePositions'
import { transformSelectionWithReceipt, type SelectionTransformResult } from './transformSelection'

export const makeVerticalWithReceipt = (
    source: State,
    selected: Entity[],
): SelectionTransformResult => {
    const changes = getMakeVerticalChanges(selected, source)
    if (!changes)
        return {
            state: source,
            counts: {},
            replacements: new Map<Entity, Entity>(),
            applications: new Map<Entity, Entity>(),
        }
    const notes = [...changes.keys()].filter((entity) => entity.type === 'note')
    for (const [note, { left, size }] of getMaterializedNotePositions(source, notes)) {
        changes.set(note, { ...changes.get(note), left, size })
    }
    return transformSelectionWithReceipt(source, selected, changes)
}

export const makeVertical = (source: State, selected: Entity[]): State =>
    makeVerticalWithReceipt(source, selected).state
