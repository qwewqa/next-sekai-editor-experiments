<script setup lang="ts">
import { i18n } from '../i18n'
import BaseModal from './BaseModal.vue'

defineProps<{
    title: () => string
    message: () => string
    /** A report of several lines, each its own paragraph, so they do not run together when they wrap. */
    lines?: (() => string)[]
}>()

defineEmits<{
    close: []
}>()
</script>

<template>
    <BaseModal :title="title()" @close="$emit('close')">
        <div v-if="lines" class="flex flex-col gap-2">
            <p v-for="(line, index) in lines" :key="index">{{ line() }}</p>
        </div>
        <div v-else class="whitespace-pre-line">{{ message() }}</div>

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
