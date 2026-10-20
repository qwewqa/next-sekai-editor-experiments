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
import { peekedKey, peekSourceGeneration } from '../../history/peek'
import { session } from '../../history/session'
import { headStep } from '../../history/stack'
import { getHistoryOperationContext } from '../../history/createHistoryOperation'
import {
    captureOperationRecipe,
    describeStep,
    disambiguateOperationRecipes,
    type OperationRecipe,
} from '../../history/operationPresentation'
import { i18n } from '../../i18n'
import {
    formatClock,
    formatClockSeconds,
    formatDateTime,
    formatDateTimeSeconds,
} from '../../i18n/when'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import { commands, type CommandName } from '../commands'
import { runCommand } from '../commands/runCommand'
import { isApplePlatform, matchBindings } from '../controls/bindings'
import ManagerMenu from '../workspace/manager/ManagerMenu.vue'
import OverlayScrollbar from '../workspace/OverlayScrollbar.vue'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import { useScrollMemory } from '../workspace/useScrollMemory'
import FlagIcon from './FlagIcon.vue'
import GapArrowIcon from './GapArrowIcon.vue'
import KindIcon from './KindIcon.vue'
import { headerText, newerStepsText, pinnedText } from './labels'
import { showChangeOf } from './changes'
import { heightOf, isCountedParent, presentRow, recipeOfRow } from './rowPresentation'
import { openOperationDetails } from './operationDetails'
import { canFocusHistory } from './openHistory'
import { buildRows, previousOf, type Entry, type EntryRow, type Header, type Row } from './rows'
import {
    backToNow,
    damagedEntries,
    keyOf,
    peekedInfo,
    requestPeek,
    requestRestore,
    type PeekedInfo,
} from './selection'
import {
    canLoadMore,
    entries,
    followEntries,
    gap,
    here,
    listedEntries,
    jumpTo as jumpToEntry,
    jumpToOldest,
    loadingMore,
    loadingNewer,
    loadMore,
    loadNewer,
    resetToNewest,
    retry,
    status,
    sourceGeneration,
    type Target,
} from './source'
import {
    expandedGroups,
    historyFilter,
    listFocus,
    historyViewGeneration,
    rememberHistoryView,
    rememberedHistoryView,
    restoreHistoryView,
} from './state'

// The Timeline is a rows-first treegrid of the chain's entries, newest first and windowed.
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
const memoryGeneration = historyViewGeneration()
const mountedSession = session.value.sessionId
const savedView = props.surface === 'dialog' ? rememberedHistoryView() : undefined
let viewRestored = !savedView
let restoreFrame = 0
let restoreReady = false

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
    buildRows(listedEntries.value, {
        filter: historyFilter.value,
        expanded: expandedGroups.value,
        damaged: damagedEntries.value,
        now: clock.value,
        gap: gap.value,
        more: canLoadMore.value,
        pinned: peekedInfo.value?.pinned,
    }),
)

// A timeline of only its first state says so, under Now.
const isEmpty = computed(
    () =>
        (historyFilter.value === 'here' ? !here.scanning : status.value !== 'loading') &&
        gap.value === undefined &&
        !built.value.some(
            (row) =>
                row.type === 'divider' ||
                (row.type === 'entry' &&
                    (row.entry.kind !== 'init' || historyFilter.value !== 'all')),
        ),
)
const rows = computed(() => (isEmpty.value ? built.value.slice(0, 1) : built.value))
const operationContext = computed(getHistoryOperationContext)
const headLabel = computed(
    () => headStep.value && describeStep(headStep.value, operationContext.value),
)
const recipes = computed(() => {
    const result = new Map<string, OperationRecipe>()
    let adjacent: EntryRow[] = []
    const flush = () => {
        const qualified = disambiguateOperationRecipes(
            adjacent.map(recipeOfRow),
            operationContext.value,
        )
        adjacent.forEach((row, index) => {
            const recipe = qualified[index]
            if (recipe) result.set(row.id, recipe)
        })
        adjacent = []
    }
    for (const row of rows.value) {
        if (row.type === 'divider' || row.type === 'gap') flush()
        else if (row.type === 'entry') {
            if (row.child) result.set(row.id, recipeOfRow(row))
            else adjacent.push(row)
        }
    }
    flush()
    return result
})
const recipeOf = (row: EntryRow) =>
    peekedInfo.value?.rowId === row.id
        ? peekedInfo.value.recipe
        : (recipes.value.get(row.id) ?? recipeOfRow(row))

// --- Geometry: rows have fixed heights per kind, so the window needs no measuring. The heights are
// px at the 16 px rem; k, the root font size / 16 read as the list is set up, scales them as the rows’
// classes scale (a larger browser text size).
const k = ref((parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16)
const rowHeight = computed(() => 44 * k.value)
const HEADER = computed(() => 28 * k.value)
const DIVIDER = computed(() => 32 * k.value)
// The list's padding: 4 px above the first row, 8 px below the last.
const PAD_TOP = computed(() => 4 * k.value)
const PAD_BOTTOM = computed(() => 8 * k.value)
const geometry = computed(() => {
    let y = PAD_TOP.value
    const offsets = rows.value.map((row) => {
        const top = y
        y += heightOf(row, k.value)
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
const MESSAGE = computed(() => 96 * k.value)
const FAILED = computed(() => 132 * k.value)
const tail = computed(() => {
    // Edits Here: its scan's progress, then what it could not check.
    if (historyFilter.value === 'here') {
        if (isEmpty.value) return { kind: 'empty', height: MESSAGE.value }
        if (here.scanning) return { kind: 'checking', height: rowHeight.value }
        if (here.unreadable) return { kind: 'notChecked', height: rowHeight.value }
        return { kind: 'none', height: 0 }
    }
    if (status.value === 'failed') return { kind: 'failed', height: FAILED.value }
    if (status.value === 'loading')
        return { kind: 'skeleton', height: SKELETON_ROWS * rowHeight.value }
    if (isEmpty.value) return { kind: 'empty', height: MESSAGE.value }
    if (loadingMore.value) return { kind: 'more', height: rowHeight.value }
    return { kind: 'none', height: 0 }
})
const contentHeight = computed(() => geometry.value.total + tail.value.height + PAD_BOTTOM.value)

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

const visibleRows = computed(() => {
    const indexes = new Set(
        Array.from(
            { length: range.value.end - range.value.first },
            (_, i) => range.value.first + i,
        ),
    )
    const focused = rows.value.findIndex((row) => row.id === cursorId.value)
    if (focused >= 0) indexes.add(focused)
    return [...indexes]
        .sort((a, b) => a - b)
        .flatMap((index) => {
            const row = rows.value[index]
            return row ? [{ row, top: geometry.value.offsets[index] ?? 0 }] : []
        })
})

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

/** Logical action positions exclude passive decorations. */
const positions = computed(() => {
    const map = new Map<string, number>()
    let n = 0
    for (const row of rows.value)
        if (row.type === 'now' || row.type === 'entry') map.set(row.id, ++n)
    return { map, size: n }
})
const continuationDescriptions = computed(() => {
    const descriptions = new Map<string, string>()
    const logical = rows.value
    for (let i = 0; i < logical.length; i++) {
        const divider = logical[i]
        if (divider?.type !== 'divider') continue
        const adjacent =
            logical.slice(i + 1).find((row) => row.type === 'entry') ??
            logical
                .slice(0, i)
                .reverse()
                .find((row) => row.type === 'entry')
        if (adjacent)
            descriptions.set(
                adjacent.id,
                [descriptions.get(adjacent.id), dividerText(divider.entry)]
                    .filter(Boolean)
                    .join(' · '),
            )
    }
    return descriptions
})

// --- The cursor: the row the keys and the peek are on.
const cursorId = ref('now')
type FocusPart = 'row' | 'leading' | 'main'
const focusPart = ref<FocusPart>('row')
const focusInside = ref(false)
let focusToken = 0
let disposed = false
type FocusRequest = Readonly<{
    id: string
    part: FocusPart
    token: number
    source: number
    peek: number
    view: number
    filter: typeof historyFilter.value
}>
let latestFocus: FocusRequest | undefined
let focusHandoff: { request: FocusRequest; outgoing: Element } | undefined
type DetailsReturn = {
    dialog?: HTMLDialogElement
    returned: boolean
    abandoned: boolean
    dispose: () => void
}
let detailsReturn: DetailsReturn | undefined
const ownsFocus = (request: FocusRequest) =>
    !disposed &&
    request.token === focusToken &&
    request.source === sourceGeneration.value &&
    request.peek === peekSourceGeneration.value &&
    request.view === historyViewGeneration() &&
    request.filter === historyFilter.value
const timelineRow = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest('[data-history-row]') : null
    return row && list.value?.contains(row) ? row : undefined
}
const replacing = shallowRef<{ token: number; filter: typeof historyFilter.value }>()
const finishReplacement = (token: number) => {
    if (replacing.value?.token === token) replacing.value = undefined
}

const selectables = computed(() =>
    rows.value.filter((row) => row.type === 'now' || row.type === 'entry'),
)

const rowById = (id: string) => rows.value.find((row) => row.id === id)
const expandable = (row: Row) => row.type === 'entry' && row.members.length > 1 && !row.child
const focusElement = (id: string, part: FocusPart) => {
    const element = list.value?.querySelector<HTMLElement>(`#${CSS.escape(domId(id))}`)
    return part === 'row'
        ? element
        : element?.querySelector<HTMLElement>(`[data-history-part="${part}"]`)
}
const focusedPart = (event: Event): FocusPart =>
    ((event.target as HTMLElement).dataset.historyPart as FocusPart | undefined) ?? 'row'
const openerPart = (element: HTMLElement): FocusPart =>
    (element.closest<HTMLElement>('[data-history-part]')?.dataset.historyPart as
        FocusPart | undefined) ?? 'row'
const tabIndex = (row: Row, part: FocusPart) =>
    row.id === cursorId.value && focusPart.value === part ? 0 : -1
const focusRow = async (id = cursorId.value, part: FocusPart = 'row', scroll = true) => {
    const token = ++focusToken
    const row = rowById(id)
    if (!row || (row.type !== 'entry' && row.type !== 'now')) return
    const request: FocusRequest = {
        id,
        part: part === 'leading' && !expandable(row) ? 'main' : part,
        token,
        source: sourceGeneration.value,
        peek: peekSourceGeneration.value,
        view: historyViewGeneration(),
        filter: historyFilter.value,
    }
    latestFocus = request
    const outgoing = timelineRow(document.activeElement)
    focusHandoff = outgoing ? { request, outgoing } : undefined
    cursorId.value = id
    focusPart.value = request.part
    try {
        if (scroll) scrollToRow(id)
        await nextTick()
        if (!ownsFocus(request) || menu.value || !canFocusHistory(props.surface)) return
        focusElement(id, request.part)?.focus({ preventScroll: true })
    } finally {
        if (focusHandoff?.request === request) focusHandoff = undefined
    }
}
const onRowFocus = (event: FocusEvent, row: Row) => {
    if (detailsReturn?.dialog?.open === false) detailsReturn.returned = true
    cursorId.value = row.id
    focusPart.value = focusedPart(event)
    focusInside.value = true
}
const onFocusout = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && list.value?.contains(event.relatedTarget)) return
    const outgoing =
        event.target instanceof Element ? event.target.closest('[data-history-row]') : null
    if (
        event.relatedTarget === null &&
        outgoing === focusHandoff?.outgoing &&
        ownsFocus(focusHandoff.request) &&
        !rows.value.some((row) => domId(row.id) === outgoing.id)
    )
        return
    // Removing the owned window's focused row is an internal focus handoff.
    if (
        event.relatedTarget === null &&
        replacing.value?.token === focusToken &&
        replacing.value.filter === historyFilter.value &&
        !rowById(cursorId.value) &&
        event.target instanceof Element &&
        event.target.closest('[data-history-row]')?.id === domId(cursorId.value)
    )
        return
    if (detailsReturn && (detailsReturn.returned || !detailsReturn.dialog))
        detailsReturn.abandoned = true
    focusInside.value = false
    focusPart.value = 'row'
    focusToken++
}
const restoreRowFocus = (id: string, part: FocusPart) => {
    if (disposed) return
    const target =
        rowById(id) ?? rowById(id.split('/')[0] ?? '') ?? rowById(cursorId.value) ?? rows.value[0]
    if (target) void focusRow(target.id, part, false)
}

// The peeked entry's row, or its group's while the group is closed.
const rowOf = (key: string | undefined) => {
    if (!key) return rows.value[0]
    const selected = peekedInfo.value
    if (selected?.key === key && selected.rowId) {
        const scoped = rows.value.find((row) => row.id === selected.rowId)
        if (scoped) return scoped
    }
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

const rememberView = () => {
    const element = list.value
    if (props.surface !== 'dialog' || !element || !viewRestored) return
    const index = rowAt(geometry.value, element.scrollTop)
    const anchor = rows.value[index]
    if (!anchor) return
    const first = entries.value[0]
    const last = entries.value.at(-1)
    rememberHistoryView(
        {
            sessionId: mountedSession,
            cursorId: cursorId.value,
            anchorId: anchor.id,
            offset: element.scrollTop - (geometry.value.offsets[index] ?? 0),
            window: {
                first: first && keyOf(first),
                last: last && keyOf(last),
                gap: gap.value !== undefined,
            },
        },
        memoryGeneration,
    )
}
const restoreView = () => {
    const element = list.value
    if (!restoreReady || viewRestored || !savedView || !element) return
    if (
        memoryGeneration !== historyViewGeneration() ||
        mountedSession !== session.value.sessionId
    ) {
        viewRestored = true
        return
    }
    if (historyFilter.value === 'here') {
        if (here.scanning) return
    } else if (
        status.value === 'loading' &&
        !rows.value.some(({ id }) => id === savedView.anchorId)
    )
        return
    const restored = restoreHistoryView(savedView, geometry.value, rowOf(peekedKey.value)?.id)
    cursorId.value = peekedKey.value ? restored.cursorId : 'now'
    element.scrollTop = restored.top
    scrollTop.value = element.scrollTop
    viewRestored = true
}
watch([geometry, status, () => here.scanning], () => void nextTick(restoreView), { flush: 'post' })

watch(peekedKey, () => {
    const key = peekedKey.value
    const row = rowOf(key)
    // A peek being asked for keeps the cursor where it was put.
    if (!key && peekedInfo.value) return
    if (row && !focusInside.value) cursorId.value = row.id
    else if (!key && !focusInside.value) cursorId.value = 'now'
})
watch(
    [rows, replacing, historyFilter],
    () => {
        if (replacing.value?.token === focusToken && replacing.value.filter === historyFilter.value)
            return
        if (rowById(cursorId.value)) return
        const parent = rowById(cursorId.value.split('/')[0] ?? '')
        const target = parent?.type === 'entry' ? parent : rows.value[0]
        const focused = focusInside.value
        cursorId.value = target?.id ?? 'now'
        focusPart.value = 'row'
        if (focused) void focusRow(cursorId.value, 'row', false)
    },
    { flush: 'pre' },
)
watch(
    [sourceGeneration, peekSourceGeneration, historyViewGeneration],
    ([, peekGeneration, historyGeneration], [, previousPeek, previousHistory]) => {
        menu.value = undefined
        cancelLongPress()
        if (
            replacing.value &&
            peekGeneration === previousPeek &&
            historyGeneration === previousHistory
        )
            return
        focusToken++
        if (focusInside.value) void focusRow('now', 'row', false)
    },
    { flush: 'sync' },
)
const selectedId = computed(() => {
    const key = peekedInfo.value?.key ?? peekedKey.value
    return key ? rowOf(key)?.id : 'now'
})

/** What a peek of an entry names, and what it is compared with: before `oldest`, its run's. */
const infoOf = (entry: Entry, oldest = entry): PeekedInfo => {
    const previous = previousOf(listedEntries.value, oldest)
    return {
        key: keyOf(entry),
        time: entry.time,
        recipe: captureOperationRecipe([
            { description: entry, time: entry.time, id: keyOf(entry) },
        ]),
        oldest: keyOf(oldest),
        initial: oldest.kind === 'init' && !previous,
        ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
        ...(previous
            ? {
                  previous: {
                      key: keyOf(previous),
                      ...(previous.snapshot ? { snapshot: previous.snapshot } : {}),
                  },
              }
            : {}),
    }
}

/** A row's peek: a closed ×N row stands for its run, so it is compared with the entry before it. */
const rowInfo = (row: EntryRow): PeekedInfo => ({
    ...infoOf(row.entry, row.child ? row.entry : (row.members.at(-1) ?? row.entry)),
    recipe: recipes.value.get(row.id) ?? recipeOfRow(row),
    rowId: row.id,
    members: row.members.map(keyOf),
    pinned: (row.child
        ? rows.value.find(
              (parent): parent is EntryRow =>
                  parent.type === 'entry' && !parent.child && row.id.startsWith(`${parent.id}/`),
          )
        : row
    )?.members.map(keyOf),
})

const moveTo = (row: Row | undefined) => {
    if (!row) return
    viewRestored = true
    // After a jump, Now goes back to the newest entries.
    if (row.type === 'now' && (gap.value !== undefined || replacing.value)) {
        void goNow()
        return
    }
    cursorId.value = row.id
    if (row.type === 'now') backToNow()
    else if (row.type === 'entry' && row.selectable) requestPeek(rowInfo(row))
    void focusRow(row.id)
}

// Brings a row into view, clear of the pinned header.
const scrollToRow = (id: string) => {
    const element = list.value
    const index = rows.value.findIndex((row) => row.id === id)
    const row = rows.value[index]
    if (!element || !row) return
    const top = geometry.value.offsets[index] ?? 0
    const bottom = top + heightOf(row, k.value)
    const cover = element.scrollTop > 0 ? HEADER.value : 0
    if (top < element.scrollTop + cover) element.scrollTop = Math.max(0, top - HEADER.value)
    else if (bottom > element.scrollTop + element.clientHeight)
        element.scrollTop = bottom + PAD_BOTTOM.value - element.clientHeight
}

const step = async (delta: number) => {
    let at = selectables.value.findIndex((row) => row.id === cursorId.value)
    const clamp = (index: number) => Math.max(0, Math.min(selectables.value.length - 1, index))
    // Up crosses the gap: the newer page loads, and the cursor goes on into it.
    if (delta < 0 && at > 0 && clamp(at + delta) === 0 && gap.value !== undefined) {
        const id = cursorId.value
        const token = focusToken
        const generation = sourceGeneration.value
        const peekGeneration = peekSourceGeneration.value
        const historyGeneration = historyViewGeneration()
        await loadNewer()
        await nextTick()
        if (
            disposed ||
            token !== focusToken ||
            cursorId.value !== id ||
            generation !== sourceGeneration.value ||
            peekGeneration !== peekSourceGeneration.value ||
            historyGeneration !== historyViewGeneration()
        )
            return
        at = selectables.value.findIndex((row) => row.id === id)
    }
    const next = selectables.value[clamp(at + delta)]
    if (next && next.id !== cursorId.value) moveTo(next)
}

// --- Jumps: Go To and End read a window at the target, Now and Home go back to the newest.
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
    const token = ++focusToken
    const peekGeneration = peekSourceGeneration.value
    const generation = historyViewGeneration()
    replacing.value = { token, filter: historyFilter.value }
    try {
        await resetToNewest()
        await nextTick()
    } finally {
        finishReplacement(token)
    }
    if (
        token !== focusToken ||
        peekGeneration !== peekSourceGeneration.value ||
        generation !== historyViewGeneration() ||
        disposed
    )
        return
    cursorId.value = 'now'
    backToNow()
    void focusRow('now')
}

/** Jumps to an entry, or to Now; the entry is peeked and scrolled to the top. */
const jumpTo = async (target: Target | 'now') => {
    if (target === 'now') return goNow()
    const token = ++focusToken
    const peekGeneration = peekSourceGeneration.value
    const historyGeneration = historyViewGeneration()
    replacing.value = { token, filter: historyFilter.value }
    try {
        const entry = await jumpToEntry(target, historyFilter.value)
        if (!entry) return
        const generation = sourceGeneration.value
        await nextTick()
        if (
            disposed ||
            token !== focusToken ||
            generation !== sourceGeneration.value ||
            peekGeneration !== peekSourceGeneration.value ||
            historyGeneration !== historyViewGeneration()
        )
            return
        const row = rowOf(keyOf(entry))
        if (row) {
            cursorId.value = row.id
            scrollRowToTop(row.id)
        }
        requestPeek(row?.type === 'entry' ? rowInfo(row) : infoOf(entry))
        if (row) void focusRow(row.id, 'row', false)
    } catch {
        // The list stays as it was.
    } finally {
        finishReplacement(token)
    }
}

/** End: the oldest entry, read directly when it is not loaded. */
const goOldest = async (part?: FocusPart) => {
    if (!canLoadMore.value) {
        const row = selectables.value.at(-1)
        if (part && row) void focusRow(row.id, part)
        else moveTo(row)
        return
    }
    const token = ++focusToken
    const peekGeneration = peekSourceGeneration.value
    const historyGeneration = historyViewGeneration()
    replacing.value = { token, filter: historyFilter.value }
    try {
        const entry = await jumpToOldest(historyFilter.value)
        if (!entry) return
        const generation = sourceGeneration.value
        await nextTick()
        if (
            disposed ||
            token !== focusToken ||
            generation !== sourceGeneration.value ||
            peekGeneration !== peekSourceGeneration.value ||
            historyGeneration !== historyViewGeneration()
        )
            return
        const row = selectables.value.at(-1)
        if (part && row) void focusRow(row.id, part)
        else moveTo(row)
    } catch {
        return
    } finally {
        finishReplacement(token)
    }
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
        if (!element || replacing.value) return
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
    if (!element || !row || replacing.value || loadingNewer.value) return false
    const top = geometry.value.offsets[index] ?? 0
    return (
        top < element.scrollTop + element.clientHeight &&
        top + heightOf(row, k.value) > element.scrollTop
    )
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
    if (
        !open &&
        (cursorId.value.startsWith(`${row.id}/`) ||
            peekedInfo.value?.rowId?.startsWith(`${row.id}/`))
    ) {
        focusElement(row.id, 'row')?.focus({ preventScroll: true })
        moveTo(row)
    }
    expandedGroups.value = next
}

// --- Restore
const restore = async (row: EntryRow) => {
    await requestRestore(keyOf(row.entry))
}

// --- Menu: Show Change and Restore, by right click, long press, Shift+F10 or the Menu key.
const menu = shallowRef<{ row: EntryRow; anchor: HTMLElement; touch: boolean; part: FocusPart }>()
const openMenu = (row: EntryRow, anchor: HTMLElement, touch = false) => {
    if (menu.value?.row.id === row.id) return
    const part = openerPart(anchor)
    cursorId.value = row.id
    focusPart.value = part
    focusToken++
    menu.value = { row, anchor, touch, part }
}
const closeMenu = (restoreFocus: boolean) => {
    if (!menu.value) return
    const { row, part } = menu.value
    menu.value = undefined
    if (restoreFocus) restoreRowFocus(row.id, part)
}
const menuItems = computed(() => [
    { key: 'details', label: i18n.value.history.details.action },
    {
        key: 'showChange',
        label: commands.showChange.title(),
        disabled: !menu.value?.row.selectable,
    },
    { key: 'restore', label: i18n.value.peek.restore, disabled: !menu.value?.row.selectable },
])
const showDetails = (
    row: EntryRow,
    opener?: HTMLElement,
    part = opener ? openerPart(opener) : focusPart.value,
) => {
    if (detailsReturn) return
    const previousRequest = latestFocus
    const context: DetailsReturn = {
        returned: false,
        abandoned: false,
        dispose: () => {
            document.removeEventListener('focusin', onDeparture, true)
            document.removeEventListener('pointerdown', onDeparture, true)
            if (detailsReturn === context) detailsReturn = undefined
        },
    }
    const onDeparture = (event: Event) => {
        const target = event.target
        if (target instanceof Node && context.dialog?.contains(target)) return
        if (timelineRow(target)) return
        if (event.type === 'focusin' && target === document.body) return
        context.abandoned = true
    }
    detailsReturn = context
    document.addEventListener('focusin', onDeparture, true)
    document.addEventListener('pointerdown', onDeparture, true)
    void openOperationDetails(recipeOf(row), row.entry.time, opener, {
        captureDialog: (dialog) => (context.dialog = dialog),
        restoreFocus: () => {
            const active = document.activeElement
            if (
                context.abandoned ||
                (active !== document.body && active !== null && !timelineRow(active))
            )
                return
            if (latestFocus !== previousRequest) {
                if (latestFocus && ownsFocus(latestFocus))
                    void focusRow(latestFocus.id, latestFocus.part, false)
            } else if (context.returned) restoreRowFocus(cursorId.value, focusPart.value)
            else restoreRowFocus(row.id, part)
        },
    }).finally(context.dispose)
}
// Show Change peeks the row first when it isn't, then brings its nearest change into view.
const showRowChange = (row: EntryRow) => {
    const info = rowInfo(row)
    const selected = peekedInfo.value
    if (
        !selected ||
        selected.rowId !== info.rowId ||
        selected.oldest !== info.oldest ||
        selected.members?.join() !== info.members?.join()
    )
        moveTo(row)
    if (peekedInfo.value) showChangeOf(peekedInfo.value)
}
const onMenuSelect = (key: string, keyboard: boolean) => {
    const current = menu.value
    closeMenu(keyboard)
    if (!current) return
    if (key === 'details') showDetails(current.row, current.anchor, current.part)
    else if (current.row.selectable && key === 'restore') void restore(current.row)
    else if (current.row.selectable && key === 'showChange') showRowChange(current.row)
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
const onRowPointerdown = (event: PointerEvent, row: Row) => {
    lastPointerType = event.pointerType
    suppressClick = false
    cancelLongPress()
    if (row.type !== 'entry' || event.pointerType !== 'touch' || !event.isPrimary) return
    if (!settings.touchLongPressContextMenu) return
    const anchor = event.currentTarget as HTMLElement
    longPress = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
            longPress = undefined
            suppressClick = true
            openMenu(row, anchor, true)
        }, LONG_PRESS_MS),
    }
}
const onRowPointermove = (event: PointerEvent) => {
    if (longPress?.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > LONG_PRESS_SLOP)
        cancelLongPress()
}
const onContextMenu = (event: MouseEvent, row: Row) => {
    event.preventDefault()
    if (row.type !== 'entry') return
    // Firefox for Android reports a plain MouseEvent: the last pointer tells touch apart.
    const touch =
        event instanceof PointerEvent ? event.pointerType === 'touch' : lastPointerType === 'touch'
    if (touch) {
        cancelLongPress()
        if (!settings.touchLongPressContextMenu) return
        suppressClick = true
    }
    const anchor =
        event.target instanceof HTMLElement
            ? (event.target.closest<HTMLElement>('[data-history-part]') ??
              (event.currentTarget as HTMLElement))
            : (event.currentTarget as HTMLElement)
    openMenu(row, anchor, touch)
}

// --- Pointer
const onRowClick = (row: Row) => {
    if (suppressClick) {
        suppressClick = false
        return
    }
    if (row.type === 'now') moveTo(row)
    else if (row.type === 'entry' && row.selectable) moveTo(row)
    if (row.type === 'entry' && !row.selectable) void focusRow(row.id)
}
const onDetailsClick = (event: MouseEvent, row: EntryRow) => {
    event.stopPropagation()
    if (suppressClick) {
        suppressClick = false
        return
    }
    showDetails(row, event.currentTarget as HTMLElement)
}

// --- Keyboard
const isApple = isApplePlatform()
// The keys the editor would run with focus elsewhere: docks pass it only unclaimed chords.
const passed: CommandName[] = ['history', 'play', 'copy', 'showChange']

const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    if (!(event.target instanceof HTMLElement) || !event.target.closest('[data-history-row]'))
        return
    const row = rowById(cursorId.value)
    const handled = () => {
        event.preventDefault()
        event.stopPropagation()
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey
    const part = focusedPart(event)
    const native = event.target instanceof HTMLButtonElement
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        handled()
        if (row?.type === 'entry') openMenu(row, event.target)
        return
    }
    if (event.key === 'Tab' && plain && row) {
        const controls: FocusPart[] = [
            ...(expandable(row) ? ['leading' as const] : []),
            ...(row.type === 'entry' && !row.selectable ? ['main' as const] : []),
        ]
        const index = controls.indexOf(part)
        if (event.shiftKey && part !== 'row') {
            handled()
            void focusRow(
                row.id,
                index > 0
                    ? controls[index - 1]
                    : part === 'main' && expandable(row)
                      ? 'leading'
                      : 'row',
                false,
            )
        } else if (!event.shiftKey && (part === 'row' || index >= 0)) {
            const next = controls[part === 'row' ? 0 : index + 1]
            if (next) {
                handled()
                void focusRow(row.id, next, false)
            }
        }
        return
    }
    if (part !== 'row' && row && !event.altKey && !event.metaKey && !event.shiftKey) {
        if (event.ctrlKey && (event.key === 'Home' || event.key === 'End')) {
            handled()
            if (event.key === 'End') void goOldest(part)
            else if (selectables.value[0]) void focusRow(selectables.value[0].id, part)
            return
        }
        if (plain) {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)) {
                handled()
                const delta = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[event.key] ?? 0
                const index = selectables.value.findIndex((candidate) => candidate.id === row.id)
                const target =
                    selectables.value[
                        Math.max(0, Math.min(selectables.value.length - 1, index + delta))
                    ]
                if (target) void focusRow(target.id, part)
                return
            }
            if (
                event.key === 'ArrowLeft' ||
                event.key === 'ArrowRight' ||
                event.key === 'Home' ||
                event.key === 'End'
            ) {
                handled()
                const next =
                    event.key === 'ArrowLeft'
                        ? part === 'main' && expandable(row)
                            ? 'leading'
                            : 'row'
                        : event.key === 'Home'
                          ? expandable(row)
                              ? 'leading'
                              : 'main'
                          : 'main'
                void focusRow(row.id, next, false)
                return
            }
        }
    }
    if (native && (event.key === 'Enter' || event.key === ' ')) return
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
                if (row?.type === 'entry') {
                    handled()
                    if (!event.repeat) {
                        if (row.selectable) void restore(row)
                        else showDetails(row, event.target)
                    }
                }
                return
            case 'Escape':
                handled()
                // Back to now first; then the dialog closes, and the tab hands focus to the chart.
                if (peekedKey.value || peekedInfo.value) moveTo(rows.value[0])
                else if (props.surface === 'dialog') emit('close')
                else event.target.blur()
                return
            case 'ArrowRight':
                if (row) {
                    handled()
                    if (
                        row.type === 'entry' &&
                        expandable(row) &&
                        !expandedGroups.value.has(row.id)
                    )
                        toggleGroup(row, true)
                    else void focusRow(row.id, expandable(row) ? 'leading' : 'main', false)
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
                        }
                    } else toggleGroup(row, false)
                }
                return
        }
    }
    // Keys the list passes on: History, Play, Copy and Show Change run as from the editor.
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
        if (name === 'showChange' && row?.type === 'entry' && !row.selectable) return
        void runCommand(commands[name])
    }
}

// --- Loading older entries as the list scrolls.
const onScroll = () => {
    cancelLongPress()
    const element = list.value
    if (!element) return
    scrollTop.value = element.scrollTop
    if (
        historyFilter.value !== 'here' &&
        canLoadMore.value &&
        element.scrollTop + element.clientHeight > geometry.value.total - 400
    )
        void loadMore()
    if (gapInView()) void loadNewer()
}
// A short list loads on until it fills the pane.
watch([() => geometry.value.total, viewport, canLoadMore], () => {
    if (historyFilter.value === 'here') return
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
    restoreFrame = requestAnimationFrame(() => {
        restoreReady = true
        if (!savedView || memoryGeneration !== historyViewGeneration()) {
            if (props.surface === 'dialog') {
                element.scrollTop = 0
                scrollTop.value = 0
            }
        }
        restoreView()
    })
})
onBeforeUnmount(() => {
    detailsReturn?.dispose()
    disposed = true
    focusToken++
    rememberView()
    cancelAnimationFrame(restoreFrame)
    observer?.disconnect()
    clearTimeout(clockTimer)
    cancelLongPress()
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

const presentationOf = (row: EntryRow) => presentRow(row, operationContext.value, recipeOf(row))

const labelOf = (row: EntryRow) => presentationOf(row).full

const flagTextOf = (row: EntryRow) =>
    row.flags.damaged
        ? i18n.value.history.damaged
        : row.flags.removed
          ? i18n.value.history.removedForSpace
          : undefined

const flagKindOf = (row: EntryRow) => (row.flags.damaged ? 'damaged' : 'removed')

// Narrow rows omit seconds and note deltas; full times remain in their names. Narrow is under 21.25rem:
// 340 px at the default size, scaled with the root font size like the one-line threshold.
const narrow = computed(() => width.value > 0 && width.value < 340 * k.value)
// From 18rem a row is one line: its mark, title, count, delta and time on one centre line. Below,
// the count, delta and time go under the title, at its edge (Part 1 §1.4.10.5).
// One-line rows from 18rem: px at the 16 px rem, scaled like the slots (owner decision, 2026-10-19).
const ONE_LINE = 18 * 16
const oneLine = computed(() => width.value >= ONE_LINE * k.value)

// A group's members carry its rail in their leading slot, from under the parent's disclosure to
// the run's end: computed from the rows, so the window cannot break it.
const isMember = (row: Row | undefined) => row?.type === 'entry' && row.child
const memberEnds = computed(() => {
    const first = new Set<string>()
    const last = new Set<string>()
    rows.value.forEach((row, i) => {
        if (!isMember(row)) return
        if (!isMember(rows.value[i - 1])) first.add(row.id)
        if (!isMember(rows.value[i + 1])) last.add(row.id)
    })
    return { first, last }
})

const clockOf = (at: number) => (narrow.value ? formatClock(at) : formatClockSeconds(at))

const timeOf = (row: EntryRow) => clockOf(row.entry.time)

const deltaOf = (row: EntryRow) =>
    row.delta === undefined ? undefined : `${row.delta > 0 ? '+' : '−'}${Math.abs(row.delta)}`

// The full date and time is the row's tooltip and in its accessible name; the header gives the date.
const whenOf = (row: EntryRow) => formatDateTimeSeconds(row.entry.time)

const titleOf = (row: EntryRow) =>
    [labelOf(row), flagTextOf(row), whenOf(row)].filter(Boolean).join(' · ')

const nameOf = (row: EntryRow) =>
    [labelOf(row), flagTextOf(row), deltaOf(row), whenOf(row)].filter(Boolean).join(', ')

const dividerText = (entry: Entry) =>
    interpolateRaw(i18n.value.history.continuedFrom, formatDateTime(entry.from ?? entry.time))

const headerClass = (header: Header) =>
    header.level === 'day'
        ? 'font-bold text-fg'
        : header.level === 'hour'
          ? 'font-bold text-fg/80'
          : 'font-medium text-fg/80'

const notCheckedText = computed(() =>
    interpolateRaw(i18n.value.history.notChecked, String(here.unreadable)),
)

defineExpose({
    focus: () => void focusRow(cursorId.value, 'row', false),
    jumpTo,
    topEntry,
    rememberView,
})
</script>

<template>
    <div class="timeline relative h-full min-h-0">
        <div
            ref="list"
            data-history-list
            data-history-focus="list"
            role="treegrid"
            tabindex="-1"
            class="timeline-list overlay-scroller h-full overflow-y-auto overscroll-contain outline-none"
            :class="oneLine ? 'timeline-one-line' : 'timeline-two-line'"
            :aria-label="i18n.history.timeline"
            aria-colcount="2"
            :aria-rowcount="canLoadMore || gap !== undefined ? -1 : positions.size"
            @scroll.passive="onScroll"
            @keydown="onKeydown"
            @focus.self="focusRow(cursorId, 'row', false)"
            @focusout="onFocusout"
        >
            <div class="relative" :style="{ height: `${contentHeight}px` }">
                <template v-for="{ row, top } in visibleRows" :key="row.id">
                    <!-- Now: the open chart. -->
                    <div
                        v-if="row.type === 'now'"
                        :id="domId(row.id)"
                        role="row"
                        aria-level="1"
                        data-history-row
                        data-history-part="row"
                        :tabindex="tabIndex(row, 'row')"
                        class="timeline-row timeline-row-plain timeline-now"
                        :class="{ 'timeline-row-selected': selectedId === row.id }"
                        :aria-selected="selectedId === row.id"
                        :aria-rowindex="positions.map.get(row.id)"
                        :style="{ top: `${top}px`, height: `${rowHeight}px` }"
                        @click="onRowClick(row)"
                        @focusin="onRowFocus($event, row)"
                    >
                        <div
                            role="gridcell"
                            aria-colspan="2"
                            class="flex min-w-0 flex-1 items-center"
                            data-history-part="main"
                            :tabindex="tabIndex(row, 'main')"
                        >
                            <span class="timeline-leading" aria-hidden="true">
                                <span class="size-2.5 rounded-full bg-fg" />
                            </span>
                            <span class="timeline-entry-text font-bold">
                                <span class="block truncate leading-5"
                                    >{{ i18n.history.now
                                    }}<template v-if="headLabel && !isEmpty">
                                        · {{ headLabel }}</template
                                    ></span
                                >
                            </span>
                        </div>
                    </div>

                    <!-- After a jump: the newer entries not read yet, read as it comes into view. -->
                    <div
                        v-else-if="row.type === 'gap'"
                        :id="domId(row.id)"
                        role="status"
                        class="timeline-divider items-center justify-center gap-1.5 font-medium text-fg/80"
                        :class="{ 'motion-safe:animate-pulse': loadingNewer }"
                        :style="{ top: `${top}px`, height: `${rowHeight}px` }"
                        data-history-gap
                    >
                        <GapArrowIcon class="size-3.5 shrink-0 fill-current" />
                        <span class="min-w-0 truncate">{{ newerStepsText(row.count) }}</span>
                    </div>

                    <!-- A continuation or file open: where one stretch of history ends. -->
                    <div
                        v-else-if="row.type === 'divider'"
                        :id="domId(row.id)"
                        role="presentation"
                        aria-hidden="true"
                        data-history-continuation
                        class="timeline-divider timeline-continuation items-center"
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
                        class="timeline-divider timeline-header items-end pb-1"
                        :class="headerClass(row)"
                        :style="{ top: `${top}px`, height: `${HEADER}px` }"
                    >
                        <span class="min-w-0 truncate">{{ headerText(row) }}</span>
                    </div>

                    <div
                        v-else
                        :id="domId(row.id)"
                        role="row"
                        data-history-row
                        data-history-part="row"
                        :tabindex="tabIndex(row, 'row')"
                        :aria-level="row.child ? 2 : 1"
                        class="timeline-row"
                        :class="{
                            'timeline-row-selected': selectedId === row.id,
                            'timeline-row-disabled': !row.selectable,
                            'timeline-row-plain': row.selectable && !expandable(row),
                            'timeline-row-group': expandable(row),
                            'timeline-row-child': row.child,
                            'timeline-row-first': memberEnds.first.has(row.id),
                            'timeline-row-last': memberEnds.last.has(row.id),
                            'timeline-row-counted': isCountedParent(row),
                        }"
                        :aria-selected="selectedId === row.id"
                        :aria-expanded="
                            row.members.length > 1 && !row.child
                                ? expandedGroups.has(row.id)
                                : undefined
                        "
                        :aria-label="nameOf(row)"
                        :aria-description="continuationDescriptions.get(row.id)"
                        :aria-rowindex="positions.map.get(row.id)"
                        :title="titleOf(row)"
                        :style="{ top: `${top}px`, height: `${heightOf(row, k)}px` }"
                        @click="onRowClick(row)"
                        @contextmenu="onContextMenu($event, row)"
                        @pointerdown="onRowPointerdown($event, row)"
                        @pointermove="onRowPointermove"
                        @pointerup="cancelLongPress"
                        @pointercancel="cancelLongPress"
                        @focusin="onRowFocus($event, row)"
                    >
                        <div
                            class="timeline-entry-header"
                            :role="expandable(row) ? 'presentation' : 'gridcell'"
                            :aria-colspan="expandable(row) ? undefined : 2"
                            :data-history-part="
                                !expandable(row) && row.selectable ? 'main' : undefined
                            "
                            :tabindex="
                                !expandable(row) && row.selectable
                                    ? tabIndex(row, 'main')
                                    : undefined
                            "
                            data-history-entry-header
                            :data-history-group-header="isCountedParent(row) ? '' : undefined"
                        >
                            <span v-if="expandable(row)" role="gridcell" class="shrink-0">
                                <button
                                    type="button"
                                    class="timeline-disclosure ghost relative z-[1] flex size-9 shrink-0 items-center justify-center rounded-full before:absolute before:-inset-y-1 before:inset-x-0"
                                    :aria-label="labelOf(row)"
                                    :aria-expanded="expandedGroups.has(row.id)"
                                    data-history-disclosure
                                    data-history-part="leading"
                                    :tabindex="tabIndex(row, 'leading')"
                                    @pointerdown.stop="cancelLongPress"
                                    @contextmenu.stop="onContextMenu($event, row)"
                                    @click.stop="toggleGroup(row, !expandedGroups.has(row.id))"
                                >
                                    <ChevronIcon
                                        :direction="expandedGroups.has(row.id) ? 'down' : 'right'"
                                        centered
                                    />
                                </button>
                            </span>
                            <!-- A member's slot holds only its group's rail (the row's ::after). -->
                            <span v-else class="timeline-leading" aria-hidden="true"
                                ><KindIcon v-if="!row.child" :kind="row.entry.kind"
                            /></span>
                            <div
                                class="timeline-main"
                                :role="expandable(row) ? 'gridcell' : undefined"
                                :data-history-part="
                                    expandable(row) && row.selectable ? 'main' : undefined
                                "
                                :tabindex="
                                    expandable(row) && row.selectable
                                        ? tabIndex(row, 'main')
                                        : undefined
                                "
                            >
                                <component
                                    :is="row.selectable ? 'div' : 'button'"
                                    :type="row.selectable ? undefined : 'button'"
                                    class="timeline-entry-text"
                                    :class="{ ghost: !row.selectable }"
                                    :aria-label="
                                        row.selectable
                                            ? undefined
                                            : interpolateRaw(
                                                  i18n.history.details.named,
                                                  nameOf(row),
                                              )
                                    "
                                    :data-history-details="row.selectable ? undefined : ''"
                                    :data-history-part="row.selectable ? undefined : 'main'"
                                    :tabindex="row.selectable ? undefined : tabIndex(row, 'main')"
                                    @click="!row.selectable && onDetailsClick($event, row)"
                                >
                                    <span
                                        class="block truncate leading-5"
                                        data-history-group-action
                                        >{{ presentationOf(row).main }}</span
                                    >
                                    <span class="timeline-entry-caption" data-history-group-caption>
                                        <!-- A group's step count, collapsed or open, at every width. -->
                                        <span class="timeline-group-count" data-history-group-count
                                            ><template v-if="presentationOf(row).count">{{
                                                presentationOf(row).count
                                            }}</template></span
                                        >
                                        <span
                                            v-if="row.selectable && !narrow && deltaOf(row)"
                                            class="timeline-count"
                                            >{{ deltaOf(row) }}</span
                                        >
                                        <span class="timeline-time" data-history-group-time>{{
                                            timeOf(row)
                                        }}</span>
                                    </span>
                                </component>
                            </div>
                        </div>
                        <span
                            v-if="flagTextOf(row)"
                            class="timeline-entry-reason timeline-flag"
                            data-history-flag
                        >
                            <FlagIcon :kind="flagKindOf(row)" />
                            <!-- Two lines at most: a larger text size in a narrow dock would spill a third. -->
                            <span class="line-clamp-2 min-w-0">{{ flagTextOf(row) }}</span>
                        </span>
                    </div>
                </template>

                <!-- What follows the rows. -->
                <!-- Loading rows take the rows' own form, one line or two, on the same columns. -->
                <div
                    v-if="tail.kind === 'skeleton'"
                    class="absolute inset-x-1.5"
                    :style="{ top: `${geometry.total}px` }"
                    aria-hidden="true"
                    data-history-loading
                >
                    <div
                        v-for="n in SKELETON_ROWS"
                        :key="n"
                        class="flex items-center px-0.5 motion-safe:animate-pulse"
                        :style="{ height: `${rowHeight}px` }"
                    >
                        <span class="flex size-9 shrink-0 items-center justify-center"
                            ><span class="size-4 rounded-full bg-fg/10"
                        /></span>
                        <template v-if="oneLine">
                            <span
                                class="ml-2 h-3 max-w-[calc(100%-8rem)] rounded-full bg-fg/10"
                                :style="{ width: `${72 - n * 9}%` }"
                            />
                            <span class="ml-auto mr-3 h-3 w-16 shrink-0 rounded-full bg-fg/10" />
                        </template>
                        <span v-else class="ml-2 flex min-w-0 flex-1 flex-col gap-1.5 pr-3">
                            <span
                                class="h-3 rounded-full bg-fg/10"
                                :style="{ width: `${92 - n * 12}%` }"
                            />
                            <span class="h-2.5 w-16 rounded-full bg-fg/10" />
                        </span>
                    </div>
                </div>
                <div
                    v-else-if="tail.kind === 'empty'"
                    class="absolute inset-x-1.5 flex items-center justify-center px-3 text-center text-sm text-fg/80"
                    :style="{ top: `${geometry.total}px`, height: `${MESSAGE}px` }"
                    data-history-empty
                >
                    <span v-if="historyFilter === 'here'" class="flex flex-col gap-1">
                        <span>{{ i18n.history.noEditsHere }}</span>
                        <span v-if="here.unreadable" class="text-xs" data-history-not-checked>{{
                            notCheckedText
                        }}</span>
                    </span>
                    <template v-else>{{
                        historyFilter === 'saves' ? i18n.history.noSaves : i18n.history.empty
                    }}</template>
                </div>
                <!-- Edits Here's scan: a passive status row while it runs, then what it left out. -->
                <div
                    v-else-if="tail.kind === 'checking' || tail.kind === 'notChecked'"
                    class="absolute inset-x-1.5 flex items-center px-0.5 text-xs text-fg/80"
                    :style="{ top: `${geometry.total}px`, height: `${rowHeight}px` }"
                    role="status"
                    data-history-scan
                    :data-scan="tail.kind"
                >
                    <span
                        class="flex size-9 shrink-0 items-center justify-center"
                        aria-hidden="true"
                        ><span
                            v-if="tail.kind === 'checking'"
                            class="size-3.5 animate-spin rounded-full border-2 border-fg/25 border-t-fg"
                    /></span>
                    <span class="min-w-0 truncate pl-2">{{
                        tail.kind === 'checking' ? i18n.history.checking : notCheckedText
                    }}</span>
                </div>
                <div
                    v-else-if="tail.kind === 'failed'"
                    class="absolute inset-x-1.5 flex flex-col items-center justify-center gap-3 px-3 text-center text-sm text-fg/80"
                    :style="{ top: `${geometry.total}px`, height: `${FAILED}px` }"
                    data-history-failed
                >
                    <span>{{ i18n.history.loadFailed }}</span>
                    <button
                        type="button"
                        class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                        @click="retry"
                    >
                        {{ i18n.history.tryAgain }}
                    </button>
                </div>
                <div
                    v-else-if="tail.kind === 'more'"
                    class="absolute inset-x-1.5 flex items-center justify-center"
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
            class="pointer-events-none absolute inset-x-0 top-0 z-10 bg-modal shadow-band"
            aria-hidden="true"
            data-history-pinned
        >
            <div
                class="flex items-end truncate pb-1 pl-[3.25rem] pr-3 text-xs"
                :class="headerClass(pinned)"
                :style="{ height: `${HEADER}px` }"
            >
                <span class="truncate">{{ pinnedText(pinned) }}</span>
            </div>
        </div>
        <OverlayScrollbar :target="list" />
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
/*
 * One grid for every row kind (list x): the row pill 6..W-6; one leading slot 8..44, centre 26, with
 * one mark per row (the Now dot, a kind glyph, a group's disclosure, a member's rail); the text pill
 * 40..W-8 with 12 px inside, so every title starts at 52 and every time ends at W-20.
 * Rows keep their fixed 44 / 80 px slots for the window; the visible pill is the row's ::before, 2 px
 * in top and bottom, so neighbouring pills sit 4 px apart, as manager rows do.
 */
.timeline-row {
    @apply absolute inset-x-1.5 select-none text-sm;
    isolation: isolate;
    /* Focus shows on the pill, below, not on the slot. */
    outline: none;
}

.timeline-row::before {
    content: '';
    @apply pointer-events-none absolute inset-x-0 inset-y-0.5 -z-10 rounded-[1.25rem] transition-[background-color,box-shadow];
    outline: 2px solid transparent;
    outline-offset: -2px;
}

/* The current row is the raised pill (row-current's tokens on the pseudo-element). Its shadow barely
   shows in dark, so there a 1 px edge tells it from a hovered row. */
.timeline-row-selected::before {
    @apply bg-button shadow-md;
}

:root[data-theme='dark'] .timeline-row-selected::before {
    @apply ring-1 ring-inset ring-fg/25;
}

/* Not while pressed, so the press shows as on every other control. */
@media (hover: hover) and (pointer: fine) {
    .timeline-row:not(.timeline-row-selected):not(.timeline-row-disabled):not(
            :active
        ):hover::before {
        @apply bg-button/70;
    }
}

/* A plain row is one control, so its press fills the row pill: the raised pill's press tone, sunk,
   which differs from the current pill in dark too (a ghost press there matches it, 1.09:1). */
.timeline-row-plain:active::before {
    @apply bg-press shadow-pressed;
}

.timeline-row-plain:active {
    @apply text-fg-strong;
}

/* Row focus rings the pill at its edge in fg (focus-edge, drawn on the pill). */
.timeline-row:focus-visible::before {
    outline-color: rgb(var(--color-fg));
}

.timeline-entry-header,
.timeline-now {
    @apply flex h-11 items-center px-0.5;
}

/* Passive marks are muted; the disclosure, a control, is not. */
.timeline-leading {
    @apply flex size-9 shrink-0 items-center justify-center text-fg/70;
}

.timeline-main {
    @apply flex min-w-0 flex-1;
}

/* The text pill reaches 4 px under the slot, so its faces are balanced 12 / 12 around the text. Its
   18 px radius is the row pill's 20 less its 2 px inset, so the two stay concentric. */
.timeline-entry-text {
    @apply -ml-1 flex h-9 min-w-0 flex-1 flex-col justify-center rounded-[1.125rem] px-3 text-left transition-colors;
    outline: 2px solid transparent;
    outline-offset: -2px;
}

/* Two lines: the face takes the row pill's 40 px, so its rounded ends clear both lines. The title's
   line is 18 px and the text sits 2 px above the face's foot, so the ring clears ascenders and
   descenders by 2 px or more in every script measured (Latin, French, Japanese). */
.timeline-two-line .timeline-entry-text {
    @apply -my-0.5 h-10 pb-0.5;
}

/* The Now row is one line: its text stays centred on its dot, with no foot padding. */
.timeline-two-line .timeline-now .timeline-entry-text {
    @apply pb-0;
}

.timeline-two-line [data-history-group-action] {
    @apply leading-[1.125rem];
}

/* A group's main cell presses its text pill, in the same tone; its disclosure presses its own circle. */
.timeline-row-group:not(.timeline-row-disabled) .timeline-main:active .timeline-entry-text {
    @apply bg-press text-fg-strong shadow-pressed;
}

/* Cell focus rings the text pill at its edge (the row exception), the unavailable row's Details
   button too, which is that pill; the cell element itself draws nothing. */
.timeline-entry-header[data-history-part],
.timeline-main[data-history-part],
.timeline-now [data-history-part] {
    outline: none;
}

[data-history-part='main']:focus-visible .timeline-entry-text,
.timeline-entry-text[data-history-part='main']:focus-visible {
    outline-color: rgb(var(--color-fg));
    outline-offset: -2px;
}

.timeline-entry-caption {
    @apply flex gap-2 whitespace-nowrap text-xs leading-4 text-fg/80;
}

.timeline-group-count {
    @apply min-w-0 truncate empty:hidden;
}

.timeline-time,
.timeline-count {
    @apply shrink-0 tabular-nums;
}

/* One line: the mark, title, count, delta and time share a centre line. The title gives way; the
   count, the delta and the time never shrink. */
.timeline-one-line .timeline-entry-header .timeline-entry-text {
    @apply flex-row items-center justify-start gap-2;
}

.timeline-one-line [data-history-group-action] {
    @apply min-w-0 flex-auto;
}

.timeline-one-line .timeline-entry-caption {
    display: contents;
}

.timeline-one-line .timeline-group-count {
    @apply shrink-0 text-right;
}

/* A member's rail: its slot's mark, from under the parent's disclosure to the run's end, beneath
   the pills, so a hover shows it faintly; the current member shows a short stretch on its pill. */
.timeline-row-child::after {
    content: '';
    @apply pointer-events-none absolute inset-y-0 left-[1.1875rem] -z-20 w-0.5 bg-fg/30;
}

.timeline-row-first::after {
    @apply top-1 rounded-t-full;
}

.timeline-row-last::after {
    @apply bottom-1 rounded-b-full;
}

.timeline-row-child.timeline-row-selected::after {
    @apply inset-y-2 z-0 rounded-full;
}

/* Unavailable: the marks and text fade; the reason, the disclosure’s face and every focus ring stay strong. */
.timeline-row-disabled
    :is(
        .timeline-leading,
        .timeline-disclosure > svg,
        [data-history-group-action],
        .timeline-entry-caption > span
    ) {
    @apply opacity-60;
}

.timeline-row-disabled.timeline-row-child::after {
    @apply opacity-60;
}

.timeline-row-disabled .timeline-flag {
    @apply text-fg/80;
}

/* 14 px lines, so a reason that wraps to two lines clears the row's ring at the 80 px row's foot. */
.timeline-entry-reason.timeline-flag {
    @apply h-8 items-start pl-[2.875rem] pr-3 leading-[0.875rem];
}

.timeline-flag {
    @apply flex min-w-0 items-center gap-1 text-xs;
}

/* On the reason's x-height, not the top of its line. */
.timeline-flag > svg {
    @apply mt-px;
}

/* Headers and dividers: labels on the text edge (52), rules from the glyph ink (18) to the time edge (W-20). */
.timeline-divider {
    @apply absolute inset-x-1.5 flex select-none px-3 text-xs;
}

.timeline-header {
    @apply pl-[2.875rem];
}

.timeline-continuation {
    @apply pr-3.5;
}

.timeline-rule {
    @apply h-px min-w-3 flex-1 bg-fg/25;
}

@media (forced-colors: active) {
    .timeline-row-selected {
        outline: 2px solid Highlight;
        outline-offset: -4px;
    }
    .timeline-row-disabled {
        color: GrayText;
    }
    .timeline-row-disabled
        :is(
            .timeline-leading,
            .timeline-disclosure > svg,
            [data-history-group-action],
            .timeline-entry-caption > span
        ) {
        opacity: 1;
    }
}
</style>
