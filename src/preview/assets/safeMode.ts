import { platform } from '../../platform'
import { isSafeMode } from '../../safe'

/** Safe mode (`?safe` on the web): no asset choice is loaded, Default is used. */
export const isAssetSafeMode = () => platform.capabilities.safeModeEntry === 'query' && isSafeMode()
