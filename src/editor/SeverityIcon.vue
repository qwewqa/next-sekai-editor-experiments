<script setup lang="ts">
import type { NoticeSeverity } from './notification'

// A notice card's severity glyph (colour system §5.6): Font Awesome's triangle-exclamation for a
// warning, circle-exclamation for an error and circle-info for info. The message carries the
// meaning, so this is a second cue; the caller sets its size.
defineProps<{ severity: NoticeSeverity }>()

const PATHS: Record<NoticeSeverity, string> = {
    warning:
        'M256 32c14.2 0 27.3 7.5 34.5 19.8l216 368c7.3 12.4 7.3 27.7 .2 40.1S486.3 480 472 480L40 480c-14.3 0-27.6-7.7-34.7-20.1s-7-27.8 .2-40.1l216-368C228.7 39.5 241.8 32 256 32zm0 128c-13.3 0-24 10.7-24 24l0 112c0 13.3 10.7 24 24 24s24-10.7 24-24l0-112c0-13.3-10.7-24-24-24zm32 224a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z',
    error: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24l0 112c0 13.3-10.7 24-24 24s-24-10.7-24-24l0-112c0-13.3 10.7-24 24-24zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z',
    info: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM216 336h24V272H216c-13.3 0-24-10.7-24-24s10.7-24 24-24h48c13.3 0 24 10.7 24 24v88h8c13.3 0 24 10.7 24 24s-10.7 24-24 24H216c-13.3 0-24-10.7-24-24s10.7-24 24-24zm40-208a32 32 0 1 1 0 64 32 32 0 1 1 0-64z',
}
const COLORS: Record<NoticeSeverity, string> = {
    warning: 'text-warning',
    error: 'text-danger',
    info: 'text-info',
}
</script>

<template>
    <svg
        class="shrink-0 fill-current forced-colors:text-[CanvasText]"
        :class="COLORS[severity]"
        :data-severity="severity"
        viewBox="0 0 512 512"
        aria-hidden="true"
    >
        <!--! Font Awesome Free 6.6.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2024 Fonticons, Inc. -->
        <path :d="PATHS[severity]" />
    </svg>
</template>
