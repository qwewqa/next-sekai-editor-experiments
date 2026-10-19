<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isPeeking, peekLoading, peekedKey } from '../../history/peek'
import { i18n } from '../../i18n'
import { isBlockingModalOpen, isToolDialogOpen } from '../../modals'
import { isComposingKey } from '../../utils/composition'
import { formatDateTimeSeconds } from '../../i18n/when'
import { interpolateRaw } from '../../utils/interpolate'
import { changeLine } from './changes'
import { settings } from '../../settings'
import { view } from '../view'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import ChangeArrows from './ChangeArrows.vue'
import InfoIcon from './InfoIcon.vue'
import { measurePeekWidths, peekLayout, peekText, peekWidths } from './peekFit'
import { backToNow, peekedInfo, peekedLabel, requestRestore } from './selection'
import { openOperationDetails } from './operationDetails'

// --- Announcing the peek: with its change when that arrives within 300 ms, else the change alone.
const announcement = ref('')
let announcedAt = 0
watch(
    peekedInfo,
    (info) => {
        announcedAt = Date.now()
        announcement.value = info
            ? interpolateRaw(i18n.value.history.announceViewing, formatDateTimeSeconds(info.time))
            : ''
    },
    { immediate: true },
)
watch(changeLine, (line) => {
    const info = peekedInfo.value
    if (!line || !info) return
    announcement.value =
        Date.now() - announcedAt <= 300
            ? interpolateRaw(
                  i18n.value.history.announceViewingChange,
                  formatDateTimeSeconds(info.time),
                  line,
              )
            : line
})

const strings = computed(() => i18n.value.peek)

// --- One width per language and width class, so the arrows below never move (peekFit.ts).
const measure = () => {
    peekWidths.value = measurePeekWidths(document.body, settings.locale, settings.beatDisplay, {
        back: strings.value.backToNow,
        restore: strings.value.restore,
        states: [
            strings.value.loadingShort,
            strings.value.unavailableShort,
            strings.value.noChanges,
            strings.value.initialState,
        ],
        statesWide: [
            strings.value.loadingChanges,
            strings.value.unavailable,
            strings.value.noChanges,
            strings.value.initialState,
        ],
    })
}
onMounted(() => {
    measure()
    document.fonts.addEventListener('loadingdone', measure)
})
onBeforeUnmount(() => {
    document.fonts.removeEventListener('loadingdone', measure)
})
watch(() => [settings.locale, settings.beatDisplay], measure)
const layout = computed(() => peekLayout(view.w, peekWidths.value))
const text = computed(() => {
    const info = peekedInfo.value
    return info ? peekText(settings.locale, info.time, layout.value.wide) : ''
})

const restore = () => {
    if (peekedKey.value) void requestRestore(peekedKey.value)
}
const details = () => {
    const info = peekedInfo.value
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
                    :title="peekedInfo && peekedLabel(peekedInfo)"
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
                    ><ChevronIcon v-else direction="left" />
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
