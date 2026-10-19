<script setup lang="ts">
import { i18n } from '../../i18n'
import { pickFile } from '../../utils/file'
import BaseField from './BaseField.vue'

defineProps<{
    label: string
    value: string | undefined
}>()

const emit = defineEmits<{
    select: [file: File]
}>()

const onClick = async () => {
    const file = await pickFile()
    if (!file) return

    emit('select', file)
}
</script>

<template>
    <BaseField :label>
        <input
            class="btn btn-secondary w-full rounded-full px-4 py-1 text-left"
            type="button"
            :value="value ?? i18n.modals.form.file.select"
            @click="onClick"
        />
    </BaseField>
</template>
