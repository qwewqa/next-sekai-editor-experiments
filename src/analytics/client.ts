import { SITE } from '../buildInfo'
import { onHistoryAction, type HistoryAction } from '../history/actions'
import { languageTag } from '../i18n/plural'
import { launch } from '../launch'
import { detection, isStandalone } from '../platform/detect'
import { settings } from '../settings'
import { bucket, isValidEvent, MAX_KEYS, type EventData } from './catalogue'
import type { AnalyticsTarget } from './config'
import { createSender, SEND_INTERVAL, type Item, type SendMode } from './sender'
import * as tally from './tally'

// The usage statistics' client, loaded after startup when they are on (start.ts). It builds the
// visit's events, sends them by the sender's rules once the visit is armed, and stops at once
// when the user turns the statistics off. Failures stay silent: nothing here reaches the user.

/** The built-in command names `usage` may count. */
const commandNames = new Set<string>()

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

const idle = (run: () => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
    else setTimeout(run, 0)
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

    // The summaries since the last send, and the events the flows recorded.
    const summaries = () => {
        const { counts, recorded } = tally.collect()
        const items: Item[] = []
        for (const { name, data, at } of recorded)
            if (isValidEvent(name, data)) items.push(item(name, data, at))
        const events = new Map<string, [string, number][]>()
        for (const [key, count] of counts) {
            const dot = key.indexOf('.')
            const name = key.slice(0, dot)
            const entries = events.get(name) ?? []
            entries.push([key.slice(dot + 1), count])
            events.set(name, entries)
        }
        for (const [name, entries] of events)
            for (let at = 0; at < entries.length; at += MAX_KEYS) {
                const data = Object.fromEntries(entries.slice(at, at + MAX_KEYS))
                if (isValidEvent(name, data, commandNames)) items.push(item(name, data))
            }
        return items
    }

    // Nothing goes before the visit is armed; a visit that never arms sends nothing.
    const send = (mode: SendMode) => {
        if (tally.armedTime() !== undefined) sender.send(mode, summaries)
    }
    const onVisibility = () => {
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

    sender.add(item())
    const data = visit()
    if (isValidEvent('visit', data)) sender.add(item('visit', data))
    const stopEdits = onHistoryAction(countEdit)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)

    return {
        stop: () => {
            sender.stop()
            stopEdits()
            stopArming?.()
            clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('pagehide', onPageHide)
        },
    }
}
