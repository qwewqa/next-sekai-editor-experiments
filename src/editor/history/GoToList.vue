<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { i18n } from '../../i18n'
import { formatClockRange } from '../../i18n/when'
import type { TimelinePiece } from '../../local/worker/timelineHandlers'
import { dayLabel, stepsText } from './labels'
import { readIndex, type Target } from './source'
import { historyFilter } from './state'

// Go To's jump list (Part 1 §1.4.10.5): Now, then the days, newest first, with the sessions in
// each; a day of one session is one row. While filtering it lists and counts saves and exports.
// The piece at the top of the Timeline has a check; the list opens scrolled to it.

const props = defineProps<{ current: Target | 'now' | undefined }>()

const emit = defineEmits<{ pick: [target: Target | 'now'] }>()

type Item =
    | { kind: 'now'; id: string }
    | {
          kind: 'day' | 'session'
          id: string
          /** A day of one session names the day and the session. */
          time: number
          range?: string
          count: number
          target: Target
          pieces: TimelinePiece[]
      }

const pieces = shallowRef<TimelinePiece[]>()
const failed = ref(false)

const load = async () => {
    const filter = historyFilter.value
    pieces.value = undefined
    failed.value = false
    try {
        const index = await readIndex(filter)
        if (filter === historyFilter.value) pieces.value = index.pieces
    } catch {
        failed.value = true
    }
}
watch(historyFilter, load, { immediate: true })

const dayOf = (time: number) => new Date(time).setHours(0, 0, 0, 0)
const rangeOf = (piece: TimelinePiece) => formatClockRange(piece.oldest, piece.newest)
const targetOf = (piece: TimelinePiece): Target => ({
    sessionId: piece.sessionId,
    seq: piece.newestSeq,
})

const items = computed((): Item[] => {
    const list: Item[] = [{ kind: 'now', id: 'now' }]
    const days: TimelinePiece[][] = []
    for (const piece of pieces.value ?? []) {
        const last = days.at(-1)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (last && dayOf(last[0]!.newest) === dayOf(piece.newest)) last.push(piece)
        else days.push([piece])
    }
    for (const day of days) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const first = day[0]!
        const count = day.reduce((sum, piece) => sum + piece.count, 0)
        list.push({
            kind: 'day',
            id: `d:${first.sessionId}:${first.newestSeq}`,
            time: first.newest,
            ...(day.length === 1 ? { range: rangeOf(first) } : {}),
            count,
            target: targetOf(first),
            pieces: day,
        })
        if (day.length > 1)
            for (const piece of day)
                list.push({
                    kind: 'session',
                    id: `s:${piece.sessionId}:${piece.newestSeq}`,
                    time: piece.newest,
                    range: rangeOf(piece),
                    count: piece.count,
                    target: targetOf(piece),
                    pieces: [piece],
                })
    }
    return list
})

const holds = (piece: TimelinePiece, target: Target) =>
    piece.sessionId === target.sessionId &&
    piece.oldestSeq <= target.seq &&
    target.seq <= piece.newestSeq

/** The row with the check: Now, a session's, or a day of one session. */
const currentId = computed(() => {
    const current = props.current
    if (current === 'now') return 'now'
    if (!current) return
    return items.value.find(
        (item) =>
            item.kind !== 'now' &&
            (item.kind === 'session' || item.pieces.length === 1) &&
            item.pieces.some((piece) => holds(piece, current)),
    )?.id
})

// --- The active row: the one the keys are on.
const listId = useId()
const optionId = (id: string) => `${listId}-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
const activeId = ref<string>()
const list = useTemplateRef<HTMLDivElement>('list')

const scrollToItem = (id: string | undefined, block: ScrollLogicalPosition) => {
    if (!id) return
    list.value
        ?.querySelector(`#${CSS.escape(optionId(id))}`)
        ?.scrollIntoView({ block, inline: 'nearest' })
}

// Opens on the current row, scrolled into view once the list has its rows and its place.
watch(
    () => pieces.value,
    async (loaded) => {
        if (!loaded) return
        activeId.value = currentId.value ?? 'now'
        await nextTick()
        requestAnimationFrame(() => {
            scrollToItem(activeId.value, 'center')
        })
    },
)

const move = (delta: number | 'first' | 'last') => {
    const all = items.value
    const at = all.findIndex((item) => item.id === activeId.value)
    const next =
        delta === 'first'
            ? 0
            : delta === 'last'
              ? all.length - 1
              : Math.max(0, Math.min(all.length - 1, at + delta))
    activeId.value = all[next]?.id
    scrollToItem(activeId.value, 'nearest')
}

const pick = (item: Item) => {
    emit('pick', item.kind === 'now' ? 'now' : item.target)
}

const onKeydown = (event: KeyboardEvent) => {
    const key = event.key
    if (key === 'ArrowDown' || key === 'ArrowUp') move(key === 'ArrowDown' ? 1 : -1)
    else if (key === 'PageDown' || key === 'PageUp') move(key === 'PageDown' ? 8 : -8)
    else if (key === 'Home' || key === 'End') move(key === 'Home' ? 'first' : 'last')
    else if (key === 'Enter' || key === ' ') {
        const item = items.value.find((candidate) => candidate.id === activeId.value)
        if (item) pick(item)
    } else return
    event.preventDefault()
}

const SKELETON_ROWS = 4

const labelOf = (item: Item) =>
    item.kind === 'now'
        ? i18n.value.history.now
        : [item.kind === 'day' ? dayLabel(item.time) : undefined, item.range, stepsText(item.count)]
              .filter(Boolean)
              .join(', ')
</script>

<template>
    <div class="popup-separator" />
    <div :id="`${listId}-heading`" class="popup-heading">{{ i18n.history.goTo }}</div>
    <div
        ref="list"
        role="listbox"
        tabindex="0"
        class="goto-list outline-none"
        :aria-labelledby="`${listId}-heading`"
        :aria-activedescendant="activeId ? optionId(activeId) : undefined"
        :aria-busy="!pieces && !failed"
        data-goto-list
        @keydown="onKeydown"
    >
        <div
            v-for="item in items"
            :id="optionId(item.id)"
            :key="item.id"
            role="option"
            class="goto-item"
            :class="{
                'goto-item-active': activeId === item.id,
                'goto-item-current': currentId === item.id,
                'goto-item-session': item.kind === 'session',
            }"
            :aria-selected="activeId === item.id"
            :aria-current="currentId === item.id ? 'location' : undefined"
            :aria-label="labelOf(item)"
            :data-goto-item="item.kind"
            @click="pick(item)"
            @pointermove="activeId = item.id"
        >
            <span
                v-if="item.kind === 'now'"
                class="flex size-4 shrink-0 items-center justify-center"
                aria-hidden="true"
            >
                <span class="size-2.5 rounded-full bg-fg" />
            </span>
            <span v-if="item.kind === 'now'" class="min-w-0 flex-1 truncate font-bold">{{
                i18n.history.now
            }}</span>
            <span v-else class="flex min-w-0 flex-1 items-baseline gap-2">
                <span v-if="item.kind === 'day'" class="shrink-0 font-bold">{{
                    dayLabel(item.time)
                }}</span>
                <span v-if="item.range" class="min-w-0 truncate">{{ item.range }}</span>
            </span>
            <svg
                v-if="currentId === item.id"
                class="size-4 shrink-0"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                data-goto-check
            >
                <path d="M3.5 8.5l3 3 6-7" />
            </svg>
            <span
                v-if="item.kind !== 'now'"
                class="shrink-0 text-right text-xs tabular-nums text-fg/70"
                >{{ stepsText(item.count) }}</span
            >
        </div>
        <template v-if="!pieces && !failed">
            <div
                v-for="n in SKELETON_ROWS"
                :key="`skeleton-${n}`"
                class="goto-item motion-safe:animate-pulse"
                aria-hidden="true"
                data-goto-loading
            >
                <span class="h-3 rounded-full bg-fg/10" :style="{ width: `${64 - n * 8}%` }" />
                <span class="ml-auto h-3 w-12 shrink-0 rounded-full bg-fg/10" />
            </div>
        </template>
        <div v-else-if="failed" class="px-3 py-2 text-fg/70" data-goto-failed>
            {{ i18n.history.loadFailed }}
        </div>
    </div>
</template>

<style scoped>
.goto-item {
    @apply flex min-h-9 shrink-0 cursor-default select-none items-center gap-3 rounded px-3 py-1.5 transition-colors [@media(pointer:coarse)]:min-h-11;
}

.goto-item-session {
    @apply pl-10;
}

.goto-item-current {
    @apply bg-popup-hover;
}

.goto-list:focus-visible .goto-item-active {
    @apply outline outline-2 -outline-offset-2 outline-fg;
}

@media (hover: hover) {
    .goto-item:hover {
        @apply bg-popup-hover;
    }
}

.goto-item:active {
    @apply bg-accent text-on-accent;
}
</style>
