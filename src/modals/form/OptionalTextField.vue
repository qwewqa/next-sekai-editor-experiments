<script setup lang="ts">
import { useTemplateRef, type Ref } from 'vue'
import { i18n } from '../../i18n'
import BaseField from './BaseField.vue'
import { useEmptyLabel } from './emptyLabel'
import { confirmOnEnter, resyncInput, revertOnEscape, trackTypedText } from './resync'

defineProps<{
    label: string
    /** Shown while empty, in place of "Not Set". */
    placeholder?: string
}>()

const emptyLabel = useEmptyLabel()

const input: Ref<HTMLInputElement | null> = useTemplateRef('input')

// Empty is a value: the field is unset.
const modelValue = defineModel<string>({ required: true })

trackTypedText(input, () => modelValue.value)

const onFocus = (event: FocusEvent) => {
    ;(event.currentTarget as HTMLInputElement | null)?.select()
}
</script>

<template>
    <BaseField :label>
        <input
            ref="input"
            v-model.lazy="modelValue"
            class="field w-full appearance-none rounded-full px-4 py-1 placeholder:text-fg/80"
            :placeholder="placeholder ?? emptyLabel?.() ?? i18n.modals.form.notSet"
            type="text"
            @focus="onFocus"
            @change="resyncInput($event, () => modelValue)"
            @keydown.esc="revertOnEscape($event, modelValue)"
            @keydown.enter="confirmOnEnter"
        />
    </BaseField>
</template>
