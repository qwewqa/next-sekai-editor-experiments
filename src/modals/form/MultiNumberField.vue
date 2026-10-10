<script setup lang="ts">
import {
    computed,
    inject,
    nextTick,
    onBeforeUnmount,
    ref,
    shallowRef,
    useTemplateRef,
    watch,
    type Ref,
} from 'vue'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import BaseField from './BaseField.vue'
import { formatNumber, formatRange, isUnset, mixedRange, useFieldUsage } from './fieldUsage'
import { numberEditKey } from './numberEdit'
import { createStepTrail } from './numberStep'
import { confirmOnEnter, isTyped, trackTyping } from './resync'

const props = defineProps<{
    label: string
    min?: number
    max?: number
    step?: number | 'any'
    /** `min` stands in for "above 0", so arrow steps never stop at it. */
    exclusiveMin?: boolean
}>()

const input: Ref<HTMLInputElement | null> = useTemplateRef('input')

const modelValue = defineModel<number | undefined>({ required: true })
const field = useFieldUsage()
const edit = inject(numberEditKey, undefined)
const owner = Symbol('number field')
// A mixed field's arrow steps: the value each value in use steps to, until committed.
const steps = shallowRef<Map<unknown, number>>()
// A mixed number shows the range in use rather than just "Mixed", stepped while previewed.
const range = computed(() => {
    if (!steps.value) return mixedRange(field?.value)
    const values = [...steps.value.values()]
    return formatRange(Math.min(...values), Math.max(...values))
})
// Shown to 4 decimals, as mixed ranges are; only typing writes, so the exact value stays.
const shown = () => (modelValue.value === undefined ? '' : formatNumber(modelValue.value))
const text = ref(shown())
// The committed text; previews change the model while typing.
let committed = text.value
// The exact value the committed text shows.
let exact = modelValue.value
let dirty = false
// The last edit was an arrow step, which native undo can't take back.
let stepped = false
// Each value's arrow steps, so stepping back returns exactly; the lone value's under `owner`.
let trails = new Map<unknown, ReturnType<typeof createStepTrail>>()
const trail = (key: unknown) => {
    let step = trails.get(key)
    if (!step) trails.set(key, (step = createStepTrail()))
    return step
}
// Typed text or mixed steps not yet committed.
const isPending = () => !!steps.value || (!!input.value && isTyped(input.value, committed))
trackTyping(input, isPending)

const reset = () => {
    dirty = false
    stepped = false
    steps.value = undefined
    trails = new Map()
    text.value = shown()
    committed = text.value
    exact = modelValue.value
    // Text already shown is left alone, keeping the caret and native undo.
    if (input.value && isTyped(input.value, text.value)) input.value.value = text.value
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
    steps.value = undefined
    stepped = false
    // Text back at the shown value, by typing or native undo, changes nothing though it is rounded.
    if (!isTyped(input.value, committed)) {
        dirty = false
        edit?.cancel(owner)
        return
    }
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
    if (steps.value) {
        edit?.commit(owner)
    } else if (input.value && !isTyped(input.value, committed)) {
        edit?.cancel(owner)
    } else if (isValid() && input.value) {
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
    if (!isPending()) {
        void cancel()
        return
    }
    event.stopPropagation()
    event.preventDefault()
    void cancel()
}

// Arrow keys step from the exact value, as the shown one is rounded, and preview until the field is left.
const onStepKey = (event: KeyboardEvent) => {
    const element = input.value
    if (!element) return
    event.preventDefault()
    const delta =
        (event.key === 'ArrowUp' ? 1 : -1) * (typeof props.step === 'number' ? props.step : 1)
    if (isTyped(element, committed)) {
        if (element.validity.badInput || element.value === '') return
        stepFrom(typed(), delta)
    } else if (modelValue.value !== undefined) {
        stepFrom(modelValue.value, delta)
    } else {
        stepEach(delta)
    }
}

const stepFrom = (from: number, delta: number) => {
    const element = input.value
    const next = trail(owner)(from, delta, props)
    if (!element || next === from) return
    // Back at the committed value, the committed text shows it, so nothing changes.
    element.value = next === exact ? committed : `${next}`
    onInput()
    stepped = true
}

// Each value in use steps on its own, as each object's would alone.
const stepEach = (delta: number) => {
    const usage = field?.value
    if (!edit || !usage?.usage) return
    const next = new Map<unknown, number>()
    for (const value of usage.usage.values.keys()) {
        if (typeof value !== 'number') continue
        const from = steps.value?.get(value) ?? (usage.map ? (usage.map(value) as number) : value)
        next.set(value, trail(value)(from, delta, props))
    }
    if (!next.size) return
    dirty = true
    stepped = true
    steps.value = next
    // A value stepped back to its own is left as it is.
    const changed = [...next.keys()].filter(
        (value) => next.get(value) !== (usage.map ? usage.map(value) : value),
    )
    edit.previewEach(owner, changed, (value) => (modelValue.value = next.get(value)))
}

// Native undo would reach past a step to another field's typing, so undo reverts steps instead.
const onHistoryKey = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase()
    if (!stepped || !(event.ctrlKey || event.metaKey) || event.altKey) return
    if (key !== 'z' && key !== 'y') return
    event.preventDefault()
    event.stopPropagation()
    if (key === 'z' && !event.shiftKey) void cancel()
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
            @keydown="onHistoryKey"
            @keydown.esc="onEscape"
            @keydown.up="onStepKey"
            @keydown.down="onStepKey"
            @keydown.enter="confirmOnEnter"
        />
    </BaseField>
</template>
