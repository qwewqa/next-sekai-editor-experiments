import { nextTick, ref, watch } from 'vue'
import { isAppActive } from './activity'
import { openFrame } from './frame'
import { timedSince } from './perf/probe'

export const time = ref({
    now: performance.now() / 1000,
    delta: 0,
})

let frame = 0

const update = (timestamp: number) => {
    frame = 0
    if (!isAppActive.value) return
    // Motion follows the frame timeline, not varying callback queue delay.
    // The first frame after activation may predate its wall-time reset.
    const now = Math.max(time.value.now, timestamp / 1000)

    // Draws invalidated by this tick render in this frame, after Vue's flush.
    const close = timedSince('clockFrame', openFrame(timestamp))
    time.value = {
        now,
        delta: now - time.value.now,
    }

    frame = requestAnimationFrame(update)
    void nextTick().finally(close)
}

const stop = watch(
    isAppActive,
    (active) => {
        cancelAnimationFrame(frame)
        frame = 0
        if (!active) return

        // Playback catches up to real time, while gestures and inertia must not
        // integrate the entire time spent away as one enormous animation frame.
        time.value = { now: Math.max(time.value.now, performance.now() / 1000), delta: 0 }
        frame = requestAnimationFrame(update)
    },
    { immediate: true, flush: 'sync' },
)

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        stop()
        cancelAnimationFrame(frame)
    })
}
