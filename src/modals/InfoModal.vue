<script setup lang="ts">
import { i18n } from '../i18n'
import BaseModal from './BaseModal.vue'

defineProps<{
    title: () => string
    message: () => string
}>()

defineEmits<{
    close: []
}>()
</script>

<template>
    <BaseModal :title="title()" @close="$emit('close')">
        <div>{{ message() }}</div>

        <div class="flex justify-end">
            <button
                class="btn btn-primary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                @click="$emit('close')"
            >
                {{ i18n.modals.info.ok }}
            </button>
        </div>
    </BaseModal>
</template>
