<script setup lang="ts">
import { computed, ref } from 'vue'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import SeverityIcon from '../SeverityIcon.vue'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import type { ExportDialog } from './dialog'

// One line above the footer for a message about the whole dialog. Its status region stays
// mounted, empty and unpadded while there is no message, so a failure placed in it is read.
const props = defineProps<{ dialog: ExportDialog }>()
const d = props.dialog
const detailsOpen = ref(false)
const coarse = matchMedia('(pointer: coarse)').matches

const message = computed(() => {
    const outcome = d.outcome.value
    if (d.phase.value === 'preparing' || d.phase.value === 'exporting')
        return {
            severity: 'info' as const,
            // A phone or tablet stops a hidden page's export; a desktop browser goes on.
            text: coarse ? i18n.value.exportVideo.keepOpenVisible : i18n.value.exportVideo.keepOpen,
        }
    if (outcome?.kind === 'failed')
        return {
            severity: 'error' as const,
            text: outcome.failure.message(),
            detail: outcome.failure.detail,
        }
    if (d.stoppedLine.value && d.phase.value === 'setup')
        return {
            severity: 'warning' as const,
            text: interpolateRaw(
                i18n.value.exportVideo.stopped,
                `${d.stoppedLine.value.resolution}p`,
                `${d.stoppedLine.value.renderScale}x`,
            ),
        }
    if (d.storageNearlyFull.value && !d.busy.value)
        return { severity: 'warning' as const, text: i18n.value.load.storageNearlyFull }
    return undefined
})
</script>

<template>
    <div
        role="status"
        class="shrink-0 text-sm"
        :class="{ 'border-t border-fg/15 px-4 py-3': message }"
        data-export-slot
    >
        <div v-if="message" class="flex flex-col gap-1">
            <p class="flex items-start gap-2">
                <SeverityIcon :severity="message.severity" class="mt-0.5 size-4" />
                <span>{{ message.text }}</span>
            </p>
            <details
                v-if="message.detail"
                class="max-h-32 overflow-auto break-words pl-6"
                @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open"
            >
                <summary
                    class="focus-ring flex h-8 w-fit cursor-pointer list-none items-center gap-2 rounded-full pr-3 [&::-webkit-details-marker]:hidden"
                >
                    <ChevronIcon :direction="detailsOpen ? 'down' : 'right'" />
                    {{ i18n.preview.errorDetails }}
                </summary>
                <p class="whitespace-break-spaces">{{ message.detail }}</p>
            </details>
        </div>
    </div>
</template>
