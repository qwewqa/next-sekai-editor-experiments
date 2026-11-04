import { allowsFileSystemAccess, detection, usesOpfsPickers } from './detect'

// Write to Chosen Files: whether saves and exports use the File System Access save picker and
// write back to the files it returned, or download. The editor's setting is handed in by
// `setFilePickerChoice`, so the platform layer does not import the settings.

export type FilePickerChoice = 'auto' | 'enabled' | 'disabled'

let choice: () => FilePickerChoice = () => 'auto'
let disable: () => void = () => undefined

/** The editor's setting, read on every call; `off` sets it to Disabled. */
export const setFilePickerChoice = (read: () => FilePickerChoice, off: () => void) => {
    choice = read
    disable = off
}

/** The setting's value now. */
export const filePickerChoice = () => choice()

/** Always Download: the setting becomes Disabled. */
export const disableFilePicker = () => {
    disable()
}

/** Whether this browser has the save picker at all; the Settings row shows only then. */
export const savePickerExists = () =>
    usesOpfsPickers() ||
    (allowsFileSystemAccess() &&
        typeof window !== 'undefined' &&
        typeof window.showSaveFilePicker === 'function')

export type UaData = {
    platform?: string
    brands?: readonly { brand: string; version: string }[]
}

/** The first Chrome for Android whose writes through the picker are trusted under Auto. */
const ANDROID_CHROME_MIN = 151

/** What Auto reads of the browser. */
export type AutoEnv = {
    data: UaData | undefined
    /** The user agent string says Android. */
    uaAndroid: boolean
    /** The user agent string says Linux (X11), as Chrome for Android's desktop site does. */
    uaLinux: boolean
    maxTouchPoints: number
}

/**
 * Auto: desktop browsers use the picker; on Android only Google Chrome 151 or later does. Android
 * is told by the client hints' platform or the user agent string. Chrome for Android's desktop site
 * (the default on large tablets) reports Linux, so Linux with a touch screen counts as Android, as
 * an iPad's desktop mode counts as iOS in detect.ts. Each test only excludes.
 */
export const autoAllowsPicker = ({ data, uaAndroid, uaLinux, maxTouchPoints }: AutoEnv) => {
    const linux = data?.platform === 'Linux' || (!data && uaLinux)
    const android = data?.platform === 'Android' || uaAndroid || (linux && maxTouchPoints > 1)
    if (!android) return true
    const chrome = data?.brands?.find((entry) => entry.brand === 'Google Chrome')
    return !!chrome && Number.parseInt(chrome.version, 10) >= ANDROID_CHROME_MIN
}

const uaData = (): UaData | undefined =>
    typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & { userAgentData?: UaData }).userAgentData

/** What this visit gets, for the usage statistics. */
export const filePickerRoute = () =>
    !savePickerExists()
        ? 'unsupported'
        : usesSavePicker()
          ? 'picker'
          : choice() === 'disabled'
            ? 'download'
            : 'autoDownload'

/** Whether saves and exports use the picker now: the API exists and the setting allows it. */
export const usesSavePicker = () => {
    if (!savePickerExists()) return false
    switch (choice()) {
        case 'enabled':
            return true
        case 'disabled':
            return false
        case 'auto':
            return autoAllowsPicker({
                data: uaData(),
                uaAndroid: detection().os === 'android',
                uaLinux: navigator.userAgent.includes('X11; Linux'),
                maxTouchPoints: navigator.maxTouchPoints,
            })
    }
}
