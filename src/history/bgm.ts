import { computed } from 'vue'
import { liveState, peek, state } from '.'

export const bgm = computed(() => state.value.bgm)

/**
 * The displayed chart's BGM with the live audio, which playback keeps while peeking a step. A
 * session's peek plays without BGM (§1.4.10.6).
 */
export const playbackBgm = computed(() => {
    const shown = state.value.bgm
    if (peek.value?.audio === 'none') return shown
    const { buffer } = liveState.value.bgm
    return shown.buffer === buffer ? shown : { ...shown, buffer }
})
