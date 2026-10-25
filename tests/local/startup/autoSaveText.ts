import { serializeAutoSave } from '../../../src/history/autoSave/serialize'
import { serializeEditorMetadata } from '../../../src/levelData/editorMetadata'
import { serializeToLevelData } from '../../../src/levelData/serialize'
import type { State } from '../../../src/state'

/** The old auto save's value for a state, in the format v0.5.22 wrote; `edit` changes its level data. */
export const autoSaveText = (
    state: State,
    filename = 'coconut',
    edit?: (levelData: ReturnType<typeof serializeToLevelData>) => void,
) => {
    const levelData = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )
    edit?.(levelData)
    return JSON.stringify(
        serializeAutoSave(
            levelData,
            filename,
            serializeEditorMetadata(levelData.entities, state.store),
        ),
    )
}
