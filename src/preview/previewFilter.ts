import { testKeysOpen } from '../platform/testKeys'
import type { PreviewFilter } from './gl'

/**
 * Test builds: the atlas filter that `nse.test.previewFilter` names (`single`, `3` or `4`), so
 * one build can compare them. Every other build, and any other value, uses 4. The main thread
 * reads it for each renderer it creates and passes it to the preview's worker and to Export
 * Video, which cannot read the page's storage.
 */
export const readPreviewFilter = (): PreviewFilter => {
    if (!testKeysOpen) return 4
    try {
        const value = localStorage.getItem('nse.test.previewFilter')
        return value === 'single' ? 'single' : value === '3' ? 3 : 4
    } catch {
        return 4
    }
}
