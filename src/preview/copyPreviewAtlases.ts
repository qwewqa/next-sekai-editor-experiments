import { watch } from 'vue'
import { assetSession } from './assets'
import { copyAtlasBitmap } from './copyAtlasBitmap'
import type { LoadedParticle } from './particle'
import type { LoadedSkin } from './skin'
import { ensurePreviewResources } from './usePreviewResources'
import { copyWorkerAtlas } from './worker/host'

export type PreviewAtlasCopyResult =
    | { status: 'copied'; skin: LoadedSkin; particle?: LoadedParticle }
    | { status: 'failed'; error: unknown }
    | { status: 'cancelled' }

/** Copies the shown atlases. The caller owns and closes each returned texture. */
export const copyPreviewAtlases = (signal: AbortSignal): Promise<PreviewAtlasCopyResult> =>
    new Promise((resolve) => {
        const controller = new AbortController()
        const copies: ImageBitmap[] = []
        let finished = false
        let copying = false
        let stopWatching: () => void = () => undefined
        const finish = (result: PreviewAtlasCopyResult) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            stopWatching()
            signal.removeEventListener('abort', cancel)
            controller.abort()
            if (result.status !== 'copied') for (const bitmap of copies) bitmap.close()
            resolve(result)
        }
        const cancel = () => {
            finish({ status: 'cancelled' })
        }
        // Loading and copying share a deadline, including an unresponsive worker.
        const timer = setTimeout(() => {
            finish({ status: 'failed', error: new Error('Preview atlas copies timed out') })
        }, 30_000)
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) {
            cancel()
            return
        }

        const copy = async (slot: 0 | 1, loaded: LoadedSkin | LoadedParticle) => {
            const bitmap = await (loaded.texture.width
                ? copyAtlasBitmap(loaded.texture)
                : copyWorkerAtlas(slot, loaded, controller.signal))
            // createImageBitmap cannot be cancelled; a late copy still needs closing.
            if (finished) bitmap.close()
            else copies.push(bitmap)
            return bitmap
        }
        const { slots } = assetSession
        const start = () => {
            if (finished || copying) return
            const skin = slots.skin.value
            const particle = slots.particle.value
            if (skin.state === 'failed') {
                finish({ status: 'failed', error: skin.error })
                return
            }
            if (!skin.value || (particle.state !== 'ready' && particle.state !== 'failed')) return
            copying = true
            const shownSkin = skin.value
            const shownParticle = particle.value
            void Promise.all([
                copy(0, shownSkin),
                shownParticle ? copy(1, shownParticle) : undefined,
            ]).then(
                ([skinTexture, particleTexture]) => {
                    finish({
                        status: 'copied',
                        skin: { ...shownSkin, texture: skinTexture },
                        particle:
                            shownParticle && particleTexture
                                ? { ...shownParticle, texture: particleTexture }
                                : undefined,
                    })
                },
                (error: unknown) => {
                    finish({ status: 'failed', error })
                },
            )
        }
        ensurePreviewResources()
        stopWatching = watch([slots.skin, slots.particle], start)
        start()
    })
