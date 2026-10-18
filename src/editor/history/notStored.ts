import { computed, shallowRef, watch } from 'vue'
import { storageStatus } from '../../local/startup/events'

// Whether history is not being saved (Part 1 §1.6.7): storage unavailable or paused. The passive
// signs show after about 3 s, so a brief stall never flickers them.

const PASSIVE_AFTER_MS = 3000

const unsaved = computed(() => {
    const status = storageStatus.value
    return !!status && (status.mode !== 'stored' || status.reason !== undefined)
})

const shown = shallowRef(false)
let timer: ReturnType<typeof setTimeout> | undefined

watch(
    unsaved,
    (value) => {
        clearTimeout(timer)
        if (!value) shown.value = false
        else timer = setTimeout(() => (shown.value = true), PASSIVE_AFTER_MS)
    },
    { immediate: true },
)

/** True once history has not been saved for about 3 s. */
export const historyNotStored = shown
