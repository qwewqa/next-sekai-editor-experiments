<script setup lang="ts">
import { ref, watch } from 'vue'
import { vFocusRescue } from '../../directives/focusRescue'
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import { choiceLine } from '../../modals/form/fieldDescription'
import SeverityIcon from '../SeverityIcon.vue'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import type { ExportDialog } from './dialog'

// The messages about the whole dialog, above the footer, in one scroller of at most 8 rem. Its
// status region stays mounted, empty and unpadded while there is no message, so a failure placed
// in it is read. Each message's text has the id `${ids}-${index}`, for the footer's buttons.
const props = defineProps<{ dialog: ExportDialog; ids: string }>()
const messages = props.dialog.messages
// Each failure's Error Details start closed.
const detailsOpen = ref(false)
watch(props.dialog.outcome, () => {
    detailsOpen.value = false
})
// The scroller goes with the last message, and focus in it goes to the footer's Cancel or Close.
const footerButton = () =>
    document.querySelector<HTMLElement>(
        '[data-export-footer] [data-export-cancel], [data-export-footer] [data-export-close]',
    )
</script>

<template>
    <div
        role="status"
        class="flex max-h-32 min-h-0 shrink flex-col text-sm"
        :class="{ 'border-t border-fg/15': messages.length }"
        data-export-slot
    >
        <div
            v-if="messages.length"
            v-scroll-edges
            v-focus-rescue="footerButton"
            tabindex="0"
            class="focus-ring flex min-h-0 flex-col gap-1 overflow-y-auto px-4 py-3"
        >
            <template v-for="(message, index) in messages" :key="index">
                <p class="flex items-start gap-2">
                    <SeverityIcon :severity="message.severity" class="mt-0.5 size-4" />
                    <span :id="`${ids}-${index}`"
                        ><span v-if="message.label" class="font-semibold">{{
                            choiceLine(message.label)
                        }}</span
                        >{{ message.text }}</span
                    >
                </p>
                <details
                    v-if="message.detail"
                    class="break-words pl-6"
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
            </template>
        </div>
    </div>
</template>
