import { testKeysOpen } from '../platform/testKeys'
import type { ComboPixels } from './engine/comboDraw'
import type { OutlineAlpha } from './outlineRenderer'

/** Test builds: what the preview specs read of the preview, whichever host draws it. */
export type PreviewTestHandle = {
    host: 'main' | 'worker'
    /** The selection outline's drawn pixels; none while it has no context. */
    outlineAlpha: () => Promise<OutlineAlpha | undefined>
    /**
     * Draws the last frame again and reads its combo in the same task, from the frame and from
     * the text texture; none while no combo is drawn.
     */
    comboPixels: () => Promise<ComboPixels | undefined>
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
