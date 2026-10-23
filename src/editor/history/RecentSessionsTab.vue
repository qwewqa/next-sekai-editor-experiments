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
import { dayKey } from '../../calendar/calendar'
import { peekedKey } from '../../history/peek'
import { session } from '../../history/session'
import { liveState } from '../../history/stack'
import { displayName, type DisplayName } from '../../local/names'
import { i18n } from '../../i18n'
import { storageWorker } from '../../local/start'
import { listRecent, type RecentChain } from '../../local/recent'
import type { StoredRead } from '../../local/storedRead'
import { flusher } from '../../local/storing'
import { storageStatus } from '../../local/startup/events'
import { isSafeMode } from '../../safe'
import { settings } from '../../settings'
import { focusLost } from '../../utils/focusFallback'
import { interpolateRaw } from '../../utils/interpolate'
import { formatCount } from '../../utils/size'
import { commands, type CommandName } from '../commands'
import { runCommand } from '../commands/runCommand'
import { isApplePlatform, matchBindings } from '../controls/bindings'
import { downloadConfirmed } from '../file/flags'
import { writesInPlace } from '../file/state'
import { platform } from '../../platform'
import { labelAccessibleName, labelLine, labelOf } from '../fileLabel'
import { liveRow } from '../liveRow'
import { readBrowserFacts, storageLineKey } from '../settings/storageLine'
import ManagerMenu from '../workspace/manager/ManagerMenu.vue'
import MoreIcon from '../workspace/manager/icons/MoreIcon.vue'
import OverlayScrollbar from '../workspace/OverlayScrollbar.vue'
import { useScrollMemory } from '../workspace/useScrollMemory'
import { useHistoryCalendar } from './calendarClock'
import { historyFormat } from './historyFormat'
import { headerText } from './labels'
import { canFocusHistory } from './openHistory'
import { backToNow, peekedSession } from './selection'
import {
    peekSession,
    runSessionItem,
    sessionMenuItems,
    type SessionMenuItem,
} from './sessionActions'
import {
    buildRows,
    createRecentList,
    peekable,
    restoreMode,
    type ChainRow,
    type DeletedRow,
    type NavRow,
} from './sessions'
import { onDeleteChanged, sessionDelete } from './sessionDeleteLive'
import { listFocus } from './state'

// Recent Sessions (Part 1 §1.4.10.6): one row per chain, newest first, under the Timeline's day
// headers, in the Timeline's row styles and keys. A click or an arrow peeks the session without
// BGM; Enter restores it; the ⋯ button, a right click, a long press, Shift+F10 and the Menu key
// open its menu. This tab's own chain is the row with the badge, and a click on it is Back to Now.

const props = defineProps<{
    /** The tab in a dock, or the dialog: each keeps its own scroll and focus rules. */
    surface: 'panel' | 'dialog'
}>()
const emit = defineEmits<{ close: [] }>()

const scroller = useTemplateRef<HTMLDivElement>('scroller')
const safe = isSafeMode()
const calendar = useHistoryCalendar()
const format = computed(() => historyFormat(calendar.value, settings.locale))
useScrollMemory(() => `${props.surface}:history-sessions`, scroller)

// --- The data: the read, who holds what, and the rule that rows hold still.
const readList = async (): Promise<StoredRead<RecentChain[]>> => {
    const worker = storageWorker
    if (!worker) return { storedRead: 'failed', storedError: undefined }
    return listRecent(worker)
}
/** The sessions other tabs or windows hold; none where Web Locks cannot tell. */
const heldElsewhere = async (): Promise<ReadonlySet<string>> => {
    try {
        const { sessionContext } = await import('../../local/startup/api')
        const context = sessionContext()
        const { hasWebLocks } = await import('../../local/locks')
        if (!context || !hasWebLocks()) return new Set()
        const { sessionsHeldElsewhere } = await import('../../local/startup/open')
        return new Set(await sessionsHeldElsewhere(context.open))
    } catch {
        return new Set()
    }
}
const list = createRecentList({ read: readList, elsewhere: heldElsewhere })
const status = list.status

/** Rows a peek found unreadable since the read. */
const failedRows = shallowRef<ReadonlyMap<string, 'damaged' | 'newer'>>(new Map())

// This tab's chain, once stored: the open session stands for its row.
const thisChain = computed(() => {
    void session.value.sessionId
    return flusher?.session?.chainId
})

const rows = computed(() =>
    buildRows(list.chains.value, {
        calendar: calendar.value,
        thisChain: thisChain.value,
        elsewhere: list.elsewhere.value,
        failed: failedRows.value,
        deleted: sessionDelete.inline.value,
    }),
)
// The rows the cursor visits: chains, and the inline Undo rows that stand where chains were.
const navRows = computed(() =>
    rows.value.filter((row): row is NavRow => row.type === 'chain' || row.type === 'deleted'),
)
const chainRows = computed(() => rows.value.filter((row): row is ChainRow => row.type === 'chain'))
const rowById = (id: string) => navRows.value.find((row) => row.id === id)

// --- Text. A row's file part is the status bar's own (`labelOf`); this tab's row is `liveRow`,
// the open session's, so it is right before the first flush.
const notesIn = (state: typeof liveState.value) => {
    let count = 0
    for (const notes of state.store.slides.note.values()) count += notes.length
    return count
}

/** The date fallback of a name, in the History calendar's zone: "Untitled · Oct 16, 2:41 PM". */
const namedBy = (shown: DisplayName, startedAt: number | undefined) =>
    shown.kind !== 'date'
        ? shown.text
        : startedAt === undefined
          ? i18n.value.save.placeholder
          : interpolateRaw(i18n.value.session.untitled, format.value.dateTime(startedAt))

/** A download not confirmed: the status bar's rule (state.ts `downloadNotConfirmed`) for a stored file. */
const notConfirmed = (file: RecentChain['file']) =>
    !!file &&
    file.event !== 'saved' &&
    file.event !== 'opened' &&
    !file.confirmed &&
    (platform.capabilities.unconfirmedDownloads || !downloadConfirmed.value)

const nameOf = (row: ChainRow) =>
    row.thisTab
        ? liveRow.value.name
        : namedBy(displayName(row.chain.nameParts), row.chain.head.startedAt)

/** The inline row's text: Deleted "X", or that it can no longer be undone. */
const deletedText = (row: DeletedRow) =>
    interpolateRaw(
        row.status === 'lost' ? i18n.value.session.undoLost : i18n.value.session.deleted,
        row.name,
    )

const badgeText = (row: ChainRow) =>
    row.badge === 'thisTab'
        ? i18n.value.history.sessions.thisTab
        : row.badge === 'elsewhere'
          ? i18n.value.history.sessions.elsewhere
          : undefined

const flagText = (row: ChainRow) =>
    row.readable === 'damaged'
        ? i18n.value.history.damaged
        : row.readable === 'newer'
          ? i18n.value.history.needsNewer
          : undefined

/** The time under the day's header; an older day is named again, as the Timeline's dividers do. */
const timeOf = (chain: RecentChain) => {
    const ago = calendar.value.today - dayKey(chain.updatedAt, calendar.value.zone)
    return ago <= 1 ? format.value.clock(chain.updatedAt) : format.value.dateTime(chain.updatedAt)
}

const notesText = (row: ChainRow) => {
    const count = row.thisTab ? notesIn(liveState.value) : row.chain.noteCount
    return count === undefined
        ? undefined
        : interpolateRaw(i18n.value.peek.notes, formatCount(count))
}

/** The caption: time, the file part, the notes (or why the session cannot be opened). */
const captionOf = (row: ChainRow) => {
    const label = row.thisTab
        ? liveRow.value.label
        : labelOf({
              name: nameOf(row),
              changed: row.chain.changed,
              writesInPlace: writesInPlace(),
              notConfirmed: notConfirmed(row.chain.file),
              ...(row.chain.file ? { file: row.chain.file } : {}),
          })
    return [timeOf(row.chain), labelLine({ ...label, name: '' }), flagText(row) ?? notesText(row)]
        .filter(Boolean)
        .join(' · ')
}

const accessibleOf = (row: ChainRow) => {
    const name = nameOf(row)
    const file = row.chain.file
    const label = row.thisTab
        ? liveRow.value.accessible
        : labelAccessibleName(
              labelOf({
                  name,
                  changed: row.chain.changed,
                  writesInPlace: writesInPlace(),
                  notConfirmed: notConfirmed(file),
                  ...(file ? { file } : {}),
              }),
              name,
              file,
          )
    return [
        label,
        badgeText(row),
        format.value.dateTimeSeconds(row.chain.updatedAt),
        flagText(row) ?? notesText(row),
    ]
        .filter(Boolean)
        .join(', ')
}

// --- The footer: the storage line, the list's last item.
const facts = shallowRef<Awaited<ReturnType<typeof readBrowserFacts>>>()
const footer = computed(() => {
    const known = facts.value
    const state = storageStatus.value
    if (!known || !state) return
    return i18n.value.storage[
        storageLineKey({
            ...known,
            unavailable: state.mode === 'memory' || state.mode === 'readOnly',
        })
    ]
})

const SKELETON_ROWS = 4

// --- Peek: the cursor's row, and what the bar shows.
const cursorId = ref('')
const focusInside = ref(false)
let disposed = false
let focusToken = 0

const selectedId = computed(() => {
    const peeked = peekedSession.value
    if (peeked && peekedKey.value === peeked.key) return peeked.chainId
    return chainRows.value.find((row) => row.thisTab)?.id
})

const markFailed = (row: ChainRow) => (reason: 'damaged' | 'newer') => {
    failedRows.value = new Map(failedRows.value).set(row.id, reason)
}

const moveTo = (row: NavRow) => {
    cursorId.value = row.id
    // An inline Undo row has nothing to peek: the chart goes back to now, as on this tab's row.
    if (row.type === 'deleted' || row.thisTab) backToNow()
    else if (peekable(row)) peekSession(row, safe, nameOf(row), markFailed(row))
    void focusRow(row.id)
}

const step = (delta: number) => {
    const all = navRows.value
    if (!all.length) return
    const at = all.findIndex((row) => row.id === cursorId.value)
    const next = all[Math.max(0, Math.min(all.length - 1, (at < 0 ? 0 : at) + delta))]
    if (next && next.id !== cursorId.value) moveTo(next)
}

const domId = (id: string) => `sessions-row-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
const rowElement = (id: string) =>
    scroller.value?.querySelector<HTMLElement>(`#${CSS.escape(domId(id))}`) ?? undefined

const focusRow = async (id = cursorId.value, scroll = true) => {
    const token = ++focusToken
    if (!rowById(id)) return
    cursorId.value = id
    await nextTick()
    if (disposed || token !== focusToken || menu.value || !canFocusHistory(props.surface)) return
    const element = rowElement(id)
    element?.focus({ preventScroll: true })
    if (scroll) element?.scrollIntoView({ block: 'nearest' })
}

// Without a cursor the list starts on this tab's row, else the first.
watch(
    navRows,
    (all) => {
        if (all.some((row) => row.id === cursorId.value)) return
        const target = all.find((row) => row.type === 'chain' && row.thisTab) ?? all[0]
        cursorId.value = target?.id ?? ''
        if (focusInside.value && target) void focusRow(target.id, false)
    },
    { flush: 'pre', immediate: true },
)

// --- Rows hold still while the pointer is over the list or focus is in it.
const onFocusin = (event: FocusEvent) => {
    // The cursor follows focus onto a row, so a key acts on the row that has it.
    const id =
        event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>('[data-sessions-row]')?.dataset.chain
            : undefined
    if (id && rowById(id)) cursorId.value = id
    focusInside.value = true
    list.hold('focus', true)
}
const onFocusout = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && scroller.value?.contains(event.relatedTarget)) return
    focusInside.value = false
    list.hold('focus', false)
}

// --- Delete: the chain is marked, and its row becomes an inline Undo row where it stood. `?safe`
// is read-only and this tab's own chain is open, so neither is deleted from here.
const deletable = (row: NavRow | undefined): row is ChainRow =>
    !safe && row?.type === 'chain' && !row.thisTab

const deleteRow = async (row: NavRow | undefined) => {
    if (!deletable(row)) return
    const inside = !!scroller.value?.contains(document.activeElement)
    const all = navRows.value
    const at = all.findIndex((each) => each.id === row.id)
    const next = all[at + 1] ?? all[at - 1]
    const outcome = await sessionDelete.remove(row.chain, nameOf(row))
    if (disposed || outcome !== 'marked' || !next || !inside) return
    // The row that had focus is replaced: focus goes to the next row, else the previous one.
    await nextTick()
    void refocus(next.id)
}
/** Puts focus on a row once the one that had it is replaced, unless it has gone elsewhere. */
const refocus = async (id: string) => {
    if (disposed) return
    if (focusLost() || scroller.value?.contains(document.activeElement)) await focusRow(id, false)
}

const undoRow = (row: DeletedRow) => {
    if (row.status === 'deleted') void sessionDelete.undo([row.id])
}

// --- Menu: Restore Session or Restore as a Copy, and Save to File….
const menu = shallowRef<{
    row: ChainRow
    anchor: HTMLElement
    touch: boolean
    items: SessionMenuItem[]
}>()
let menuToken = 0
const openMenu = async (row: ChainRow, anchor: HTMLElement, touch = false) => {
    if (menu.value?.row.id === row.id) return
    const token = ++menuToken
    cursorId.value = row.id
    focusToken++
    // The item reads as of now: who holds the session is asked again.
    const held = await heldElsewhere()
    if (disposed || token !== menuToken) return
    const items = sessionMenuItems(row, held, safe)
    if (!items.length) return
    list.hold('menu', true)
    menu.value = { row, anchor, touch, items }
}
const closeMenu = (restoreFocus: boolean) => {
    menuToken++
    const open = menu.value
    if (!open) return
    menu.value = undefined
    list.hold('menu', false)
    if (restoreFocus) void focusRow(open.row.id, false)
}
const onMenuSelect = (key: string, keyboard: boolean) => {
    const open = menu.value
    closeMenu(keyboard)
    if (!open) return
    if (key === 'delete') void deleteRow(open.row)
    else runSessionItem(key, open.row)
}

// iOS fires no contextmenu event for a long press: a touch held still opens the menu itself.
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10
let longPress: { pointerId: number; x: number; y: number; timer: number } | undefined
let lastPointerType = ''
// The click that ends a long press must not also pick the row.
let suppressClick = false
const cancelLongPress = () => {
    if (longPress) clearTimeout(longPress.timer)
    longPress = undefined
}
const onRowPointerdown = (event: PointerEvent, row: ChainRow) => {
    lastPointerType = event.pointerType
    suppressClick = false
    cancelLongPress()
    if (event.pointerType !== 'touch' || !event.isPrimary || !settings.touchLongPressContextMenu)
        return
    const anchor = event.currentTarget as HTMLElement
    longPress = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
            longPress = undefined
            suppressClick = true
            void openMenu(row, anchor, true)
        }, LONG_PRESS_MS),
    }
}
const onRowPointermove = (event: PointerEvent) => {
    if (longPress?.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > LONG_PRESS_SLOP)
        cancelLongPress()
}
const onContextMenu = (event: MouseEvent, row: ChainRow) => {
    event.preventDefault()
    // Firefox for Android reports a plain MouseEvent: the last pointer tells touch apart.
    const touch =
        event instanceof PointerEvent ? event.pointerType === 'touch' : lastPointerType === 'touch'
    if (touch) {
        cancelLongPress()
        if (!settings.touchLongPressContextMenu) return
        suppressClick = true
    }
    void openMenu(row, event.currentTarget as HTMLElement, touch)
}
const onMoreClick = (event: MouseEvent, row: ChainRow) => {
    event.stopPropagation()
    if (menu.value?.row.id === row.id) {
        closeMenu(false)
        return
    }
    void openMenu(row, event.currentTarget as HTMLElement, lastPointerType === 'touch')
}

const onRowClick = (row: NavRow) => {
    if (suppressClick) {
        suppressClick = false
        return
    }
    moveTo(row)
}

// --- Keyboard
const isApple = isApplePlatform()
// The keys the editor would run with focus elsewhere: docks pass it only unclaimed chords.
const passed: CommandName[] = ['history', 'play', 'copy']

const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    if (
        !(event.target instanceof HTMLElement) ||
        (event.target !== scroller.value && !event.target.closest('[data-sessions-row]'))
    )
        return
    const row = rowById(cursorId.value)
    const handled = () => {
        event.preventDefault()
        event.stopPropagation()
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        handled()
        const element = row && rowElement(row.id)
        if (row?.type === 'chain' && element) void openMenu(row, element)
        return
    }
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' '))
        return
    if (plain && !event.shiftKey) {
        const all = navRows.value
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowUp':
            case 'PageDown':
            case 'PageUp':
                handled()
                step({ ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[event.key])
                return
            case 'Home':
                handled()
                if (all[0]) moveTo(all[0])
                return
            case 'End':
                handled()
                {
                    const last = all.at(-1)
                    if (last) moveTo(last)
                }
                return
            case 'Enter':
                if (row) {
                    handled()
                    if (event.repeat) return
                    if (row.type === 'deleted') {
                        undoRow(row)
                        return
                    }
                    const mode = restoreMode(row, safe)
                    if (row.thisTab) backToNow()
                    else if (mode) runSessionItem(mode, row)
                }
                return
            case 'Delete':
                // Only while focus is in the list, so the chart's Delete never runs from here and
                // this never runs from the chart. A held key deletes one chain.
                handled()
                if (!event.repeat) void deleteRow(row)
                return
            case ' ':
                // Space is Undo on an inline row; elsewhere it plays, as the chart's.
                if (row?.type !== 'deleted') break
                handled()
                if (!event.repeat) undoRow(row)
                return
            case 'Escape':
                handled()
                // The dialog closes and keeps a peek. The tab goes back to now first, then hands
                // focus to the chart.
                if (props.surface === 'dialog') emit('close')
                else if (peekedKey.value) backToNow()
                else event.target.blur()
                return
        }
    }
    // Keys the list passes on: History, Play and Copy run as from the editor.
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

// --- Refresh: when the tab shows, on pageshow and visibility, when another tab reports a chain,
// and when this tab's session changes.
const refresh = () => {
    void list.refresh()
}
const onVisible = () => {
    if (document.visibilityState === 'visible') refresh()
}
let channel: BroadcastChannel | undefined
// A Delete, an Undo or a chain found gone changes the list: it reads at once, the user's own act.
let stopDeleteChanges: (() => void) | undefined
onMounted(() => {
    sessionDelete.listShown(true)
    stopDeleteChanges = onDeleteChanged(() => void list.refresh({ now: true }))
    void list.refresh({ now: true })
    void readBrowserFacts().then(
        (known) => {
            facts.value = known
        },
        () => undefined,
    )
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', onVisible)
    try {
        channel = new BroadcastChannel('nse-local-data')
        channel.addEventListener('message', (event: MessageEvent) => {
            const data: unknown = event.data
            if (
                typeof data === 'object' &&
                data !== null &&
                'type' in data &&
                data.type === 'sessionUpdated'
            )
                refresh()
        })
    } catch {
        // No BroadcastChannel: pageshow and visibility still refresh it.
    }
})
watch(() => session.value.sessionId, refresh)
onBeforeUnmount(() => {
    disposed = true
    focusToken++
    list.dispose()
    stopDeleteChanges?.()
    sessionDelete.listShown(false)
    cancelLongPress()
    window.removeEventListener('pageshow', refresh)
    document.removeEventListener('visibilitychange', onVisible)
    channel?.close()
})

const tryAgain = () => {
    void list.refresh({ now: true }).then(() => {
        if (!disposed && focusLost() && status.value === 'ready')
            void focusRow(cursorId.value, false)
    })
}

// A link asks for the list's focus, also from a list that mounts a moment later.
watch(
    listFocus,
    (request) => {
        if (request?.surface !== props.surface || performance.now() - request.at > 3000) return
        listFocus.value = undefined
        void nextTick(() => scroller.value?.focus({ preventScroll: true }))
    },
    { immediate: true },
)

defineExpose({ focus: () => void focusRow(cursorId.value, false) })

const notePointer = (event: PointerEvent) => {
    lastPointerType = event.pointerType
}
</script>

<template>
    <div class="relative h-full min-h-0" data-recent-sessions>
        <div
            ref="scroller"
            data-history-list
            data-history-focus="list"
            data-sessions-list
            tabindex="-1"
            class="sessions-list overlay-scroller h-full overflow-y-auto overscroll-contain px-1.5 pb-2 outline-none"
            @scroll.passive="cancelLongPress"
            @keydown="onKeydown"
            @focus.self="focusRow(cursorId, false)"
            @focusin="onFocusin"
            @focusout="onFocusout"
            @pointerenter="list.hold('pointer', true)"
            @pointerleave="list.hold('pointer', false)"
        >
            <!-- Loading rows take the rows' own form: a name over a caption. -->
            <div v-if="status === 'loading'" aria-hidden="true" class="pt-1" data-sessions-loading>
                <div
                    v-for="n in SKELETON_ROWS"
                    :key="n"
                    class="flex h-11 items-center px-0.5 motion-safe:animate-pulse"
                >
                    <span class="flex min-w-0 flex-1 flex-col gap-1.5 pl-2.5 pr-3">
                        <span
                            class="h-3 rounded-full bg-fg/10"
                            :style="{ width: `${72 - n * 9}%` }"
                        />
                        <span class="h-2.5 w-2/5 rounded-full bg-fg/10" />
                    </span>
                </div>
            </div>
            <div
                v-else-if="status === 'failed'"
                class="flex h-[8.25rem] flex-col items-center justify-center gap-3 px-3 text-center text-sm text-fg/80"
                data-sessions-failed
            >
                <span>{{ i18n.history.sessions.loadFailed }}</span>
                <button
                    type="button"
                    class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    data-history-focus="try-again"
                    @click="tryAgain"
                >
                    {{ i18n.history.tryAgain }}
                </button>
            </div>
            <template v-else>
                <div
                    v-if="!rows.length"
                    class="flex h-24 items-center justify-center px-3 text-center text-sm text-fg/80"
                    data-sessions-empty
                >
                    {{ i18n.history.empty }}
                </div>
                <div
                    v-else
                    role="grid"
                    :aria-label="i18n.history.recentSessions"
                    :aria-rowcount="navRows.length"
                    class="pt-1"
                >
                    <template v-for="row in rows" :key="row.id">
                        <div
                            v-if="row.type === 'header'"
                            role="presentation"
                            aria-hidden="true"
                            class="sessions-header sticky top-0 z-10 flex h-7 select-none items-end bg-modal pb-1 pl-3 pr-3 text-xs font-bold text-fg"
                        >
                            <span class="min-w-0 truncate">{{ headerText(row, calendar) }}</span>
                        </div>
                        <!-- A chain marked for Delete stands where it was, with its Undo. -->
                        <div
                            v-else-if="row.type === 'deleted'"
                            :id="domId(row.id)"
                            role="row"
                            data-sessions-row
                            data-sessions-deleted
                            :data-chain="row.id"
                            :data-status="row.status"
                            :tabindex="row.id === cursorId ? 0 : -1"
                            class="sessions-row scroll-mt-7"
                            :aria-label="deletedText(row)"
                            @click="onRowClick(row)"
                        >
                            <div role="gridcell" class="sessions-text">
                                <span class="sessions-title">
                                    <span
                                        class="line-clamp-2 min-w-0 flex-1"
                                        data-sessions-deleted-text
                                        >{{ deletedText(row) }}</span
                                    >
                                </span>
                            </div>
                            <button
                                v-if="row.status === 'deleted'"
                                type="button"
                                tabindex="-1"
                                class="btn btn-secondary mr-0.5 h-8 min-w-0 max-w-[40%] shrink-0 truncate rounded-full px-4"
                                data-sessions-undo
                                @click.stop="undoRow(row)"
                            >
                                {{ i18n.commands.undo.title }}
                            </button>
                            <span v-else class="size-9 shrink-0" aria-hidden="true" />
                        </div>
                        <div
                            v-else
                            :id="domId(row.id)"
                            role="row"
                            data-sessions-row
                            :data-chain="row.id"
                            :data-badge="row.badge"
                            :tabindex="row.id === cursorId ? 0 : -1"
                            class="sessions-row scroll-mt-7"
                            :class="{
                                'sessions-row-selected': selectedId === row.id,
                                'sessions-row-disabled': row.readable !== 'yes',
                            }"
                            :aria-selected="selectedId === row.id"
                            :aria-label="accessibleOf(row)"
                            :title="accessibleOf(row)"
                            @click="onRowClick(row)"
                            @contextmenu="onContextMenu($event, row)"
                            @pointerdown="onRowPointerdown($event, row)"
                            @pointermove="onRowPointermove"
                            @pointerup="cancelLongPress"
                            @pointercancel="cancelLongPress"
                        >
                            <div role="gridcell" class="sessions-text">
                                <span class="sessions-title">
                                    <span class="min-w-0 flex-1 truncate">{{ nameOf(row) }}</span>
                                    <span
                                        v-if="badgeText(row)"
                                        class="sessions-badge"
                                        data-sessions-badge
                                        >{{ badgeText(row) }}</span
                                    >
                                </span>
                                <span class="sessions-caption" data-sessions-caption>{{
                                    captionOf(row)
                                }}</span>
                            </div>
                            <button
                                v-if="sessionMenuItems(row, new Set(), safe).length"
                                type="button"
                                tabindex="-1"
                                aria-haspopup="menu"
                                :aria-expanded="menu?.row.id === row.id"
                                class="sessions-more ghost relative flex size-9 shrink-0 items-center justify-center rounded-full before:absolute before:-inset-y-1 before:inset-x-0"
                                :aria-label="
                                    interpolateRaw(i18n.history.sessions.actions, nameOf(row))
                                "
                                :title="interpolateRaw(i18n.history.sessions.actions, nameOf(row))"
                                data-sessions-more
                                @pointerdown.stop="notePointer"
                                @click="onMoreClick($event, row)"
                                @contextmenu.stop.prevent
                            >
                                <MoreIcon class="size-4 fill-current" aria-hidden="true" />
                            </button>
                            <!-- Keeps the badge and text edge where a row with a button has them. -->
                            <span v-else class="size-9 shrink-0" aria-hidden="true" />
                        </div>
                    </template>
                </div>
                <p v-if="footer" class="px-3 pb-1 pt-3 text-xs text-fg/80" data-sessions-footer>
                    {{ footer }}
                </p>
            </template>
        </div>
        <OverlayScrollbar :target="scroller" />
        <ManagerMenu
            v-if="menu"
            :key="menu.row.id"
            :anchor="menu.anchor"
            :touch="menu.touch"
            :label="i18n.history.recentSessions"
            :items="menu.items"
            @select="onMenuSelect"
            @close="closeMenu"
        />
    </div>
</template>

<style scoped>
/*
 * The Timeline's row (list x): the row pill 6..W-6 with its 2 px inset; the text face starts at the
 * tab labels' 18 px; a 36 px slot at the end holds the ⋯ button, or keeps its place. The 44 px slot
 * holds two lines, 18 and 16 px, in the 40 px pill.
 */
.sessions-row {
    @apply relative flex h-11 select-none items-center px-0.5 text-sm;
    isolation: isolate;
    outline: none;
}

.sessions-row::before {
    content: '';
    @apply pointer-events-none absolute inset-x-0 inset-y-0.5 -z-10 rounded-[1.25rem] transition-[background-color,box-shadow];
    outline: 2px solid transparent;
    outline-offset: -2px;
}

/* The current row is the raised pill with a 1 px inset edge, as the Timeline's. */
.sessions-row-selected::before {
    @apply bg-button shadow-md ring-1 ring-inset ring-fg/25;
}

@media (hover: hover) and (pointer: fine) {
    .sessions-row:not(.sessions-row-selected):not(.sessions-row-disabled):not(
            :active
        ):hover::before {
        @apply bg-button/70;
    }
}

.sessions-row:not(.sessions-row-disabled):active::before {
    @apply bg-press shadow-pressed;
}

.sessions-row:not(.sessions-row-disabled):active {
    @apply text-fg-strong;
}

.sessions-row:focus-visible::before {
    outline-color: rgb(var(--color-fg));
}

.sessions-text {
    @apply flex h-10 min-w-0 flex-1 flex-col justify-center rounded-[1.125rem] pb-0.5 pl-2.5 pr-3 text-left;
}

.sessions-title {
    @apply flex items-center gap-2 leading-[1.125rem];
}

.sessions-badge {
    @apply max-w-[60%] shrink-0 truncate rounded-full px-2 text-xs leading-4 ring-1 ring-inset ring-fg/25;
}

.sessions-caption {
    @apply block truncate whitespace-nowrap text-xs leading-4 text-fg/80;
}

/* Unavailable: the text fades; the reason, in the caption, stays strong. */
.sessions-row-disabled .sessions-title {
    @apply opacity-60;
}

.sessions-more:focus-visible {
    outline: 2px solid rgb(var(--color-fg));
    outline-offset: -2px;
}

@media (forced-colors: active) {
    .sessions-row-selected {
        outline: 2px solid Highlight;
        outline-offset: -4px;
    }
    .sessions-row-disabled {
        color: GrayText;
    }
}
</style>
