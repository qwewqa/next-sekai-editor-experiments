<script lang="ts">
// How far the notice last taken away had faded. Moving a notice to another place, such as from a
// closing dialog to the pane or into the elevation editor, draws it again, and the fade carries on
// from there, paused as the page pauses it.
let left: { id: number; time: CSSNumberish } | undefined
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import type { Notice } from './notification'
import SeparatedText from './SeparatedText.vue'

// Quick feedback, as v0.5.22 drew it: a mint pill that fades to a ghost over a second, with no input.
const props = defineProps<{ notice: Notice }>()

const pill = useTemplateRef<HTMLElement>('pill')
const fade = () => pill.value?.getAnimations()[0]
onMounted(() => {
    const animation = fade()
    if (animation && left?.id === props.notice.id) animation.currentTime = left.time
})
onBeforeUnmount(() => {
    const time = fade()?.currentTime
    left = time == null ? undefined : { id: props.notice.id, time }
})
</script>

<template>
    <div
        ref="pill"
        class="notification max-w-full min-w-0 rounded-full px-6 py-2 text-center wrap-anywhere whitespace-break-spaces"
    >
        <SeparatedText :text="notice.message?.() ?? ''" />
    </div>
</template>

<style scoped>
.notification {
    animation-name: fade;
    animation-duration: 1s;
    animation-fill-mode: forwards;
}

@keyframes fade {
    0% {
        z-index: 100;
        /* Dark text on mint, as on every accent fill (8.9:1). */
        color: var(--color-on-accent);
        background-color: var(--color-accent);
    }

    99% {
        z-index: 100;
    }

    100% {
        color: rgb(255 255 255 / 0.25);
        background-color: transparent;
    }
}
</style>
