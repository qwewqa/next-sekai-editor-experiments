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
import { formatNumber } from '../../utils/formatNumber'
import { extentOf } from '../../utils/math'
import { formatRange, isUnset, mixedRange, useFieldUsage } from './fieldUsage'
import { useFieldReadOnly } from './fieldReadOnly'
import { numberEditKey } from './numberEdit'
import { isChromium } from '../../utils/browser'
import { createStepTrail, stepValues } from './numberStep'
import { confirmOnEnter, isTyped, trackTyping } from './resync'

const props = defineProps<{
    label: string
    min?: number
    max?: number
    step?: number | 'any'
    /** `min` stands in for "above 0", so arrow steps never stop at it. */
    exclusiveMin?: boolean
    /** Sets a stepped value in place of the model, as Beat does to keep it on its grid. */
    setStep?: (value: number) => void
}>()

const input: Ref<HTMLInputElement | null> = useTemplateRef('input')

const modelValue = defineModel<number | undefined>({ required: true })
const field = useFieldUsage()
// Shown and selectable, not changed: the arrow keys and the wheel step nothing.
const readOnly = useFieldReadOnly()
const edit = inject(numberEditKey, undefined)
const owner = Symbol('number field')
// A mixed field's arrow steps: the value each value in use steps to, until committed.
const steps = shallowRef<Map<unknown, number>>()
// A mixed number shows the range in use rather than just "Mixed", stepped while previewed.
const range = computed(() => {
    if (!steps.value) return mixedRange(field?.value)
    const values = [...steps.value.values()]
    const { min, max } = extentOf(values)
    return formatRange(min, max)
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
// The text the last arrow step wrote; native undo back to it is a step again.
let steppedText: string | undefined
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
    steppedText = undefined
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
onBeforeUnmount(() => {
    edit?.cancel(owner)
    input.value?.removeEventListener('wheel', onWheel)
})

// Parsed from the text: Firefox's valueAsNumber keeps only 15 digits.
const typed = () => Number(input.value?.value)
const isValid = () => input.value?.validity.valid && Number.isFinite(typed())

const setModel = (value: number) => {
    modelValue.value = value
}

const onInput = (event?: Event, step = false) => {
    if (!input.value) return
    // Number inputs expose an empty value for intermediate text such as "-"
    // or "1e". Writing that empty value back would erase the user's typing.
    if (!input.value.validity.badInput) text.value = input.value.value
    steps.value = undefined
    stepped =
        (event as InputEvent | undefined)?.inputType === 'historyUndo' &&
        input.value.value === steppedText
    const set = (step || stepped ? props.setStep : undefined) ?? setModel
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
        edit.preview(owner, () => {
            set(value)
        })
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
    event.preventDefault()
    if (readOnly.value) return
    stepBy(event.key === 'ArrowUp' ? 1 : -1)
}

// Chromium steps a focused number input under the wheel natively, from the shown text; it steps as the arrows do.
const stepsOnWheel = isChromium(navigator)
const onWheel = (event: WheelEvent) => {
    if (!stepsOnWheel || !event.deltaY || document.activeElement !== event.currentTarget) return
    if (readOnly.value) return
    event.preventDefault()
    stepBy(event.deltaY < 0 ? 1 : -1)
}

const stepBy = (direction: number) => {
    const element = input.value
    if (!element) return
    const delta = direction * (typeof props.step === 'number' ? props.step : 1)
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
    steppedText = next === exact ? undefined : element.value
    onInput(undefined, true)
    stepped = true
}

// Each value in use steps on its own, as each object's would alone.
const stepEach = (delta: number) => {
    const usage = field?.value
    if (!edit || !usage?.usage) return
    const origins = new Map<unknown, number>()
    for (const value of usage.usage.values.keys()) {
        if (typeof value !== 'number') continue
        origins.set(value, usage.map ? (usage.map(value) as number) : value)
    }
    if (!origins.size) return
    const { next, changed } = stepValues(origins, steps.value, (value, from) =>
        trail(value)(from, delta, props),
    )
    steppedText = undefined
    // Every value back at its own leaves nothing to commit.
    if (!changed.length) {
        steps.value = undefined
        dirty = false
        stepped = false
        edit.cancel(owner)
        return
    }
    dirty = true
    stepped = true
    steps.value = next
    const set = props.setStep ?? setModel
    edit.previewEach(owner, changed, (value) => {
        const to = next.get(value)
        if (to !== undefined) set(to)
    })
}

// Native undo would reach past a step to another field's typing, so undo reverts steps instead.
const onHistoryKey = (event: KeyboardEvent) => {
    // A non-Latin layout's Z key still undoes natively; a Latin one's letter is the shortcut.
    const key = /^[a-z]$/i.test(event.key)
        ? event.key.toLowerCase()
        : ({ KeyZ: 'z', KeyY: 'y' } as Record<string, string>)[event.code]
    if (!stepped || !(event.ctrlKey || event.metaKey) || event.altKey) return
    if (key !== 'z' && key !== 'y') return
    event.preventDefault()
    event.stopPropagation()
    if (key === 'z' && !event.shiftKey) void cancel()
}

// The wheel listener can't be passive, so only a focused field holds it.
const onFocus = (event: FocusEvent) => {
    const element = event.currentTarget as HTMLInputElement | null
    element?.select()
    if (stepsOnWheel) element?.addEventListener('wheel', onWheel, { passive: false })
}

const onBlur = () => {
    input.value?.removeEventListener('wheel', onWheel)
    void onChange()
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
            class="field w-full appearance-none rounded-full px-4 py-1 placeholder:text-fg/80"
            type="number"
            :min
            :max
            :step
            required
            :readonly="readOnly"
            @focus="onFocus"
            @input="onInput"
            @change="onChange"
            @blur="onBlur"
            @keydown="onHistoryKey"
            @keydown.esc="onEscape"
            @keydown.up="onStepKey"
            @keydown.down="onStepKey"
            @keydown.enter="confirmOnEnter"
        />
    </BaseField>
</template>
