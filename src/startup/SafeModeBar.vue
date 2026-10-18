<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import { i18n } from '../i18n'
import { leaveSafeMode } from '../safe'

// The bar over the editor in safe mode (Part 1 §1.4.2): nothing is stored, and Leave Safe Mode
// goes back to the editor, after the in-app not-stored prompt when the tab has edits (registered
// by `editor/switch.ts` with setLeaveSafeModeGuard).

// The editor sits below the bar, whatever height its text takes in a narrow window.
const bar = useTemplateRef<HTMLElement>('bar')
let observer: ResizeObserver | undefined
onMounted(() => {
    const element = bar.value
    if (!element) return
    const measure = () => {
        document.documentElement.style.setProperty(
            '--safe-bar-height',
            `${element.getBoundingClientRect().height}px`,
        )
    }
    measure()
    observer = new ResizeObserver(measure)
    observer.observe(element)
})
onBeforeUnmount(() => {
    observer?.disconnect()
    document.documentElement.style.removeProperty('--safe-bar-height')
})
</script>

<template>
    <div
        ref="bar"
        class="fixed inset-x-0 top-0 z-[60] flex min-h-10 flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-header px-3 py-1 text-center text-sm font-bold shadow-band [@media(pointer:coarse)]:min-h-12"
        data-safe-bar
    >
        <span class="min-w-0">{{ i18n.safe.bar }}</span>
        <button
            type="button"
            class="h-8 shrink-0 rounded-full bg-button px-3 shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-10"
            @click="void leaveSafeMode()"
        >
            {{ i18n.safe.leave }}
        </button>
    </div>
</template>
