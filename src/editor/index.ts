import { computed } from 'vue'
import { settings } from '../settings'
import { timeToBeat } from '../state/integrals/bpms'
import { beatToKey } from '../state/store/grid'
import { computedRange } from '../utils/range'
import { OFFSCREEN_REACH } from './offscreenNotes'
import { sceneBpms } from './sceneState'
import { view } from './view'

export const times = computed(() => ({
    min: Math.max(0, view.time - (0.5 * view.h) / settings.pps),
    max: view.time + (0.5 * view.h) / settings.pps,
}))

export const beats = computed(() => ({
    min: timeToBeat(sceneBpms.value, times.value.min),
    max: timeToBeat(sceneBpms.value, times.value.max),
}))

const keyAt = (time: number) => beatToKey(timeToBeat(sceneBpms.value, Math.max(0, time)))

// Include artwork whose center lies outside the viewport. Diagonal flick
// arrows extend 1.2 scene units above their beat, plus a non-scaling stroke.
export const keys = computedRange(() => {
    // And notes off-screen badges still count.
    const padding = Math.max((1.25 * view.w) / settings.width + 4, OFFSCREEN_REACH + 4)
    return {
        min: keyAt(view.time - (0.5 * view.h + padding) / settings.pps),
        max: keyAt(view.time + (0.5 * view.h + padding) / settings.pps),
    }
})
