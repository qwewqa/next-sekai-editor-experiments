<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { i18n } from '../i18n'
import ChevronIcon from '../editor/workspace/ChevronIcon.vue'
import WaitBar from '../editor/workspace/WaitBar.vue'
import { errorMessage } from '../utils/error'
import BaseModal from './BaseModal.vue'
import { describeFailure } from './loadingFailure'

const props = defineProps<{
    title: () => string
    task: (signal: AbortSignal) => AsyncIterable<() => string> | Iterable<() => string>
    /** The fraction done, 0 to 100, when the total is known. Without it the bar slides. */
    progress?: () => number | undefined
}>()

const emit = defineEmits<{
    close: []
}>()

const ids = useId()
const message = ref(() => i18n.value.modals.loading.loading)
// English technical detail of a failure, behind a disclosure.
const detail = ref<string>()
const failed = ref(false)
const isDetailOpen = ref(false)

const controller = new AbortController()
onBeforeUnmount(() => {
    controller.abort()
})
onMounted(async () => {
    try {
        for await (const next of props.task(controller.signal)) {
            if (controller.signal.aborted) return
            message.value = next
        }

        if (!controller.signal.aborted) emit('close')
    } catch (error) {
        if (
            controller.signal.aborted ||
            (error instanceof DOMException && error.name === 'AbortError')
        ) {
            if (!controller.signal.aborted) emit('close')
            return
        }
        console.error(error)
        failed.value = true

        const failure = describeFailure(error)
        message.value = failure.headline ?? (() => errorMessage(error))
        detail.value = failure.detail
    }
})

const onClose = () => {
    controller.abort()
    emit('close')
}
</script>

<template>
    <BaseModal :title="title()" @close="onClose">
        <div class="flex flex-col gap-2">
            <span :id="`${ids}-text`" role="status" class="whitespace-break-spaces">{{
                message()
            }}</span>
            <WaitBar v-if="!failed" :value="progress?.()" :labelledby="`${ids}-text`" />
        </div>
        <details
            v-if="detail"
            class="mt-2 max-h-32 max-w-full overflow-auto break-words text-sm"
            @toggle="isDetailOpen = ($event.target as HTMLDetailsElement).open"
        >
            <!-- The shared chevron in place of the native marker. -->
            <summary
                class="focus-ring flex h-8 w-fit cursor-pointer list-none items-center gap-2 rounded-full pr-3 [&::-webkit-details-marker]:hidden"
            >
                <ChevronIcon :direction="isDetailOpen ? 'down' : 'right'" />
                {{ i18n.preview.errorDetails }}
            </summary>
            <p class="whitespace-break-spaces">{{ detail }}</p>
        </details>
    </BaseModal>
</template>
