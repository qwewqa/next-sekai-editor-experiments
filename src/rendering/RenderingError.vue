<script setup lang="ts">
import { i18n } from '../i18n'

defineProps<{ message: string }>()
defineEmits<{ reload: [] }>()
</script>

<template>
    <div
        role="alert"
        class="rendering-error absolute inset-0 z-40 flex items-center justify-center overflow-auto bg-bg/95 p-4 text-center text-sm"
        @pointerdown.stop
        @click.stop
        @keydown.stop
    >
        <div class="flex max-w-md flex-col items-center gap-3">
            <p class="break-words">{{ message }}</p>
            <p>{{ i18n.preview.graphicsHelp }}</p>
            <button
                type="button"
                class="min-h-11 rounded-full bg-button px-4 text-fg shadow-md focus-visible:ring-2 focus-visible:ring-accent"
                @click="$emit('reload')"
            >
                {{ i18n.preview.reload }}
            </button>
        </div>
    </div>
</template>
