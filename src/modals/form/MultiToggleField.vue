<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '../../i18n'
import BaseField from './BaseField.vue'
import { useFieldUsage } from './fieldUsage'
import ToggleSwitch from './ToggleSwitch.vue'

defineProps<{
    label: string
}>()

const modelValue = defineModel<boolean | undefined>({ required: true })
// Only a value several objects share can be mixed; one always set, as the brush's, is a switch.
const mixable = !!useFieldUsage()
// The shown value, also on hover where it truncates.
const shown = computed(() =>
    modelValue.value === undefined
        ? i18n.value.modals.form.mixed
        : modelValue.value
          ? i18n.value.modals.form.toggle.enabled
          : i18n.value.modals.form.toggle.disabled,
)
</script>

<template>
    <BaseField :label>
        <!-- Named by its row; a checkbox where it can be mixed, as ARIA has no mixed switch. -->
        <template #default="{ textId }">
            <div class="form-field-toggle">
                <input
                    class="btn btn-secondary w-full rounded-full px-4 py-1 text-left"
                    type="button"
                    :role="mixable ? 'checkbox' : 'switch'"
                    :aria-checked="modelValue ?? 'mixed'"
                    :aria-labelledby="textId"
                    :class="{ 'text-fg/80 active:text-fg-strong': modelValue === undefined }"
                    :value="shown"
                    :title="shown"
                    @click="modelValue = !modelValue"
                />
                <ToggleSwitch :value="modelValue" />
            </div>
        </template>
    </BaseField>
</template>
