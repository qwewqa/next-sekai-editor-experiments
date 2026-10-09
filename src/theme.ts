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

export const theme = computed(() =>
    settings.theme === 'system' ? (prefersDark.value ? 'dark' : 'light') : settings.theme,
)

const stop = watch(
    theme,
    (value) => {
        document.documentElement.dataset.theme = value
        const channels = getComputedStyle(document.documentElement)
            .getPropertyValue('--color-bg')
            .trim()
            .split(/\s+/)
            .map(Number)
        setChartBackground(`#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}`)
    },
    { immediate: true, flush: 'sync' },
)

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        stop()
        query.removeEventListener('change', updatePrefersDark)
    })
}
