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
import { i18n } from '../../i18n'
import { holdsCharacter, menuKeyIndex } from '../../utils/menuKeys'
import { swallowPress } from '../../utils/swallowPress'
import CheckIcon from './CheckIcon.vue'

const props = defineProps<{
    anchor: HTMLElement
    summary: string
    checked: boolean
    inspectable: boolean
}>()
const emit = defineEmits<{ toggle: []; inspect: []; close: [restoreFocus: boolean] }>()
const menu = useTemplateRef<HTMLDivElement>('menu')
const summaryId = useId()
const alive = ref(false)
const isAlive = () => alive.value
const position = ref<{ left: number; top: number; maxHeight: number }>()
const container = computed(() => props.anchor.closest('dialog') ?? 'body')
const buttons = () => [...(menu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
const place = () => {
    if (!menu.value || !props.anchor.isConnected) return
    const anchor = props.anchor.getBoundingClientRect()
    const width = menu.value.offsetWidth
    const height = menu.value.scrollHeight
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = window.innerHeight
    const below = viewportHeight - anchor.bottom - 12
    const above = anchor.top - 12
    const maxHeight = Math.max(0, viewportHeight - 16)
    const top =
        height <= below
            ? anchor.bottom + 4
            : height <= above
              ? anchor.top - height - 4
              : Math.max(8, Math.min(anchor.bottom + 4, viewportHeight - height - 8))
    position.value = {
        left: Math.max(8, Math.min(anchor.right - width, viewportWidth - width - 8)),
        top,
        maxHeight,
    }
}
const outside = (event: PointerEvent) => {
    if (
        event.target instanceof Node &&
        !menu.value?.contains(event.target) &&
        !props.anchor.contains(event.target)
    ) {
        // The press only closes it, so it moves no focus: focus goes back to the button.
        swallowPress(event)
        emit('close', true)
    }
}
const keydown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && /^[a-z]$/i.test(event.key)) {
        event.preventDefault()
        return
    }
    if (event.key === 'Escape') {
        event.preventDefault()
        emit('close', true)
    } else if (event.key === 'Tab') emit('close', true)
    else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const list = buttons()
        const index = menuKeyIndex(
            event.key,
            list.findIndex((button) => button === document.activeElement),
            list.length,
        )
        if (index !== undefined) list[index]?.focus()
    } else if (holdsCharacter(event)) event.preventDefault()
}
watch(
    () => [props.summary, props.inspectable],
    () => {
        void nextTick(place)
    },
)
onMounted(async () => {
    alive.value = true
    await nextTick()
    if (!isAlive()) return
    place()
    await nextTick()
    if (!isAlive() || !menu.value) return
    buttons()[0]?.focus({ preventScroll: true })
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', place)
})
onBeforeUnmount(() => {
    alive.value = false
    window.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('resize', place)
})
</script>

<template>
    <Teleport :to="container">
        <!-- Under 640 px the menus' bottom sheet, over a dimmed backdrop. -->
        <div
            class="manager-menu-backdrop fixed inset-0 z-40 bg-black/30 sm:hidden"
            aria-hidden="true"
            @mousedown.prevent
        />
        <div
            ref="menu"
            role="menu"
            :aria-label="i18n.peek.changeOptions"
            :aria-describedby="summaryId"
            class="popup-surface popup-sheet fixed z-50 sm:max-w-[min(20rem,calc(100vw-1rem))]"
            :class="{ invisible: !position }"
            :style="{
                left: `${position?.left ?? 0}px`,
                top: `${position?.top ?? 0}px`,
                maxHeight: `${position?.maxHeight ?? 0}px`,
            }"
            data-change-options-menu
            @keydown.stop="keydown"
            @contextmenu.prevent
        >
            <div class="popup-scroller">
                <p
                    :id="summaryId"
                    class="whitespace-pre-wrap px-3 py-2 text-sm text-fg/80 [overflow-wrap:anywhere]"
                    data-change-options-summary
                >
                    {{ summary }}
                </p>
                <div role="separator" class="popup-separator" />
                <button
                    type="button"
                    role="menuitemcheckbox"
                    :aria-checked="checked"
                    class="popup-item w-full"
                    @click="emit('toggle')"
                >
                    <span
                        class="flex size-4 shrink-0 items-center justify-center"
                        aria-hidden="true"
                        ><CheckIcon v-if="checked" class="size-4 fill-current"
                    /></span>
                    <span>{{ i18n.peek.showEdits }}</span>
                </button>
                <button
                    v-if="inspectable"
                    type="button"
                    role="menuitem"
                    class="popup-item w-full"
                    @click="emit('inspect')"
                >
                    <span class="size-4 shrink-0" aria-hidden="true" />
                    <span>{{ i18n.historyChanges.view }}</span>
                </button>
            </div>
        </div>
    </Teleport>
</template>
