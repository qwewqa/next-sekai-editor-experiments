import { settings } from '../../settings'
import { isMinimapShown } from '../workspace'

export { isMinimapShown }

/** Shows or hides the minimap by saving the opposite of what is shown now. */
export const toggleMinimap = () => {
    settings.showMinimap = !isMinimapShown.value
}
