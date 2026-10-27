import { watch } from 'vue'
import { areGroupsStagesSideBySide, isPanelVisible } from '../editor/workspace'
import { isPlaying } from '../player'
import { previewHost } from '../preview/worker/host'
import { settings } from '../settings'
import { capCount, capSeconds, type EventData } from './catalogue'
import { createSpan, createStateLog, takeSeconds, type FrameState } from './intervals'
import { bucket } from './scales'
import { renderScaleOf } from './snapshot'
import * as tally from './tally'

// Field performance (docs/analytics.md): long frames and slow events from observers that run only
// for slow entries, the visible and playing time as spans, and the preview's host, its render scale
// and whether Groups and Stages are side by side as values that can change within an interval. No
// timer and no polling; nothing here runs per frame.

/** How far back a long frame is still placed by the state it began in. */
const HISTORY_MS = 30_000

// Chromium's count of interactions; other browsers have none.
const interactionCount = () => (performance as { interactionCount?: number }).interactionCount

const hostNow = (): NonNullable<EventData<'perf'>['previewHost']> => {
    if (!isPanelVisible('preview')) return 'none'
    const kind: string = previewHost.kind
    return kind === 'main' || kind === 'worker' ? kind : 'unknown'
}

const scaleNow = (): NonNullable<EventData<'perf'>['previewRenderScale']> =>
    Number.isFinite(settings.previewRenderScale)
        ? renderScaleOf(settings.previewRenderScale)
        : 'unknown'

// Shown side by side, not only allowed by the setting.
const sideBySideNow = (): NonNullable<EventData<'perf'>['groupsStagesSideBySide']> =>
    areGroupsStagesSideBySide.value ? 'on' : 'off'

export const startField = () => {
    const isVisible = () => document.visibilityState === 'visible'
    let visibleSince: number | undefined = isVisible() ? performance.now() : undefined
    let visibleTotal = 0
    let sentVisible = 0
    let sentInteractions = interactionCount() ?? 0

    // Playback counts only while the page is visible.
    let playSince: number | undefined =
        isPlaying.value && isVisible() ? performance.now() : undefined
    let playTotal = 0
    let sentPlay = 0

    // The state each long frame is sorted by, from the time it began.
    const stateNow = (): FrameState =>
        playSince !== undefined ? 'playing' : tally.isBusy() ? 'busy' : 'other'
    const states = createStateLog(stateNow(), performance.now())
    const syncPlay = () => {
        const now = performance.now()
        const playing = isPlaying.value && isVisible()
        if (playing && playSince === undefined) playSince = now
        else if (!playing && playSince !== undefined) {
            playTotal += now - playSince
            playSince = undefined
        }
        states.set(stateNow(), now)
    }
    // Synchronous, so the time of a change is the change's and a round trip within a tick is seen.
    // Each reads a few scalars.
    const stopWatching = watch(isPlaying, syncPlay, { flush: 'sync' })
    tally.watchBusy(() => {
        states.set(stateNow(), performance.now())
    })

    const host = createSpan(hostNow())
    const renderScale = createSpan(scaleNow())
    const stopHost = watch(hostNow, host.see, { flush: 'sync' })
    const stopScale = watch(scaleNow, renderScale.see, { flush: 'sync' })
    const sideBySide = createSpan(sideBySideNow())
    const stopSideBySide = watch(sideBySideNow, sideBySide.see, { flush: 'sync' })

    let unclassified = false
    let lastFrameStart = 0
    const countFrames = (entries: readonly PerformanceEntry[]) => {
        for (const { startTime, duration } of entries) {
            const state = states.at(startTime)
            if (state) tally.bump(`perf.frames.${state}.${bucket('frame', duration)}`)
            else {
                tally.bump('perf.frames.unclassified')
                unclassified = true
            }
            lastFrameStart = Math.max(lastFrameStart, startTime)
        }
        // Later entries begin no earlier than this one.
        states.trim(lastFrameStart)
    }
    const countEvents = (entries: readonly PerformanceEntry[]) => {
        for (const { duration } of entries)
            tally.bump(`perf.slowEvents.${bucket('slowEvent', duration)}`)
    }

    const observers: PerformanceObserver[] = []
    const observe = (
        type: string,
        count: (entries: readonly PerformanceEntry[]) => void,
        extra = {},
    ) => {
        try {
            if (!PerformanceObserver.supportedEntryTypes.includes(type)) return
            const observer = new PerformanceObserver((list) => {
                count(list.getEntries())
            })
            observer.observe({ type, ...extra })
            observers.push(observer)
            return { observer, count }
        } catch {
            return
        }
    }
    const frames = observe('long-animation-frame', countFrames)
    // 104 ms is where Event Timing's 8 ms rounding puts a response of 100 ms or more.
    const events = observe('event', countEvents, { durationThreshold: 104 })

    return {
        /** The page was shown or hidden. */
        visibility: () => {
            const now = performance.now()
            if (!isVisible()) {
                if (visibleSince !== undefined) visibleTotal += now - visibleSince
                visibleSince = undefined
            } else visibleSince ??= now
            syncPlay()
        },
        /** Counts the entries the browser has not yet delivered, so a send holds its whole interval. */
        flush: () => {
            for (const watched of [frames, events]) {
                const pending = watched?.observer.takeRecords()
                if (pending?.length) watched?.count(pending)
            }
            states.trim(Math.max(lastFrameStart, performance.now() - HISTORY_MS))
        },
        /** The `perf` event's other measures, for the time since the last call. */
        measures: (): EventData<'perf'> => {
            const now = performance.now()
            const visible = visibleTotal + (visibleSince === undefined ? 0 : now - visibleSince)
            const played = playTotal + (playSince === undefined ? 0 : now - playSince)
            const interactions = interactionCount()
            const playing = takeSeconds(played, sentPlay)
            const measures: EventData<'perf'> = {
                loafSupported: frames !== undefined,
                eventTimingSupported: events !== undefined,
                frameAttribution: unclassified ? 'partial' : 'full',
                // A count is capped at 9999 and a time at a day, or a long visit would lose its whole `perf` event.
                visibleTime: capSeconds(visible - sentVisible),
                playSeconds: playing.seconds,
                // Only the browser's count: the commands run are not a stand-in for interactions.
                ...(interactions !== undefined && {
                    interactions: capCount(interactions - sentInteractions),
                }),
                previewHost: host.take(hostNow()),
                previewRenderScale: renderScale.take(scaleNow()),
                groupsStagesSideBySide: sideBySide.take(sideBySideNow()),
            }
            sentVisible = visible
            sentPlay = playing.sent
            sentInteractions = interactions ?? sentInteractions
            unclassified = false
            return measures
        },
        stop: () => {
            stopWatching()
            stopHost()
            stopScale()
            stopSideBySide()
            tally.watchBusy(undefined)
            for (const observer of observers) observer.disconnect()
        },
    }
}
