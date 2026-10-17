import { computed, onMounted, ref, watch } from 'vue'
import { errorMessage } from '../utils/error'
import { AssetError, assetSession } from './assets'

// Decoded skin and particle atlases are shared by every preview mount for the
// lifetime of the page. Closing, covering, moving, or recreating a preview's
// WebGL context re-uploads these bitmaps instead of downloading and decoding
// them again. Only successful loads are cached; failures retry on next use.
const { slots } = assetSession
const skin = computed(() => slots.skin.value.value)
const particle = computed(() => slots.particle.value.value)
const background = computed(() => slots.background.value.value)
const skinState = computed(() => slots.skin.value.state)
const skinError = computed(() => {
    const { error } = slots.skin.value
    // A missing skin has no detail to show.
    return error === undefined || (error instanceof AssetError && error.code === 'missing')
        ? ''
        : errorMessage(error)
})

// The particle loads once the skin shows; a particle failure never blocks the preview.
watch(skinState, (state) => {
    if (state === 'ready') assetSession.ensure('particle')
})

/** Starts loading anything not yet cached. Concurrent callers share one load. */
export const ensurePreviewResources = () => {
    assetSession.ensure('background')
    assetSession.ensure('skin')
    if (skinState.value === 'ready') assetSession.ensure('particle')
}

/** Discards failed state and retries the downloads. Cached atlases are kept. */
export const reloadPreviewResources = () => {
    for (const type of ['skin', 'background', 'particle'] as const) assetSession.retry(type)
    ensurePreviewResources()
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        assetSession.dispose()
    })
}

export const usePreviewResources = () => {
    // Graphics failures belong to one preview's canvas and never poison the cache.
    const graphicsError = ref<string>()
    const loadVersion = ref(0)

    const status = computed<'loading' | 'missing' | 'error' | 'ready'>(() => {
        if (skinState.value === 'failed') return 'missing'
        if (skinState.value !== 'ready') return 'loading'
        return graphicsError.value === undefined ? 'ready' : 'error'
    })
    const errorDetail = computed(() =>
        status.value === 'error' ? (graphicsError.value ?? '') : skinError.value,
    )

    const setGraphicsError = (error: unknown) => {
        graphicsError.value = errorMessage(error)
    }
    const clearGraphicsError = () => {
        graphicsError.value = undefined
    }

    const reload = () => {
        if (status.value === 'error') {
            // A new canvas gets a new context; the cached atlases are re-uploaded.
            clearGraphicsError()
            loadVersion.value++
            return
        }
        reloadPreviewResources()
    }

    onMounted(ensurePreviewResources)

    return {
        skin,
        particle,
        background,
        status,
        errorDetail,
        loadVersion,
        reload,
        setGraphicsError,
        clearGraphicsError,
    }
}
