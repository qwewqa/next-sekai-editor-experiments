import { platform as buildPlatform } from '#platform'
import { startDetection } from './detect'
import type { Platform } from './types'

export { diskStateOfBytes, levelDataDiskState } from './fingerprint'
export * from './types'
export { appVersion, type AppVersion } from './version'

/** The platform this build runs on; tests swap it with setPlatformForTests. */
export let platform: Platform = buildPlatform

/** Injects a platform, such as the mock; undefined restores the build's own. */
export const setPlatformForTests = (p: Platform | undefined) => {
    platform = p ?? buildPlatform
}

// Latch the standalone flag at startup, before any fullscreen.
if (typeof window !== 'undefined') startDetection()
