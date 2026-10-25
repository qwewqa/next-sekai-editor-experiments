import { computed, nextTick, ref, shallowReactive, watch } from 'vue'
import { isAppActive } from './activity'
import { openFrame } from './frame'
import { timedSince } from './perf/probe'

/**
 * The app clock's last tick: its frame time and the time since the tick before. The clock ticks
 * once per animation frame, only while something registered with `keepClockWhile` needs it, so
 * read the current time with `clockNow`.
 */
export const time = ref({
    now: performance.now() / 1000,
    delta: 0,
})

// The clock's own time, which `time` publishes on each tick.
let last = time.value.now
// The frame interval while ticking, and the last tick's timestamp while ticks run back to back.
let interval = 1 / 60
let previous: number | undefined
let frame = 0

const needs = shallowReactive(new Set<() => boolean>())
const isNeeded = computed(() => [...needs].some((need) => need()))

/** Runs the clock while `need` returns true; returns a function that removes it. */
export const keepClockWhile = (need: () => boolean) => {
    needs.add(need)
    return () => {
        needs.delete(need)
    }
}

// A stopped clock reads the time one frame before now, where a running clock's last tick would
// be, so the first frame after it wakes moves by about one frame, as every later frame does.
const catchUp = () => {
    if (!frame) last = Math.max(last, performance.now() / 1000 - interval)
}

/** The clock's time: its last tick's, or while it is stopped, a frame before now. */
export const clockNow = () => {
    catchUp()
    return last
}

const update = (timestamp: number) => {
    frame = 0
    if (!isAppActive.value) return
    if (previous !== undefined && timestamp > previous)
        interval = Math.min((timestamp - previous) / 1000, 1 / 30)
    previous = timestamp
    // Motion follows the frame timeline, not varying callback queue delay.
    // The first frame after activation or a wake may predate its wall-time reset.
    const now = Math.max(last, timestamp / 1000)

    // Draws invalidated by this tick render in this frame, after Vue's flush.
    const close = timedSince('clockFrame', openFrame(timestamp))
    time.value = {
        now,
        delta: now - last,
    }
    last = now

    if (isNeeded.value) frame = requestAnimationFrame(update)
    void nextTick().finally(() => {
        close()
        // What this tick finished, such as an ease, needs no further frame.
        if (!frame || isNeeded.value) return
        cancelAnimationFrame(frame)
        frame = 0
    })
}

const wake = () => {
    if (frame || !isAppActive.value) return
    catchUp()
    previous = undefined
    frame = requestAnimationFrame(update)
}

const stopNeeds = watch(
    isNeeded,
    (needed) => {
        if (needed) wake()
    },
    { flush: 'sync' },
)

const stop = watch(
    isAppActive,
    (active) => {
        cancelAnimationFrame(frame)
        frame = 0
        previous = undefined
        if (!active) return

        // Playback catches up to real time, while gestures and inertia must not
        // integrate the entire time spent away as one enormous animation frame.
        last = Math.max(last, performance.now() / 1000)
        time.value = { now: last, delta: 0 }
        if (isNeeded.value) frame = requestAnimationFrame(update)
    },
    { immediate: true, flush: 'sync' },
)

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        stopNeeds()
        stop()
        cancelAnimationFrame(frame)
    })
}
