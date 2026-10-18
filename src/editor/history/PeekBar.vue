<script setup lang="ts">
import { computed } from 'vue'
import { isPeeking, peekLoading, peekedKey } from '../../history/peek'
import { i18n } from '../../i18n'
import { formatEntryTime } from '../../i18n/when'
import { interpolateRaw } from '../../utils/interpolate'
import { view } from '../view'
import { isCoarsePointer, isPanelVisible, workspaceLayout } from '../workspace'
import { backToNow, peekedInfo, requestRestore } from './selection'

// The peek bar (Part 1 §1.4.11): on the canvas, so it shows with the panel scrolled, folded or on
// another dock. A 2 px accent edge marks the peeked canvas.

// The pane's width decides the text, so the bar stays on one line: under 480 px the time alone,
// from 480 "Viewing {time} · read-only", from 720 with what the entry is. An entry not from today
// always carries its date, so an old state never reads as one from this afternoon.
const MEDIUM_PANE = 480
const WIDE_PANE = 720

const strings = computed(() => i18n.value.peek)

const text = computed(() => {
    const info = peekedInfo.value
    if (!info) return ''
    const time = formatEntryTime(info.time)
    if (view.w >= WIDE_PANE) return interpolateRaw(strings.value.viewing, time, info.label)
    if (view.w >= MEDIUM_PANE) return interpolateRaw(strings.value.viewingShort, time)
    return time
})

// The hint is for a finger: a mouse has nothing to tap. It shows while the History tab is shown in
// the top dock.
const foldHint = computed(
    () =>
        isCoarsePointer.value &&
        isPanelVisible('history') &&
        workspaceLayout.value.sides.history === 'top',
)

const restore = () => {
    const key = peekedKey.value
    if (key) void requestRestore(key)
}

const button =
    'h-8 shrink-0 rounded-full px-4 font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-modal [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11'
</script>

<template>
    <template v-if="isPeeking">
        <div
            class="pointer-events-none absolute inset-0 z-10 ring-2 ring-inset ring-accent forced-colors:ring-[Highlight]"
            aria-hidden="true"
        />
        <div
            class="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-1 px-2 pt-2"
            data-peek-bar
        >
            <div
                class="pointer-events-auto flex max-w-full items-center justify-center gap-x-2 rounded-3xl bg-modal py-1 pl-4 pr-1 text-sm text-fg shadow-md"
            >
                <span v-if="text" class="min-w-0 truncate py-1" data-peek-text>{{ text }}</span>
                <span
                    v-if="peekLoading"
                    class="size-4 shrink-0 animate-spin rounded-full border-2 border-fg/25 border-t-fg"
                    role="status"
                    aria-hidden="true"
                />
                <span class="flex shrink-0 gap-2">
                    <button
                        type="button"
                        class="bg-button shadow-md hover:bg-header-hover active:bg-accent active:text-on-accent"
                        :class="button"
                        data-peek-back
                        @click="backToNow"
                    >
                        {{ strings.backToNow }}
                    </button>
                    <button
                        type="button"
                        class="bg-accent text-on-accent"
                        :class="button"
                        data-peek-restore
                        @click="restore"
                    >
                        {{ strings.restore }}
                    </button>
                </span>
            </div>
            <div
                v-if="foldHint"
                class="rounded-full bg-modal/90 px-3 py-0.5 text-xs text-fg"
                data-peek-hint
            >
                {{ i18n.history.foldHint }}
            </div>
        </div>
    </template>
</template>
