<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { i18n } from '../i18n'
import { openInSafeMode } from '../safe'
import { interpolate } from '../utils/interpolate'
import { SPINNER_DELAY_MS, registerGateElement, startBlank, startupGate } from './gate'

// The startup gate (Part 1 §1.4.2): a modal dialog, so the page behind it is inert, over the
// editor from the first frame. Nothing shows for the first 150 ms; then a spinner with the
// session's name. After 10 s it offers Start Blank and Open in Safe Mode, and a startup that
// throws shows the error's own text with Open in Safe Mode and Export Raw Data….

const dialog = useTemplateRef<HTMLDialogElement>('dialog')
const textId = useId()

// A failure is said at once; a quick open shows nothing at all.
const delayed = ref(false)
const shown = computed(() => delayed.value || startupGate.phase === 'error')

const text = computed(() => {
    if (startupGate.phase === 'error') return i18n.value.startup.error
    const name = startupGate.name
    return name === undefined
        ? i18n.value.startup.openingBlank
        : interpolate(() => i18n.value.startup.opening, name)()
})

let timer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
    const element = dialog.value
    if (!element) return
    registerGateElement(element)
    element.showModal()
    timer = setTimeout(() => {
        delayed.value = true
    }, SPINNER_DELAY_MS)
})

onBeforeUnmount(() => {
    clearTimeout(timer)
    registerGateElement(undefined)
    if (dialog.value?.open) dialog.value.close()
})

// The buttons arrive after the dialog opened: focus the first, as a dialog's default would.
watch(
    () => [startupGate.phase, startupGate.slow] as const,
    () => {
        void Promise.resolve().then(() => {
            dialog.value?.querySelector<HTMLElement>('button')?.focus()
        })
    },
    { flush: 'post' },
)

const buttonClass = 'btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4'
</script>

<template>
    <!-- Escape does not close it: there is no ×. -->
    <dialog
        ref="dialog"
        tabindex="-1"
        :aria-labelledby="textId"
        class="m-auto w-[calc(100%-1rem)] max-w-sm flex-col items-center gap-4 rounded-xl bg-modal p-5 text-center text-fg shadow-xl outline-none open:flex"
        :class="shown ? 'backdrop:bg-scrim/75' : 'opacity-0 backdrop:bg-transparent'"
        data-startup-gate
        @cancel.prevent
    >
        <template v-if="shown">
            <svg
                v-if="startupGate.phase === 'opening'"
                class="size-8 animate-spin text-fg motion-reduce:animate-none"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
            >
                <circle
                    cx="12"
                    cy="12"
                    r="9"
                    stroke="currentColor"
                    stroke-opacity="0.25"
                    stroke-width="3"
                />
                <path
                    d="M21 12a9 9 0 0 0-9-9"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                />
            </svg>
            <p
                :id="textId"
                :role="startupGate.phase === 'error' ? 'alert' : 'status'"
                class="whitespace-break-spaces"
            >
                {{ text }}
            </p>
            <p
                v-if="startupGate.phase === 'error'"
                class="max-h-40 w-full select-text overflow-y-auto break-words rounded-md bg-header p-2 text-start text-sm"
                data-startup-error
            >
                {{ startupGate.error }}
            </p>
            <p v-else-if="startupGate.slow">{{ i18n.startup.slow }}</p>
            <div
                v-if="startupGate.phase === 'error' || startupGate.slow"
                class="flex flex-wrap justify-center gap-2"
            >
                <button
                    v-if="startupGate.phase === 'opening'"
                    type="button"
                    :class="buttonClass"
                    @click="startBlank()"
                >
                    {{ i18n.startup.blank }}
                </button>
                <button type="button" :class="buttonClass" @click="openInSafeMode()">
                    {{ i18n.safe.open }}
                </button>
                <button
                    v-if="startupGate.phase === 'error' && startupGate.rawExport"
                    type="button"
                    :class="buttonClass"
                    @click="startupGate.rawExport.run()"
                >
                    {{ startupGate.rawExport.label() }}
                </button>
            </div>
        </template>
        <template v-else>
            <!-- Named for the dialog's label while nothing shows. -->
            <span :id="textId" class="sr-only">{{ text }}</span>
        </template>
    </dialog>
</template>
