<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    useTemplateRef,
    watch,
} from 'vue'
import { peekedKey, restoreEntry } from '../../history/peek'
import { headName } from '../../history/stack'
import { session } from '../../history/session'
import { i18n } from '../../i18n'
import {
    formatClock,
    formatClockSeconds,
    formatDate,
    formatDateTime,
    formatEntryTime,
} from '../../i18n/when'
import { interpolate, interpolateRaw } from '../../utils/interpolate'
import { commands, type CommandName } from '../commands'
import { runCommand } from '../commands/runCommand'
import { isApplePlatform, matchBindings } from '../controls/bindings'
import { settings } from '../../settings'
import { closeHistory, isCoarsePointer } from '../workspace'
import ManagerMenu from '../workspace/manager/ManagerMenu.vue'
import OverlayScrollbar from '../workspace/OverlayScrollbar.vue'
import KindIcon from './KindIcon.vue'
import WarningIcon from './WarningIcon.vue'
import { buildRows, selectableRows, type Entry, type EntryRow, type Row } from './rows'
import { backToNow, damagedEntries, entryKey, peekedInfo, requestPeek, sameKey } from './selection'
import { canLoadMore, entries, followEntries, loadMore } from './source'
import { expandedGroups, historyFilter } from './state'

// The Timeline (Part 1 §1.4.10.5): an ARIA listbox of the chain's entries, newest first, windowed.
// Selecting a row peeks it; the controls for leaving or restoring are on the canvas (§1.4.11).

const props = defineProps<{
    /** Two-line rows, in the side docks; the top dock's rows are one line. */
    twoLine: boolean
}>()

const list = useTemplateRef<HTMLDivElement>('list')
const scrollTop = ref(0)
const viewport = ref(0)
const width = ref(0)

followEntries()

const rows = computed(() =>
    buildRows(entries.value, {
        filter: historyFilter.value,
        expanded: expandedGroups.value,
        damaged: damagedEntries.value,
    }),
)

// --- Geometry: rows have fixed heights per kind, so the window needs no measuring.
const rowHeight = computed(() => {
    if (props.twoLine) return isCoarsePointer.value ? 48 : 40
    return isCoarsePointer.value ? 44 : 36
})
const HEADER = 28
const DIVIDER = 32
const heightOf = (row: Row) =>
    row.type === 'header' ? HEADER : row.type === 'divider' ? DIVIDER : rowHeight.value
const geometry = computed(() => {
    let y = 0
    const offsets = rows.value.map((row) => {
        const top = y
        y += heightOf(row)
        return top
    })
    return { offsets, total: y }
})

const OVERSCAN = 12
const range = computed(() => {
    const { offsets } = geometry.value
    const count = rows.value.length
    // The last row starting at or above the scroll position.
    let low = 0
    let high = count
    while (low < high) {
        const mid = (low + high) >> 1
        if ((offsets[mid] ?? Infinity) <= scrollTop.value) low = mid + 1
        else high = mid
    }
    const first = Math.max(0, low - 1 - OVERSCAN)
    const bottom = scrollTop.value + viewport.value
    let end = low
    while (end < count && (offsets[end] ?? Infinity) < bottom) end++
    return { first, end: Math.min(count, end + OVERSCAN) }
})

const visibleRows = computed(() =>
    rows.value.slice(range.value.first, range.value.end).map((row, i) => ({
        row,
        top: geometry.value.offsets[range.value.first + i] ?? 0,
    })),
)

/** Rows a listbox counts: everything but the headers. */
const positions = computed(() => {
    const map = new Map<string, number>()
    let n = 0
    for (const row of rows.value) if (row.type !== 'header') map.set(row.id, ++n)
    return { map, size: n }
})

// --- The cursor: the row the keys and the peek are on.
const cursorId = ref('now')

const selectables = computed(() => selectableRows(rows.value))

const rowById = (id: string) => rows.value.find((row) => row.id === id)

// The peeked entry's row, or its group's while the group is closed.
const rowOf = (key: ReturnType<typeof entryKey> | undefined) => {
    if (!key) return rows.value[0]
    const plain = rows.value.find(
        (row) => row.type === 'entry' && row.child && sameKey(entryKey(row.entry), key),
    )
    if (plain) return plain
    return rows.value.find(
        (row) =>
            row.type === 'entry' &&
            !row.child &&
            row.members.some((member) => sameKey(entryKey(member), key)),
    )
}

watch([peekedKey, () => rows.value], () => {
    const key = peekedKey.value
    const row = rowOf(key)
    // A peek being asked for keeps the cursor where it was put.
    if (!key && peekedInfo.value) return
    if (row) cursorId.value = row.id
    else if (!key) cursorId.value = 'now'
})

const infoOf = (entry: Entry) => ({ key: entryKey(entry), time: entry.time, label: entry.label })

const moveTo = (row: Row | undefined, immediate: boolean) => {
    if (!row) return
    cursorId.value = row.id
    if (row.type === 'now') backToNow()
    else if (row.type === 'entry' && row.selectable) requestPeek(infoOf(row.entry), { immediate })
    scrollToRow(row.id)
}

const scrollToRow = (id: string) => {
    const element = list.value
    const index = rows.value.findIndex((row) => row.id === id)
    const row = rows.value[index]
    if (!element || !row) return
    const top = geometry.value.offsets[index] ?? 0
    const bottom = top + heightOf(row)
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight)
        element.scrollTop = bottom - element.clientHeight
}

const step = (delta: number) => {
    const at = selectables.value.findIndex((row) => row.id === cursorId.value)
    const next = selectables.value[Math.max(0, Math.min(selectables.value.length - 1, at + delta))]
    if (next && next.id !== cursorId.value) moveTo(next, false)
}

const toggleGroup = (row: EntryRow, open: boolean) => {
    if (row.members.length < 2 || row.child) return
    const next = new Set(expandedGroups.value)
    if (open) next.add(row.id)
    else next.delete(row.id)
    expandedGroups.value = next
}

// --- Restore
const restore = async (row: EntryRow) => {
    await restoreEntry(entryKey(row.entry))
}

// --- Menu: Restore, by right click, Shift+F10 or the Menu key.
const menu = shallowRef<{ row: EntryRow; anchor: HTMLElement; touch: boolean }>()
const openMenu = (row: EntryRow, anchor: HTMLElement, touch = false) => {
    if (!row.selectable || menu.value?.row.id === row.id) return
    menu.value = { row, anchor, touch }
}
const closeMenu = (restoreFocus: boolean) => {
    if (!menu.value) return
    menu.value = undefined
    if (restoreFocus) list.value?.focus({ preventScroll: true })
}
const menuItems = computed(() => [{ key: 'restore', label: i18n.value.peek.restore }])
const onMenuSelect = (key: string, keyboard: boolean) => {
    const current = menu.value
    closeMenu(keyboard)
    if (current && key === 'restore') void restore(current.row)
}
const onContextMenu = (event: MouseEvent, row: Row) => {
    event.preventDefault()
    if (row.type !== 'entry') return
    openMenu(row, event.currentTarget as HTMLElement, event.detail === 0 && false)
}

// --- Pointer
const onRowClick = (row: Row) => {
    if (row.type === 'now') moveTo(row, true)
    else if (row.type === 'entry' && row.selectable) moveTo(row, true)
    list.value?.focus({ preventScroll: true })
}

// --- Keyboard
const isApple = isApplePlatform()
// The keys the editor would run with focus elsewhere: docks pass it only unclaimed chords.
const passed: CommandName[] = ['history', 'play', 'copy']

const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    const row = rowById(cursorId.value)
    const handled = (): true => {
        event.preventDefault()
        event.stopPropagation()
        return true
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey
    if (plain && !event.shiftKey) {
        switch (event.key) {
            case 'ArrowDown':
                return void (handled() && step(1))
            case 'ArrowUp':
                return void (handled() && step(-1))
            case 'PageDown':
                return void (handled() && step(5))
            case 'PageUp':
                return void (handled() && step(-5))
            case 'Home':
                return void (handled() && moveTo(rows.value[0], true))
            case 'End':
                return void (handled() && moveTo(selectables.value.at(-1), false))
            case 'Enter':
                if (row?.type === 'entry' && row.selectable) {
                    handled()
                    void restore(row)
                }
                return
            case 'Escape':
                handled()
                if (peekedKey.value || peekedInfo.value) moveTo(rows.value[0], true)
                else closeHistory()
                return
            case 'ArrowRight':
                if (row?.type === 'entry' && row.members.length > 1 && !row.child) {
                    handled()
                    toggleGroup(row, true)
                }
                return
            case 'ArrowLeft':
                if (row?.type === 'entry') {
                    handled()
                    if (row.child) {
                        const group = rows.value.find(
                            (other) =>
                                other.type === 'entry' &&
                                !other.child &&
                                row.id.startsWith(`${other.id}/`),
                        )
                        if (group?.type === 'entry') {
                            toggleGroup(group, false)
                            moveTo(group, false)
                        }
                    } else toggleGroup(row, false)
                }
                return
        }
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        handled()
        const element = list.value?.querySelector<HTMLElement>(
            `#${CSS.escape(domId(cursorId.value))}`,
        )
        if (row?.type === 'entry' && element) openMenu(row, element)
        return
    }
    // Keys the list passes on: History, Play and Copy run as they would from the editor.
    const matched = matchBindings(
        Object.fromEntries(
            passed.map((name) => [name, settings.keyboardShortcuts[name]]),
        ) as Partial<Record<CommandName, string>>,
        event,
        isApple,
    )
    const name = matched.names.find((candidate) => passed.includes(candidate))
    if (name && !event.repeat) {
        handled()
        void runCommand(commands[name])
    }
}

// --- Loading older entries as the list scrolls.
const onScroll = () => {
    const element = list.value
    if (!element) return
    scrollTop.value = element.scrollTop
    if (canLoadMore.value && element.scrollTop + element.clientHeight > geometry.value.total - 400)
        void loadMore()
}
// A short list loads on until it fills the pane.
watch([() => geometry.value.total, viewport, canLoadMore], () => {
    if (canLoadMore.value && geometry.value.total < viewport.value + 400) void loadMore()
})

let observer: ResizeObserver | undefined
onMounted(() => {
    const element = list.value
    if (!element) return
    observer = new ResizeObserver(([entry]) => {
        if (!entry) return
        viewport.value = element.clientHeight
        width.value = entry.contentRect.width
    })
    observer.observe(element)
    viewport.value = element.clientHeight
    width.value = element.clientWidth
    // Keyboard focus starts in the list, at the Now row (§1.4.10.2).
    element.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
    observer?.disconnect()
})

// --- Text
const domId = (id: string) => `history-row-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`

const labelOf = (row: EntryRow) => {
    const { kind, label } = row.entry
    const strings = i18n.value
    if (kind === 'undo') return `${strings.commands.undo.title} · ${label}`
    if (kind === 'redo') return `${strings.commands.redo.title} · ${label}`
    return label
}

const flagTextOf = (row: EntryRow) =>
    row.flags.damaged
        ? i18n.value.history.damaged
        : row.flags.removed
          ? i18n.value.history.removedForSpace
          : row.flags.notInUndo
            ? i18n.value.history.notInUndo
            : undefined

const flagTipOf = (row: EntryRow) =>
    row.flags.notInUndo && !row.flags.damaged && !row.flags.removed
        ? i18n.value.history.notInUndoTip
        : undefined

const timeOf = (row: EntryRow) => formatEntryTime(row.entry.time)

const deltaOf = (row: EntryRow) =>
    row.delta === undefined ? undefined : `${row.delta > 0 ? '+' : '−'}${Math.abs(row.delta)}`

const titleOf = (row: EntryRow) => flagTipOf(row) ?? `${labelOf(row)} · ${timeOf(row)}`

const nowTime = computed(() => entries.value[0]?.time ?? session.value.startedAt ?? Date.now())

const dividerText = (entry: Entry) =>
    interpolateRaw(i18n.value.history.continuedFrom, formatDateTime(entry.from ?? entry.time))

const dayText = (time: number) => {
    const now = new Date()
    const day = new Date(time)
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    if (day.toDateString() === now.toDateString()) return i18n.value.history.today
    if (day.toDateString() === yesterday.toDateString()) return i18n.value.history.yesterday
    return formatDate(time)
}

const narrow = computed(() => width.value > 0 && width.value < 360)

// --- Announcing the peek
const announcement = computed(() =>
    peekedInfo.value
        ? interpolateRaw(
              i18n.value.history.announceViewing,
              formatClockSeconds(peekedInfo.value.time),
          )
        : '',
)

void interpolate
void formatClock
void nextTick

defineExpose({ focus: () => list.value?.focus({ preventScroll: true }) })
</script>

<template>
    <div class="timeline relative h-full min-h-0">
        <div
            ref="list"
            data-history-list
            role="listbox"
            tabindex="0"
            class="timeline-list overlay-scroller h-full overflow-y-auto overscroll-contain outline-none"
            :aria-label="i18n.history.timeline"
            :aria-activedescendant="domId(cursorId)"
            @scroll.passive="onScroll"
            @keydown="onKeydown"
        >
            <div class="relative px-1.5" :style="{ height: `${geometry.total}px` }">
                <template v-for="{ row, top } in visibleRows" :key="row.id">
                    <!-- Now: the open chart. -->
                    <div
                        v-if="row.type === 'now'"
                        :id="domId(row.id)"
                        role="option"
                        class="timeline-row"
                        :class="{ 'timeline-row-selected': cursorId === row.id }"
                        :aria-selected="cursorId === row.id"
                        :aria-posinset="positions.map.get(row.id)"
                        :aria-setsize="positions.size"
                        :style="{ top: `${top}px`, height: `${rowHeight}px` }"
                        @click="onRowClick(row)"
                    >
                        <span
                            class="flex size-4 shrink-0 items-center justify-center"
                            aria-hidden="true"
                        >
                            <span class="size-2.5 rounded-full bg-fg" />
                        </span>
                        <span class="min-w-0 flex-1 truncate font-bold"
                            >{{ i18n.history.now
                            }}<template v-if="headName"> · {{ headName }}</template></span
                        >
                        <span class="timeline-time shrink-0">{{ formatEntryTime(nowTime) }}</span>
                    </div>

                    <!-- A continuation or file open: where one stretch of history ends. -->
                    <div
                        v-else-if="row.type === 'divider'"
                        :id="domId(row.id)"
                        role="option"
                        aria-disabled="true"
                        class="timeline-divider"
                        :aria-posinset="positions.map.get(row.id)"
                        :aria-setsize="positions.size"
                        :style="{ top: `${top}px`, height: `${DIVIDER}px` }"
                    >
                        <span class="timeline-rule" aria-hidden="true" />
                        <span class="min-w-0 truncate px-2">{{ dividerText(row.entry) }}</span>
                        <span class="timeline-rule" aria-hidden="true" />
                    </div>

                    <!-- A minute's or a day's header. -->
                    <div
                        v-else-if="row.type === 'header'"
                        role="presentation"
                        aria-hidden="true"
                        class="timeline-divider"
                        :class="{ 'font-bold': row.level === 'day' }"
                        :style="{ top: `${top}px`, height: `${HEADER}px` }"
                    >
                        <span class="timeline-rule" />
                        <span class="min-w-0 truncate px-2">{{
                            row.level === 'day' ? dayText(row.time) : formatClock(row.time)
                        }}</span>
                        <span class="timeline-rule" />
                    </div>

                    <div
                        v-else
                        :id="domId(row.id)"
                        role="option"
                        class="timeline-row"
                        :class="{
                            'timeline-row-selected': cursorId === row.id,
                            'timeline-row-disabled': !row.selectable,
                            'timeline-row-child': row.child,
                            'timeline-row-two': twoLine,
                        }"
                        :aria-selected="cursorId === row.id"
                        :aria-disabled="row.selectable ? undefined : true"
                        :aria-expanded="
                            row.members.length > 1 && !row.child
                                ? expandedGroups.has(row.id)
                                : undefined
                        "
                        :aria-posinset="positions.map.get(row.id)"
                        :aria-setsize="positions.size"
                        :title="titleOf(row)"
                        :style="{ top: `${top}px`, height: `${rowHeight}px` }"
                        @click="onRowClick(row)"
                        @contextmenu="onContextMenu($event, row)"
                    >
                        <KindIcon :kind="row.entry.kind" />
                        <span class="flex min-w-0 flex-1 flex-col justify-center">
                            <span class="flex min-w-0 items-baseline gap-1.5">
                                <span class="min-w-0 truncate">{{ labelOf(row) }}</span>
                                <span
                                    v-if="row.members.length > 1"
                                    class="timeline-count shrink-0"
                                    :aria-label="`×${row.members.length}`"
                                    >×{{ row.members.length }}</span
                                >
                            </span>
                            <span v-if="twoLine" class="timeline-detail">
                                <span v-if="flagTextOf(row)" class="timeline-flag">
                                    <WarningIcon
                                        v-if="
                                            row.flags.notInUndo &&
                                            !row.flags.damaged &&
                                            !row.flags.removed
                                        "
                                        class="size-3 shrink-0"
                                    />
                                    <span class="truncate">{{ flagTextOf(row) }}</span>
                                </span>
                                <span v-if="deltaOf(row)">{{ deltaOf(row) }}</span>
                            </span>
                        </span>
                        <template v-if="!twoLine">
                            <span
                                v-if="flagTextOf(row)"
                                class="timeline-flag shrink-0"
                                :title="flagTipOf(row)"
                            >
                                <WarningIcon
                                    v-if="
                                        row.flags.notInUndo &&
                                        !row.flags.damaged &&
                                        !row.flags.removed
                                    "
                                    class="size-3 shrink-0"
                                />
                                <span :class="narrow ? 'sr-only' : 'truncate'">{{
                                    flagTextOf(row)
                                }}</span>
                            </span>
                            <span v-if="deltaOf(row)" class="timeline-count shrink-0">{{
                                deltaOf(row)
                            }}</span>
                        </template>
                        <span class="timeline-time shrink-0">{{ timeOf(row) }}</span>
                    </div>
                </template>
            </div>
        </div>
        <OverlayScrollbar :target="list" />
        <div class="sr-only" aria-live="polite" data-history-announcement>{{ announcement }}</div>
        <ManagerMenu
            v-if="menu"
            :key="menu.row.id"
            :anchor="menu.anchor"
            :touch="menu.touch"
            :label="i18n.history.timeline"
            :items="menuItems"
            @select="onMenuSelect"
            @close="closeMenu"
        />
    </div>
</template>

<style scoped>
.timeline-row {
    @apply absolute inset-x-1.5 flex select-none items-center gap-2 rounded-full px-3 text-sm;
}

.timeline-row-two {
    @apply py-0.5;
}

.timeline-row-child {
    @apply pl-8;
}

.timeline-row-selected {
    @apply bg-button shadow-md;
}

.timeline-row-disabled {
    @apply opacity-60;
}

.timeline-time {
    @apply text-xs tabular-nums;
}

.timeline-count {
    @apply text-xs tabular-nums opacity-80;
}

.timeline-detail {
    @apply flex min-w-0 items-center gap-2 text-xs opacity-80;
}

.timeline-flag {
    @apply flex min-w-0 items-center gap-1 text-xs;
}

.timeline-divider {
    @apply absolute inset-x-1.5 flex select-none items-center px-3 text-xs;
}

.timeline-rule {
    @apply h-px min-w-3 flex-1 bg-fg/25;
}

@media (hover: hover) {
    .timeline-row:not(.timeline-row-selected):not(.timeline-row-disabled):hover {
        @apply bg-fg/10;
    }
}

.timeline-list:focus-visible .timeline-row-selected {
    @apply ring-2 ring-inset ring-fg;
}
</style>
