import { watch } from 'vue'
import { SITE } from '../buildInfo'
import { isSafeMode } from '../safe'
import { settings } from '../settings'
import { startupGate } from '../startup/gate'
import { browserSignal, shouldSend, type AnalyticsTarget } from './config'
import * as tally from './tally'

declare const __NSE_ANALYTICS__: AnalyticsTarget | null

// Starts and stops the usage statistics. A build without an analytics target has none of this
// at run time, and no client chunk: the minifier drops what the constant below rules out.

const BUILT = typeof __NSE_ANALYTICS__ === 'object' ? __NSE_ANALYTICS__ : null

// Dev builds only: a browser spec points the statistics at its mock endpoint with this key.
const testTarget = ((): AnalyticsTarget | null => {
    if (!import.meta.env.DEV) return null
    try {
        const value = JSON.parse(localStorage.getItem('nse.test.analytics') ?? 'null') as unknown
        return typeof value === 'object' &&
            value !== null &&
            'origin' in value &&
            'website' in value &&
            typeof value.origin === 'string' &&
            typeof value.website === 'string'
            ? { origin: value.origin, website: value.website }
            : null
    } catch {
        return null
    }
})()

/** Where this build sends usage statistics; null when it has nowhere to send them. */
export const analyticsTarget = testTarget ?? BUILT

/** Do Not Track or Global Privacy Control, read once per load. */
export const browserSignalSet = browserSignal()

const sends = () =>
    shouldSend({
        target: analyticsTarget,
        fromTestKey: testTarget !== null,
        choice: settings.usageStatistics,
        signal: browserSignalSet,
        webdriver: navigator.webdriver,
        hostname: location.hostname,
        site: SITE,
        safeMode: isSafeMode(),
        saveData:
            (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
                ?.saveData === true,
    })

// Startup ended, whether it opened the session or stopped at an error: a startup that failed is
// the signal that matters most, so the client loads after it too, and once the user has used the
// page (the gate swallows other input), it sends the failure.
const startupEnded = () =>
    new Promise<void>((resolve) => {
        const stop = watch(
            () => startupGate.phase,
            (phase) => {
                if (phase === 'opening') return
                stop()
                resolve()
            },
        )
        if (startupGate.phase !== 'opening') {
            stop()
            resolve()
        }
    })

const idle = () =>
    new Promise<void>((resolve) => {
        if (typeof requestIdleCallback === 'function')
            requestIdleCallback(
                () => {
                    resolve()
                },
                { timeout: 10_000 },
            )
        else setTimeout(resolve, 1000)
    })

let client: { stop: () => void } | undefined
// Counts starts and stops. A client that finishes loading after a later stop does not start.
let generation = 0

const load = async (target: AnalyticsTarget) => {
    const at = ++generation
    await startupEnded()
    await idle()
    if (at !== generation) return
    try {
        const { startClient } = await import('./client')
        if (at === generation) client = startClient(target)
    } catch {
        // A chunk gone after a deploy: this visit sends nothing.
    }
}

const apply = () => {
    if (!analyticsTarget) return
    if (sends()) {
        if (tally.isEnabled()) return
        tally.enable()
        void load(analyticsTarget)
        return
    }
    generation++
    tally.disable()
    client?.stop()
    client = undefined
}

/** Starts the statistics when they are on, and follows the switch here and in other tabs. */
export const startAnalytics = () => {
    if (!(import.meta.env.DEV || BUILT) || !analyticsTarget) return
    apply()
    watch(() => settings.usageStatistics, apply)
    // Settings are read once per tab, so a switch turned off in another tab is followed here.
    // One turned on there waits for this tab's next load.
    window.addEventListener('storage', (event) => {
        if (event.key?.endsWith('.usageStatistics') && event.newValue === 'false')
            settings.usageStatistics = false
    })
}
