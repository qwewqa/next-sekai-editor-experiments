import { testKeysOpen } from '../platform/testKeys'

/** Test builds: what the preview specs read of the preview, whichever host draws it. */
export type PreviewTestHandle = {
    host: 'main' | 'worker'
    /** The selection outline's pixels with any alpha. */
    outlinePixels: () => Promise<number>
}

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        nsePreviewTest?: PreviewTestHandle
    }
}

/** Sets the handle while a preview is mounted; the returned function clears it. */
export const exposePreviewTest = (handle: PreviewTestHandle) => {
    if (!testKeysOpen) return () => undefined
    window.nsePreviewTest = handle
    return () => {
        if (window.nsePreviewTest === handle) window.nsePreviewTest = undefined
    }
}
