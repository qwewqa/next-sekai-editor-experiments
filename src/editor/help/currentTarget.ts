import { isPeeking } from '../../history/stack'
import { isElevationEditorOpen, isElevationSideBySide } from '../elevation/state'
import { toolName } from '../tools/state'
import { helpTargetFor } from './target'

/** The entry Help opens at now. */
export const helpTarget = () =>
    helpTargetFor({
        peeking: isPeeking.value,
        elevationFull: isElevationEditorOpen.value && !isElevationSideBySide.value,
        tool: toolName.value,
    })
