<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import { isPeeking } from '../../history/peek'
import { i18n } from '../../i18n'
import { modals, showModal } from '../../modals'
import { interpolateRaw } from '../../utils/interpolate'
import { formatCount } from '../../utils/size'
import { view } from '../view'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import HiddenIcon from '../workspace/manager/icons/HiddenIcon.vue'
import MoreIcon from '../workspace/manager/icons/MoreIcon.vue'
import VisibleIcon from '../workspace/manager/icons/VisibleIcon.vue'
import {
    canInspectProperties,
    changeLine,
    comparisonStatus,
    fixedLine,
    offBand,
    openPropertyInspection,
    pressWhenRead,
    propertyInspection,
    reportCounts,
    awaitingRead,
    firstRead,
    heldBar,
    showChangeToward,
    shownChange,
    showEdits,
    slowRead,
    toggleShowEdits,
    usableBand,
} from './changes'
import ChangeOptionsMenu from './ChangeOptionsMenu.vue'
import PropertyChangesModal from './PropertyChangesModal.vue'
import { peekLayout, peekWidths } from './peekFit'
import { peekedInfo } from './selection'

// Between steps the last step's line stays until the next one's is read, or a slow read says so.
const line = computed(
    () =>
        changeLine.value ??
        (slowRead.value ? fixedLine('loadingChanges') : (heldBar.value?.line ?? '')),
)
const visibleLine = computed(() => {
    if (view.w >= 480) return line.value
    if (comparisonStatus.value === 'loading')
        return slowRead.value ? fixedLine('loadingShort') : (heldBar.value?.line ?? '')
    if (comparisonStatus.value === 'unavailable') return fixedLine('unavailableShort')
    return line.value
})
// By fit (peekFit.ts): the options button where the eye and summary would not fit, then narrow arrows.
const layout = computed(() => peekLayout(view.w, peekWidths.value))
const compact = computed(() => layout.value.compact)
const narrowArrows = computed(() => layout.value.narrowArrows)
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
// A re-measured fit can flip compact while the menu is open, like a width change.
watch(
    () => [view.w, compact.value],
    () => {
        if (menuOpen.value) closeMenu(true)
    },
)
const inspect = async (opener: HTMLElement | null) => {
    if (awaitingRead.value) {
        pressWhenRead(() => void inspect(opener))
        return
    }
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
            { size: 'large', cap: '34rem' },
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
// The arrows, counts and summary follow the held step while its successor is being read.
const liveCountOf = (direction: 'up' | 'down') =>
    direction === 'up' ? offBand.value.above : offBand.value.below
const countOf = (direction: 'up' | 'down') => {
    const held = heldBar.value
    return held ? (direction === 'up' ? held.above : held.below) : liveCountOf(direction)
}
const counted = computed(() => heldBar.value?.reportCounts ?? reportCounts.value)
const inspectable = computed(() => heldBar.value?.inspectable ?? canInspectProperties.value)
const enabled = (direction: 'up' | 'down') =>
    heldBar.value ? countOf(direction) > 0 : usableBand.value && countOf(direction) > 0
// A press while the last step is held acts on the new step once its change is read.
const press = (direction: 'up' | 'down') => {
    if (heldBar.value) {
        if (enabled(direction))
            pressWhenRead(() => {
                press(direction)
            })
    } else if (enabled(direction)) showChangeToward(direction)
}
const labelOf = (direction: 'up' | 'down') => {
    const strings = i18n.value.peek
    return counted.value
        ? interpolateRaw(
              direction === 'up' ? strings.changesAbove : strings.changesBelow,
              formatCount(countOf(direction)),
          )
        : direction === 'up'
          ? strings.changesAboveAny
          : strings.changesBelowAny
}
</script>

<template>
    <!-- Every face is a 24 px circle or pill, 4 px in from the capsule's edge; hits reach 4 px past it. -->
    <div
        v-if="isPeeking"
        :class="{ invisible: firstRead }"
        class="pointer-events-auto flex h-8 w-[calc(var(--peek-w)-0.75rem)] max-w-[calc(100%-0.75rem)] items-center gap-2 rounded-full bg-modal p-1 text-xs text-fg shadow-md ring-1 ring-fg/10"
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
                class="change-control ghost focus-out btn-toggle relative flex size-6 shrink-0 items-center justify-center rounded-full before:absolute before:-inset-1"
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
            <!-- The summary hugs its words, its chevron right after them. -->
            <button
                v-if="inspectable"
                ref="summary"
                type="button"
                class="change-control ghost focus-out relative mr-auto flex h-6 min-w-0 items-center gap-1 rounded-full pl-2 pr-1.5 text-left before:absolute before:-inset-1"
                :title="line"
                :aria-label="i18n.historyChanges.view"
                :aria-describedby="summaryId"
                data-property-summary
                @click="inspect(summary)"
            >
                <span :id="summaryId" class="min-w-0 truncate" data-peek-change>{{
                    visibleLine
                }}</span
                ><ChevronIcon class="shrink-0" direction="right" centered />
            </button>
            <span v-else class="mr-auto flex h-6 min-w-0 items-center px-2" :title="line"
                ><span class="min-w-0 truncate" aria-hidden="true" data-peek-change>{{
                    visibleLine
                }}</span
                ><span class="sr-only">{{ line }}</span></span
            >
        </template>
        <button
            v-else
            ref="options"
            type="button"
            class="change-control ghost focus-out relative flex size-6 shrink-0 items-center justify-center rounded-full before:absolute before:-inset-1"
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
        <!-- Each arrow: its chevron's circle is the face, its count a passive label in the fixed
             slot after it, both inside the one 48 x 24 button and its 56 x 32 hit. -->
        <div
            class="flex shrink-0"
            :class="[narrowArrows ? 'gap-1' : 'gap-2', { 'ml-auto': compact }]"
        >
            <button
                v-for="direction in directions"
                :key="direction"
                type="button"
                class="change-arrow change-control relative flex h-6 shrink-0 items-center tabular-nums outline-none before:absolute before:-inset-1"
                :class="narrowArrows ? 'w-11 before:-inset-x-0.5' : 'w-12'"
                :aria-disabled="!enabled(direction)"
                :aria-label="labelOf(direction)"
                :title="labelOf(direction)"
                :data-change-arrow="direction"
                :data-count="counted ? countOf(direction) : undefined"
                @click="press(direction)"
            >
                <span
                    class="change-face flex size-6 shrink-0 items-center justify-center rounded-full transition-colors"
                    ><ChevronIcon :direction="direction" centered
                /></span>
                <!-- 6 px after the circle, clear of its focus ring; three digits take 4 px, to fit the slot. -->
                <span
                    class="change-count text-left"
                    :class="[
                        narrowArrows ? 'w-5' : 'w-6',
                        counted && countOf(direction) >= 100 ? 'pl-1' : 'pl-1.5',
                    ]"
                    aria-hidden="true"
                    >{{ counted ? formatCount(countOf(direction)) : '–' }}</span
                >
            </button>
        </div>
        <ChangeOptionsMenu
            v-if="menuOpen && options"
            :anchor="options"
            :summary="line"
            :checked="showEdits"
            :inspectable="inspectable"
            @close="closeMenu"
            @toggle="toggleFromMenu"
            @inspect="inspectFromMenu"
        />
    </div>
</template>

<style scoped>
/* The arrows' face is the chevron's circle (the inner-face pattern, with ghost tokens): hover,
   press and focus are drawn on it, centred on the chevron. A face under 32 px rings outside. */
@media (hover: hover) and (pointer: fine) {
    .change-arrow[aria-disabled='false']:hover .change-face {
        @apply bg-fg/10;
    }
}

.change-arrow[aria-disabled='false']:active .change-face {
    @apply bg-ghost-press text-fg-strong;
}

.change-face {
    outline: 2px solid transparent;
    outline-offset: 1px;
}

.change-arrow:focus-visible .change-face {
    outline-color: rgb(var(--color-fg));
}

/* Disabled dims the chevron and the count, not the face, so a focus ring stays strong. */
.change-arrow[aria-disabled='true'] :is(.change-face > svg, .change-count) {
    opacity: 0.4;
}

@media (forced-colors: active) {
    .change-control {
        border: 1px solid ButtonText;
    }
    .change-arrow[aria-disabled='true'] {
        color: GrayText;
        border-color: GrayText;
    }
    .change-arrow[aria-disabled='true'] :is(.change-face > svg, .change-count) {
        opacity: 1;
    }
}
</style>
