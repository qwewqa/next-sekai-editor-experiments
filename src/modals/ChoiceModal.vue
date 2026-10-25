<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef } from 'vue'
import BaseModal from './BaseModal.vue'
import { useActivationGuard } from './activationGuard'
import type { ChoiceButton } from './choice'

// The shared choice dialog: Cancel, the other choices, then the safe default (with
// `cancelIsDefault`, the choices, then Cancel).
const props = defineProps<{
    title: () => string
    message?: () => string
    /** Instead of `message`: sentences that are each their own paragraph, so they do not run together when they wrap. */
    lines?: () => string[]
    /** In button order: Cancel and the other choices come first, the safe default last. */
    buttons: ChoiceButton[]
}>()

const emit = defineEmits<{
    close: [result: unknown]
}>()

const { accidental, onKeydown } = useActivationGuard()
const ids = useId()

// Descriptions sit under their buttons, so a dialog with any stacks them.
const described = computed(() => props.buttons.some((button) => button.description))

// Below about 480 px, or when the labels do not fit one row, the safe default goes on top and Cancel last.
// Decided before the first render, so the focus hook sees the final order.
const narrow = ref(window.innerWidth < 480)
const crowded = ref(false)
const stacked = computed(() => narrow.value || crowded.value || described.value)
// Each button keeps its place in `buttons` as its key, so a restack moves the same elements.
const ordered = computed(() => {
    const items = props.buttons.map((button, index) => ({ button, index }))
    return stacked.value ? items.reverse() : items
})

const row = useTemplateRef<HTMLElement>('row')
// A row's overflow runs off its left edge, which scrollWidth ignores, so the buttons are summed.
const fits = () => {
    if (!row.value) return true
    const buttons = Array.from(row.value.children)
    const width = buttons.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
    return width + 8 * (buttons.length - 1) <= row.value.clientWidth + 1
}
const layout = async () => {
    // Moving a focused button in the DOM drops its focus; it gets it back.
    const focused = row.value?.contains(document.activeElement) ? document.activeElement : null
    narrow.value = window.innerWidth < 480
    crowded.value = false
    await nextTick()
    // Measured as a row; a stacked one has no overflow to measure.
    if (!narrow.value && !described.value && !fits()) {
        crowded.value = true
        await nextTick()
    }
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused)
        focused.focus()
}
const onResize = () => {
    void layout()
}
onMounted(() => {
    onResize()
    window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize)
})

const pick = (button: ChoiceButton) => {
    if (button.disabled || accidental()) return
    emit('close', button.cancel ? undefined : button.value)
}

// Primary is the safe default; a destructive choice beside it is quiet red.
const classes = (button: ChoiceButton) =>
    button.danger ? 'btn-danger-quiet' : button.default ? 'btn-primary' : 'btn-secondary'
</script>

<template>
    <BaseModal :title="title()" @close="emit('close', undefined)">
        <div v-if="lines" class="flex flex-col gap-2">
            <p v-for="(line, index) in lines()" :key="index">{{ line }}</p>
        </div>
        <div v-else-if="message" class="whitespace-pre-line">{{ message() }}</div>

        <div
            ref="row"
            data-choice-buttons
            class="flex gap-2"
            :class="stacked ? 'flex-col' : 'justify-end'"
            @keydown.capture="onKeydown"
        >
            <template v-for="{ button, index } in ordered" :key="index">
                <div class="flex shrink-0 flex-col gap-1" :class="{ 'items-stretch': stacked }">
                    <button
                        type="button"
                        class="btn min-h-9 min-w-24 max-w-full rounded-full px-4"
                        :class="[
                            classes(button),
                            stacked
                                ? 'h-auto w-full py-1.5 leading-tight'
                                : 'h-9 whitespace-nowrap',
                        ]"
                        :disabled="button.disabled"
                        :data-autofocus="button.default || undefined"
                        :data-choice="
                            button.cancel ? 'cancel' : button.default ? 'default' : 'other'
                        "
                        :aria-describedby="button.description ? `${ids}-${index}` : undefined"
                        @click="pick(button)"
                    >
                        {{ button.label() }}
                    </button>
                    <div
                        v-if="button.description"
                        :id="`${ids}-${index}`"
                        class="px-2 text-sm text-fg/80"
                    >
                        {{ button.description() }}
                    </div>
                </div>
            </template>
        </div>
    </BaseModal>
</template>
