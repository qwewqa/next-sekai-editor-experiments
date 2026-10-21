<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import type { DayKey } from '../../calendar/calendar'
import { daysOf, type TimelinePiece } from '../../calendar/pieces'
import { i18n } from '../../i18n'
import { settings } from '../../settings'
import { checkHistoryCalendar, useHistoryCalendar } from './calendarClock'
import CheckIcon from './CheckIcon.vue'
import { historyFormat } from './historyFormat'
import { dayLabel, stepsText } from './labels'
import { goToPieces, goToStamp, here, loadGoTo, type Target } from './source'
import { hereRange, historyFilter, historyViewGeneration } from './state'
import { session } from '../../history/session'

// Go To's jump list (Part 1 §1.4.10.5): Now, then the days, newest first, with the sessions in
// each; a day of one session is one row. While filtering it lists and counts saves and exports.
// The piece at the top of the Timeline has a check; the list opens scrolled to it.

const props = defineProps<{ current: Target | 'now' | undefined; restoreActiveId?: string }>()

const emit = defineEmits<{ pick: [target: Target | 'now']; ready: [] }>()

type Item =
    | { kind: 'now'; id: string }
    | {
          kind: 'day' | 'session'
          id: string
          /** A day of one session names the day and the session. */
          day: DayKey
          range?: string
          count: number
          target: Target
          pieces: TimelinePiece[]
      }

// Go To's day names and times are the Timeline's: one History clock and zone (I-1). It looks at the
// clock when it opens, so a list opened after a sleep or a move is current at once.
const calendar = useHistoryCalendar()
checkHistoryCalendar()
const format = computed(() => historyFormat(calendar.value, settings.locale))
const dayText = (day: DayKey) => dayLabel(day, calendar.value)

// Go To's pieces are the source's: the index read for this list, with the Timeline's own entries
// above what it covers. They are dropped only for another view (a zone, filter, range or session),
// not while the index is read again for the same one.
const pieces = goToPieces
const failed = ref(false)
let request = 0
// Counts the openings of the list (it showing its rows), so a read again does not cancel one.
let shown = 0
let frame = 0
let restored = false
let shownFor: string | undefined
const identity = () =>
    [
        historyViewGeneration(),
        session.value.sessionId,
        historyFilter.value,
        hereRange.value?.from,
        hereRange.value?.to,
    ].join('|')
const openedFor = identity()
onBeforeUnmount(() => {
    request++
    shown++
    cancelAnimationFrame(frame)
})

const load = async () => {
    const mark = ++request
    const context = identity()
    const filter = historyFilter.value
    const zone = calendar.value.zone
    const view = `${context}|${zone}`
    const keep = view === shownFor
    if (!keep) shownFor = undefined
    failed.value = false
    try {
        await loadGoTo(filter, zone, keep)
        if (mark === request && context === identity()) shownFor = view
    } catch {
        // A list that is shown stays when it cannot be read again.
        if (mark === request && context === identity() && !pieces.value) failed.value = true
    }
}
watch(
    [
        historyFilter,
        hereRange,
        historyViewGeneration,
        () => session.value.sessionId,
        () => here.scanning,
        // The days are in the clock's zone: a list read for another zone is read again.
        () => calendar.value.zone,
    ],
    load,
    {
        immediate: true,
    },
)
// The entries the index covers moved: read it again, keeping the list. A watch of its own, as a
// source list with a shallow ref calls back whenever any source is read again, equal or not.
watch(goToStamp, load)

const rangeOf = (piece: TimelinePiece) => format.value.clockRange(piece.earliest, piece.latest)
const targetOf = (piece: TimelinePiece): Target => ({
    sessionId: piece.sessionId,
    seq: piece.newestSeq,
})

const items = computed((): Item[] => {
    const list: Item[] = [{ kind: 'now', id: 'now' }]
    for (const { day, pieces: members, count } of daysOf(pieces.value ?? [])) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const first = members[0]!
        list.push({
            kind: 'day',
            id: `d:${first.sessionId}:${first.oldestSeq}`,
            day,
            ...(members.length === 1 ? { range: rangeOf(first) } : {}),
            count,
            target: targetOf(first),
            pieces: members,
        })
        if (members.length > 1)
            for (const piece of members)
                list.push({
                    kind: 'session',
                    id: `s:${piece.sessionId}:${piece.oldestSeq}`,
                    day,
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
defineExpose({ activeId: () => activeId.value })

const scrollToItem = (id: string | undefined, block: ScrollLogicalPosition) => {
    if (!id) return
    list.value
        ?.querySelector(`#${CSS.escape(optionId(id))}`)
        ?.scrollIntoView({ block, inline: 'nearest' })
}

// Opens on the current row, scrolled into view once the list has its rows and its place. Now sits
// at the top, so in a short popover it stays put and Show stays in view.
watch(
    () => !!pieces.value,
    async (loaded) => {
        const mark = ++shown
        if (!loaded) return
        const saved = !restored && openedFor === identity() ? props.restoreActiveId : undefined
        activeId.value =
            saved && items.value.some(({ id }) => id === saved) ? saved : (currentId.value ?? 'now')
        restored = true
        await nextTick()
        if (mark !== shown) return
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
            if (mark !== shown) return
            scrollToItem(activeId.value, activeId.value === 'now' ? 'nearest' : 'center')
            emit('ready')
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
        : [item.kind === 'day' ? dayText(item.day) : undefined, item.range, stepsText(item.count)]
              .filter(Boolean)
              .join(', ')
</script>

<template>
    <!-- One rule between Show and Go To: the popover draws it. Labels share one column at 40 (the
         Now dot's slot, kept empty on days), sessions 20 px inside their day. -->
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
                v-if="item.kind !== 'session'"
                class="flex size-4 shrink-0 items-center justify-center"
                aria-hidden="true"
            >
                <span v-if="item.kind === 'now'" class="size-2.5 rounded-full bg-fg" />
            </span>
            <span v-if="item.kind === 'now'" class="min-w-0 flex-1 truncate font-bold">{{
                i18n.history.now
            }}</span>
            <span v-else class="flex min-w-0 flex-1 items-baseline gap-2">
                <span v-if="item.kind === 'day'" class="shrink-0 font-bold">{{
                    dayText(item.day)
                }}</span>
                <span v-if="item.range" class="min-w-0 truncate">{{ item.range }}</span>
            </span>
            <CheckIcon
                v-if="currentId === item.id"
                class="size-4 shrink-0 fill-current"
                data-goto-check
            />
            <span
                v-if="item.kind !== 'now'"
                class="shrink-0 text-right text-xs tabular-nums text-fg/80"
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
                <span class="size-4 shrink-0" />
                <span class="h-3 rounded-full bg-fg/10" :style="{ width: `${64 - n * 8}%` }" />
                <span class="ml-auto h-3 w-12 shrink-0 rounded-full bg-fg/10" />
            </div>
        </template>
        <div v-else-if="failed" class="py-2 pl-10 pr-3 text-fg/80" data-goto-failed>
            {{ i18n.history.loadFailed }}
        </div>
    </div>
</template>

<style scoped>
.goto-item {
    @apply flex min-h-9 shrink-0 cursor-default select-none items-center gap-3 rounded px-3 py-2 transition-colors;
}

.goto-item-session {
    @apply pl-[3.75rem];
}

/* The listbox holds focus; its active option rings at its edge (focus-edge, on the option). */
.goto-list:focus-visible .goto-item-active {
    outline: 2px solid rgb(var(--color-fg));
    outline-offset: -2px;
}

@media (hover: hover) and (pointer: fine) {
    .goto-item:hover {
        @apply bg-popup-hover;
    }
}

.goto-item:active {
    @apply bg-ghost-press text-fg-strong;
}
</style>
