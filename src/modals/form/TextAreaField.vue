<script setup lang="ts">
import { useTemplateRef, type Ref } from 'vue'
import { i18n } from '../../i18n'
import BaseField from './BaseField.vue'
import { useEmptyLabel } from './emptyLabel'
import { revertOnEscape, trackTypedText } from './resync'

defineProps<{
    label: string
    rows?: number
}>()

const emptyLabel = useEmptyLabel()

const input: Ref<HTMLTextAreaElement | null> = useTemplateRef('input')

// Empty is a value: the field is unset.
const modelValue = defineModel<string>({ required: true })

// The shared helpers read `value` and `validity`, which a textarea has as an input does.
trackTypedText(input as unknown as Ref<HTMLInputElement | null>, () => modelValue.value)
</script>

<template>
    <BaseField :label>
        <textarea
            ref="input"
            v-model.lazy="modelValue"
            class="field block w-full resize-y appearance-none rounded-2xl px-4 py-2 placeholder:text-fg/80"
            :rows="rows ?? 4"
            :placeholder="emptyLabel?.() ?? i18n.modals.form.notSet"
            @keydown.esc="revertOnEscape($event, modelValue)"
        />
    </BaseField>
</template>
