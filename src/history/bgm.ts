import { computed } from 'vue'
import { liveState, peek, state } from './stack'

export const bgm = computed(() => state.value.bgm)

/**
 * The displayed chart's BGM with the live audio, which playback keeps while peeking a step, and
 * the step's offset only when its BGM is the live one, as Restore keeps it (§1.4.10.5). A
 * session's peek plays without BGM (§1.4.10.6).
 */
export const playbackBgm = computed(() => {
    const shown = state.value.bgm
    if (peek.value?.audio === 'none') return shown
    const { buffer, meta, offset: liveOffset } = liveState.value.bgm
    const offset = shown.meta?.hash === meta?.hash ? shown.offset : liveOffset
    return shown.buffer === buffer && shown.offset === offset ? shown : { ...shown, buffer, offset }
})
