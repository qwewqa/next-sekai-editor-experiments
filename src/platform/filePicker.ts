import { allowsFileSystemAccess, usesOpfsPickers } from './detect'

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

/** Whether the setting lets saves and exports use a save picker: only Enabled does. */
export const choiceAllowsPicker = () => choice() === 'enabled'

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
export const usesSavePicker = () => savePickerExists() && choiceAllowsPicker()
