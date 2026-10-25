<script setup lang="ts">
import { i18n } from '../i18n'
import { runCommand } from './commands/runCommand'
import { save } from './commands/save'
import SeverityIcon from './SeverityIcon.vue'

// The bar over the chart on iOS and iPadOS while changes are not stored and no file holds them:
// they have no leave prompt, so this is the strong sign there. It takes no focus; the chip stays
// the way to the dialog.
</script>

<template>
    <div class="flex shrink-0 items-center gap-2 bg-header px-2 py-1 text-sm" data-not-stored-bar>
        <SeverityIcon class="size-4" severity="warning" />
        <span class="min-w-0 flex-1">{{ i18n.notSaving.bar }}</span>
        <button
            type="button"
            class="btn btn-secondary h-9 shrink-0 rounded-full px-4"
            @click="void runCommand(save, 'button')"
        >
            {{ i18n.prompt.save }}
        </button>
    </div>
</template>
