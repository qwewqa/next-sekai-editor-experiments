<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import { beats, times } from '.'
import { settings } from '../settings'
import { formatTime } from '../utils/format'
import { formatBeatPosition } from './beatDisplay'
import {
    coveredEdgeLabels,
    edgeLabelSizes,
    lowerEdgeLabelsCovered,
    observeLabelSize,
    unobserveLabelSize,
} from './edgeLabels'
import { drawnBpms } from './sceneState'

// The grid leaves out its own labels under these; a little inset keeps them clear of dock shadows.
const labels = {
    top: { time: useTemplateRef('topTime'), beat: useTemplateRef('topBeat') },
    bottom: { time: useTemplateRef('bottomTime'), beat: useTemplateRef('bottomBeat') },
}
const elements = () =>
    (['top', 'bottom'] as const).flatMap((row) =>
        (['time', 'beat'] as const).map(
            (label) => [labels[row][label].value, edgeLabelSizes[row][label]] as const,
        ),
    )
onMounted(() => {
    for (const [element, size] of elements()) if (element) observeLabelSize(element, size)
})
onBeforeUnmount(() => {
    for (const [element] of elements()) if (element) unobserveLabelSize(element)
})
</script>

<template>
    <div
        class="editor-range-labels pointer-events-none absolute flex size-full flex-col justify-between tabular-nums text-white/70 forced-color-adjust-none"
    >
        <div class="flex justify-between">
            <span ref="topTime" class="pl-1" :class="{ invisible: coveredEdgeLabels.top.time }">{{
                formatTime(times.max)
            }}</span>
            <span ref="topBeat" class="pr-1" :class="{ invisible: coveredEdgeLabels.top.beat }">{{
                formatBeatPosition(drawnBpms, beats.max, settings.beatDisplay, true)
            }}</span>
        </div>
        <div class="flex justify-between" :class="{ invisible: lowerEdgeLabelsCovered }">
            <span
                ref="bottomTime"
                class="pl-1"
                :class="{ invisible: coveredEdgeLabels.bottom.time }"
                >{{ formatTime(times.min) }}</span
            >
            <span
                ref="bottomBeat"
                class="pr-1"
                :class="{ invisible: coveredEdgeLabels.bottom.beat }"
                >{{ formatBeatPosition(drawnBpms, beats.min, settings.beatDisplay, true) }}</span
            >
        </div>
    </div>
</template>
