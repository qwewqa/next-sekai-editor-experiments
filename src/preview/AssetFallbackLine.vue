<script setup lang="ts">
import { computed } from 'vue'
import { showPreviewAssets } from '../editor/commands/previewAssets/modal'
import CloseIcon from '../editor/workspace/CloseIcon.vue'
import { i18n } from '../i18n'
import { panelText } from './assets/fallbackText'
import { dismissFallback, panelFallbacks } from './assets/active'

// The small line a fallback gets in the panel (Part 2, 2.4.2): at load or after the user's own
// change, once per choice and reason.
const strings = computed(() => i18n.value.commands.previewAssets)
</script>

<template>
    <div
        v-if="panelFallbacks.length"
        class="pointer-events-none absolute inset-x-2 top-2 z-20 flex flex-col items-start gap-1"
        data-asset-fallbacks
    >
        <div
            v-for="fallback in panelFallbacks"
            :key="fallback.key"
            class="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl bg-modal/95 py-1 pl-3 pr-1 text-sm text-fg shadow-md"
            :data-asset-fallback="fallback.type"
        >
            <p class="min-w-[10rem] flex-1 py-0.5" data-asset-fallback-text>
                {{ panelText(fallback) }}
            </p>
            <!-- Below the sentence where the panel is narrow, at its right. -->
            <div class="ml-auto flex shrink-0 items-center gap-1">
                <button
                    type="button"
                    class="h-7 shrink-0 rounded-full bg-button px-3 shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11"
                    data-asset-fallback-open
                    @click="showPreviewAssets(fallback.type)"
                >
                    {{ strings.title }}
                </button>
                <button
                    type="button"
                    class="flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-band-hover focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:size-11"
                    :aria-label="i18n.modals.close"
                    :title="i18n.modals.close"
                    data-asset-fallback-dismiss
                    @click="dismissFallback(fallback.key)"
                >
                    <CloseIcon class="size-3.5" />
                </button>
            </div>
        </div>
    </div>
</template>
