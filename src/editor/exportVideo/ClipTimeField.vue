<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { i18n } from '../../i18n'
import { formatClipTime, parseClipTime } from './clipTime'

// In or Out: a time field, or in phone landscape a chip that opens the field in a popover. A value
// applies on Enter, when the field loses focus, and on a press outside the popover; only Escape
// reverts it.
const props = defineProps<{
    label: string
    value: number
    hours: boolean
    busy: boolean
    chip: boolean
    /** The label sits above the field when In and Out do not fit side by side. */
    stacked?: boolean
}>()
const emit = defineEmits<{
    apply: [time: number]
    invalid: [invalid: boolean]
}>()

const ids = useId()
const input = useTemplateRef<HTMLInputElement>('input')
const chipButton = useTemplateRef<HTMLButtonElement>('chipButton')
const popover = useTemplateRef<HTMLDivElement>('popover')
const shown = computed(() => formatClipTime(props.value, props.hours))
const text = ref(shown.value)
const editing = ref(false)
const invalid = ref(false)
watch(shown, (value) => {
    if (!editing.value) text.value = value
})
watch(invalid, (value) => {
    emit('invalid', value)
})

const onInput = () => {
    editing.value = true
    invalid.value = false
}
const apply = () => {
    if (!editing.value) return true
    const time = parseClipTime(text.value)
    if (time === undefined) {
        invalid.value = true
        return false
    }
    editing.value = false
    invalid.value = false
    emit('apply', time)
    text.value = shown.value
    return true
}
const revert = () => {
    editing.value = false
    invalid.value = false
    text.value = shown.value
}
const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
        event.preventDefault()
        if (apply() && props.chip) close(true)
    } else if (event.key === 'Escape') {
        // An edit not applied is reverted first; the next Escape reaches the dialog.
        if (!editing.value && !invalid.value && !props.chip) return
        event.preventDefault()
        event.stopPropagation()
        revert()
        if (props.chip) close(true)
    }
}
const onBlur = () => {
    if (props.chip && popover.value?.contains(document.activeElement)) return
    if (apply() && props.chip && open.value) close(false)
}
const onFocus = () => {
    input.value?.select()
}

// --- The chip's popover.
const open = ref(false)
const place = ref<{ left: number; top: number }>()
// Read again after a wait.
const isOpen = () => open.value
const openPopover = async () => {
    if (props.busy) return
    open.value = true
    text.value = shown.value
    await nextTick()
    const anchor = chipButton.value?.getBoundingClientRect()
    const box = popover.value?.getBoundingClientRect()
    if (anchor && box) {
        const room = document.documentElement.clientWidth
        const below = anchor.bottom + 4 + box.height <= window.innerHeight - 8
        place.value = {
            left: Math.max(8, Math.min(anchor.left, room - 8 - box.width)),
            top: below ? anchor.bottom + 4 : Math.max(8, anchor.top - 4 - box.height),
        }
    }
    // Shown once placed; a hidden field cannot take focus.
    await nextTick()
    if (!isOpen()) return
    input.value?.focus()
    window.addEventListener('pointerdown', onOutside, true)
}
const close = (refocus: boolean) => {
    open.value = false
    place.value = undefined
    window.removeEventListener('pointerdown', onOutside, true)
    if (refocus) void nextTick(() => chipButton.value?.focus())
}
const onOutside = (event: PointerEvent) => {
    if (event.target instanceof Node && popover.value?.contains(event.target)) return
    // A press outside applies, as Done on the iOS keyboard does; one that cannot be read stays.
    if (apply()) close(false)
}
// A change of form that replaces the chip with a field closes its popover.
watch(
    () => props.chip,
    (chip) => {
        if (!chip && open.value) close(false)
    },
)
onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', onOutside, true)
})

const container = computed(() => chipButton.value?.closest('dialog') ?? 'body')
</script>

<template>
    <template v-if="chip">
        <button
            ref="chipButton"
            type="button"
            class="clip-chip ghost ghost-tinted relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3"
            :aria-disabled="busy || undefined"
            :aria-expanded="open"
            :aria-controls="open ? `${ids}-popover` : undefined"
            :data-clip-chip="label"
            @click="openPopover"
        >
            <span>{{ label }}</span
            ><span>{{ shown }}</span>
        </button>
        <Teleport v-if="open" :to="container">
            <div
                :id="`${ids}-popover`"
                ref="popover"
                class="popup-surface fixed z-50 flex flex-col gap-1 p-3"
                :class="{ invisible: !place }"
                :style="{ left: `${place?.left ?? 0}px`, top: `${place?.top ?? 0}px` }"
                role="group"
                :aria-label="label"
            >
                <label class="flex items-center gap-2">
                    <span>{{ label }}</span>
                    <input
                        ref="input"
                        v-model="text"
                        class="field h-9 rounded-full px-3 tabular-nums"
                        :class="hours ? 'w-32' : 'w-[6.5rem]'"
                        type="text"
                        inputmode="decimal"
                        spellcheck="false"
                        autocomplete="off"
                        :aria-invalid="invalid"
                        :aria-describedby="invalid ? `${ids}-error` : undefined"
                        @input="onInput"
                        @keydown="onKeydown"
                        @blur="onBlur"
                        @focus="onFocus"
                    />
                </label>
                <p v-if="invalid" :id="`${ids}-error`" role="alert" class="text-sm text-danger">
                    {{ i18n.exportVideo.invalidTime }}
                </p>
            </div>
        </Teleport>
    </template>
    <label
        v-else
        class="flex shrink-0 gap-2"
        :class="stacked ? 'flex-col items-start gap-0.5' : 'items-center'"
        data-clip-field
    >
        <span
            class="flex shrink-0 items-center"
            :class="stacked ? 'h-5 px-3 text-sm leading-5' : 'h-9'"
            >{{ label }}</span
        >
        <input
            ref="input"
            v-model="text"
            class="clip-field field relative h-9 shrink-0 rounded-full px-3 tabular-nums"
            :class="[hours ? 'w-32' : 'w-[6.5rem]', { 'clip-field-busy': busy }]"
            type="text"
            inputmode="decimal"
            spellcheck="false"
            autocomplete="off"
            :readonly="busy"
            :aria-disabled="busy || undefined"
            :aria-invalid="invalid"
            @input="onInput"
            @keydown="onKeydown"
            @blur="onBlur"
            @focus="onFocus"
        />
    </label>
</template>

<style scoped>
/* While an export runs: read-only, the face flat and faded, the value in ink. */
.clip-field-busy {
    box-shadow: none;
    background-color: rgb(var(--color-button) / 0.4);
}

/* 44 px targets for the 32 px chips. */
.clip-chip::before {
    content: '';
    position: absolute;
    inset: -0.375rem -0.25rem;
}
</style>
