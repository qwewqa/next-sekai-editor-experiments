<script setup lang="ts">
import { autoscrollMarker } from './controls/autoscroll'
</script>

<template>
    <Teleport to="body">
        <div
            v-if="autoscrollMarker"
            class="autoscroll-marker pointer-events-none fixed z-50 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-popup text-fg shadow-md outline outline-1 outline-[--popup-outline] ring-1 ring-[--popup-ring]"
            :style="{ left: `${autoscrollMarker.x}px`, top: `${autoscrollMarker.y}px` }"
            aria-hidden="true"
        >
            <svg viewBox="0 0 32 32" class="size-full" fill="currentColor">
                <path d="M16 6 20 11H12ZM16 26 20 21H12Z" />
                <path v-if="autoscrollMarker.sideways" d="M6 16 11 12V20ZM26 16 21 12V20Z" />
                <circle cx="16" cy="16" r="2" />
            </svg>
        </div>
    </Teleport>
</template>
