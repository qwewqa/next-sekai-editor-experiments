import { shallowRef } from 'vue'

/**
 * Set while Export Video is open. The preview then frees its atlas textures and draws nothing, so
 * its canvas keeps the last frame. It uploads the current atlases and draws again once cleared.
 */
export const previewSuspended = shallowRef(false)
