import type { LevelDataEntity } from '@sonolus/core'
import Type from 'typebox'
import { orderStore } from '../local/records/extract'
import type { Store } from '../state/store'

// Editor choices that cannot be represented in playable level data. Recovery
// and clipboard envelopes carry this alongside the level entities.
export const editorMetadataSchema = Type.Object({
    defaultGuideColors: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
})

export type EditorMetadata = Type.Static<typeof editorMetadataSchema>

export const serializeEditorMetadata = (
    entities: readonly LevelDataEntity[],
    store: Store,
): EditorMetadata => {
    // The serializer emits notes in the records' order; pair them in the same
    // order. Record entity indices because import can reorder standalone notes before named slides.
    const notes = orderStore(store).slides.flatMap(({ entity }) => entity)
    let noteIndex = 0
    const defaultGuideColors = entities.flatMap((entity, index) => {
        if (!entity.data.some(({ name }) => name === 'segmentKind')) return []
        const note = notes[noteIndex++]
        return note?.connectorType === 'guide' && note.connectorStyle === 'default' ? [index] : []
    })
    return defaultGuideColors.length ? { defaultGuideColors } : {}
}
