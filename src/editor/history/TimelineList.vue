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
import { peekedKey } from '../../history/peek'
import { session } from '../../history/session'
import { headName } from '../../history/stack'
import { i18n } from '../../i18n'
import { formatClockSeconds, formatDateTime, formatDateTimeSeconds } from '../../i18n/when'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import { commands, type CommandName } from '../commands'
import { runCommand } from '../commands/runCommand'
import { isApplePlatform, matchBindings } from '../controls/bindings'
import { isCoarsePointer } from '../workspace'
import ManagerMenu from '../workspace/manager/ManagerMenu.vue'
import OverlayScrollbar from '../workspace/OverlayScrollbar.vue'
import { useScrollMemory } from '../workspace/useScrollMemory'
import FlagIcon from './FlagIcon.vue'
import KindIcon from './KindIcon.vue'
import { headerText, newerStepsText, pinnedText } from './labels'
import { buildRows, selectableRows, type Entry, type EntryRow, type Header, type Row } from './rows'
import {
    backToNow,
    damagedEntries,
    keyOf,
    peekedInfo,
    requestPeek,
    requestRestore,
} from './selection'
import {
    canLoadMore,
    entries,
    followEntries,
    gap,
    jumpTo as jumpToEntry,
    jumpToOldest,
    loadingMore,
    loadingNewer,
    loadMore,
    loadNewer,
    resetToNewest,
    retry,
    status,
    type Target,
} from './source'
import { expandedGroups, historyFilter, listFocus } from './state'

// The Timeline (Part 1 §1.4.10.5): an ARIA listbox of the chain's entries, newest first, windowed.
// Selecting a row peeks it; the controls for leaving or restoring are on the canvas (§1.4.11).

const props = defineProps<{
    /** The tab in a dock, or the dialog: each keeps its own scroll and focus rules. */
    surface: 'panel' | 'dialog'
}>()

const emit = defineEmits<{ close: [] }>()

const list = useTemplateRef<HTMLDivElement>('list')
const scrollTop = ref(0)
const viewport = ref(0)
const width = ref(0)

followEntries()
useScrollMemory(() => `${props.surface}:history`, list)

// The headers' ages are measured against the clock, rebuilt at each hour: a row changes tier only
// then, and always below the top of the list (Part 1 §1.4.10.5).
const clock = ref(Date.now())
let clockTimer: ReturnType<typeof setTimeout> | undefined
const tickClock = () => {
    clock.value = Date.now()
    const next = new Date(clock.value)
    next.setHours(next.getHours() + 1, 0, 1, 0)
    clockTimer = setTimeout(tickClock, next.getTime() - clock.value)
}
tickClock()

const built = computed(() =>
    buildRows(entries.value, {
        filter: historyFilter.value,
        expanded: expandedGroups.value,
        damaged: damagedEntries.value,
        now: clock.value,
        gap: gap.value,
    }),
)

// A timeline of only its first state says so, under Now.
const isEmpty = computed(
    () =>
        status.value !== 'loading' &&
        gap.value === undefined &&
        !built.value.some(
            (row) =>
                row.type === 'divider' ||
                (row.type === 'entry' &&
                    (row.entry.kind !== 'init' || historyFilter.value !== 'all')),
        ),
)
const rows = computed(() => (isEmpty.value ? built.value.slice(0, 1) : built.value))

// --- Geometry: rows have fixed heights per kind, so the window needs no measuring.
const rowHeight = computed(() => (isCoarsePointer.value ? 44 : 36))
const HEADER = 28
const DIVIDER = 32
// The list's padding: 4 px above the first row, 8 px below the last.
const PAD_TOP = 4
const PAD_BOTTOM = 8
// The gap row is a row high.
const heightOf = (row: Row) =>
    row.type === 'header' ? HEADER : row.type === 'divider' ? DIVIDER : rowHeight.value
const geometry = computed(() => {
    let y = PAD_TOP
    const offsets = rows.value.map((row) => {
        const top = y
        y += heightOf(row)
        return top
    })
    return {
        ids: rows.value.map((row) => row.id),
        kinds: rows.value.map((row) => row.type),
        offsets,
        total: y,
    }
})

/** The first row reaching below `y`. */
const rowAt = ({ offsets, total }: { offsets: number[]; total: number }, y: number) => {
    let low = 0
    let high = offsets.length
    while (low < high) {
        const mid = (low + high) >> 1
        if ((offsets[mid + 1] ?? total) <= y) low = mid + 1
        else high = mid
    }
    return low
}

// What follows the rows: the first page loading, an empty or failed timeline, an older page loading.
const SKELETON_ROWS = 4
const MESSAGE = 96
const FAILED = 132
const tail = computed(() => {
    if (status.value === 'failed') return { kind: 'failed', height: FAILED }
    if (status.value === 'loading')
        return { kind: 'skeleton', height: SKELETON_ROWS * rowHeight.value }
    if (isEmpty.value) return { kind: 'empty', height: MESSAGE }
    if (loadingMore.value) return { kind: 'more', height: rowHeight.value }
    return { kind: 'none', height: 0 }
})
const contentHeight = computed(() => geometry.value.total + tail.value.height + PAD_BOTTOM)

const OVERSCAN = 12
/** The last row starting at or above the scroll position. */
const topIndex = computed(() => {
    const { offsets } = geometry.value
    let low = 0
    let high = rows.value.length
    while (low < high) {
        const mid = (low + high) >> 1
        if ((offsets[mid] ?? Infinity) <= scrollTop.value) low = mid + 1
        else high = mid
    }
    return low - 1
})
const range = computed(() => {
    const { offsets } = geometry.value
    const count = rows.value.length
    const first = Math.max(0, topIndex.value - OVERSCAN)
    const bottom = scrollTop.value + viewport.value
    let end = topIndex.value + 1
    while (end < count && (offsets[end] ?? Infinity) < bottom) end++
    return { first, end: Math.min(count, end + OVERSCAN) }
})

const visibleRows = computed(() =>
    rows.value.slice(range.value.first, range.value.end).map((row, i) => ({
        row,
        top: geometry.value.offsets[range.value.first + i] ?? 0,
    })),
)

// The header of the rows at the top, pinned there once they scroll under it.
const pinned = computed(() => {
    if (scrollTop.value <= 0) return
    const at = topIndex.value
    const current = rows.value[at]
    if (current?.type === 'header' && (geometry.value.offsets[at] ?? 0) >= scrollTop.value) return
    for (let i = at; i >= 0; i--) {
        const row = rows.value[i]
        if (row?.type === 'header') return row
    }
    return undefined
})

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
const rowOf = (key: string | undefined) => {
    if (!key) return rows.value[0]
    const plain = rows.value.find(
        (row) => row.type === 'entry' && row.child && keyOf(row.entry) === key,
    )
    if (plain) return plain
    return rows.value.find(
        (row) =>
            row.type === 'entry' &&
            !row.child &&
            row.members.some((member) => keyOf(member) === key),
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

const infoOf = (entry: Entry) => ({ key: keyOf(entry), time: entry.time, label: entry.label })

const moveTo = (row: Row | undefined) => {
    if (!row) return
    // After a jump, Now goes back to the newest entries.
    if (row.type === 'now' && gap.value !== undefined) {
        void goNow()
        return
    }
    cursorId.value = row.id
    if (row.type === 'now') backToNow()
    else if (row.type === 'entry' && row.selectable) requestPeek(infoOf(row.entry))
    scrollToRow(row.id)
}

// Brings a row into view, clear of the pinned header.
const scrollToRow = (id: string) => {
    const element = list.value
    const index = rows.value.findIndex((row) => row.id === id)
    const row = rows.value[index]
    if (!element || !row) return
    const top = geometry.value.offsets[index] ?? 0
    const bottom = top + heightOf(row)
    const cover = element.scrollTop > 0 ? HEADER : 0
    if (top < element.scrollTop + cover) element.scrollTop = Math.max(0, top - HEADER)
    else if (bottom > element.scrollTop + element.clientHeight)
        element.scrollTop = bottom + PAD_BOTTOM - element.clientHeight
}

const step = async (delta: number) => {
    let at = selectables.value.findIndex((row) => row.id === cursorId.value)
    const clamp = (index: number) => Math.max(0, Math.min(selectables.value.length - 1, index))
    // Up crosses the gap: the newer page loads, and the cursor goes on into it.
    if (delta < 0 && at > 0 && clamp(at + delta) === 0 && gap.value !== undefined) {
        const id = cursorId.value
        await loadNewer()
        await nextTick()
        if (cursorId.value !== id) return
        at = selectables.value.findIndex((row) => row.id === id)
    }
    const next = selectables.value[clamp(at + delta)]
    if (next && next.id !== cursorId.value) moveTo(next)
}

// --- Jumps: Go To and End read a window at the target, Now and Home go back to the newest.
let replacing = false

/** Scrolls a row to the top of the list, with its header when one is just above it. */
const scrollRowToTop = (id: string) => {
    const element = list.value
    const index = rows.value.findIndex((row) => row.id === id)
    if (!element || index === -1) return
    const above = rows.value[index - 1]?.type === 'header' ? index - 1 : index
    element.scrollTop = geometry.value.offsets[above] ?? 0
    scrollTop.value = element.scrollTop
}

const goNow = async () => {
    replacing = true
    try {
        await resetToNewest()
        await nextTick()
    } finally {
        replacing = false
    }
    cursorId.value = 'now'
    backToNow()
    scrollToRow('now')
}

/** Jumps to an entry, or to Now; the entry is peeked and scrolled to the top. */
const jumpTo = async (target: Target | 'now') => {
    if (target === 'now') return goNow()
    replacing = true
    try {
        const entry = await jumpToEntry(target, historyFilter.value)
        if (!entry) return
        await nextTick()
        const row = rowOf(keyOf(entry))
        if (row) {
            cursorId.value = row.id
            scrollRowToTop(row.id)
        }
        requestPeek(infoOf(entry))
    } catch {
        // The list stays as it was.
    } finally {
        replacing = false
    }
}

/** End: the oldest entry, read directly when it is not loaded. */
const goOldest = async () => {
    if (!canLoadMore.value) {
        moveTo(selectables.value.at(-1))
        return
    }
    replacing = true
    try {
        await jumpToOldest(historyFilter.value)
        await nextTick()
    } catch {
        return
    } finally {
        replacing = false
    }
    moveTo(selectables.value.at(-1))
}

/** The entry at the top of the list, or Now: Go To's current piece. */
const topEntry = (): Target | 'now' => {
    for (let i = Math.max(0, topIndex.value); i < rows.value.length; i++) {
        const row = rows.value[i]
        if (row?.type === 'now') return 'now'
        if (row?.type === 'entry') return { sessionId: row.entry.sessionId, seq: row.entry.seq }
    }
    return 'now'
}

// Rows inserted or removed above the first one on screen move the scroll position by as much,
// so nothing under the pointer moves (Part 1 §1.4.10.5). At the very top, new rows simply appear.
watch(
    geometry,
    (next, previous) => {
        const element = list.value
        if (!element || replacing) return
        const top = element.scrollTop
        if (top <= 0 && !previous.ids.includes('gap')) return
        const index = new Map(next.ids.map((id, i) => [id, i]))
        for (let i = rowAt(previous, top); i < previous.ids.length; i++) {
            const id = previous.ids[i]
            const at = id === undefined ? undefined : index.get(id)
            // Headers are no anchor: the span they label grows with newer rows.
            if (at === undefined || next.kinds[at] === 'now' || next.kinds[at] === 'gap') continue
            if (next.kinds[at] === 'header') continue
            const shift = (next.offsets[at] ?? 0) - (previous.offsets[i] ?? 0)
            if (shift !== 0) {
                element.scrollTop = top + shift
                scrollTop.value = element.scrollTop
            }
            return
        }
    },
    { flush: 'post' },
)

// The gap row loads the newer entries as it comes into view: checked after the anchoring above
// has moved the list, and never while a jump replaces the rows.
const gapInView = () => {
    const element = list.value
    const index = rows.value.findIndex((row) => row.type === 'gap')
    const row = rows.value[index]
    if (!element || !row || replacing || loadingNewer.value) return false
    const top = geometry.value.offsets[index] ?? 0
    return top < element.scrollTop + element.clientHeight && top + heightOf(row) > element.scrollTop
}
watch(
    [() => geometry.value.total, viewport, gap, loadingNewer],
    () => {
        if (gapInView()) void loadNewer()
    },
    { flush: 'post' },
)

const toggleGroup = (row: EntryRow, open: boolean) => {
    if (row.members.length < 2 || row.child) return
    const next = new Set(expandedGroups.value)
    if (open) next.add(row.id)
    else next.delete(row.id)
    expandedGroups.value = next
}

// --- Restore
const restore = async (row: EntryRow) => {
    await requestRestore(keyOf(row.entry))
}

// --- Menu: Restore, by right click, Shift+F10 or the Menu key.
const menu = shallowRef<{ row: EntryRow; anchor: HTMLElement; touch: boolean }>()
const openMenu = (row: EntryRow, anchor: HTMLElement) => {
    if (!row.selectable || menu.value?.row.id === row.id) return
    menu.value = { row, anchor, touch: false }
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
    openMenu(row, event.currentTarget as HTMLElement)
}

// --- Pointer
const onRowClick = (row: Row) => {
    if (row.type === 'now') moveTo(row)
    else if (row.type === 'entry' && row.selectable) moveTo(row)
    list.value?.focus({ preventScroll: true })
}

// --- Keyboard
const isApple = isApplePlatform()
// The keys the editor would run with focus elsewhere: docks pass it only unclaimed chords.
const passed: CommandName[] = ['history', 'play', 'copy']

const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    const row = rowById(cursorId.value)
    const handled = () => {
        event.preventDefault()
        event.stopPropagation()
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey
    if (plain && !event.shiftKey) {
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowUp':
            case 'PageDown':
            case 'PageUp':
                handled()
                void step({ ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[event.key])
                return
            case 'Home':
                handled()
                moveTo(rows.value[0])
                return
            case 'End':
                handled()
                void goOldest()
                return
            case 'Enter':
                if (row?.type === 'entry' && row.selectable) {
                    handled()
                    if (!event.repeat) void restore(row)
                }
                return
            case 'Escape':
                handled()
                // Back to now first; then the dialog closes, and the tab hands focus to the chart.
                if (peekedKey.value || peekedInfo.value) moveTo(rows.value[0])
                else if (props.surface === 'dialog') emit('close')
                else list.value?.blur()
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
                            moveTo(group)
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
    if (gapInView()) void loadNewer()
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
    // The dialog's list takes focus as it opens; the tab's only for a link that asked.
    if (props.surface === 'dialog') element.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
    observer?.disconnect()
    clearTimeout(clockTimer)
})
// A link asks for the list's focus, also from a list that mounts a moment later.
watch(
    listFocus,
    (request) => {
        if (request?.surface !== props.surface || Date.now() - request.at > 3000) return
        listFocus.value = undefined
        void nextTick(() => list.value?.focus({ preventScroll: true }))
    },
    { immediate: true },
)

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
          : undefined

const flagKindOf = (row: EntryRow) => (row.flags.damaged ? 'damaged' : 'removed')

// Under about 300 px a flag keeps only its icon; its text is still the name and the tooltip.
const narrow = computed(() => width.value > 0 && width.value < 300)

const timeOf = (row: EntryRow) => formatClockSeconds(row.entry.time)

const deltaOf = (row: EntryRow) =>
    row.delta === undefined ? undefined : `${row.delta > 0 ? '+' : '−'}${Math.abs(row.delta)}`

// The full date and time is the row's tooltip and in its accessible name; the header gives the date.
const whenOf = (row: EntryRow) => formatDateTimeSeconds(row.entry.time)

const titleOf = (row: EntryRow) =>
    [labelOf(row), flagTextOf(row), whenOf(row)].filter(Boolean).join(' · ')

const nameOf = (row: EntryRow) =>
    [
        row.members.length > 1 && !row.child
            ? `${labelOf(row)} ×${row.members.length}`
            : labelOf(row),
        flagTextOf(row),
        deltaOf(row),
        whenOf(row),
    ]
        .filter(Boolean)
        .join(', ')

const nowTime = computed(() => entries.value[0]?.time ?? session.value.startedAt ?? Date.now())

const dividerText = (entry: Entry) =>
    interpolateRaw(i18n.value.history.continuedFrom, formatDateTime(entry.from ?? entry.time))

const headerClass = (header: Header) =>
    header.level === 'day'
        ? 'font-bold text-fg'
        : header.level === 'hour'
          ? 'font-bold text-fg/80'
          : 'font-medium text-fg/70'

// --- Announcing the peek
const announcement = computed(() =>
    peekedInfo.value
        ? interpolateRaw(
              i18n.value.history.announceViewing,
              formatDateTimeSeconds(peekedInfo.value.time),
          )
        : '',
)

defineExpose({ focus: () => list.value?.focus({ preventScroll: true }), jumpTo, topEntry })
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
            <div class="relative" :style="{ height: `${contentHeight}px` }">
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
                            }}<template v-if="headName && !isEmpty">
                                · {{ headName }}</template
                            ></span
                        >
                        <span class="timeline-time shrink-0">{{
                            formatClockSeconds(nowTime)
                        }}</span>
                    </div>

                    <!-- After a jump: the newer entries not read yet, read as it comes into view. -->
                    <div
                        v-else-if="row.type === 'gap'"
                        :id="domId(row.id)"
                        role="option"
                        aria-disabled="true"
                        class="timeline-divider items-center justify-center gap-1.5 font-medium text-fg/80"
                        :class="{ 'motion-safe:animate-pulse': loadingNewer }"
                        :aria-posinset="positions.map.get(row.id)"
                        :aria-setsize="positions.size"
                        :style="{ top: `${top}px`, height: `${rowHeight}px` }"
                        data-history-gap
                    >
                        <svg
                            class="size-3.5 shrink-0"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.75"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                        </svg>
                        <span class="min-w-0 truncate">{{ newerStepsText(row.count) }}</span>
                    </div>

                    <!-- A continuation or file open: where one stretch of history ends. -->
                    <div
                        v-else-if="row.type === 'divider'"
                        :id="domId(row.id)"
                        role="option"
                        aria-disabled="true"
                        class="timeline-divider items-center"
                        :aria-posinset="positions.map.get(row.id)"
                        :aria-setsize="positions.size"
                        :style="{ top: `${top}px`, height: `${DIVIDER}px` }"
                    >
                        <span class="timeline-rule" aria-hidden="true" />
                        <span class="min-w-0 truncate px-2">{{ dividerText(row.entry) }}</span>
                        <span class="timeline-rule" aria-hidden="true" />
                    </div>

                    <!-- A minute's, an hour's or a day's header: a label at the rows' text edge. -->
                    <div
                        v-else-if="row.type === 'header'"
                        role="presentation"
                        aria-hidden="true"
                        class="timeline-divider items-end pb-1"
                        :class="headerClass(row)"
                        :style="{ top: `${top}px`, height: `${HEADER}px` }"
                    >
                        <span class="min-w-0 truncate">{{ headerText(row) }}</span>
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
                        }"
                        :aria-selected="cursorId === row.id"
                        :aria-disabled="row.selectable ? undefined : true"
                        :aria-expanded="
                            row.members.length > 1 && !row.child
                                ? expandedGroups.has(row.id)
                                : undefined
                        "
                        :aria-label="nameOf(row)"
                        :aria-posinset="positions.map.get(row.id)"
                        :aria-setsize="positions.size"
                        :title="titleOf(row)"
                        :style="{ top: `${top}px`, height: `${rowHeight}px` }"
                        @click="onRowClick(row)"
                        @contextmenu="onContextMenu($event, row)"
                    >
                        <KindIcon :kind="row.entry.kind" />
                        <span class="min-w-0 flex-1 truncate">{{ labelOf(row) }}</span>
                        <span
                            v-if="row.members.length > 1 && !row.child"
                            class="timeline-count shrink-0"
                            aria-hidden="true"
                            >×{{ row.members.length }}</span
                        >
                        <!-- A removed or damaged row says why; the label gives way to it. -->
                        <span
                            v-if="flagTextOf(row)"
                            class="timeline-flag shrink-0"
                            :class="narrow ? '' : 'max-w-[55%]'"
                            data-history-flag
                        >
                            <FlagIcon :kind="flagKindOf(row)" />
                            <span :class="narrow ? 'sr-only' : 'truncate'">{{
                                flagTextOf(row)
                            }}</span>
                        </span>
                        <span v-if="deltaOf(row)" class="timeline-count shrink-0">{{
                            deltaOf(row)
                        }}</span>
                        <span class="timeline-time shrink-0">{{ timeOf(row) }}</span>
                    </div>
                </template>

                <!-- What follows the rows. -->
                <div
                    v-if="tail.kind === 'skeleton'"
                    class="absolute inset-x-2"
                    :style="{ top: `${geometry.total}px` }"
                    aria-hidden="true"
                    data-history-loading
                >
                    <div
                        v-for="n in SKELETON_ROWS"
                        :key="n"
                        class="flex items-center gap-2 px-3 motion-safe:animate-pulse"
                        :style="{ height: `${rowHeight}px` }"
                    >
                        <span class="size-4 shrink-0 rounded-full bg-fg/10" />
                        <span
                            class="h-3 rounded-full bg-fg/10"
                            :style="{ width: `${72 - n * 9}%` }"
                        />
                        <span class="ml-auto h-3 w-16 shrink-0 rounded-full bg-fg/10" />
                    </div>
                </div>
                <div
                    v-else-if="tail.kind === 'empty'"
                    class="absolute inset-x-2 flex items-center justify-center px-3 text-center text-sm text-fg/70"
                    :style="{ top: `${geometry.total}px`, height: `${MESSAGE}px` }"
                    data-history-empty
                >
                    {{ historyFilter === 'saves' ? i18n.history.noSaves : i18n.history.empty }}
                </div>
                <div
                    v-else-if="tail.kind === 'failed'"
                    class="absolute inset-x-2 flex flex-col items-center justify-center gap-3 px-3 text-center text-sm text-fg/70"
                    :style="{ top: `${geometry.total}px`, height: `${FAILED}px` }"
                    data-history-failed
                >
                    <span>{{ i18n.history.loadFailed }}</span>
                    <button
                        type="button"
                        class="h-9 rounded-full bg-button px-4 font-bold text-fg shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11"
                        @click="retry"
                    >
                        {{ i18n.history.tryAgain }}
                    </button>
                </div>
                <div
                    v-else-if="tail.kind === 'more'"
                    class="absolute inset-x-2 flex items-center justify-center"
                    :style="{ top: `${geometry.total}px`, height: `${rowHeight}px` }"
                    aria-hidden="true"
                >
                    <span
                        class="size-4 animate-spin rounded-full border-2 border-fg/25 border-t-fg"
                    />
                </div>
            </div>
        </div>
        <!-- The header of the rows at the top, so a long day never loses its place. -->
        <div
            v-if="pinned"
            class="pointer-events-none absolute inset-x-0 top-0 z-10 bg-modal pt-1 shadow-band"
            aria-hidden="true"
            data-history-pinned
        >
            <div
                class="flex items-end truncate px-5 pb-1 text-xs"
                :class="headerClass(pinned)"
                :style="{ height: `${HEADER}px` }"
            >
                <span class="truncate">{{ pinnedText(pinned) }}</span>
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
    @apply absolute inset-x-2 flex select-none items-center gap-2 rounded-full px-3 text-sm;
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

.timeline-flag {
    @apply flex min-w-0 items-center gap-1 text-xs;
}

/* Headers and dividers: labels at the rows' text edge, inside the 8 px gutter. */
.timeline-divider {
    @apply absolute inset-x-2 flex select-none px-3 text-xs;
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
