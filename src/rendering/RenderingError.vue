<script setup lang="ts">
import { ref } from 'vue'
import ChevronIcon from '../editor/workspace/ChevronIcon.vue'
import { i18n } from '../i18n'

defineProps<{ message: string }>()
defineEmits<{ reload: [] }>()

const isDetailOpen = ref(false)
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
            <p>{{ i18n.preview.chartGraphicsUnavailable }}</p>
            <p>{{ i18n.preview.graphicsHelp }}</p>
            <details
                v-if="message"
                class="max-h-32 max-w-full overflow-auto break-words"
                @toggle="isDetailOpen = ($event.target as HTMLDetailsElement).open"
            >
                <!-- The shared chevron in place of the native marker. -->
                <summary
                    class="focus-ring flex h-8 cursor-pointer list-none items-center justify-center gap-2 rounded-full px-3 [&::-webkit-details-marker]:hidden"
                >
                    <ChevronIcon :direction="isDetailOpen ? 'down' : 'right'" />
                    {{ i18n.preview.errorDetails }}
                </summary>
                <p>{{ message }}</p>
            </details>
            <button
                type="button"
                class="btn btn-secondary min-h-11 rounded-full px-4"
                @click="$emit('reload')"
            >
                {{ i18n.preview.reload }}
            </button>
        </div>
    </div>
</template>
