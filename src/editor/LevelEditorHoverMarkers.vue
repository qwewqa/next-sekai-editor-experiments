<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import { settings } from '../settings'
import { timeToBeat } from '../state/integrals/bpms'
import { formatTime } from '../utils/format'
import { formatBeatPosition } from './beatDisplay'
import {
    edgeLabelSizes,
    hoverLabelCenter,
    observeLabelSize,
    unobserveLabelSize,
} from './edgeLabels'
import { drawnBpms, sceneBpms } from './sceneState'
import { view } from './view'

const hover = computed(() => ({
    time: view.hoverTime,
    beat: timeToBeat(sceneBpms.value, view.hoverTime),
}))

// The grid leaves out its own labels under these; a little inset keeps them clear of dock shadows.
const time = useTemplateRef('time')
const beat = useTemplateRef('beat')
onMounted(() => {
    if (time.value) observeLabelSize(time.value, edgeLabelSizes.hover.time)
    if (beat.value) observeLabelSize(beat.value, edgeLabelSizes.hover.beat)
})
onBeforeUnmount(() => {
    if (time.value) unobserveLabelSize(time.value)
    if (beat.value) unobserveLabelSize(beat.value)
})
</script>

<template>
    <div
        class="absolute flex w-full -translate-y-1/2 justify-between text-white/70 forced-color-adjust-none"
        :class="{ invisible: view.isHoverHidden }"
        :style="{ top: `${hoverLabelCenter}px` }"
    >
        <span ref="time" class="pl-1">{{ formatTime(hover.time) }}</span>
        <span ref="beat" class="pr-1">{{
            formatBeatPosition(drawnBpms, hover.beat, settings.beatDisplay, true)
        }}</span>
    </div>
</template>
