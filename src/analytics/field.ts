import { watch } from 'vue'
import { isPlaying } from '../player'
import { capCount, capSeconds } from './catalogue'
import { bucket } from './scales'
import * as tally from './tally'

// Field performance (docs/analytics.md): long frames and slow inputs from observers that run only
// for slow entries, and the visible and playing time as spans. No timer and no polling; nothing
// here runs per frame.

// Chromium's count of interactions; other browsers have none.
const interactionCount = () => (performance as { interactionCount?: number }).interactionCount

export const startField = () => {
    let visibleSince: number | undefined =
        document.visibilityState === 'visible' ? performance.now() : undefined
    let visibleTotal = 0
    let playSince: number | undefined
    let playTotal = 0
    let sentVisible = 0
    let sentPlay = 0
    let sentInteractions = interactionCount() ?? 0

    const stopWatching = watch(
        isPlaying,
        (playing) => {
            if (playing) playSince = performance.now()
            else if (playSince !== undefined) {
                playTotal += performance.now() - playSince
                playSince = undefined
            }
        },
        { immediate: true },
    )

    const observers: PerformanceObserver[] = []
    const observe = (
        type: string,
        callback: (count: number, durations: number[]) => void,
        extra = {},
    ) => {
        try {
            if (!PerformanceObserver.supportedEntryTypes.includes(type)) return false
            const observer = new PerformanceObserver((list) => {
                const entries = list.getEntries()
                callback(
                    entries.length,
                    entries.map((entry) => entry.duration),
                )
            })
            observer.observe({ type, ...extra })
            observers.push(observer)
            return true
        } catch {
            return false
        }
    }
    const loafSupported = observe('long-animation-frame', (_count, durations) => {
        const state = isPlaying.value ? 'playing' : tally.isBusy() ? 'busy' : 'other'
        for (const duration of durations)
            tally.bump(`perf.frames.${state}.${bucket('frame', duration)}`)
    })
    observe(
        'event',
        (count) => {
            tally.bump('perf.slowInputs', count)
        },
        { durationThreshold: 200 },
    )

    return {
        /** The page was shown or hidden. */
        visibility: () => {
            const now = performance.now()
            if (document.visibilityState === 'hidden') {
                if (visibleSince !== undefined) visibleTotal += now - visibleSince
                visibleSince = undefined
            } else visibleSince ??= now
        },
        /**
         * The `perf` event’s other measures, for the time since the last call. The inputs are the
         * browser’s count of interactions, else the commands run (`commands`).
         */
        measures: (commands: number) => {
            const now = performance.now()
            const visible = visibleTotal + (visibleSince === undefined ? 0 : now - visibleSince)
            const played = playTotal + (playSince === undefined ? 0 : now - playSince)
            const interactions = interactionCount()
            const measures = {
                loafSupported,
                cores: bucket('cores', navigator.hardwareConcurrency),
                // A count is capped at 9999 and a time at a day, or a long visit would lose its whole `perf` event.
                visibleTime: capSeconds(visible - sentVisible),
                playSeconds: capSeconds(played - sentPlay),
                interactions: capCount(
                    interactions === undefined ? commands : interactions - sentInteractions,
                ),
            }
            sentVisible = visible
            sentPlay = played
            sentInteractions = interactions ?? sentInteractions
            return measures
        },
        stop: () => {
            stopWatching()
            for (const observer of observers) observer.disconnect()
        },
    }
}
