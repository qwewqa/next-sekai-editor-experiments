<script lang="ts">
// One bubble is open at a time: opening one closes the other.
let closeOpen: (() => void) | undefined
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { vScrollEdges } from '../../directives/scrollEdges'
import InfoIcon from '../../editor/history/InfoIcon.vue'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'

// The ⓘ after a setting's label: hover or focus shows its description after a moment, and a
// click, tap, Enter or Space pins it. The bubble goes under the field, or above it when there is
// no room below, and scrolls inside when it fits neither side.

defineProps<{
    label: string
    description: string
    /** The field's description for screen readers, which starts with this text. */
    describedBy: string
}>()

const OPEN_DELAY_MS = 400
const CLOSE_DELAY_MS = 150
const GAP = 4
const MARGIN = 8

const button = useTemplateRef<HTMLButtonElement>('button')
const bubble = useTemplateRef<HTMLDivElement>('bubble')
const scroller = useTemplateRef<HTMLDivElement>('scroller')
const bubbleId = useId()

/** Shown by hover or focus, or pinned by a press. */
const state = ref<'closed' | 'shown' | 'pinned'>('closed')
const placement = ref<{ left: number; top: number; maxHeight?: number }>()
// The field the bubble is placed against: the label and its control, a stacked control included.
const field = () => button.value?.closest<HTMLElement>('.form-field')
const container = computed(() => button.value?.closest('dialog') ?? 'body')

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
    // The press goes on: a drag on the list still scrolls it.
    if (!inside(event.target)) close()
}

const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    // The bubble closes, and the dialog under it stays.
    event.preventDefault()
    event.stopImmediatePropagation()
    // Focus goes back first, while the bubble is open, so the focus does not show it again.
    if (bubble.value?.contains(document.activeElement)) button.value?.focus()
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
    <button
        ref="button"
        type="button"
        class="ghost focus-out holds-open relative ml-1 flex size-6 shrink-0 items-center justify-center rounded-full text-fg/70 before:absolute before:-inset-2.5 hover:text-fg aria-expanded:text-fg"
        data-field-info
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
        <InfoIcon class="size-4 fill-current" />
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
            data-field-info-bubble
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
                {{ description }}
            </div>
        </div>
    </Teleport>
</template>
