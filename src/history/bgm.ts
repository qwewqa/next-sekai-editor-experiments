import { computed } from 'vue'
import { liveState, state } from '.'

export const bgm = computed(() => state.value.bgm)

/** The displayed chart's BGM with the live audio, which playback keeps while peeking. */
export const playbackBgm = computed(() => {
    const shown = state.value.bgm
    const { buffer } = liveState.value.bgm
    return shown.buffer === buffer ? shown : { ...shown, buffer }
})
