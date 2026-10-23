<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { i18n } from '../i18n'
import { dismissNoticeCard, holdNotice, type Notice } from './notification'
import SeverityIcon from './SeverityIcon.vue'
import CloseIcon from './workspace/CloseIcon.vue'

// A notice card (Part 1 §1.4.1): the peek strip's surface (a 22 px pill), with a severity glyph, a
// white action pill and a close button; the start-up card is the same surface as a column of rows.
// A touch or pen drag sideways dismisses it. `over` draws it over a blocking dialog, on the menus'
// surface.
const props = defineProps<{ notice: Notice; over?: boolean }>()

const card = useTemplateRef<HTMLElement>('card')
const label = computed(() => i18n.value.modals.close)
const messageId = computed(() => `notice-card-${props.notice.id}`)

// The name and version join into the start-up card's heading; the other lines are its rows. In a
// narrow card the name gives way first, and when the version has no room beside it, the version
// takes a line of its own, so it is never cut (X-9).
const heading = computed(() =>
    (props.notice.lines ?? []).filter((line) => line.heading).map((line) => line.message()),
)
const rows = computed(() => (props.notice.lines ?? []).filter((line) => !line.heading))
// Rows with no heading over them (the switch card with a BGM line): the first row holds the ×.
const headless = computed(() => heading.value.length === 0)

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
    // A card that goes with its dialog gets no pointerleave or focusout: its holds go with it, or
    // the timeout would never run again.
    for (const source of held) holdNotice(source, false)
})

// The holds this instance placed, as other panes may show the same card.
const held = new Set<'hover' | 'focus'>()
const hold = (source: 'hover' | 'focus', on: boolean) => {
    if (on) held.add(source)
    else held.delete(source)
    holdNotice(source, on)
}

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

// Single cards: the 36 px controls of the peek strip, concentric with the 22 px corners (18 + 4).
const actionClass = 'btn btn-secondary h-9 min-w-0 max-w-full truncate rounded-full px-4'
const closeClass = 'ghost flex size-9 shrink-0 items-center justify-center rounded-full'
// Start-up rows: 32 px pills, concentric in the same corners (16 + 2 + 4).
const rowActionClass = 'btn btn-secondary ml-auto h-8 min-w-0 max-w-full truncate rounded-full px-4'
const rowCloseClass = 'ghost ml-1 flex size-8 shrink-0 items-center justify-center rounded-full'
// The text wraps at any length, and at the end of a sentence in browsers that balance it.
const messageClass =
    'min-w-0 flex-auto whitespace-break-spaces pr-3 [overflow-wrap:anywhere] [text-wrap:pretty]'

// Every row has the glyph column once any row has a severity, so the text edges agree.
const glyphColumn = computed(() => rows.value.some((line) => line.severity))
</script>

<template>
    <Transition appear name="notice-card">
        <div
            ref="card"
            data-notice-card
            class="notification-pill pointer-events-auto rounded-[1.375rem] p-1 text-sm text-fg shadow-xl outline outline-1 ring-1"
            :class="[
                over
                    ? 'bg-popup outline-[--popup-outline] ring-[--popup-ring]'
                    : 'bg-modal outline-transparent ring-fg/10',
                // The start-up card scrolls when its rows are taller than the room, with its × kept.
                notice.lines
                    ? [
                          'flex w-[min(36rem,100%)] touch-pan-y flex-col overflow-y-auto overscroll-contain',
                          over ? 'max-h-[calc(100dvh-2rem)]' : 'max-h-full',
                      ]
                    : [
                          // The message block keeps its one-line width as its basis, so the action
                          // and × wrap under it exactly when they cannot share its line.
                          'flex max-w-[min(36rem,100%)] touch-none',
                          notice.action ? 'flex-wrap items-center gap-y-1' : 'items-start',
                      ],
            ]"
            :style="style"
            @pointerenter="hold('hover', true)"
            @pointerleave="hold('hover', false)"
            @focusin="hold('focus', true)"
            @focusout="hold('focus', false)"
            @pointerdown="onDown"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onCancel"
        >
            <template v-if="notice.lines">
                <div
                    v-if="!headless"
                    class="sticky -top-1 z-10 flex shrink-0 items-center p-0.5"
                    :class="over ? 'bg-popup' : 'bg-modal'"
                >
                    <p
                        :id="messageId"
                        class="min-w-0 flex-1 pl-2.5 pr-2 text-xs font-bold text-fg/80"
                    >
                        <!-- The name truncates down to 32 px; then the version takes a line of
                             its own, wrapping at its space (or, narrower still, anywhere) rather
                             than lose a character. Each part after the name keeps its " · " in its
                             own 10 px start, which the list hides past its start edge when the
                             part begins a line (X-9). -->
                        <span class="block overflow-hidden"
                            ><span class="-ml-2.5 flex flex-wrap"
                                ><span
                                    class="min-w-[2.625rem] max-w-max grow basis-0 truncate pl-2.5"
                                    >{{ heading[0] }}</span
                                ><span
                                    v-for="(part, i) in heading.slice(1)"
                                    :key="i"
                                    class="relative min-w-0 pl-2.5 [overflow-wrap:anywhere]"
                                    ><span
                                        class="absolute inset-y-0 left-0 w-2.5 whitespace-pre text-center"
                                        >{{ ' · ' }}</span
                                    >{{ part }}</span
                                ></span
                            ></span
                        >
                    </p>
                    <button
                        type="button"
                        data-notice-close
                        :class="rowCloseClass"
                        :aria-label="label"
                        :aria-describedby="messageId"
                        :title="label"
                        @click="dismissNoticeCard()"
                    >
                        <CloseIcon class="size-3.5" />
                    </button>
                </div>
                <div
                    v-for="(line, i) in rows"
                    :key="i"
                    class="relative flex shrink-0 flex-wrap items-center px-0.5 py-1 last:pb-0.5"
                    :class="
                        headless && i === 0
                            ? 'pt-0.5'
                            : 'before:absolute before:inset-x-3 before:top-0 before:border-t before:border-fg/15'
                    "
                >
                    <div class="flex min-w-0 flex-auto items-start">
                        <span
                            v-if="glyphColumn"
                            class="flex h-8 w-[1.625rem] shrink-0 items-center pl-2.5"
                        >
                            <SeverityIcon
                                v-if="line.severity"
                                class="size-4"
                                :severity="line.severity"
                            />
                        </span>
                        <p
                            :id="headless && i === 0 ? messageId : undefined"
                            :class="[messageClass, 'py-1.5', glyphColumn ? 'pl-2' : 'pl-2.5']"
                        >
                            {{ line.message() }}
                        </p>
                    </div>
                    <!-- With no heading the first row also holds the ×, beside its action. -->
                    <div
                        v-if="headless && i === 0"
                        class="ml-auto flex max-w-full shrink-0 items-center"
                    >
                        <button
                            v-if="line.action"
                            type="button"
                            data-notice-action
                            :class="rowActionClass"
                            :title="line.action.label()"
                            @click="line.action.run()"
                        >
                            {{ line.action.label() }}
                        </button>
                        <button
                            type="button"
                            data-notice-close
                            :class="rowCloseClass"
                            :aria-label="label"
                            :aria-describedby="messageId"
                            :title="label"
                            @click="dismissNoticeCard()"
                        >
                            <CloseIcon class="size-3.5" />
                        </button>
                    </div>
                    <button
                        v-else-if="line.action"
                        type="button"
                        data-notice-action
                        :class="rowActionClass"
                        :title="line.action.label()"
                        @click="line.action.run()"
                    >
                        {{ line.action.label() }}
                    </button>
                </div>
            </template>
            <template v-else>
                <div
                    class="flex min-w-0 items-start"
                    :class="notice.action ? 'flex-auto' : 'flex-1'"
                >
                    <span v-if="notice.severity" class="flex h-9 shrink-0 items-center pl-3">
                        <SeverityIcon class="size-4" :severity="notice.severity" />
                    </span>
                    <p
                        :id="messageId"
                        :class="[messageClass, 'py-2', notice.severity ? 'pl-2' : 'pl-3']"
                    >
                        {{ notice.message?.() }}
                    </p>
                </div>
                <div
                    class="flex shrink-0 items-center gap-1"
                    :class="notice.action ? 'ml-auto max-w-full' : 'ml-1'"
                >
                    <button
                        v-if="notice.action"
                        type="button"
                        data-notice-action
                        :class="actionClass"
                        :title="notice.action.label()"
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
                        <CloseIcon class="size-3.5" />
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
