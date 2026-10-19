<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { isPeeking, peekLoading, peekedKey } from '../../history/peek'
import { i18n } from '../../i18n'
import { isBlockingModalOpen, isToolDialogOpen } from '../../modals'
import { isComposingKey } from '../../utils/composition'
import { formatEntryTime, formatDateTimeSeconds } from '../../i18n/when'
import { interpolateRaw } from '../../utils/interpolate'
import { changeLine } from './changes'
import { languageTag } from '../../i18n/plural'
import { settings } from '../../settings'
import { view } from '../view'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import ChangeArrows from './ChangeArrows.vue'
import { backToNow, peekedInfo, requestRestore } from './selection'

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
const compact = computed(() => view.w < 600)
const tiny = computed(() => view.w < 300)
const text = computed(() => {
    const info = peekedInfo.value
    if (!info) return ''
    if (view.w < 480)
        return new Intl.DateTimeFormat(languageTag(settings.locale), {
            year: '2-digit',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        }).format(info.time)
    return formatEntryTime(info.time)
})
const restore = () => {
    if (peekedKey.value) void requestRestore(peekedKey.value)
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
const button =
    'h-11 shrink-0 rounded-full px-4 font-bold outline-offset-[-3px] transition-colors focus-visible:outline focus-visible:outline-2'
</script>

<template>
    <div class="sr-only" aria-live="polite" data-history-announcement>{{ announcement }}</div>
    <template v-if="isPeeking">
        <div
            class="pointer-events-none absolute inset-0 z-10 ring-2 ring-inset ring-accent forced-colors:ring-[Highlight]"
            aria-hidden="true"
        />
        <div
            class="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 px-2"
            :class="view.w < 640 ? 'pt-7' : 'pt-2'"
            data-peek-bar
            @keydown="onKeydown"
        >
            <div
                class="pointer-events-auto flex w-full max-w-lg items-center rounded-3xl bg-modal p-1 text-sm text-fg shadow-md"
                :class="tiny ? 'flex-wrap gap-1' : compact ? 'gap-1' : 'gap-2'"
                data-peek-main
            >
                <span
                    class="min-w-0 truncate pl-3"
                    :class="
                        tiny
                            ? 'w-full pt-1 text-center leading-5'
                            : view.w < 350
                              ? 'flex-1 text-xs'
                              : 'flex-1'
                    "
                    :title="peekedInfo?.label"
                    data-peek-text
                    >{{ text }}</span
                >
                <span class="size-4 shrink-0" :class="tiny ? 'ml-auto' : ''" aria-hidden="true">
                    <span
                        v-if="peekLoading"
                        class="block size-4 animate-spin rounded-full border-2 border-fg/25 border-t-fg"
                    />
                </span>
                <button
                    type="button"
                    class="flex min-w-11 items-center justify-center bg-button shadow-md hover:bg-header-hover active:bg-accent active:text-on-accent"
                    :class="button"
                    :aria-label="strings.backToNow"
                    :title="strings.backToNow"
                    data-peek-back
                    @click="backToNow"
                >
                    <ChevronIcon v-if="compact" direction="left" /><template v-else>{{
                        strings.backToNow
                    }}</template>
                </button>
                <button
                    type="button"
                    class="bg-accent text-on-accent"
                    :class="[button, tiny ? 'mr-auto' : '']"
                    data-peek-restore
                    @click="restore"
                >
                    {{ strings.restore }}
                </button>
            </div>
            <ChangeArrows />
        </div>
    </template>
</template>
