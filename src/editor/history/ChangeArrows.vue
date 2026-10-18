<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { isPeeking } from '../../history/peek'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import { changeLine, comparisonStatus, countsShown, offBand, showChangeToward } from './changes'
import { peekedInfo } from './selection'

const delayed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(
    [comparisonStatus, peekedInfo],
    ([status]) => {
        clearTimeout(timer)
        delayed.value = false
        if (status === 'loading')
            timer = setTimeout(() => {
                delayed.value = true
            }, 250)
    },
    { immediate: true, flush: 'sync' },
)
onBeforeUnmount(() => {
    clearTimeout(timer)
})
const line = computed(
    () => changeLine.value ?? (delayed.value ? i18n.value.peek.loadingChanges : ''),
)
const directions = ['up', 'down'] as const
const countOf = (direction: 'up' | 'down') =>
    direction === 'up' ? offBand.value.above : offBand.value.below
const labelOf = (direction: 'up' | 'down') => {
    const strings = i18n.value.peek
    return countsShown.value
        ? interpolateRaw(
              direction === 'up' ? strings.changesAbove : strings.changesBelow,
              String(countOf(direction)),
          )
        : direction === 'up'
          ? strings.changesAboveAny
          : strings.changesBelowAny
}
</script>

<template>
    <div
        v-if="isPeeking"
        class="pointer-events-auto flex h-[52px] w-full max-w-lg items-center gap-1 rounded-3xl bg-modal p-1 pl-4 text-sm text-fg shadow-md"
        data-peek-navigation
    >
        <span class="min-w-0 flex-1 truncate" :title="line" :aria-label="line" data-peek-change>{{
            line
        }}</span>
        <button
            v-for="direction in directions"
            :key="direction"
            type="button"
            class="change-arrow flex h-11 w-16 shrink-0 items-center justify-center gap-1 rounded-full bg-button text-xs tabular-nums outline-offset-[-3px] focus-visible:outline focus-visible:outline-2"
            :aria-disabled="!countOf(direction)"
            :aria-label="labelOf(direction)"
            :title="labelOf(direction)"
            :data-change-arrow="direction"
            :data-count="countsShown ? countOf(direction) : undefined"
            @click="countOf(direction) && showChangeToward(direction)"
        >
            <ChevronIcon :direction="direction" /><span class="w-6 text-center">{{
                countsShown && countOf(direction) ? countOf(direction) : ''
            }}</span>
        </button>
    </div>
</template>

<style scoped>
.change-arrow[aria-disabled='true'] {
    opacity: 0.45;
}
@media (forced-colors: active) {
    .change-arrow {
        border: 1px solid ButtonText;
    }
    .change-arrow[aria-disabled='true'] {
        color: GrayText;
        border-color: GrayText;
        opacity: 1;
    }
}
</style>
