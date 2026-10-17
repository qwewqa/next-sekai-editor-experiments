import type { PlatformOs } from './types'

// Detection is for wording and hand-over paths only: nothing stored depends on it (Part 1 §1.6.10).

export type Engine = 'webkit' | 'chromium' | 'firefox' | 'other'

export type Detection = {
    engine: Engine
    os: PlatformOs
}

/** The test override, read from localStorage in every build. */
export type PlatformOverride = {
    engine?: Engine
    os?: PlatformOs
    standalone?: boolean
    persisted?: boolean
    privateSuspected?: boolean
    fileSystemAccess?: boolean
    activation?: boolean
}

export const PLATFORM_OVERRIDE_KEY = 'nse.test.platform'

export type UaEnv = {
    userAgent: string
    maxTouchPoints: number
    /** 'GestureEvent' in window, which only WebKit has. */
    gestureEvent: boolean
}

/** iPhone, iPad or iPod, including an iPad with a desktop UA; every browser there is WebKit. */
export const isIosDevice = ({ userAgent, maxTouchPoints }: UaEnv) =>
    /iPhone|iPad|iPod/.test(userAgent) || (userAgent.includes('Macintosh') && maxTouchPoints > 1)

export const isMacSafari = (env: UaEnv) =>
    env.userAgent.includes('Macintosh') &&
    env.userAgent.includes('Safari/') &&
    env.userAgent.includes('Version/') &&
    !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(env.userAgent) &&
    env.gestureEvent

export const detectFromUa = (env: UaEnv): Detection => {
    const { userAgent } = env
    if (isIosDevice(env)) return { engine: 'webkit', os: 'ios' }

    const os: PlatformOs = userAgent.includes('Android')
        ? 'android'
        : userAgent.includes('Windows')
          ? 'windows'
          : /Macintosh|Mac OS X/.test(userAgent)
            ? 'macos'
            : userAgent.includes('CrOS')
              ? 'other'
              : /Linux|X11/.test(userAgent)
                ? 'linux'
                : 'other'

    const engine: Engine = isMacSafari(env)
        ? 'webkit'
        : userAgent.includes('Firefox/')
          ? 'firefox'
          : /Chrome\/|Chromium\//.test(userAgent)
            ? 'chromium'
            : 'other'

    return { engine, os }
}

const engines: readonly Engine[] = ['webkit', 'chromium', 'firefox', 'other']
const oses: readonly PlatformOs[] = ['windows', 'macos', 'linux', 'ios', 'android', 'other']
const flags = [
    'standalone',
    'persisted',
    'privateSuspected',
    'fileSystemAccess',
    'activation',
] as const

/** The override's known fields; anything else, or text that is not JSON, is ignored. */
export const parsePlatformOverride = (text: string | null | undefined): PlatformOverride => {
    if (!text) return {}
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return {}
    }
    if (typeof value !== 'object' || value === null) return {}
    const raw = value as Record<string, unknown>
    const override: PlatformOverride = {}
    if (engines.includes(raw.engine as Engine)) override.engine = raw.engine as Engine
    if (oses.includes(raw.os as PlatformOs)) override.os = raw.os as PlatformOs
    for (const flag of flags) if (typeof raw[flag] === 'boolean') override[flag] = raw[flag]
    return override
}

export type StandaloneEnv = {
    displayModeStandalone: () => boolean
    navigatorStandalone: () => boolean
    fullscreen: () => boolean
}

/** Latched at startup and re-read on pageshow, never during fullscreen, where display-mode stops matching. */
export const createStandaloneLatch = (env: StandaloneEnv) => {
    let value = false
    const reread = () => {
        if (env.fullscreen()) return
        value = env.displayModeStandalone() || env.navigatorStandalone()
    }
    reread()
    return { get: () => value, reread }
}

/** A quota below this, with storage not persisted, suggests a private window (§1.6.9). */
export const PRIVATE_QUOTA_LIMIT = 1024 ** 3

export const suspectPrivate = ({ persisted, quota }: { persisted: boolean; quota: number }) =>
    !persisted && quota < PRIVATE_QUOTA_LIMIT

const hasWindow = () => typeof window !== 'undefined'

let override: PlatformOverride | undefined

/** The test override, read once. */
export const platformOverride = (): PlatformOverride => {
    if (override) return override
    let text: string | null = null
    try {
        text = hasWindow() ? localStorage.getItem(PLATFORM_OVERRIDE_KEY) : null
    } catch {
        // Storage can be unavailable; detection still runs.
    }
    return (override = parsePlatformOverride(text))
}

let detected: Detection | undefined

export const detection = (): Detection => {
    if (detected) return detected
    const env: UaEnv = hasWindow()
        ? {
              userAgent: navigator.userAgent,
              maxTouchPoints: navigator.maxTouchPoints,
              gestureEvent: 'GestureEvent' in window,
          }
        : { userAgent: '', maxTouchPoints: 0, gestureEvent: false }
    const { engine, os } = platformOverride()
    const ua = detectFromUa(env)
    return (detected = { engine: engine ?? ua.engine, os: os ?? ua.os })
}

const noStandalone: StandaloneEnv = {
    displayModeStandalone: () => false,
    navigatorStandalone: () => false,
    fullscreen: () => false,
}

let latch: ReturnType<typeof createStandaloneLatch> | undefined

const standaloneLatch = () => {
    if (latch) return latch
    if (!hasWindow() || typeof matchMedia !== 'function')
        return (latch = createStandaloneLatch(noStandalone))
    latch = createStandaloneLatch({
        displayModeStandalone: () => matchMedia('(display-mode: standalone)').matches,
        navigatorStandalone: () =>
            (navigator as Navigator & { standalone?: boolean }).standalone === true,
        fullscreen: () => !!document.fullscreenElement,
    })
    window.addEventListener('pageshow', latch.reread)
    return latch
}

/** A Home Screen web app the user added (§1.7.5). */
export const isStandalone = () => platformOverride().standalone ?? standaloneLatch().get()

/** Whether the page has transient activation, where the browser reports it. */
export const hasActivation = () =>
    platformOverride().activation ??
    (hasWindow() && 'userActivation' in navigator ? navigator.userActivation.isActive : true)

/** False when the override turns the File System Access pickers off. */
export const allowsFileSystemAccess = () => platformOverride().fileSystemAccess ?? true

/** Detects and latches at startup. */
export const startDetection = () => {
    detection()
    isStandalone()
}
