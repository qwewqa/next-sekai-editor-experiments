<script lang="ts">
import type { CommandName as Name } from '../commands'

// Each pane and layout's shown members, kept while a tool dialog hides the toolbar.
const shownByLayout = new Map<string, Name[]>()
// Each pane and layout's faces a tool in use displaced until it ends, groups with a tool in use,
// and faces a right press's tool displaced until its release.
type Temporary = {
    displaced: (Name | undefined)[]
    inUse: boolean[]
    returning: (Name | undefined)[]
}
const temporaryByLayout = new Map<string, Temporary>()
const layoutOf = (toolbar: Name[][]) => toolbar.map((group) => group.join(',')).join('|')
</script>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    useId,
    useTemplateRef,
    watch,
} from 'vue'
import { modals } from '../../modals'
import { settings } from '../../settings'
import { commands, type CommandName } from '../commands'
import { flyoutEscapes } from '../controls'
import { repeatsWhenHeld } from '../controls/keyboard'
import { secondarySwitchBack } from '../controls/mouse'
import { isDragging } from '../controls/gestures/recognizers/drag'
import { isCoarsePointer } from '../workspace'
import type { ToolModalPane } from '../toolModals'
import { vScrollEdges } from '../../directives/scrollEdges'
import { blurPointerClick } from '../../utils/blurPointerClick'
import LevelEditorToolbarTool from './LevelEditorToolbarTool.vue'
import {
    maxCoarseToolSize,
    maxShortCoarseToolSize,
    minToolSize,
    shortPaneHeight,
    toolbarGroups,
    toolbarPadding,
} from './layout'
import { commandState, isCommandPressed } from './pressed'

const props = defineProps<{ pane: ToolModalPane; available?: CommandName[] }>()

const toolbar = computed<CommandName[][]>(() => toolbarGroups(settings.toolbar, props.available))
const keyOf = (toolbar: CommandName[][]) => `${props.pane}:${layoutOf(toolbar)}`

const isPressed = (name: CommandName, index: number) =>
    isCommandPressed(name, toolbar.value[index] ?? [])
const stateOf = (name: CommandName, index: number) => commandState(name, toolbar.value[index] ?? [])
// A flyout with values gives every row the check column, so labels line up.
const hasValues = (index: number) =>
    toolbar.value[index]?.some((name) => stateOf(name, index)?.kind === 'value') ?? false

const hasToolInUse = (index: number) =>
    toolbar.value[index]?.some((name) => {
        const state = stateOf(name, index)
        return state?.kind === 'tool' && state.current
    }) ?? false

const activeNames = ref<CommandName[]>([])
let temporary: Temporary = { displaced: [], inUse: [], returning: [] }

watch(
    toolbar,
    (toolbar, previous) => {
        const layout = layoutOf(toolbar)
        if (previous && layoutOf(previous) === layout) return
        // A remount keeps the members shown before; a new layout starts from the defaults.
        const kept = previous ? undefined : shownByLayout.get(keyOf(toolbar))
        activeNames.value = toolbar.map(
            (commands, index) => kept?.[index] ?? commands[commands.length - 1] ?? 'select',
        )
        // A group with a tool in use keeps a face it displaced before the change.
        const before = previous ? temporary.displaced.filter((name) => name !== undefined) : []
        temporary = (previous ? undefined : temporaryByLayout.get(keyOf(toolbar))) ?? {
            displaced: toolbar.map((group, index) =>
                hasToolInUse(index) ? before.find((name) => group.includes(name)) : undefined,
            ),
            inUse: [],
            returning: [],
        }
        temporaryByLayout.set(keyOf(toolbar), temporary)
    },
    { immediate: true },
)
watch(activeNames, (names) => shownByLayout.set(keyOf(toolbar.value), [...names]), {
    deep: true,
    immediate: true,
})

// Values move a face only in a group whose states are all of one value family.
const followsValues = (index: number) => {
    const states = (toolbar.value[index] ?? []).flatMap((name) => stateOf(name, index) ?? [])
    const families = new Set(states.map((state) => state.kind === 'value' && state.family))
    return families.size === 1 && !families.has(false)
}

// A group shows its tool in use, else its value in use where values move it, nearest its default.
watch(
    [
        () => toolbar.value.map((group) => group.filter((name) => isCommandPressed(name, group))),
        () => !!secondarySwitchBack.value,
    ],
    ([pressed, switched]) => {
        for (const [index, names] of pressed.entries()) {
            const tools = names.filter((name) => stateOf(name, index)?.kind === 'tool')
            const { displaced, inUse, returning } = temporary
            const wasInUse = inUse[index]
            inUse[index] = tools.length > 0
            const restored = displaced[index]
            if (!tools.length && restored) {
                displaced[index] = undefined
                returning[index] = undefined
                activeNames.value[index] = restored
                continue
            }
            // A right press's release returns the face it displaced, unless another tool took it.
            const back = returning[index]
            if (back && !switched) {
                returning[index] = undefined
                if (!tools.length || tools.includes(back)) {
                    activeNames.value[index] = back
                    continue
                }
            }
            // A group with a tool never follows values.
            const candidates = followsValues(index) ? names : tools
            const shown = activeNames.value[index]
            const name = candidates[candidates.length - 1]
            if (!name || !shown || candidates.includes(shown)) continue
            // A right press's tool shows over any face until its release.
            if (switched && inUse[index]) returning[index] ??= shown
            // A tool coming into use over an action or value shows until it ends.
            else if (inUse[index] && wasInUse === false && stateOf(shown, index)?.kind !== 'tool')
                displaced[index] = shown
            activeNames.value[index] = name
        }
    },
    { immediate: true },
)

const activeIndex = ref(-1)
const flyoutId = useId()
// A flyout belongs to a group, so a new layout closes it.
watch(
    () => layoutOf(toolbar.value),
    () => (activeIndex.value = -1),
)

/** A group's main tool discloses its flyout, if it has other members. */
const flyoutAttributes = (index: number) =>
    (toolbar.value[index]?.length ?? 0) > 1
        ? {
              'aria-expanded': activeIndex.value === index ? 'true' : 'false',
              'aria-controls': activeIndex.value === index ? flyoutId : undefined,
          }
        : {}

// Sizes and rows follow ./layout, which side docks' defaults leave room for.
const root = useTemplateRef<HTMLDivElement>('root')
const room = ref(0)
const short = ref(false)
const height = ref(0)
const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
        if (entry.target === root.value) {
            room.value = entry.contentRect.width
            height.value = entry.contentRect.height
            short.value = entry.contentRect.height < shortPaneHeight
        } else if (
            entry.target === observedFlyout &&
            Math.abs((entry.borderBoxSize[0]?.inlineSize ?? placedWidth) - placedWidth) > 0.5
        )
            // A flyout whose own width changes, as on a language switch, re-centres on its tool.
            void follow()
    }
})
watch(root, (element, previous) => {
    if (previous) observer.unobserve(previous)
    if (element) observer.observe(element)
})
onBeforeUnmount(() => {
    observer.disconnect()
})
const toolRows = computed(() => {
    const count = activeNames.value.length
    // Until measured, wrap freely at the smallest size.
    if (!room.value) return { perRow: count, size: minToolSize }
    const rows = Math.ceil(count / Math.max(1, Math.floor(room.value / minToolSize)))
    const perRow = Math.ceil(count / Math.max(1, rows))
    const size = isCoarsePointer.value
        ? Math.max(
              minToolSize,
              Math.min(
                  short.value ? maxShortCoarseToolSize : maxCoarseToolSize,
                  Math.floor(room.value / perRow),
              ),
          )
        : minToolSize
    return { perRow, size }
})

// Opening on movement rather than pointerover keeps a group closed when docks
// open or resize and move the toolbar under a resting pointer. A drag passing over opens nothing.
const onOverMain = (event: PointerEvent, index: number) => {
    if (event.pointerType !== 'mouse' || event.buttons || activeIndex.value === index) return

    activeIndex.value = index
}

const onClickMain = (event: MouseEvent, index: number, name: CommandName) => {
    // Pointer clicks return shortcuts to the editor, so Space cannot click the tool again.
    blurPointerClick(event)
    if (activeIndex.value === -1 && toolbar.value[index] && toolbar.value[index].length > 1) {
        activeIndex.value = index
        return
    }

    void commands[name].execute()

    activeIndex.value = -1
}

const onClickSub = (event: MouseEvent, index: number, name: CommandName) => {
    blurPointerClick(event)
    // The flyout closes under a keyboard choice, so focus returns to its tool first.
    if (event.detail === 0) groups.value[index]?.querySelector('button')?.focus()
    const done = commands[name].execute()

    activeIndex.value = -1
    // A toggle takes the face once in use; one a dialog cancels leaves it on the one in use.
    const show = () => {
        if (isPressed(name, index) === false || !toolbar.value[index]?.includes(name)) return
        // Over a temporary face, a picked tool holds the face; anything else is where it returns.
        const { displaced } = temporary
        if (displaced[index])
            displaced[index] = stateOf(name, index)?.kind === 'tool' ? undefined : name
        // A value leaves the face to a tool in use.
        if (stateOf(name, index)?.kind === 'value' && hasToolInUse(index)) return
        activeNames.value[index] = name
    }
    if (isPressed(name, index) === false) void Promise.resolve(done).then(show)
    else show()
}

// A held key repeats only a command that repeats when held, and never opens a flyout.
const onKeydownRepeat = (event: KeyboardEvent, name: CommandName, opens = false) => {
    if (!event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return
    if (opens || !repeatsWhenHeld.has(name)) event.preventDefault()
}

// The group whose cell holds the pointer, or -1; cells tile, each owning its left and top edges.
const groupAt = ({ clientX: x, clientY: y }: PointerEvent) =>
    activeNames.value.findIndex((_, index) => {
        const cell = groups.value[index]?.getBoundingClientRect()
        return !!cell && cell.left <= x && x < cell.right && cell.top <= y && y < cell.bottom
    })

// Tools under the backdrop take no input; moving onto one opens it at once, and off all closes.
// Only free movement counts: the backdrop appearing under a resting pointer leaves a keyboard-opened flyout.
const onMoveBackdrop = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || inPlace || event.buttons) return

    activeIndex.value = groupAt(event)
}

// Moving straight off the pane from the open tool or its flyout closes it too. Only movement
// counts: WebKit also sends a move in place when content scrolls under a resting pointer.
const backdrop = useTemplateRef<HTMLDivElement>('backdrop')
let lastMove: { x: number; y: number } | undefined
let inPlace = false
const onMoveOutside = (event: PointerEvent) => {
    const press = presses.get(event.pointerId)
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > pressJitter)
        endPress(event)
    if (event.pointerType !== 'mouse') return
    inPlace = lastMove?.x === event.clientX && lastMove.y === event.clientY
    lastMove = { x: event.clientX, y: event.clientY }
    const target = event.target
    if (inPlace || activeIndex.value === -1 || !(target instanceof Node)) return
    if (root.value?.contains(target) || backdrop.value?.contains(target)) return
    activeIndex.value = -1
}
// A drag that starts anywhere but the open flyout and its tools closes it, by any pointer;
// so does a touch the browser takes over to scroll. Each pointer's press counts for one flyout.
const pressJitter = 10
const presses = new Map<number, { x: number; y: number }>()
const onPressOutside = (event: PointerEvent) => {
    const target = event.target
    if (activeIndex.value !== -1 && target instanceof Node && !root.value?.contains(target))
        presses.set(event.pointerId, { x: event.clientX, y: event.clientY })
    else presses.delete(event.pointerId)
}
const endPress = (event: PointerEvent) => {
    if (!presses.delete(event.pointerId)) return
    if (event.type !== 'pointerup') activeIndex.value = -1
}
watch(
    activeIndex,
    () => {
        presses.clear()
    },
    { flush: 'sync' },
)
// Capturing, as resize handles stop moves from bubbling; it runs before the backdrop’s handler.
const listeners = [
    ['pointermove', onMoveOutside],
    ['pointerdown', onPressOutside],
    ['pointerup', endPress],
    ['pointercancel', endPress],
] as const
for (const [type, listener] of listeners)
    window.addEventListener(type, listener, { capture: true, passive: true })
onBeforeUnmount(() => {
    for (const [type, listener] of listeners)
        window.removeEventListener(type, listener, { capture: true })
})

// A flyout rises from its tool's top edge, centered on the tool and kept 8px
// inside the pane, so it stays attached to the tool that opened it and is never
// clipped at either edge.
const flyoutMargin = 8
const groups = ref<HTMLElement[]>([])
// Found by id: switching groups mounts one flyout and unmounts another in either order.
const openFlyout = () => document.getElementById(flyoutId) ?? undefined
const placement = ref<{ left: number; bottom: number; maxHeight: number }>()
let placedWidth = 0

const place = () => {
    const group = groups.value[activeIndex.value]
    const element = openFlyout()
    if (!root.value || !group || !element) return
    const pane = root.value.getBoundingClientRect()
    const tool = group.getBoundingClientRect()
    const width = element.getBoundingClientRect().width
    placedWidth = width
    const center = tool.left + tool.width / 2 - pane.left
    placement.value = {
        left: Math.max(
            flyoutMargin,
            Math.min(center - width / 2, pane.width - flyoutMargin - width),
        ),
        bottom: pane.bottom - tool.top,
        maxHeight: Math.max(0, tool.top - pane.top - flyoutMargin),
    }
}

// A flyout opens with its checked value centred, without moving focus; later, only a clipped one moves.
const revealChecked = (ifClipped = false) => {
    const flyout = openFlyout()
    const row = flyout?.querySelector('[data-value-check]')?.closest('button')
    if (!flyout || !row) return
    const shown =
        row.offsetTop >= flyout.scrollTop &&
        row.offsetTop + row.offsetHeight <= flyout.scrollTop + flyout.clientHeight
    if (ifClipped && shown) return
    const top = row.offsetTop - (flyout.clientHeight - row.offsetHeight) / 2
    flyout.scrollTo({ top, behavior: 'instant' })
}

// Re-placed as its own width changes too.
let observedFlyout: HTMLElement | undefined
const observeFlyout = () => {
    const flyout = openFlyout()
    if (flyout === observedFlyout) return
    if (observedFlyout) observer.unobserve(observedFlyout)
    observedFlyout = flyout
    if (flyout) observer.observe(flyout)
}

const follow = async () => {
    place()
    await nextTick()
    revealChecked(true)
}

watch(activeIndex, async () => {
    placement.value = undefined
    await nextTick()
    observeFlyout()
    if (activeIndex.value === -1) return
    place()
    await nextTick()
    revealChecked()
})
// After the rows rewrap, so the flyout follows its tool.
watch([room, short, height, isCoarsePointer], async () => {
    await nextTick()
    await follow()
})

// Escape closes an open flyout and returns focus to its tool.
const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || activeIndex.value === -1) return
    // Escape stays with a focused field, row or dialog; a hovered flyout just closes.
    const active = document.activeElement
    if (
        event.defaultPrevented ||
        modals.length ||
        (active !== document.body &&
            !root.value?.contains(active) &&
            !active?.matches('.chart-pane'))
    ) {
        activeIndex.value = -1
        return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    const group = groups.value[activeIndex.value]
    activeIndex.value = -1
    group?.querySelector('button')?.focus()
}

onMounted(() => {
    flyoutEscapes.add(onKeydown)
})
onBeforeUnmount(() => {
    flyoutEscapes.delete(onKeydown)
})
</script>

<template>
    <!-- The bottom inset clears the time labels in the canvas corners. -->
    <div
        v-show="!isDragging"
        ref="root"
        data-editor-toolbar
        class="pointer-events-none absolute flex size-full items-end justify-center pb-6"
        :style="{
            paddingInline: toolbarPadding(isCoarsePointer),
            '--tool-size': `${toolRows.size}px`,
        }"
    >
        <div
            class="flex flex-wrap justify-center"
            :style="{ maxWidth: `${toolRows.perRow * toolRows.size}px` }"
        >
            <div
                v-for="(activeName, i) in activeNames"
                :key="i"
                :ref="(element) => element && (groups[i] = element as HTMLElement)"
                class="pointer-events-auto"
                :class="{ 'z-20': activeIndex === i }"
                :inert="activeIndex !== -1 && activeIndex !== i"
            >
                <!-- A square pseudo-element, centred in place, takes input in the corners; the face stays unpositioned. -->
                <LevelEditorToolbarTool
                    class="size-[--tool-size] justify-center before:absolute before:size-[--tool-size]"
                    :name="activeName"
                    :state="stateOf(activeName, i)"
                    v-bind="flyoutAttributes(i)"
                    @pointermove="onOverMain($event, i)"
                    @click="onClickMain($event, i, activeName)"
                    @keydown="onKeydownRepeat($event, activeName, (toolbar[i]?.length ?? 0) > 1)"
                />

                <div
                    v-if="activeIndex === i"
                    :id="flyoutId"
                    v-scroll-edges
                    class="absolute w-max overflow-y-auto"
                    :class="{ invisible: !placement }"
                    :style="
                        placement && {
                            left: `${placement.left}px`,
                            bottom: `${placement.bottom}px`,
                            maxHeight: `${placement.maxHeight}px`,
                        }
                    "
                >
                    <!-- Rows split the gaps between them, and the last takes the one above its tool. -->
                    <LevelEditorToolbarTool
                        v-for="(name, j) in toolbar[i]"
                        :key="j"
                        class="relative mb-1 w-full before:absolute before:-inset-y-0.5 before:inset-x-0 last:before:-bottom-1"
                        :name
                        :state="stateOf(name, i)"
                        :check-column="hasValues(i)"
                        show-label
                        @click="onClickSub($event, i, name)"
                        @keydown="onKeydownRepeat($event, name)"
                    />
                </div>
            </div>
        </div>
    </div>

    <div
        v-if="activeIndex !== -1"
        ref="backdrop"
        class="absolute size-full bg-scrim/75"
        @pointermove="onMoveBackdrop"
        @click="activeIndex = -1"
    />
</template>
