<script lang="ts">
// One bubble is open at a time: opening one closes the other.
let closeOpen: (() => void) | undefined
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
import { vScrollEdges } from '../../directives/scrollEdges'
import InfoIcon from '../../editor/history/InfoIcon.vue'
import { dockKeysAttribute, isInWorkspaceDock, takesDockKeys } from '../../editor/workspace'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import { swallowPress } from '../../utils/swallowPress'
import { choiceLine, type FieldDescription } from './fieldDescription'
import { CLOSE_DELAY_MS, OPEN_DELAY_MS } from './infoBubble'

// The ⓘ after a setting's or property's label: hover or focus shows its description after a moment,
// and a click, tap, Enter or Space pins it. The bubble goes under the field, or above it when there
// is no room below, and scrolls inside when it fits neither side.

defineProps<{
    label: string
    description: FieldDescription
    /** The id of the description's text for screen readers. */
    describedBy: string
}>()

const GAP = 4
const MARGIN = 8

const button = useTemplateRef<HTMLButtonElement>('button')
const bubble = useTemplateRef<HTMLDivElement>('bubble')
const scroller = useTemplateRef<HTMLDivElement>('scroller')
const bubbleId = useId()
const buttonId = useId()

/** Shown by hover or focus, or pinned by a press. */
const state = ref<'closed' | 'shown' | 'pinned'>('closed')
const placement = ref<{ left: number; top: number; maxHeight?: number }>()
// The field the bubble is placed against: the label and its control, a stacked control included.
const field = () => button.value?.closest<HTMLElement>('.form-field')
const container = computed(() => button.value?.closest('dialog') ?? 'body')
// The bubble sits outside any dock, so it is marked for its keys to reach no shortcut, as in a
// dock. A tool dialog stops shortcuts only in its fields, so its button is marked too.
const inToolDialog = ref(false)
const bubbleKeys = ref(false)
onMounted(() => {
    inToolDialog.value = !!button.value?.closest('[data-tool-dialog]')
    bubbleKeys.value = inToolDialog.value || takesDockKeys(button.value)
})

let timer: ReturnType<typeof setTimeout> | undefined
const stopTimer = () => {
    clearTimeout(timer)
    timer = undefined
}
const later = (ms: number, run: () => void) => {
    stopTimer()
    timer = setTimeout(run, ms)
}

const close = () => {
    stopTimer()
    if (state.value === 'closed') return
    // Focus in the bubble goes back to the button, so it never falls to the page. It moves while
    // the bubble is open, so the focus does not show the bubble again.
    if (bubble.value?.contains(document.activeElement)) button.value?.focus({ preventScroll: true })
    state.value = 'closed'
    placement.value = undefined
    if (closeOpen === close) closeOpen = undefined
}

const show = (how: 'shown' | 'pinned') => {
    stopTimer()
    if (closeOpen !== close) closeOpen?.()
    closeOpen = close
    state.value = how
}

// The visible part of the layout viewport, which fixed boxes are placed in.
const visibleArea = () => {
    const viewport = window.visualViewport
    const width = document.documentElement.clientWidth
    const height = window.innerHeight
    return viewport
        ? {
              left: viewport.offsetLeft,
              top: viewport.offsetTop,
              right: viewport.offsetLeft + viewport.width,
              bottom: viewport.offsetTop + viewport.height,
          }
        : { left: 0, top: 0, right: width, bottom: height }
}

// One measurement on opening and when the visual viewport changes size, never per frame.
const place = () => {
    const element = bubble.value
    const box = field()?.getBoundingClientRect()
    if (!element || !box) return
    const area = visibleArea()
    const width = element.offsetWidth
    const height = scroller.value?.scrollHeight ?? element.scrollHeight
    const below = area.bottom - MARGIN - (box.bottom + GAP)
    const above = box.top - GAP - (area.top + MARGIN)
    let top: number
    let maxHeight: number | undefined
    if (height <= below) top = box.bottom + GAP
    else if (height <= above) top = box.top - GAP - height
    else if (above > below) {
        maxHeight = Math.max(0, above)
        top = area.top + MARGIN
    } else {
        maxHeight = Math.max(0, below)
        top = box.bottom + GAP
    }
    placement.value = {
        left: Math.max(area.left + MARGIN, Math.min(box.left, area.right - MARGIN - width)),
        top,
        maxHeight,
    }
}

const inside = (target: EventTarget | null) =>
    target instanceof Node && (!!button.value?.contains(target) || !!bubble.value?.contains(target))

// --- The button.
const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    if (state.value === 'closed')
        later(OPEN_DELAY_MS, () => {
            show('shown')
        })
    else stopTimer()
}

const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    if (state.value === 'closed') stopTimer()
    else if (state.value === 'shown') later(CLOSE_DELAY_MS, close)
}

const onFocus = () => {
    if (state.value === 'closed' && button.value?.matches(':focus-visible'))
        later(OPEN_DELAY_MS, () => {
            show('shown')
        })
}

const onFocusOut = (event: FocusEvent) => {
    if (inside(event.relatedTarget)) return
    close()
}

const onClick = () => {
    if (state.value === 'pinned') close()
    else show('pinned')
}

// Scroll keys scroll a bubble that overflows, while focus stays on the button.
const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']
const onKeydown = (event: KeyboardEvent) => {
    const element = scroller.value
    if (state.value === 'closed' || !element || !SCROLL_KEYS.includes(event.key)) return
    if (element.scrollHeight <= element.clientHeight) return
    event.preventDefault()
    const page = element.clientHeight * 0.9
    const line = 40
    const top = {
        ArrowUp: element.scrollTop - line,
        ArrowDown: element.scrollTop + line,
        PageUp: element.scrollTop - page,
        PageDown: element.scrollTop + page,
        Home: 0,
        End: element.scrollHeight,
    }[event.key]
    element.scrollTo({ top })
}

// --- The bubble.
const onBubbleEnter = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && state.value === 'shown') stopTimer()
}

const onBubbleLeave = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && state.value === 'shown') later(CLOSE_DELAY_MS, close)
}

// --- Closing from outside.
const onOutside = (event: PointerEvent) => {
    if (inside(event.target)) return
    // A press over the chart that closes a pinned bubble only closes it, so it edits nothing. In a
    // dock or a dialog the press continues, so a drag on the list still scrolls it.
    const target = event.target instanceof Element ? event.target : null
    if (
        state.value === 'pinned' &&
        !isInWorkspaceDock(target) &&
        !target?.closest('dialog, [data-tool-dialog]')
    )
        swallowPress(event)
    close()
}

const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    // The bubble closes, and the dialog under it stays.
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
}

const onScroll = (event: Event) => {
    if (event.target !== scroller.value) close()
}

let width = 0
const onViewportResize = () => {
    if (document.documentElement.clientWidth !== width) close()
    else place()
}

const listen = (on: boolean) => {
    if (on) {
        window.addEventListener('pointerdown', onOutside, true)
        window.addEventListener('keydown', onEscape, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onViewportResize)
        window.addEventListener('blur', close)
        window.visualViewport?.addEventListener('resize', onViewportResize)
    } else {
        window.removeEventListener('pointerdown', onOutside, true)
        window.removeEventListener('keydown', onEscape, true)
        window.removeEventListener('scroll', onScroll, true)
        window.removeEventListener('resize', onViewportResize)
        window.removeEventListener('blur', close)
        window.visualViewport?.removeEventListener('resize', onViewportResize)
    }
}

watch(state, async (now, before) => {
    if ((now === 'closed') === (before === 'closed')) return
    listen(now !== 'closed')
    if (now === 'closed') return
    width = document.documentElement.clientWidth
    await nextTick()
    place()
})

onBeforeUnmount(() => {
    close()
    listen(false)
})
</script>

<template>
    <!-- Its 44 px target is in flow, as a chip's is, so the controls and chips after it keep their own. -->
    <button
        :id="buttonId"
        ref="button"
        type="button"
        class="ghost focus-out holds-open ghost-dim ml-1 grid size-6 shrink-0 place-items-center rounded-full before:-m-2.5 before:place-self-stretch before:[grid-area:1/1]"
        data-field-info
        :[dockKeysAttribute]="inToolDialog ? '' : undefined"
        :aria-label="interpolateRaw(i18n.modals.form.about, label)"
        :aria-expanded="state !== 'closed'"
        :aria-controls="bubbleId"
        :aria-describedby="describedBy"
        @pointerenter="onPointerEnter"
        @pointerleave="onPointerLeave"
        @focus="onFocus"
        @focusout="onFocusOut"
        @click="onClick"
        @keydown="onKeydown"
    >
        <InfoIcon class="size-4 fill-current [grid-area:1/1]" />
    </button>
    <Teleport v-if="state !== 'closed'" :to="container">
        <div
            :id="bubbleId"
            ref="bubble"
            class="popup-surface fixed z-50 max-w-[min(20rem,calc(100vw-1rem))]"
            :class="{ invisible: !placement }"
            :style="{
                left: `${placement?.left ?? 0}px`,
                top: `${placement?.top ?? 0}px`,
                maxHeight: placement?.maxHeight === undefined ? '' : `${placement.maxHeight}px`,
            }"
            :data-field-info-bubble="buttonId"
            :[dockKeysAttribute]="bubbleKeys ? '' : undefined"
            @pointerenter="onBubbleEnter"
            @pointerleave="onBubbleLeave"
            @focusout="onFocusOut"
        >
            <div
                ref="scroller"
                v-scroll-edges
                tabindex="-1"
                class="min-h-0 select-text overflow-y-auto overscroll-contain px-3 py-2 outline-none [touch-action:pan-y]"
            >
                <template v-if="typeof description === 'string'">{{ description }}</template>
                <template v-else>
                    <p v-if="description.intro" class="mb-2">{{ description.intro }}</p>
                    <ul class="flex flex-col gap-1">
                        <li v-for="(line, index) in description.lines" :key="index">
                            <span class="font-semibold">{{ choiceLine(line.name) }}</span
                            >{{ line.text }}
                        </li>
                    </ul>
                </template>
            </div>
        </div>
    </Teleport>
</template>
