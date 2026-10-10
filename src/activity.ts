import { computed, readonly, ref, watch } from 'vue'
import { isBlockingModalOpen } from './modals'

const active = ref(document.visibilityState !== 'hidden' && document.hasFocus())

// A visible window can still be behind another application. Stop presentation
// work in both cases, including browsers that keep firing RAF while unfocused.
export const isAppActive = readonly(active)

/** Leaving the app or a dialog that holds the editor cancels any press or drag. */
export const interruptsDrags = computed(() => !active.value || isBlockingModalOpen.value)

const stop = watch(
    active,
    (value) => {
        document.documentElement.toggleAttribute('data-app-inactive', !value)
    },
    { immediate: true, flush: 'sync' },
)

const update = () => {
    active.value = document.visibilityState !== 'hidden' && document.hasFocus()
}
const blur = () => {
    active.value = false
}

window.addEventListener('focus', update)
window.addEventListener('blur', blur)
document.addEventListener('visibilitychange', update)

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        stop()
        window.removeEventListener('focus', update)
        window.removeEventListener('blur', blur)
        document.removeEventListener('visibilitychange', update)
    })
}
