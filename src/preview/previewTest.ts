import { testKeysOpen } from '../platform/testKeys'

/** Test builds: what the preview specs read of the preview, whichever host draws it. */
export type PreviewTestHandle = {
    host: 'main' | 'worker'
    /** The selection outline's pixels with any alpha. */
    outlinePixels: () => Promise<number>
    /** Resolves once the worker host has drawn the frames asked for; at once in the main host. */
    settled: () => Promise<void>
    /** The worker host's context loss, which the specs cannot reach; resolves once it is handled. */
    setContextLost: (lost: boolean) => Promise<void>
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
