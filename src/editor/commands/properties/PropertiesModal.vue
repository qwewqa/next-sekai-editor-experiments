<script setup lang="ts">
import { ref } from 'vue'
import { i18n } from '../../../i18n'
import FormModal from '../../../modals/form/FormModal.vue'
import NumberField from '../../../modals/form/NumberField.vue'

const props = defineProps<{
    initialLife: number
    /** While peeking: shown, not changed. */
    readOnly?: boolean
}>()

defineEmits<{
    close: [initialLife?: number]
}>()

const model = ref(props.initialLife)
</script>

<template>
    <FormModal
        :title="i18n.commands.properties.title"
        @close="$emit('close')"
        @submit="$emit('close', model)"
    >
        <fieldset class="contents" :disabled="readOnly">
            <NumberField
                v-model="model"
                :label="i18n.commands.properties.modal.life"
                :min="1"
                :step="1"
            />
        </fieldset>
    </FormModal>
</template>
