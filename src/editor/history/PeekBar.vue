<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { isPeeking, peekedKey, restoreEntry } from '../../history/peek'
import { i18n } from '../../i18n'
import { formatClockSeconds } from '../../i18n/when'
import { interpolateRaw } from '../../utils/interpolate'
import { view } from '../view'
import { isCoarsePointer, isHistoryOpen, workspaceLayout } from '../workspace'
import { backToNow, peekPending, peekedInfo } from './selection'

// The peek bar (Part 1 §1.4.11): on the canvas, so it shows with the panel scrolled, folded or on
// another dock. A 2 px accent edge marks the peeked canvas.

// Wide enough for the whole line beside the buttons; otherwise just the time and "read-only".
const WIDE_PANE = 640

const strings = computed(() => i18n.value.peek)

const text = computed(() => {
    const info = peekedInfo.value
    if (!info) return ''
    const time = formatClockSeconds(info.time)
    return view.w >= WIDE_PANE
        ? interpolateRaw(strings.value.viewing, time, info.label)
        : interpolateRaw(strings.value.viewingShort, time)
})

// A spinner appears when a state takes more than 150 ms to load (§1.4.11).
const busy = shallowRef(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(peekPending, (pending) => {
    clearTimeout(timer)
    busy.value = false
    if (pending) timer = setTimeout(() => (busy.value = true), 150)
})
onBeforeUnmount(() => {
    clearTimeout(timer)
})

// The hint is for a finger: a mouse has nothing to tap. It shows while History is open and its
// dock is not folded away.
const foldHint = computed(() => {
    if (!isCoarsePointer.value || !isHistoryOpen.value) return false
    const side = workspaceLayout.value.sides.history
    return !!side && !workspaceLayout.value.docks[side]?.collapsed
})

const restore = () => {
    const key = peekedKey.value
    if (key) void restoreEntry(key)
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
                class="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1.5 rounded-3xl bg-modal px-4 py-1.5 text-sm text-fg shadow-md"
            >
                <span v-if="text" class="min-w-0 py-1" data-peek-text>{{ text }}</span>
                <span
                    v-if="busy"
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
