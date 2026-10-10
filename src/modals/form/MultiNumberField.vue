<script setup lang="ts">
import {
    computed,
    inject,
    nextTick,
    onBeforeUnmount,
    ref,
    useTemplateRef,
    watch,
    type Ref,
} from 'vue'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import BaseField from './BaseField.vue'
import { formatNumber, isUnset, mixedRange, useFieldUsage } from './fieldUsage'
import { numberEditKey } from './numberEdit'
import { confirmOnEnter, isTyped, trackTypedText } from './resync'

const props = defineProps<{
    label: string
    min?: number
    max?: number
    step?: number | 'any'
}>()

const input: Ref<HTMLInputElement | null> = useTemplateRef('input')

const modelValue = defineModel<number | undefined>({ required: true })
const field = useFieldUsage()
// A mixed number shows the range in use rather than just "Mixed".
const range = computed(() => mixedRange(field?.value))
const edit = inject(numberEditKey, undefined)
const owner = Symbol('number field')
// Shown to 4 decimals, as mixed ranges are; only typing writes, so the exact value stays.
const shown = () => (modelValue.value === undefined ? '' : formatNumber(modelValue.value))
const text = ref(shown())
// The committed text; previews change the model while typing.
let committed = text.value
let dirty = false
trackTypedText(input, () => committed)

const reset = () => {
    dirty = false
    text.value = shown()
    committed = text.value
    if (input.value) input.value.value = text.value
}

watch(modelValue, () => {
    if (!dirty) reset()
})
if (edit) watch(edit.revision, reset)
onBeforeUnmount(() => edit?.cancel(owner))

// Parsed from the text: Firefox's valueAsNumber keeps only 15 digits.
const typed = () => Number(input.value?.value)
const isValid = () => input.value?.validity.valid && Number.isFinite(typed())

const onInput = () => {
    if (!input.value) return
    // Number inputs expose an empty value for intermediate text such as "-"
    // or "1e". Writing that empty value back would erase the user's typing.
    if (!input.value.validity.badInput) text.value = input.value.value
    dirty = true
    if (!edit) return
    if (isValid()) {
        const value = typed()
        edit.preview(owner, () => (modelValue.value = value))
    } else {
        edit.invalidate(owner)
    }
}

const onChange = async () => {
    if (!dirty) return
    if (isValid() && input.value) {
        if (edit) {
            edit.commit(owner)
        } else {
            modelValue.value = typed()
        }
    } else {
        edit?.cancel(owner)
    }
    dirty = false
    await nextTick()
    reset()
}

const cancel = async () => {
    edit?.cancel(owner)
    dirty = false
    await nextTick()
    reset()
}

// Escape reverts an uncommitted edit; otherwise it reaches the dialog or panel.
const onEscape = (event: KeyboardEvent) => {
    if (!dirty) return
    // Text a native undo returned to its committed value passes Escape on.
    if (input.value && !isTyped(input.value, committed)) {
        void cancel()
        return
    }
    event.stopPropagation()
    event.preventDefault()
    void cancel()
}

// Arrow keys step from the exact value: the shown one is rounded, and so are native steps.
const onStepKey = (event: KeyboardEvent) => {
    const element = input.value
    const from = dirty ? (isValid() ? typed() : undefined) : modelValue.value
    if (props.step !== 'any' || !element || from === undefined || !Number.isFinite(from)) return
    event.preventDefault()
    let next = from + (event.key === 'ArrowUp' ? 1 : -1)
    if (props.min !== undefined) next = Math.max(props.min, next)
    if (props.max !== undefined) next = Math.min(props.max, next)
    element.value = `${next}`
    onInput()
}

const onFocus = (event: FocusEvent) => {
    ;(event.currentTarget as HTMLInputElement | null)?.select()
}
</script>

<template>
    <BaseField :label :mixed="[]">
        <input
            ref="input"
            :value="text"
            :placeholder="
                modelValue === undefined
                    ? (range ?? (isUnset(field) ? i18n.modals.form.notSet : i18n.modals.form.mixed))
                    : undefined
            "
            :title="
                modelValue === undefined && range
                    ? interpolateRaw(i18n.modals.form.mixedValues, range)
                    : undefined
            "
            class="w-full appearance-none rounded-full bg-button px-4 py-1 shadow-md outline-none transition-colors placeholder:text-fg/80 hover:shadow-accent focus:ring-2 focus:ring-fg active:bg-accent active:text-on-accent"
            type="number"
            :min
            :max
            :step
            required
            @focus="onFocus"
            @input="onInput"
            @change="onChange"
            @blur="onChange"
            @keydown.esc="onEscape"
            @keydown.up="onStepKey"
            @keydown.down="onStepKey"
            @keydown.enter="confirmOnEnter"
        />
    </BaseField>
</template>
