<script setup lang="ts">
import { i18n } from '../../i18n'
import BaseField from './BaseField.vue'
import { useEmptyLabel } from './emptyLabel'

defineProps<{
    label: string
    rows?: number
}>()

const emptyLabel = useEmptyLabel()

// Empty is a value: the field is unset. The text is the value as typed, so a dialog that guards
// its changes sees it, and Escape leaves the field as the dialog does rather than reverting it.
const modelValue = defineModel<string>({ required: true })
</script>

<template>
    <BaseField :label>
        <textarea
            v-model="modelValue"
            class="field block w-full resize-y appearance-none rounded-2xl px-4 py-2 placeholder:text-fg/80"
            :rows="rows ?? 4"
            :placeholder="emptyLabel?.() ?? i18n.modals.form.notSet"
        />
    </BaseField>
</template>
