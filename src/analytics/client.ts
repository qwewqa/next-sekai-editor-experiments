import { watch } from 'vue'
import { SITE } from '../buildInfo'
import { builtInCommandNames } from '../editor/commands/names'
import { onHistoryAction, type HistoryAction } from '../history/actions'
import { liveState, stackLength } from '../history/stack'
import { languageTag } from '../i18n/plural'
import { launch } from '../launch'
import { detection, isStandalone, suspectPrivate } from '../platform/detect'
import { isPlaying } from '../player'
import { previewHost } from '../preview/worker/host'
import { hasDefaultValue, settings } from '../settings'
import {
    bucket,
    fromRaw,
    isValidEvent,
    MAX_KEYS,
    type EventData,
    type EventName,
} from './catalogue'
import type { AnalyticsTarget } from './config'
import { startField } from './field'
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
    return {
        version: launch.release,
        site: SITE === 'test' ? 'test' : 'production',
        ...detection(),
        standalone: isStandalone(),
        touch: matchMedia('(pointer: coarse)').matches,
        viewport: bucket('viewport', innerWidth),
        dpr: bucket('dpr', devicePixelRatio),
        browserLanguage: /^[a-z]{2,3}$/.test(language) ? language : 'other',
        returning: launch.isExistingUser,
        updated: launch.updated,
    }
}

const operationId = (operation: unknown) =>
    typeof operation === 'object' &&
    operation !== null &&
    'id' in operation &&
    typeof operation.id === 'string'
        ? operation.id.replace(/^nse\./, '')
        : undefined

const countEdit = (action: HistoryAction) => {
    if (action.kind === 'undo' || action.kind === 'redo') tally.bump(`edits.${action.kind}`)
    else if (action.kind === 'edit' || action.kind === 'restore') {
        const id = operationId(action.step.operation)
        if (id) tally.bump(`edits.${id}`)
    }
}

/** How the visit began, from the load events and the tab’s claim; the first that fits. */
const startKind = (): NonNullable<EventData<'startup'>['start']> => {
    if (status.isSafeMode()) return 'safeMode'
    const kinds = new Set<string>(status.loadEvents.value.map((event) => event.kind))
    if (['journalRecovered', 'unsavedRecovered', 'journalKept'].some((kind) => kinds.has(kind)))
        return 'recovered'
    if (kinds.has('continued')) return 'continued'
    return tally.wasNoted('reload') ? 'reload' : 'blank'
}

const startupEvent = (): EventData<'startup'> | undefined => {
    const started = tally.startup()
    if (!started) return
    const found = Object.fromEntries(
        status.loadEvents.value.map((event) => [`found.${event.kind}`, true]),
    )
    return {
        start: startKind(),
        outcome: started.outcome,
        // A hidden page is throttled, which inflates the time; a failed startup has no time.
        ...(started.hidden || started.outcome === 'error'
            ? {}
            : { ready: bucket('time', started.at) }),
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
    const privateWindow =
        quota !== undefined && suspectPrivate({ persisted: persisted === true, quota })
    const sessions = status.recentSessionCount.value
    return {
        mode: current.mode === 'memory' && privateWindow ? 'memory-private' : current.mode,
        ...(current.reason && { reason: current.reason }),
        persisted: persisted === undefined ? 'unsupported' : persisted ? 'granted' : 'not',
        ...(usage !== undefined && { usage: bucket('size', usage) }),
        ...(quota !== undefined && { quota: bucket('quota', quota) }),
        cleanup: status.pressureRuns.some((run) => run.freed > 0),
        ...(sessions !== undefined && { sessions: bucket('small', sessions) }),
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
    return {
        trigger,
        notes: bucket('objects', notes),
        slides: bucket(
            'objects',
            [...store.slides.note.values()].filter((n) => n.length > 1).length,
        ),
        bpms: bucket('objects', bpms.length),
        timeScales: bucket('objects', total(['timeScale'])),
        events: bucket('objects', events),
        stages: bucket('small', stages.size),
        groups: bucket('small', groups.size),
        dynamicStages: isDynamicStages,
        bgm: bgm.meta?.durationMs === undefined ? 'none' : bucket('audio', bgm.meta.durationMs),
        historySteps: bucket('objects', stackLength()),
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
    const base = {
        website: target.website,
        hostname: location.hostname,
        screen: `${screen.width}x${screen.height}`,
        language: languageTag(settings.locale),
        url: '/',
        title: '',
        referrer: referrerOrigin(),
    }
    const item = (name?: string, data?: Record<string, unknown>, at = Date.now()): Item => ({
        type: 'event',
        payload: { ...base, ...(name && { name, data }), timestamp: Math.floor(at / 1000) },
    })
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
        const { counts, recorded } = tally.collect()
        const items: Item[] = []
        for (const { name, data, at } of recorded) {
            const made = fromRaw(name, data)
            if (isValidEvent(name, made)) items.push(item(name, made, at))
        }
        const events = new Map<string, Record<string, unknown>>()
        let commands = 0
        for (const [key, count] of counts) {
            const dot = key.indexOf('.')
            const name = key.slice(0, dot)
            if (name === 'usage') commands += count
            events.set(name, { ...events.get(name), [key.slice(dot + 1)]: count })
        }
        // The perf event goes at every send: the time and the inputs belong with the counts.
        events.set('perf', { ...events.get('perf'), ...field.measures(commands) })
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
    // Once the storage status is known, and again when it changes to paused or to memory.
    let storageSent = ''
    const sendStorage = () =>
        storageEvent().then(
            (data) => {
                if (!data) return
                const kind = `${data.mode ?? ''}/${data.reason ?? ''}`
                if (kind === storageSent) return
                storageSent = kind
                add('storage', data)
            },
            () => undefined,
        )
    void sendStorage()
    const stopStorage = watch(status.storageStatus, (now) => {
        if (now && (!storageSent || now.mode !== 'stored' || now.reason)) void sendStorage()
    })
    if (settings.showPreview && settings.previewPosition !== 'disabled')
        add('preview', {
            host: previewHost.kind,
            graphics: tally.wasNoted('graphicsUnavailable') ? 'unavailable' : 'ok',
        })

    // A chart opened, restored or saved is counted when the browser is idle and not playing.
    const countCharts = () => {
        idle((deadline) => {
            if (isPlaying.value || (!deadline.didTimeout && deadline.timeRemaining() < 12)) {
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
            tally.watchCharts(undefined)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('pagehide', onPageHide)
        },
    }
}
