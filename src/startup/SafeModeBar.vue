<script setup lang="ts">
import { checkState } from '../history'
import { i18n } from '../i18n'
import { leaveSafeMode } from '../safe'

// The bar over the editor in safe mode (Part 1 §1.4.2): nothing is stored, and Leave Safe Mode
// goes back to the editor, after the in-app not-stored prompt when the tab has edits (today's
// changes prompt until that one registers with setLeaveSafeModeGuard).

const confirmLeave = async () => (await checkState()) === true
</script>

<template>
    <div
        class="fixed inset-x-0 top-0 z-[60] flex h-10 items-center justify-center gap-3 bg-header px-3 text-sm font-bold shadow-band [@media(pointer:coarse)]:h-12"
        data-safe-bar
    >
        <span class="min-w-0 truncate">{{ i18n.safe.bar }}</span>
        <button
            type="button"
            class="h-8 shrink-0 rounded-full bg-button px-3 shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-10"
            @click="void leaveSafeMode(confirmLeave)"
        >
            {{ i18n.safe.leave }}
        </button>
    </div>
</template>
