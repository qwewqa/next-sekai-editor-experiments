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
        <div v-if="lines" class="flex flex-col gap-2 wrap-anywhere">
            <p v-for="(line, index) in lines" :key="index">{{ line() }}</p>
        </div>
        <div v-else class="wrap-anywhere whitespace-pre-line">{{ message() }}</div>

        <div class="flex justify-end">
            <button
                class="btn btn-primary h-9 max-w-full min-w-24 truncate rounded-full px-4"
                @click="$emit('close')"
            >
                {{ i18n.modals.info.ok }}
            </button>
        </div>
    </BaseModal>
</template>
