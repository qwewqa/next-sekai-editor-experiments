import { computed, onMounted, ref, shallowRef } from 'vue'
import { errorMessage } from '../utils/error'
import {
    AssetError,
    assets,
    type AssetChoice,
    type LoadContext,
    type LoadedBackground,
} from './assets'
import type { LoadedParticle } from './particle'
import type { LoadedSkin } from './skin'

// Choosing assets arrives with the Preview Assets dialog; until then Default is used.
const choice: AssetChoice = { source: 'default' }
// Neither preview resource needs audio.
const loadContext = (signal: AbortSignal): LoadContext => ({
    signal,
    decodeAudio: () => Promise.reject(new Error('Preview resources have no audio')),
})

// Decoded skin and particle atlases are shared by every preview mount for the
// lifetime of the page. Closing, covering, moving, or recreating a preview's
// WebGL context re-uploads these bitmaps instead of downloading and decoding
// them again. Only successful loads are cached; failures retry on next use.
const skin = shallowRef<LoadedSkin>()
const particle = shallowRef<LoadedParticle>()
const background = shallowRef<LoadedBackground>()
const skinStatus = ref<'idle' | 'loading' | 'missing' | 'ready'>('idle')
const skinError = ref('')
let particleStatus: 'idle' | 'loading' | 'done' = 'idle'
let loadController: AbortController | undefined

const loadParticle = async (signal: AbortSignal) => {
    if (particleStatus !== 'idle') return
    particleStatus = 'loading'
    try {
        const loaded = await assets.load('particle', choice, loadContext(signal))
        if (!loaded) return
        particle.value = loaded.value
        particleStatus = 'done'
    } catch (error) {
        if (signal.aborted) return
        // A missing particle package is a valid configuration; effects are skipped.
        if (error instanceof AssetError && error.code === 'missing') {
            particleStatus = 'done'
            return
        }
        console.error('Failed to load preview particle:', error)
    } finally {
        if (!signal.aborted && particleStatus === 'loading') particleStatus = 'idle'
    }
}

const loadBackground = async (signal: AbortSignal) => {
    if (background.value) return
    try {
        const loaded = await assets.load('background', choice, loadContext(signal))
        if (loaded) background.value = loaded.value
    } catch (error) {
        if (!signal.aborted) console.error('Failed to load preview background:', error)
    }
}

const load = async (signal: AbortSignal) => {
    void loadBackground(signal)
    if (!skin.value) {
        skinStatus.value = 'loading'
        skinError.value = ''
        try {
            const loaded = await assets.load('skin', choice, loadContext(signal))
            if (!loaded) return
            skin.value = loaded.value
        } catch (error) {
            if (signal.aborted) return
            skinStatus.value = 'missing'
            // A missing skin has no detail to show.
            if (error instanceof AssetError && error.code === 'missing') return
            console.error('Failed to load preview skin:', error)
            skinError.value = errorMessage(error)
            return
        }
    }
    skinStatus.value = 'ready'
    await loadParticle(signal)
}

/** Starts loading anything not yet cached. Concurrent callers share one load. */
export const ensurePreviewResources = () => {
    if (skinStatus.value === 'loading') return
    if (skin.value) {
        skinStatus.value = 'ready'
        if (particleStatus !== 'idle') return
    }
    loadController = new AbortController()
    void load(loadController.signal)
}

/** Discards failed state and retries the downloads. Cached atlases are kept. */
export const reloadPreviewResources = () => {
    loadController?.abort()
    if (particleStatus === 'loading') particleStatus = 'idle'
    skinStatus.value = 'idle'
    ensurePreviewResources()
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        loadController?.abort()
        skin.value?.texture.close()
        particle.value?.texture.close()
    })
}

export const usePreviewResources = () => {
    // Graphics failures belong to one preview's canvas and never poison the cache.
    const graphicsError = ref<string>()
    const loadVersion = ref(0)

    const status = computed<'loading' | 'missing' | 'error' | 'ready'>(() => {
        if (skinStatus.value === 'missing') return 'missing'
        if (skinStatus.value !== 'ready') return 'loading'
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
