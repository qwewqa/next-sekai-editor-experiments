<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isPeeking, peekLoading, peekedKey } from '../../history/peek'
import { i18n } from '../../i18n'
import { isBlockingModalOpen, isToolDialogOpen } from '../../modals'
import { isComposingKey } from '../../utils/composition'
import { interpolateRaw } from '../../utils/interpolate'
import {
    barInfo,
    changeLine,
    countedLines,
    fixedLine,
    fixedLines,
    heldBar,
    pressWhenRead,
} from './changes'
import { settings } from '../../settings'
import { view } from '../view'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import ChangeArrows from './ChangeArrows.vue'
import InfoIcon from './InfoIcon.vue'
import { useRootFontSize } from '../useRootFontSize'
import { useHistoryCalendar } from './calendarClock'
import { historyFormat } from './historyFormat'
import { historyOperationContext } from './historyOperationContext'
import { measurePeekWidths, peekLayout, peekText, peekWidths } from './peekFit'
import { backToNow, peekedInfo, peekedLabel, requestRestore } from './selection'
import { openOperationDetails } from './operationDetails'
import { focusAfterRemoval } from '../../utils/focusFallback'

// The History clock: the bar's dates and the peeked step's name are in its zone.
const calendar = useHistoryCalendar()
const format = computed(() => historyFormat(calendar.value, settings.locale))
const peekContext = computed(() => historyOperationContext(calendar.value))

// --- Announcing the peek: with its change when that arrives within 300 ms, else the change alone.
const announcement = ref('')
let announcedAt = 0
watch(
    peekedInfo,
    (info) => {
        announcedAt = performance.now()
        announcement.value = info
            ? interpolateRaw(
                  i18n.value.history.announceViewing,
                  format.value.dateTimeSeconds(info.time),
              )
            : ''
    },
    { immediate: true },
)
watch(changeLine, (line) => {
    const info = peekedInfo.value
    if (!line || !info) return
    announcement.value =
        performance.now() - announcedAt <= 300
            ? interpolateRaw(
                  i18n.value.history.announceViewingChange,
                  format.value.dateTimeSeconds(info.time),
                  line,
              )
            : line
})

const strings = computed(() => i18n.value.peek)

// --- One width per language and width class, so the arrows below never move (peekFit.ts).
const measure = () => {
    peekWidths.value = measurePeekWidths(
        document.body,
        settings.locale,
        settings.beatDisplay,
        {
            back: strings.value.backToNow,
            restore: strings.value.restore,
            states: fixedLines.short.map(fixedLine),
            statesWide: fixedLines.wide.map(fixedLine),
            summary: fixedLines.summary.map(fixedLine),
            counted: countedLines(),
        },
        calendar.value,
    )
}
onMounted(() => {
    measure()
    document.fonts.addEventListener('loadingdone', measure)
})
onBeforeUnmount(() => {
    document.fonts.removeEventListener('loadingdone', measure)
})
watch(() => [settings.locale, settings.beatDisplay], measure)
// The widths are in px at the root font size they were measured at: a change measures them again.
watch(useRootFontSize(), measure)
const layout = computed(() => peekLayout(view.w, peekWidths.value))
// The step the bar names: the last one's until the next one's change is read (changes.ts).
const shownInfo = barInfo
const text = computed(() => {
    const info = shownInfo.value
    return info ? peekText(calendar.value, settings.locale, info.time, layout.value.wide) : ''
})

// Leaving the peek takes the strip away, by Back to Now, Restore, Escape, Undo or anything else:
// focus in it, or in its options menu, goes to the chart (§1.4.10.2, X-2).
watch(
    isPeeking,
    (peeking) => {
        if (peeking) return
        const active = document.activeElement
        if (active?.closest('[data-peek-bar], [data-change-options-menu]')) void focusAfterRemoval()
    },
    { flush: 'sync' },
)

const restore = () => {
    if (peekedKey.value) void requestRestore(peekedKey.value)
}
// A press while the last step is held opens the new step's details once its change is read.
const details = () => {
    if (heldBar.value) {
        pressWhenRead(details)
        return
    }
    const info = shownInfo.value
    if (info) void openOperationDetails(info.recipe, info.time)
}
const onKeydown = (event: KeyboardEvent) => {
    const target = event.target
    const host = event.currentTarget
    if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.repeat ||
        isComposingKey(event) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !isPeeking.value ||
        isBlockingModalOpen.value ||
        isToolDialogOpen.value ||
        !(target instanceof HTMLButtonElement) ||
        target !== document.activeElement ||
        !(host instanceof HTMLElement) ||
        !host.contains(target)
    )
        return
    event.preventDefault()
    event.stopPropagation()
    backToNow()
}
</script>

<template>
    <div class="sr-only" aria-live="polite" data-history-announcement>{{ announcement }}</div>
    <template v-if="isPeeking">
        <div
            class="pointer-events-none absolute inset-0 z-10 ring-2 ring-inset ring-accent forced-colors:ring-[Highlight]"
            aria-hidden="true"
        />
        <!-- Two strips of one width, the change capsule inset 6 px so their end caps are concentric. -->
        <div
            class="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 px-2"
            :class="layout.inset"
            :style="{ '--peek-w': `${layout.width}px` }"
            data-peek-bar
            @keydown="onKeydown"
        >
            <div
                class="pointer-events-auto flex w-[--peek-w] max-w-full items-center gap-2 rounded-full bg-modal p-1 text-sm text-fg shadow-xl ring-1 ring-fg/10"
                data-peek-main
            >
                <!-- The date at the start, its glyph concentric with the strip's end cap. -->
                <button
                    type="button"
                    class="peek-hit ghost mr-auto flex h-9 min-w-0 items-center gap-2 rounded-full"
                    :class="layout.tiny ? 'w-9 shrink-0 justify-center' : 'px-2.5'"
                    :title="shownInfo && peekedLabel(shownInfo, peekContext)"
                    :aria-label="interpolateRaw(i18n.history.details.named, text)"
                    data-peek-text
                    data-peek-details
                    @click="details"
                >
                    <span
                        v-if="peekLoading"
                        class="size-4 shrink-0 animate-spin rounded-full border-2 border-fg/25 border-t-fg"
                        aria-hidden="true"
                    />
                    <InfoIcon v-else class="size-4 shrink-0 fill-current" />
                    <span v-if="!layout.tiny" class="min-w-0 truncate tabular-nums">{{
                        text
                    }}</span>
                </button>
                <button
                    type="button"
                    class="peek-hit btn btn-secondary flex h-9 shrink-0 items-center justify-center rounded-full"
                    :class="layout.back === 'label' ? 'px-4' : 'w-9'"
                    :aria-label="strings.backToNow"
                    :title="strings.backToNow"
                    data-peek-back
                    @click="backToNow"
                >
                    <template v-if="layout.back === 'label'">{{ strings.backToNow }}</template
                    ><ChevronIcon v-else direction="left" centered />
                </button>
                <button
                    type="button"
                    class="peek-hit btn btn-primary flex h-9 items-center justify-center rounded-full"
                    :class="[
                        layout.snug ? 'px-3' : 'px-4',
                        layout.restoreFits ? 'shrink-0' : 'min-w-0',
                    ]"
                    :title="layout.restoreFits ? undefined : strings.restore"
                    data-peek-restore
                    @click="restore"
                >
                    <span class="truncate">{{ strings.restore }}</span>
                </button>
            </div>
            <ChangeArrows />
        </div>
    </template>
</template>

<style scoped>
/* Hits reach 4 px past each face: 44 px tall, meeting their neighbours in the 8 px gaps. */
.peek-hit {
    position: relative;
}

.peek-hit::before {
    content: '';
    @apply absolute -inset-1;
}
</style>
