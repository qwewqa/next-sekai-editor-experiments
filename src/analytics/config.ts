// Whether this page sends usage statistics, as one pure rule over what the page knows. start.ts
// gathers the inputs; docs/analytics.md explains each.

/** Where the statistics go: the analytics origin and Umami's website id. */
export type AnalyticsTarget = { origin: string; website: string }

export type Inputs = {
    /** The build's target, or a dev build's test key; null when the build has none. */
    target: AnalyticsTarget | null
    /** The target came from the dev build's test key, which a browser spec sets. */
    fromTestKey: boolean
    /** The Settings switch as the user left it; null until they choose. */
    choice: boolean | null
    /** The browser sends Do Not Track or Global Privacy Control. */
    signal: boolean
    /** An automated browser (`navigator.webdriver`). */
    webdriver: boolean
    hostname: string
    /** The site the build is for (`production` or `test`). */
    site: string
    safeMode: boolean
    /** The browser asks pages to save data (`navigator.connection.saveData`). */
    saveData: boolean
}

/** Where each site's build runs. A copy of the files on another host sends nothing. */
export const SITE_HOSTS: Partial<Record<string, string>> = {
    production: 'nse.qwewqa.dev',
    test: 'test.nse.qwewqa.dev',
}

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/

/** An `http:` origin on this machine, such as a perf run's mock endpoint. */
export const isLoopbackOrigin = (origin: string) => {
    try {
        const url = new URL(origin)
        return url.protocol === 'http:' && LOOPBACK.test(url.hostname)
    } catch {
        return false
    }
}

/** What the switch shows: the user's choice, else on unless the browser sends a signal. */
export const preference = (choice: boolean | null, signal: boolean) => choice ?? !signal

/** Whether this page sends usage statistics. */
export const shouldSend = (inputs: Inputs) => {
    const { target } = inputs
    if (!target || !preference(inputs.choice, inputs.signal)) return false
    if (inputs.safeMode || inputs.saveData) return false
    if (inputs.webdriver && !inputs.fromTestKey && !isLoopbackOrigin(target.origin)) return false
    return LOOPBACK.test(inputs.hostname) || inputs.hostname === SITE_HOSTS[inputs.site]
}

/** Do Not Track or Global Privacy Control, as the browser reports them. */
export const browserSignal = () => {
    if (typeof navigator === 'undefined') return false
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
    const win = window as Window & { doNotTrack?: string }
    return nav.globalPrivacyControl === true || nav.doNotTrack === '1' || win.doNotTrack === '1'
}
