<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isPeeking, peekLoading, peekedKey } from '../../history/peek'
import { i18n } from '../../i18n'
import { isBlockingModalOpen, isToolDialogOpen } from '../../modals'
import { isComposingKey } from '../../utils/composition'
import { interpolateRaw } from '../../utils/interpolate'
import {
    awaitingRead,
    barInfo,
    firstRead,
    changeLine,
    countedLines,
    fixedLine,
    fixedLines,
    pressWhenRead,
} from './changes'
import { settings } from '../../settings'
import { view } from '../view'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import WaitSpinner from '../workspace/WaitSpinner.vue'
import ChangeArrows from './ChangeArrows.vue'
import InfoIcon from './InfoIcon.vue'
import { useRootFontSize } from '../useRootFontSize'
import { useHistoryCalendar } from './calendarClock'
import { historyFormat } from './historyFormat'
import { historyOperationContext } from './historyOperationContext'
import {
    measurePeekWidths,
    peekLayout,
    peekText,
    peekWidths,
    SESSION_STRIP_MAX,
    sessionPeekText,
} from './peekFit'
import { backToNow, peekedInfo, peekedLabel, peekedSession, requestRestore } from './selection'
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
watch(peekedSession, (info) => {
    if (!info) return
    announcedAt = performance.now()
    announcement.value = interpolateRaw(
        i18n.value.history.announceViewing,
        `${interpolateRaw(i18n.value.history.quoted, info.name)} · ${format.value.dateTimeSeconds(info.time)}`,
    )
})
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
const measureWith = (restore: string) =>
    measurePeekWidths(
        document.body,
        settings.locale,
        settings.beatDisplay,
        {
            back: strings.value.backToNow,
            restore,
            states: fixedLines.short.map(fixedLine),
            statesWide: fixedLines.wide.map(fixedLine),
            summary: fixedLines.summary.map(fixedLine),
            counted: countedLines(),
        },
        calendar.value,
    )
// A session's button reads Restore Session or Restore as a Copy: the widest of the two.
const sessionLabels = computed(() => ({
    restore: i18n.value.open.restoreIt,
    copy: i18n.value.load.restoreAsCopy,
}))
const sessionRestoreWidth = ref(0)
const measure = () => {
    peekWidths.value = measureWith(strings.value.restore)
    sessionRestoreWidth.value = Math.max(
        measureWith(sessionLabels.value.restore).restore,
        measureWith(sessionLabels.value.copy).restore,
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
// The session strip names the session beside its time, in two lines; the time has no seconds, and
// the name takes what the fit leaves, 64 px at least. It has no change capsule to keep its width
// with, so it may be wider than the Timeline's strip.
const layout = computed(() => {
    const widths = peekWidths.value
    const session = peekedSession.value
    if (!session || !widths) return peekLayout(view.w, widths)
    const room = (64 * widths.rem) / 16
    const time = (widths.session ?? widths.earlier) + room
    return peekLayout(
        view.w,
        {
            ...widths,
            restore: sessionRestoreWidth.value,
            today: time,
            earlier: time,
            compact: time,
        },
        SESSION_STRIP_MAX,
    )
})
// A session's strip is two rows in a narrow pane, so its name has the room: the text, then the
// buttons, which keep their labels where the row has room for both.
const stacked = computed(() => !!peekedSession.value && view.w < 420)
// The stacked strip takes the pane less its gutters, as the Timeline's strip does.
const stackedWidth = computed(() => view.w - (16 * (peekWidths.value?.rem ?? 16)) / 16)
const backLabel = computed(() => {
    const widths = peekWidths.value
    if (!stacked.value || !widths) return layout.value.back === 'label'
    const k = widths.rem / 16
    const row = (4 + 8 + 8 + 4 + 32 + 32) * k + widths.back + sessionRestoreWidth.value
    return row <= stackedWidth.value
})
const sessionText = computed(() => {
    const info = peekedSession.value
    return info
        ? {
              name: interpolateRaw(i18n.value.history.quoted, info.name),
              time: sessionPeekText(calendar.value, settings.locale, info.time),
              restore: sessionLabels.value[info.action],
          }
        : undefined
})
// The step the bar names: the last one's until the next one's change is read (changes.ts).
const shownInfo = barInfo
const text = computed(() => {
    const info = shownInfo.value
    return info ? peekText(calendar.value, settings.locale, info.time, layout.value.wide) : ''
})

// Leaving the peek takes the strip away, by Back to Now, Restore, Escape, Undo or anything else:
// focus in it, or in its options menu, goes to the chart.
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
    if (peekedSession.value) peekedSession.value.restore()
    else if (peekedKey.value) void requestRestore(peekedKey.value)
}
// A press while the last step is held opens the new step's details once its change is read.
const details = () => {
    if (awaitingRead.value) {
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
            :style="{ '--peek-w': `${stacked ? stackedWidth : layout.width}px` }"
            data-peek-bar
            @keydown="onKeydown"
        >
            <div
                class="pointer-events-auto flex w-[--peek-w] max-w-full items-center gap-2 bg-modal p-1 text-sm text-fg shadow-xl ring-1 ring-fg/10"
                :class="stacked ? 'flex-wrap justify-end rounded-[1.375rem]' : 'rounded-full'"
                data-peek-main
            >
                <!-- A session: its name over its time, no details to open. -->
                <div
                    v-if="sessionText"
                    class="mr-auto flex h-9 min-w-0 flex-col justify-center px-2.5"
                    :class="{ 'w-full': stacked }"
                    :title="`${sessionText.name} · ${sessionText.time}`"
                    data-peek-text
                    data-peek-session
                >
                    <span class="block truncate text-sm leading-[1.125rem]">{{
                        sessionText.name
                    }}</span>
                    <span class="block truncate text-xs tabular-nums leading-4 text-fg/80">{{
                        sessionText.time
                    }}</span>
                </div>
                <!-- The date at the start, its glyph concentric with the strip's end cap. -->
                <button
                    v-else
                    type="button"
                    class="peek-hit ghost mr-auto flex h-9 min-w-0 items-center gap-2 rounded-full"
                    :class="[
                        layout.tiny ? 'w-9 shrink-0 justify-center' : 'px-2.5',
                        { invisible: firstRead },
                    ]"
                    :title="shownInfo && peekedLabel(shownInfo, peekContext)"
                    :aria-label="interpolateRaw(i18n.history.details.named, text)"
                    data-peek-text
                    data-peek-details
                    @click="details"
                >
                    <WaitSpinner v-if="peekLoading" class="size-4" />
                    <InfoIcon v-else class="size-4 shrink-0 fill-current" />
                    <span v-if="!layout.tiny" class="min-w-0 truncate tabular-nums">{{
                        text
                    }}</span>
                </button>
                <button
                    type="button"
                    class="peek-hit btn btn-secondary flex h-9 shrink-0 items-center justify-center rounded-full"
                    :class="backLabel ? 'px-4' : 'w-9'"
                    :aria-label="strings.backToNow"
                    :title="strings.backToNow"
                    data-peek-back
                    @click="backToNow"
                >
                    <template v-if="backLabel">{{ strings.backToNow }}</template
                    ><ChevronIcon v-else direction="left" centered />
                </button>
                <button
                    type="button"
                    class="peek-hit btn btn-primary flex h-9 items-center justify-center rounded-full"
                    :class="[
                        layout.snug ? 'px-3' : 'px-4',
                        layout.restoreFits ? 'shrink-0' : 'min-w-0',
                    ]"
                    :title="
                        layout.restoreFits ? undefined : (sessionText?.restore ?? strings.restore)
                    "
                    data-peek-restore
                    @click="restore"
                >
                    <span class="truncate">{{ sessionText?.restore ?? strings.restore }}</span>
                </button>
            </div>
            <ChangeArrows v-if="!sessionText" />
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
