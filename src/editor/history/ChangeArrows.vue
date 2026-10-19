<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { isPeeking } from '../../history/peek'
import { i18n } from '../../i18n'
import { modals, showModal } from '../../modals'
import { interpolateRaw } from '../../utils/interpolate'
import { view } from '../view'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import HiddenIcon from '../workspace/manager/icons/HiddenIcon.vue'
import MoreIcon from '../workspace/manager/icons/MoreIcon.vue'
import VisibleIcon from '../workspace/manager/icons/VisibleIcon.vue'
import {
    canInspectProperties,
    changeLine,
    comparisonStatus,
    countsShown,
    offBand,
    openPropertyInspection,
    propertyInspection,
    showChangeToward,
    shownChange,
    showEdits,
    toggleShowEdits,
    usableBand,
} from './changes'
import ChangeOptionsMenu from './ChangeOptionsMenu.vue'
import PropertyChangesModal from './PropertyChangesModal.vue'
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
const visibleLine = computed(() => {
    if (view.w >= 480) return line.value
    if (comparisonStatus.value === 'loading')
        return delayed.value ? i18n.value.peek.loadingShort : ''
    if (comparisonStatus.value === 'unavailable') return i18n.value.peek.unavailableShort
    return line.value
})
const compact = computed(() => view.w < 320)
const narrowArrows = computed(() => view.w < 180)
const options = useTemplateRef<HTMLButtonElement>('options')
const summary = useTemplateRef<HTMLButtonElement>('summary')
const eye = useTemplateRef<HTMLButtonElement>('eye')
const summaryId = useId()
const menuOpen = ref(false)
let inspecting = false
const restoreFocus = (opener: HTMLElement | undefined | null) => {
    const target =
        opener?.isConnected && opener.getClientRects().length
            ? opener
            : compact.value
              ? options.value
              : (summary.value ?? eye.value)
    if (
        target?.isConnected &&
        target.getClientRects().length &&
        !modals.some((modal) => modal.presentation !== 'tool')
    )
        target.focus({ preventScroll: true })
}
const closeMenu = (focus: boolean) => {
    const request = peekedInfo.value
    const opener = options.value
    menuOpen.value = false
    if (focus)
        void nextTick(() => {
            if (peekedInfo.value === request && isPeeking.value) restoreFocus(opener)
        })
}
const toggleFromMenu = () => {
    toggleShowEdits()
    closeMenu(true)
}
watch(
    [peekedInfo, isPeeking],
    () => {
        menuOpen.value = false
    },
    { flush: 'sync' },
)
watch(
    () => view.w,
    () => {
        if (menuOpen.value) closeMenu(true)
    },
)
const inspect = async (opener: HTMLElement | null) => {
    if (inspecting || !canInspectProperties.value) return
    const comparison = shownChange.value
    if (!comparison) return
    const request = peekedInfo.value
    menuOpen.value = false
    openPropertyInspection()
    if (propertyInspection.value?.comparison !== comparison) return
    inspecting = true
    try {
        await showModal(
            PropertyChangesModal,
            { comparison, summary: line.value },
            { size: 'large' },
        )
    } finally {
        inspecting = false
        if (peekedInfo.value === request && isPeeking.value) restoreFocus(opener)
    }
}
const inspectFromMenu = () => {
    const opener = options.value
    const request = peekedInfo.value
    closeMenu(true)
    void nextTick(() => {
        if (peekedInfo.value === request && isPeeking.value) void inspect(opener)
    })
}
const directions = ['up', 'down'] as const
const countOf = (direction: 'up' | 'down') =>
    direction === 'up' ? offBand.value.above : offBand.value.below
const enabled = (direction: 'up' | 'down') => usableBand.value && countOf(direction) > 0
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
        class="pointer-events-auto flex h-8 w-full max-w-96 items-center gap-2 rounded-lg bg-modal px-1 text-xs text-fg shadow-sm"
        data-peek-navigation
        :data-change-options-mode="compact || undefined"
        @pointerdown.stop
        @mousedown.stop
        @touchstart.stop
        @wheel.stop
        @contextmenu.prevent.stop
    >
        <template v-if="!compact">
            <button
                ref="eye"
                type="button"
                class="change-control pointer-events-auto flex size-8 shrink-0 items-center justify-center rounded-md transition-colors active:bg-accent active:text-on-accent"
                :class="
                    showEdits
                        ? 'bg-accent text-on-accent hover:bg-accent/80'
                        : 'hover:bg-header-hover'
                "
                :aria-label="i18n.peek.showEdits"
                :title="i18n.peek.showEdits"
                :aria-pressed="showEdits"
                data-show-edits
                @click="toggleShowEdits"
            >
                <VisibleIcon v-if="showEdits" class="size-4 fill-current" /><HiddenIcon
                    v-else
                    class="size-4 fill-current"
                />
            </button>
            <button
                v-if="canInspectProperties"
                ref="summary"
                type="button"
                class="change-control pointer-events-auto flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-2 transition-colors hover:bg-header-hover active:bg-accent active:text-on-accent"
                :title="line"
                :aria-label="i18n.historyChanges.view"
                :aria-describedby="summaryId"
                data-property-summary
                @click="inspect(summary)"
            >
                <span :id="summaryId" class="min-w-0 flex-1 truncate" data-peek-change>{{
                    visibleLine
                }}</span
                ><ChevronIcon class="size-4 shrink-0" direction="right" />
            </button>
            <span
                v-else
                class="pointer-events-auto flex h-8 min-w-0 flex-1 items-center px-1"
                :title="line"
                :aria-label="line"
                ><span class="min-w-0 truncate" data-peek-change>{{ visibleLine }}</span></span
            >
        </template>
        <button
            v-else
            ref="options"
            type="button"
            class="change-control pointer-events-auto flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-header-hover active:bg-accent active:text-on-accent"
            :aria-label="i18n.peek.changeOptions"
            :title="i18n.peek.changeOptions"
            aria-haspopup="menu"
            :aria-expanded="menuOpen"
            data-change-options
            @click="menuOpen = !menuOpen"
            @keydown.down.prevent="menuOpen = true"
        >
            <MoreIcon class="size-4 fill-current" />
        </button>
        <div class="flex shrink-0 gap-1" :class="{ 'ml-auto': compact }">
            <button
                v-for="direction in directions"
                :key="direction"
                type="button"
                class="change-arrow change-control pointer-events-auto flex h-8 shrink-0 items-center justify-center rounded-md tabular-nums transition-colors"
                :class="[
                    narrowArrows ? 'w-11 gap-0.5' : 'w-14 gap-1',
                    {
                        'hover:bg-header-hover active:bg-accent active:text-on-accent':
                            enabled(direction),
                    },
                ]"
                :aria-disabled="!enabled(direction)"
                :aria-label="labelOf(direction)"
                :title="labelOf(direction)"
                :data-change-arrow="direction"
                :data-count="countsShown ? countOf(direction) : undefined"
                @click="enabled(direction) && showChangeToward(direction)"
            >
                <ChevronIcon
                    :class="narrowArrows ? 'size-3' : 'size-4'"
                    :direction="direction"
                /><span class="w-6 text-center">{{
                    countsShown && countOf(direction) ? countOf(direction) : ''
                }}</span>
            </button>
        </div>
        <ChangeOptionsMenu
            v-if="menuOpen && options"
            :anchor="options"
            :summary="line"
            :checked="showEdits"
            :inspectable="canInspectProperties"
            @close="closeMenu"
            @toggle="toggleFromMenu"
            @inspect="inspectFromMenu"
        />
    </div>
</template>

<style scoped>
.change-control {
    outline-offset: -3px;
}
.change-control:focus-visible {
    outline: 2px solid currentColor;
}
.change-arrow[aria-disabled='true'] > * {
    opacity: 0.45;
}
@media (forced-colors: active) {
    .change-control {
        border: 1px solid ButtonText;
    }
    .change-control[aria-pressed='true'] {
        color: HighlightText;
        background: Highlight;
        border-color: Highlight;
    }
    .change-arrow[aria-disabled='true'] {
        color: GrayText;
        border-color: GrayText;
    }
    .change-arrow[aria-disabled='true'] > * {
        opacity: 1;
    }
}
</style>
