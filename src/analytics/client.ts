import { watch } from 'vue'
import { SITE } from '../buildInfo'
import { builtInCommandNames } from '../editor/commands/names'
import { isPanelVisible, workspaceSize } from '../editor/workspace'
import { onHistoryAction, type HistoryAction } from '../history/actions'
import { STACK_CAP } from '../history/cap'
import { liveState, stackLength } from '../history/stack'
import { launch } from '../launch'
import { detection, isStandalone } from '../platform/detect'
import { isPlaying } from '../player'
import { previewHost } from '../preview/worker/host'
import { hasDefaultValue, settings } from '../settings'
import {
    bucket,
    capCount,
    capMs,
    chartObjects,
    fromRaw,
    isValidEvent,
    MAX_KEYS,
    measured,
    type EventData,
    type EventName,
} from './catalogue'
import type { AnalyticsTarget } from './config'
import { device } from './device'
import { startField } from './field'
import { editKey, requestFields, requestItem, startKind } from './rules'
import { createSender, SEND_INTERVAL, type Item, type SendMode } from './sender'
import { settingsSnapshot } from './snapshot'
import * as status from './status'
import * as tally from './tally'

// The usage statistics' client, loaded after startup when they are on (start.ts). It builds the
// visit's events, sends them by the sender's rules once the visit is armed, and stops at once
// when the user turns the statistics off. Failures stay silent: nothing here reaches the user.

/** The page the visit came from, as its origin only, when it is another site. */
const referrerOrigin = () => {
    try {
        const origin = new URL(document.referrer).origin
        return origin === location.origin || origin === 'null' ? '' : origin
    } catch {
        return ''
    }
}

const visit = (): EventData<'visit'> => {
    const language = navigator.language.split('-')[0]?.toLowerCase() ?? ''
    const { width, height } = workspaceSize.value
    const { cores, deviceMemory, dpr, viewport } = device()
    return {
        version: launch.release,
        site: SITE === 'test' ? 'test' : 'production',
        ...detection(),
        standalone: isStandalone(),
        touch: matchMedia('(pointer: coarse)').matches,
        ...(viewport && { viewport, viewportPortrait: height > width }),
        ...(dpr && { dpr }),
        ...(cores && { cores }),
        ...(deviceMemory && { deviceMemory }),
        browserLanguage: /^[a-z]{2,3}$/.test(language) ? language : 'other',
        returning: launch.isExistingUser,
        updated: launch.updated,
    }
}

const countEdit = (action: HistoryAction) => {
    const key = editKey(action)
    if (key) tally.bump(`edits.${key}`)
}

/** How the visit began, from the load events and the tab's claim. */
const startOf = () =>
    startKind(
        status.isSafeMode(),
        new Set<string>(status.loadEvents.value.map((event) => event.kind)),
        tally.wasNoted('reload'),
    )

const navigationTypes = {
    navigate: 'navigate',
    reload: 'reload',
    back_forward: 'back_forward',
    prerender: 'other',
} as const

/** How the document came: a guess from the browser's timing entry, `unknown` when unclear. */
const documentDelivery = (
    entry: PerformanceNavigationTiming | undefined,
): NonNullable<EventData<'startup'>['documentDelivery']> => {
    if (!entry) return 'unknown'
    if (entry.workerStart > 0) return 'serviceWorker'
    const delivery = (entry as { deliveryType?: string }).deliveryType
    if (delivery === 'cache') return 'cache'
    if (entry.transferSize > 0) return 'network'
    return entry.decodedBodySize > 0 ? 'cache' : 'unknown'
}

const startupEvent = (): EventData<'startup'> | undefined => {
    const started = tally.startup()
    if (!started) return
    const found = Object.fromEntries(
        status.loadEvents.value.map((event) => [`found.${event.kind}`, true]),
    )
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    const discarded = (document as { wasDiscarded?: unknown }).wasDiscarded
    return {
        start: startOf(),
        outcome: started.outcome,
        // A hidden page is throttled, which inflates the time; a failed startup has no time.
        ...(started.hidden || started.outcome === 'error' ? {} : { ready: capMs(started.at) }),
        hidden: started.hidden,
        navigation: entry
            ? ((navigationTypes as Record<string, EventData<'startup'>['navigation']>)[
                  entry.type
              ] ?? 'other')
            : 'unknown',
        documentDelivery: documentDelivery(entry),
        ...(typeof discarded === 'boolean' && { wasDiscarded: discarded }),
        ...device(),
        ...found,
    }
}

/** What Recent Sessions and the browser say about storage. Rejects only on a bug. */
const storageEvent = async (): Promise<EventData<'storage'> | undefined> => {
    const current = status.storageStatus.value
    if (!current) return
    // An insecure page has no storage manager.
    const manager = (navigator as { storage?: Partial<StorageManager> }).storage
    const [estimate, persisted] = await Promise.all([
        manager?.estimate?.().catch(() => undefined),
        manager?.persisted?.().catch(() => undefined),
    ])
    const { usage, quota } = estimate ?? {}
    const sessions = status.recentSessionCount.value
    const run = status.pressureRuns.at(-1)
    const share =
        usage !== undefined && quota !== undefined && quota > 0
            ? measured('usageShare', (usage * 100) / quota)
            : undefined
    return {
        mode: current.mode,
        ...(current.reason && { reason: current.reason }),
        persisted: persisted === undefined ? 'unsupported' : persisted ? 'granted' : 'not',
        ...(measured('size', usage) && { usage: measured('size', usage) }),
        ...(measured('quota', quota) && { quota: measured('quota', quota) }),
        ...(share && { usageShare: share }),
        cleanup: !run ? 'notRun' : run.freed > 0 ? 'freed' : run.busy ? 'busy' : 'noSpaceFreed',
        ...(sessions !== undefined && { sessions: capCount(sessions) }),
    }
}

/** The editor's object counts, as the `chart` event; undefined for an empty chart. */
const chartEvent = (trigger: tally.ChartTrigger): EventData<'chart'> | undefined => {
    const { store, bpms, stages, groups, isDynamicStages, bgm } = liveState.value
    const total = (types: (keyof typeof store.grid)[]) => {
        let count = 0
        for (const type of types) for (const set of store.grid[type].values()) count += set.size
        return count
    }
    const notes = total(['note'])
    const events = total([
        'cameraEventJoint',
        'stageMaskEventJoint',
        'stagePivotEventJoint',
        'stageStyleEventJoint',
        'stageTransformEventJoint',
    ])
    if (!notes && !events) return
    const timeScales = total(['timeScale'])
    const objects = chartObjects({
        notes,
        timeScales,
        events,
        bpms: bpms.length,
        stages: stages.size,
        groups: groups.size,
    })
    return {
        trigger,
        notes: bucket('counts', notes),
        slides: bucket(
            'counts',
            [...store.slides.note.values()].filter((n) => n.length > 1).length,
        ),
        bpms: bucket('counts', bpms.length),
        timeScales: bucket('counts', timeScales),
        events: bucket('counts', events),
        stages: bucket('counts', stages.size),
        groups: bucket('counts', groups.size),
        objects: bucket('counts', objects),
        dynamicStages: isDynamicStages,
        bgm: bgm.meta?.durationMs === undefined ? 'none' : 'some',
        historySteps: Math.min(STACK_CAP, stackLength()),
    }
}

const idle = (run: (deadline: IdleDeadline) => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
    else
        setTimeout(() => {
            run({ didTimeout: true, timeRemaining: () => 0 })
        }, 0)
}

/** Starts the visit's statistics; `stop` ends them and drops what was not sent. */
export const startClient = (target: AnalyticsTarget) => {
    const base = requestFields({
        website: target.website,
        hostname: location.hostname,
        screenWidth: screen.width,
        screenHeight: screen.height,
        locale: settings.locale,
        referrer: referrerOrigin(),
    })
    const item = (name?: string, data?: Record<string, unknown>, at = Date.now()) =>
        requestItem(base, name, data, at)
    const sender = createSender({
        url: `${target.origin}/api/batch`,
        fetch: (url, init) => fetch(url, init),
        sendBeacon:
            typeof navigator.sendBeacon === 'function'
                ? (url, body) => navigator.sendBeacon(url, body)
                : undefined,
        onLine: () => navigator.onLine,
        now: () => performance.now(),
    })

    const field = startField()

    // The summaries since the last send, and the events the flows recorded.
    const summaries = () => {
        field.flush()
        const { counts, recorded } = tally.collect()
        const items: Item[] = []
        const where = device()
        for (const { name, data, at, device: ranOn } of recorded) {
            const made = { ...fromRaw(name, data), ...ranOn }
            if (isValidEvent(name, made)) items.push(item(name, made, at))
        }
        const events = new Map<string, Record<string, unknown>>()
        for (const [key, count] of counts) {
            const dot = key.indexOf('.')
            const name = key.slice(0, dot)
            events.set(name, { ...events.get(name), [key.slice(dot + 1)]: count })
        }
        // The perf event goes at every send: the time and the inputs belong with the counts. The
        // peek event goes only when there were peeks.
        events.set('perf', { ...events.get('perf'), ...field.measures(), ...where })
        const peeks = events.get('peek')
        if (peeks) events.set('peek', { ...peeks, ...where })
        for (const [name, all] of events) {
            const entries = Object.entries(all)
            for (let at = 0; at < entries.length; at += MAX_KEYS) {
                const data = Object.fromEntries(entries.slice(at, at + MAX_KEYS))
                if (isValidEvent(name, data, builtInCommandNames)) items.push(item(name, data))
            }
        }
        return items
    }

    // Nothing goes before the visit is armed; a visit that never arms sends nothing.
    const send = (mode: SendMode) => {
        if (tally.armedTime() !== undefined) sender.send(mode, summaries)
    }
    const onVisibility = () => {
        field.visibility()
        if (document.visibilityState === 'hidden') send('hidden')
    }
    const onPageHide = () => {
        send('leaving')
    }

    // The first send: at the first hide, or a minute after arming with the page still visible.
    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleFirst = () => {
        const armed = tally.armedTime() ?? performance.now()
        timer = setTimeout(
            () => {
                idle(() => {
                    if (document.visibilityState === 'visible' && sender.requests() === 0)
                        send('hidden')
                })
            },
            Math.max(0, SEND_INTERVAL - (performance.now() - armed)),
        )
    }
    const stopArming =
        tally.armedTime() === undefined
            ? tally.onArmed(scheduleFirst)
            : (scheduleFirst(), undefined)

    // The start events: queued now, sent once the visit is armed.
    const add = (name: EventName, data: Record<string, unknown> | undefined) => {
        if (data && isValidEvent(name, data)) sender.add(item(name, data))
    }
    sender.add(item())
    add('visit', visit())
    add(
        'settings',
        settingsSnapshot(matchMedia('(pointer: coarse)').matches, !hasDefaultValue('toolbar')),
    )
    add('startup', startupEvent())
    // Once the storage status is known, again when it changes to paused or to memory, and once
    // more when the Recent Sessions count becomes known after the first event went without it.
    let storageSent = ''
    let sessionsSent = false
    const sendStorage = () =>
        storageEvent().then(
            (data) => {
                if (!data) return
                const kind = `${data.mode ?? ''}/${data.reason ?? ''}`
                const sessions = data.sessions !== undefined
                if (kind === storageSent && !(sessions && !sessionsSent)) return
                storageSent = kind
                sessionsSent ||= sessions
                add('storage', data)
            },
            () => undefined,
        )
    void sendStorage()
    const stopStorage = watch(status.storageStatus, (now) => {
        if (now && (!storageSent || now.mode !== 'stored' || now.reason)) void sendStorage()
    })
    const stopSessions = watch(status.recentSessionCount, (count) => {
        if (count !== undefined && !sessionsSent) void sendStorage()
    })
    if (settings.showPreview && settings.previewPosition !== 'disabled')
        add('preview', {
            host: previewHost.kind,
            graphics: tally.wasNoted('graphicsUnavailable') ? 'unavailable' : 'ok',
        })

    // A chart opened, restored or saved is counted when the browser is idle and not playing.
    // While it plays nothing is scheduled; the count waits for playback to stop.
    const countCharts = () => {
        if (isPlaying.value) return
        idle((deadline) => {
            if (isPlaying.value) return
            if (!deadline.didTimeout && deadline.timeRemaining() < 12) {
                countCharts()
                return
            }
            for (const trigger of tally.takeCharts()) {
                const data = chartEvent(trigger)
                if (data) add('chart', data)
            }
        })
    }
    tally.watchCharts(countCharts)
    if (tally.hasCharts()) countCharts()
    const stopPlayback = watch(isPlaying, (playing) => {
        if (!playing && tally.hasCharts()) countCharts()
    })

    // The History panel shown, however it was opened: a link, its tab, a setting.
    const stopPanel = watch(
        () => isPanelVisible('history'),
        (shown) => {
            if (shown) tally.bump('features.historyPanel')
        },
    )
    const stopEdits = onHistoryAction(countEdit)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)

    return {
        stop: () => {
            sender.stop()
            stopEdits()
            stopArming?.()
            clearTimeout(timer)
            field.stop()
            stopStorage()
            stopSessions()
            stopPlayback()
            stopPanel()
            tally.watchCharts(undefined)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('pagehide', onPageHide)
        },
    }
}
