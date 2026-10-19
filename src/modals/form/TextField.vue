<script setup lang="ts">
import { useTemplateRef, type Ref } from 'vue'
import BaseField from './BaseField.vue'
import { confirmOnEnter, resyncInput, revertOnEscape, trackTypedText } from './resync'

defineProps<{
    label: string
}>()

const input: Ref<HTMLInputElement | null> = useTemplateRef('input')

const modelValue = defineModel<string>({
    required: true,
    set: (value) => (input.value?.reportValidity() ? value : modelValue.value),
})

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
            class="field w-full appearance-none rounded-full px-4 py-1"
            type="text"
            required
            @focus="onFocus"
            @change="resyncInput($event, () => modelValue)"
            @keydown.esc="revertOnEscape($event, modelValue)"
            @keydown.enter="confirmOnEnter"
        />
    </BaseField>
</template>
