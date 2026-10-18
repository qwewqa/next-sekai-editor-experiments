import { serializeAutoSave } from '../../../src/history/autoSave/serialize'
import { serializeEditorMetadata } from '../../../src/levelData/editorMetadata'
import { serializeToLevelData } from '../../../src/levelData/serialize'
import type { State } from '../../../src/state'

/** The old auto save's value for a state, as today's editor writes it. */
export const autoSaveText = (state: State, filename = 'coconut') => {
    const levelData = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )
    return JSON.stringify(
        serializeAutoSave(
            levelData,
            filename,
            serializeEditorMetadata(levelData.entities, state.store),
        ),
    )
}
