import { computed, shallowRef, watch } from 'vue'
import { setChartBackground } from './editor/canvas/nameColors'
import { settings } from './settings'

// index.html applies the same choice before the app loads.
const query = matchMedia('(prefers-color-scheme: dark)')
const prefersDark = shallowRef(query.matches)
const updatePrefersDark = () => {
    prefersDark.value = query.matches
}
query.addEventListener('change', updatePrefersDark)

const theme = computed(() =>
    settings.theme === 'system' ? (prefersDark.value ? 'dark' : 'light') : settings.theme,
)

const root = document.documentElement
let frame = 0

const readChartBackground = () => {
    const channels = getComputedStyle(root).getPropertyValue('--color-bg').trim()
    if (!channels) return false
    const hex = channels.split(/\s+/).map((v) => Number(v).toString(16).padStart(2, '0'))
    setChartBackground(`#${hex.join('')}`)
    return true
}

const stop = watch(
    theme,
    (value, previous) => {
        // A switch recolours everything at once rather than fading the controls that transition.
        if (previous) {
            root.toggleAttribute('data-theme-switching', true)
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => {
                    root.removeAttribute('data-theme-switching')
                })
            })
        }
        root.dataset.theme = value
        // WebKit can run this before the stylesheet applies; read again once the page loads.
        if (!readChartBackground())
            window.addEventListener('load', readChartBackground, { once: true })
    },
    { immediate: true, flush: 'sync' },
)

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        stop()
        cancelAnimationFrame(frame)
        window.removeEventListener('load', readChartBackground)
        root.removeAttribute('data-theme-switching')
        query.removeEventListener('change', updatePrefersDark)
    })
}
