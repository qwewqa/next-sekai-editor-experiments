<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { settings } from '../settings'
import { timeToBeat } from '../state/integrals/bpms'
import { formatTime } from '../utils/format'
import { formatBeatPosition } from './beatDisplay'
import { measureFigureMiddle } from './canvas/text'
import {
    edgeLabelSizes,
    hoverFigureOffset,
    hoverLabelCenter,
    observeLabelSize,
    unobserveLabelSize,
} from './edgeLabels'
import { shownMarkerTime } from './hoverMarker'
import { drawnBpms, sceneBpms } from './sceneState'
import { view } from './view'

// The touch marker keeps its exact beat; hidden, the labels measure at the last hover.
const hover = computed(() => {
    const time = shownMarkerTime.value
    const marker = view.touchMarker
    return view.isHoverHidden && marker && time !== undefined
        ? { time, beat: marker.beat }
        : { time: view.hoverTime, beat: timeToBeat(sceneBpms.value, view.hoverTime) }
})

// The grid leaves out its own labels under these; a little inset keeps them clear of dock shadows.
const time = useTemplateRef<HTMLElement>('time')
const beat = useTemplateRef('beat')
const baseline = useTemplateRef<HTMLElement>('baseline')

// The line box centres the font's ascent and descent; the line meets the figures' middle instead.
const measureFigures = () => {
    if (!time.value || !baseline.value) return
    const { fontFamily, fontSize } = getComputedStyle(time.value)
    const box = time.value.getBoundingClientRect()
    const middle = baseline.value.getBoundingClientRect().top - box.top
    hoverFigureOffset.value =
        middle - measureFigureMiddle(fontFamily) * parseFloat(fontSize) - box.height / 2
}
// Again as the font size changes its height.
watch(() => edgeLabelSizes.hover.time.height, measureFigures)
onMounted(() => {
    if (time.value) observeLabelSize(time.value, edgeLabelSizes.hover.time)
    if (beat.value) observeLabelSize(beat.value, edgeLabelSizes.hover.beat)
    measureFigures()
    document.fonts.addEventListener('loadingdone', measureFigures)
})
onBeforeUnmount(() => {
    if (time.value) unobserveLabelSize(time.value)
    if (beat.value) unobserveLabelSize(beat.value)
    document.fonts.removeEventListener('loadingdone', measureFigures)
})
</script>

<template>
    <div
        class="editor-hover-labels pointer-events-none absolute flex w-full -translate-y-1/2 justify-between tabular-nums text-white/70 forced-color-adjust-none"
        :class="{ invisible: shownMarkerTime === undefined }"
        :style="{ top: `${hoverLabelCenter - hoverFigureOffset}px` }"
    >
        <span ref="time" class="pl-1"
            >{{ formatTime(hover.time) }}<span ref="baseline" class="inline-block"
        /></span>
        <span ref="beat" class="pr-1">{{
            formatBeatPosition(drawnBpms, hover.beat, settings.beatDisplay, true)
        }}</span>
    </div>
</template>
