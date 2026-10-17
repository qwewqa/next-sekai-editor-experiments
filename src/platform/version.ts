declare const __APP_VERSION__: string

export type AppVersion = {
    appVersion: string
    /** Built from a version tag: X.Y.Z, not X.Y.Z+<commit>. */
    atTag: boolean
}

/** The version override the test fixture sets, read instead of the compiled version. */
export const VERSION_OVERRIDE_KEY = 'nse.test.version'

export const parseVersionOverride = (text: string | null | undefined): AppVersion | undefined => {
    if (!text) return
    try {
        const value = JSON.parse(text) as Partial<AppVersion> | null
        if (typeof value?.appVersion !== 'string' || typeof value.atTag !== 'boolean') return
        return { appVersion: value.appVersion, atTag: value.atTag }
    } catch {
        return
    }
}

const compiled = (): AppVersion => {
    // Node tests have no build define.
    const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
    return { appVersion, atTag: /^\d+\.\d+\.\d+$/.test(appVersion) }
}

let version: AppVersion | undefined

/** The version the app shows. */
export const appVersion = (): AppVersion => {
    if (version) return version
    let text: string | null = null
    try {
        text = typeof window !== 'undefined' ? localStorage.getItem(VERSION_OVERRIDE_KEY) : null
    } catch {
        // Storage can be unavailable.
    }
    return (version = parseVersionOverride(text) ?? compiled())
}
