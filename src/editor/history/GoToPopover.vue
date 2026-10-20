<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, useTemplateRef } from 'vue'
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import { swallowPress } from '../../utils/swallowPress'
import { workspaceDockAttribute } from '../workspace'
import CheckIcon from './CheckIcon.vue'
import { filterHere, hereRangeText, takeHereRange } from './editsHere'
import type { Filter } from './rows'
import { historyFilter } from './state'
import type { GoToView } from './presentation'

// The Go To popover (Part 1 §1.4.10.5): the Show list, All, Saves and Exports or Edits Here with
// the beats it would take, and under it the jump list, which the default slot holds. Under 640 px
// it is the menus' bottom sheet over a dimmed backdrop.

const props = defineProps<{ anchor: HTMLElement; restore?: GoToView }>()
const container = computed(() => props.anchor.closest('dialog') ?? 'body')

const emit = defineEmits<{ close: [restoreFocus: boolean] }>()

const popover = useTemplateRef<HTMLDivElement>('popover')
const scroller = useTemplateRef<HTMLDivElement>('scroller')
const headingId = useId()
let scrollRestored = false
const restoreScroll = () => {
    if (!props.restore || !scroller.value || scrollRestored) return
    scroller.value.scrollTop = props.restore.top
    scrollRestored = true
}
defineExpose({
    restoreScroll,
    captureView: () => ({
        top: scroller.value?.scrollTop ?? 0,
        focus:
            document.activeElement instanceof HTMLElement
                ? (document.activeElement.dataset.gotoFilter ??
                  (document.activeElement.hasAttribute('data-goto-list') ? 'list' : undefined))
                : undefined,
    }),
})

const filters: readonly Filter[] = ['all', 'saves', 'here']
const filterTitle = (filter: Filter) =>
    filter === 'all'
        ? i18n.value.history.filterAll
        : filter === 'saves'
          ? i18n.value.history.filterSaves
          : i18n.value.history.filterHere
// The beats Edits Here would take now, as choosing it takes them: it follows the view and the
// selection while the popover is open, so a pick names the range the banner then shows (X-7).
const hereText = computed(() => hereRangeText(takeHereRange()))
const hereId = useId()

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
let resizer: ResizeObserver | undefined

onMounted(async () => {
    await nextTick()
    place()
    // Hidden elements cannot take focus, so wait for the placed popover to show.
    await nextTick()
    if (!active) return
    const focus = props.restore?.focus
    const target =
        focus === 'list'
            ? popover.value?.querySelector<HTMLElement>('[data-goto-list]')
            : radios().find((radio) =>
                  focus
                      ? radio.dataset.gotoFilter === focus
                      : radio.getAttribute('aria-checked') === 'true',
              )
    target?.focus({ preventScroll: true })
    // The jump list loads after it opens: placed again as it grows.
    if (scroller.value?.firstElementChild) {
        resizer = new ResizeObserver(() => {
            place()
        })
        for (const child of scroller.value.children) resizer.observe(child)
    }
    window.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('blur', onDismiss)
})

onUnmounted(() => {
    active = false
    resizer?.disconnect()
    window.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('resize', onDismiss)
    window.removeEventListener('blur', onDismiss)
})

// Focus in it goes back to the button as it closes (X-3).
const onDismiss = () => {
    emit('close', !!popover.value?.contains(document.activeElement))
}

const onOutside = (event: PointerEvent) => {
    const target = event.target
    if (!(target instanceof Node)) return
    // The button toggles the popover itself on click.
    if (popover.value?.contains(target) || props.anchor.contains(target)) return
    // The press only closes it, so closing never edits what lies under it, and it moves no focus:
    // focus goes back to the button (X-3).
    swallowPress(event)
    emit('close', true)
}

// Edits Here takes its beats again each time it is chosen.
const pick = (filter: Filter) => {
    if (filter === 'here') filterHere()
    else historyFilter.value = filter
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
        // Tab goes between the Show switch and the jump list; out of them, focus returns to the
        // button first, so Tab continues from there.
        const list = popover.value?.querySelector<HTMLElement>('[data-goto-list]')
        const inList = !!list && event.target === list
        if (list && inList === event.shiftKey) {
            event.preventDefault()
            if (inList)
                radios()
                    .find((radio) => radio.getAttribute('aria-checked') === 'true')
                    ?.focus()
            else list.focus()
        } else emit('close', true)
    } else if (event.target instanceof HTMLElement && event.target.matches('[role="radio"]')) {
        const at = radios().indexOf(event.target)
        const next = {
            ArrowLeft: at - 1,
            ArrowUp: at - 1,
            ArrowRight: at + 1,
            ArrowDown: at + 1,
            Home: 0,
            End: filters.length - 1,
        }[event.key]
        if (next !== undefined) {
            const filter = filters[(next + filters.length) % filters.length]
            if (!filter) return
            event.preventDefault()
            void nextTick(() => radios()[filters.indexOf(filter)]?.focus())
            // Arrows move the focus; Space or Enter picks.
            return
        }
        if (event.key === ' ' || event.key === 'Enter') {
            const at = radios().indexOf(event.target)
            const filter = filters[at]
            if (!filter) return
            event.preventDefault()
            pick(filter)
        }
    }
}
</script>

<template>
    <Teleport :to="container">
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
            class="popup-surface popup-sheet fixed z-50 sm:w-80"
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
                <div role="radiogroup" :aria-labelledby="headingId" class="flex shrink-0 flex-col">
                    <button
                        v-for="filter in filters"
                        :key="filter"
                        type="button"
                        role="radio"
                        class="goto-filter popup-item"
                        :aria-checked="historyFilter === filter"
                        :aria-label="filterTitle(filter)"
                        :aria-describedby="filter === 'here' ? hereId : undefined"
                        :tabindex="historyFilter === filter ? 0 : -1"
                        :data-goto-filter="filter"
                        @click="pick(filter)"
                    >
                        <CheckIcon
                            class="size-4 shrink-0 fill-current"
                            :class="{ invisible: historyFilter !== filter }"
                        />
                        <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate">{{ filterTitle(filter) }}</span>
                            <span
                                v-if="filter === 'here'"
                                :id="hereId"
                                class="truncate text-xs tabular-nums opacity-80"
                                data-goto-here-range
                                >{{ hereText }}</span
                            >
                        </span>
                    </button>
                </div>
                <div role="separator" class="popup-separator" />
                <!-- The jump list: Now, then days and the sessions in them. -->
                <slot />
            </div>
        </div>
    </Teleport>
</template>
