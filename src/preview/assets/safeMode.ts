import { platform } from '../../platform'

/** Safe mode (`?safe` on the web): no asset choice is loaded, Default is used (Part 2, 2.4.2). */
export const isAssetSafeMode = () =>
    platform.capabilities.safeModeEntry === 'query' &&
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).has('safe')
