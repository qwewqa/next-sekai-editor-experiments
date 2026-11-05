import { shallowRef } from 'vue'

/**
 * Set while Export Video is open. The preview then frees its textures and draws nothing, so
 * its canvas keeps the last frame. Once cleared, it uploads the current images and draws again.
 */
export const previewSuspended = shallowRef(false)
