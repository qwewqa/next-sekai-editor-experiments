<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId, useTemplateRef } from 'vue'
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import { swallowPress } from '../../utils/swallowPress'
import { workspaceDockAttribute } from '../workspace'
import type { Filter } from './rows'
import { historyFilter } from './state'

// The Go To popover (Part 1 §1.4.10.5): the Show switch, All or Saves and Exports, and under it the
// jump list. Under 640 px it is the menus' bottom sheet over a dimmed backdrop. The jump list
// (days, sessions and Now) goes in the default slot, which is empty until the long-history work.

const props = defineProps<{ anchor: HTMLElement }>()

const emit = defineEmits<{ close: [restoreFocus: boolean] }>()

const popover = useTemplateRef<HTMLDivElement>('popover')
const scroller = useTemplateRef<HTMLDivElement>('scroller')
const headingId = useId()

const filters: readonly Filter[] = ['all', 'saves']
const filterTitle = (filter: Filter) =>
    filter === 'all' ? i18n.value.history.filterAll : i18n.value.history.filterSaves

const margin = 8
const gap = 4
const placement = ref<{ left: number; top: number; maxHeight?: number }>()

// Below its button when it fits there, else on the roomier side, scrolling if it fits neither:
// opened from a sheet at the bottom of the window, it goes up.
const place = () => {
    const element = popover.value
    if (!element) return
    const anchor = props.anchor.getBoundingClientRect()
    const width = element.offsetWidth
    const height = scroller.value?.scrollHeight ?? element.scrollHeight
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = window.innerHeight
    const below = viewportHeight - anchor.bottom - gap - margin
    const above = anchor.top - gap - margin
    let top: number
    let maxHeight: number | undefined
    if (height <= below) top = anchor.bottom + gap
    else if (height <= above) top = anchor.top - gap - height
    else if (above > below) {
        maxHeight = above
        top = margin
    } else {
        maxHeight = below
        top = anchor.bottom + gap
    }
    placement.value = {
        left: Math.max(margin, Math.min(anchor.right - width, viewportWidth - margin - width)),
        top,
        maxHeight,
    }
}

const radios = () => [...(popover.value?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])]

let active = true

onMounted(async () => {
    await nextTick()
    place()
    // Hidden elements cannot take focus, so wait for the placed popover to show.
    await nextTick()
    if (!active) return
    radios()
        .find((radio) => radio.getAttribute('aria-checked') === 'true')
        ?.focus({
            preventScroll: true,
        })
    window.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('blur', onDismiss)
})

onUnmounted(() => {
    active = false
    window.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('resize', onDismiss)
    window.removeEventListener('blur', onDismiss)
})

const onDismiss = () => {
    emit('close', false)
}

const onOutside = (event: PointerEvent) => {
    const target = event.target
    if (!(target instanceof Node)) return
    // The button toggles the popover itself on click.
    if (popover.value?.contains(target) || props.anchor.contains(target)) return
    // The press only closes it, so closing never edits what lies under it.
    swallowPress(event)
    emit('close', false)
}

const pick = (filter: Filter) => {
    historyFilter.value = filter
}

const onKeydown = (event: KeyboardEvent) => {
    // An open popover holds chords from the browser, such as Ctrl+S saving the page.
    if ((event.ctrlKey || event.metaKey) && /^[a-z]$/i.test(event.key)) {
        event.preventDefault()
        return
    }
    if (event.key === 'Escape') {
        event.preventDefault()
        emit('close', true)
    } else if (event.key === 'Tab') {
        // Focus returns to the button first, so Tab continues from there.
        emit('close', true)
    } else if (event.target instanceof HTMLElement && event.target.matches('[role="radio"]')) {
        const at = filters.indexOf(historyFilter.value)
        const next = {
            ArrowLeft: at - 1,
            ArrowUp: at - 1,
            ArrowRight: at + 1,
            ArrowDown: at + 1,
            Home: 0,
            End: filters.length - 1,
        }[event.key]
        const filter =
            next === undefined ? undefined : filters[(next + filters.length) % filters.length]
        if (!filter) return
        event.preventDefault()
        pick(filter)
        void nextTick(() => radios()[filters.indexOf(filter)]?.focus())
    }
}
</script>

<template>
    <Teleport to="body">
        <div
            class="manager-menu-backdrop fixed inset-0 z-40 bg-black/30 sm:hidden"
            aria-hidden="true"
            @mousedown.prevent
        />
        <div
            ref="popover"
            :[workspaceDockAttribute]="'menu'"
            role="dialog"
            tabindex="-1"
            :aria-label="i18n.history.goTo"
            class="popup-surface popup-sheet fixed z-50 sm:w-72"
            :class="{ invisible: !placement }"
            :style="{
                left: `${placement?.left ?? 0}px`,
                top: `${placement?.top ?? 0}px`,
                maxHeight: placement?.maxHeight === undefined ? '' : `${placement.maxHeight}px`,
            }"
            data-history-goto
            @keydown.stop="onKeydown"
            @contextmenu.prevent
        >
            <div ref="scroller" v-scroll-edges class="popup-scroller">
                <div :id="headingId" class="popup-heading">{{ i18n.history.show }}</div>
                <div
                    role="radiogroup"
                    :aria-labelledby="headingId"
                    class="mx-2 mb-2 flex shrink-0 rounded-full bg-recess p-0.5 shadow-track"
                >
                    <button
                        v-for="filter in filters"
                        :key="filter"
                        type="button"
                        role="radio"
                        class="goto-segment flex h-7 min-w-0 flex-1 items-center justify-center rounded-full px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-10"
                        :class="{ 'bg-button shadow-md': historyFilter === filter }"
                        :aria-checked="historyFilter === filter"
                        :tabindex="historyFilter === filter ? 0 : -1"
                        @click="pick(filter)"
                    >
                        <span class="truncate">{{ filterTitle(filter) }}</span>
                    </button>
                </div>
                <!-- The jump list: Now, then days and the sessions in them. -->
                <slot />
            </div>
        </div>
    </Teleport>
</template>
