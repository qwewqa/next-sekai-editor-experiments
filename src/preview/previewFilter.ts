import { testKeysOpen } from '../platform/testKeys'
import type { PreviewFilter } from './gl'

/**
 * The atlas filter for a renderer: 4x4 taps with Antialiasing on, the single tap with it off.
 * In test builds, `nse.test.previewFilter` (`single`, `3` or `4`) overrides it, so one build can
 * compare them. The main thread reads it for each renderer it creates and passes it to the
 * preview's worker and to Export Video, which cannot read the page's storage.
 */
export const readPreviewFilter = (antialias: boolean): PreviewFilter => {
    const filter = antialias ? 4 : 'single'
    if (!testKeysOpen) return filter
    try {
        const value = localStorage.getItem('nse.test.previewFilter')
        return value === 'single' ? 'single' : value === '3' ? 3 : value === '4' ? 4 : filter
    } catch {
        return filter
    }
}
