<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '../../i18n'
import BaseField from './BaseField.vue'
import ToggleSwitch from './ToggleSwitch.vue'

defineProps<{
    label: string
    /** Short remarks under the field. */
    notes?: string[]
    /** What the setting does, behind an ⓘ after the label. */
    description?: string
}>()

const modelValue = defineModel<boolean>({ required: true })
// The shown value, also on hover where it truncates.
const shown = computed(() =>
    modelValue.value
        ? i18n.value.modals.form.toggle.enabled
        : i18n.value.modals.form.toggle.disabled,
)
</script>

<template>
    <BaseField :label :notes :description>
        <!-- A switch named by its row; the shown state stays its text. -->
        <template #default="{ textId }">
            <div class="form-field-toggle">
                <input
                    class="btn btn-secondary w-full rounded-full px-4 py-1 text-left"
                    type="button"
                    role="switch"
                    :aria-checked="modelValue"
                    :aria-labelledby="textId"
                    :value="shown"
                    :title="shown"
                    @click="modelValue = !modelValue"
                />
                <ToggleSwitch :value="modelValue" />
            </div>
        </template>
    </BaseField>
</template>
