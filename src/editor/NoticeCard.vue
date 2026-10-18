<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { i18n } from '../i18n'
import { dismissNoticeCard, holdNotice, type Notice } from './notification'
import CloseIcon from './workspace/CloseIcon.vue'

// A notice card (Part 1 §1.4.1): the peek bar's surface, with a white action pill and a close
// button; the start-up card is the same surface as a column of rows. A touch or pen drag sideways
// dismisses it. `over` draws it over a blocking dialog, on the menus' surface.
const props = defineProps<{ notice: Notice; over?: boolean }>()

const card = useTemplateRef<HTMLElement>('card')
const label = computed(() => i18n.value.modals.close)
const messageId = computed(() => `notice-card-${props.notice.id}`)

// The name and version join into the start-up card's heading; the other lines are its rows.
const heading = computed(() =>
    (props.notice.lines ?? [])
        .filter((line) => line.heading)
        .map((line) => line.message())
        .join(' · '),
)
const rows = computed(() => (props.notice.lines ?? []).filter((line) => !line.heading))

// Swipe: the card follows the finger sideways, and goes past 30% of its width or on a flick.
const SWIPE_FRACTION = 0.3
const FLICK_PX_PER_MS = 0.5
const TAP_SLOP = 8
const OUT_MS = 150
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

type Swipe = { x: number; opacity: number; animate: boolean }
const swipe = ref<Swipe>()
let width = 1
let drag:
    { id: number; x: number; last: number; at: number; velocity: number; held: boolean } | undefined
let timer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => {
    clearTimeout(timer)
})

const onDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || !event.isPrimary || swipe.value?.animate) return
    drag = {
        id: event.pointerId,
        x: event.clientX,
        last: event.clientX,
        at: event.timeStamp,
        velocity: 0,
        held: false,
    }
}

const onMove = (event: PointerEvent) => {
    if (event.pointerId !== drag?.id || !card.value) return
    const moved = event.clientX - drag.x
    if (!drag.held) {
        if (Math.abs(moved) <= TAP_SLOP) return
        // From here the gesture is the card's, so a button under the finger does not click.
        drag.held = true
        width = card.value.getBoundingClientRect().width || 1
        try {
            card.value.setPointerCapture(event.pointerId)
        } catch {
            // A pointer that is gone needs no capture.
        }
    }
    const dt = event.timeStamp - drag.at
    if (dt > 0) drag.velocity = (event.clientX - drag.last) / dt
    drag.last = event.clientX
    drag.at = event.timeStamp
    swipe.value = {
        x: moved,
        opacity: 1 - 0.6 * Math.min(1, Math.abs(moved) / width),
        animate: false,
    }
}

const onUp = (event: PointerEvent) => {
    if (event.pointerId !== drag?.id) return
    const { held, velocity } = drag
    drag = undefined
    if (!held || !swipe.value) return
    const { x } = swipe.value
    const gone =
        Math.abs(x) > SWIPE_FRACTION * width ||
        (Math.abs(velocity) > FLICK_PX_PER_MS && Math.sign(velocity) === Math.sign(x))
    if (gone) {
        // On in its direction, or only fading out under reduced motion.
        swipe.value = {
            x: reduced() ? x : Math.sign(x) * (width + 16),
            opacity: 0,
            animate: true,
        }
        timer = setTimeout(dismissNoticeCard, OUT_MS)
    } else {
        springBack()
    }
}

const springBack = () => {
    swipe.value = { x: 0, opacity: 1, animate: true }
    timer = setTimeout(() => {
        swipe.value = undefined
    }, OUT_MS)
}

const onCancel = (event: PointerEvent) => {
    if (event.pointerId !== drag?.id) return
    const { held } = drag
    drag = undefined
    if (held) springBack()
}

const style = computed(() => {
    const value = swipe.value
    if (!value) return undefined
    return {
        transform: `translateX(${value.x}px)`,
        opacity: value.opacity,
        transition: value.animate
            ? `transform ${OUT_MS}ms ease-out, opacity ${OUT_MS}ms ease-out`
            : undefined,
    }
})

const actionClass =
    'h-8 shrink-0 rounded-full bg-button px-4 font-bold shadow-md outline-none transition-colors hover:bg-header-hover focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-modal active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11'
const closeClass =
    'flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-band-hover focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:size-11'
</script>

<template>
    <Transition appear name="notice-card">
        <div
            ref="card"
            data-notice-card
            class="notification-pill pointer-events-auto touch-none rounded-3xl py-1 pl-4 pr-1 text-sm text-fg outline outline-1 ring-1 ring-[--popup-ring]"
            :class="[
                over
                    ? 'bg-popup shadow-xl outline-[--popup-outline]'
                    : 'bg-modal shadow-md outline-transparent',
                notice.lines
                    ? 'flex w-[min(36rem,100%)] flex-col'
                    : [
                          'flex max-w-[min(36rem,100%)] items-center justify-end gap-x-2 gap-y-1',
                          notice.action ? 'flex-wrap' : '',
                      ],
            ]"
            :style="style"
            @pointerenter="holdNotice('hover', true)"
            @pointerleave="holdNotice('hover', false)"
            @focusin="holdNotice('focus', true)"
            @focusout="holdNotice('focus', false)"
            @pointerdown="onDown"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onCancel"
        >
            <template v-if="notice.lines">
                <div class="flex items-center gap-2">
                    <p
                        :id="messageId"
                        class="min-w-0 flex-1 truncate py-1.5 text-xs font-bold text-fg/80"
                    >
                        {{ heading }}
                    </p>
                    <button
                        type="button"
                        data-notice-close
                        :class="closeClass"
                        :aria-label="label"
                        :aria-describedby="messageId"
                        :title="label"
                        @click="dismissNoticeCard()"
                    >
                        <CloseIcon class="size-3.5 [@media(pointer:coarse)]:size-4" />
                    </button>
                </div>
                <div
                    v-for="(line, i) in rows"
                    :key="i"
                    class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 border-t border-fg/15 py-0.5"
                >
                    <p
                        class="min-w-0 whitespace-break-spaces py-1.5 pr-3"
                        :class="line.action ? 'mr-auto max-w-[22rem] flex-[1_1_auto]' : 'flex-1'"
                    >
                        {{ line.message() }}
                    </p>
                    <button
                        v-if="line.action"
                        type="button"
                        data-notice-action
                        :class="actionClass"
                        @click="line.action.run()"
                    >
                        {{ line.action.label() }}
                    </button>
                </div>
            </template>
            <template v-else>
                <p
                    :id="messageId"
                    class="min-w-0 whitespace-break-spaces py-1.5"
                    :class="
                        notice.action
                            ? 'mr-auto max-w-[22rem] flex-[1_1_auto]'
                            : 'max-w-[32rem] flex-1'
                    "
                >
                    {{ notice.message?.() }}
                </p>
                <div class="flex shrink-0 items-center gap-1">
                    <button
                        v-if="notice.action"
                        type="button"
                        data-notice-action
                        :class="actionClass"
                        @click="notice.action.run()"
                    >
                        {{ notice.action.label() }}
                    </button>
                    <button
                        type="button"
                        data-notice-close
                        :class="closeClass"
                        :aria-label="label"
                        :aria-describedby="messageId"
                        :title="label"
                        @click="dismissNoticeCard()"
                    >
                        <CloseIcon class="size-3.5 [@media(pointer:coarse)]:size-4" />
                    </button>
                </div>
            </template>
        </div>
    </Transition>
</template>

<style scoped>
.notification-pill {
    z-index: 100;
}

.notice-card-enter-active {
    transition:
        opacity 150ms ease-out,
        transform 150ms ease-out;
}

.notice-card-enter-from {
    opacity: 0;
    transform: translateY(0.5rem);
}
</style>
