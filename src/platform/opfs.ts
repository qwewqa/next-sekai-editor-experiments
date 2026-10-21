import { testKeysOpen } from './testKeys'

// The pickers under the test override's `fileSystemAccess: 'opfs'` (Part 1 §1.11): Playwright
// cannot drive the native pickers, so they return handles from the origin private file system.
// Each pick takes the next name queued in `nse.test.picks` (null cancels); with none queued,
// a save pick takes its suggested name and an open pick cancels. Every call is logged in
// `nse.test.pickerCalls`.

const OPFS_PICKS_KEY = 'nse.test.picks'
const OPFS_PICKER_CALLS_KEY = 'nse.test.pickerCalls'

const readJson = (key: string): unknown => {
    try {
        return JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
        return null
    }
}

const nextPick = (): string | null | undefined => {
    if (!testKeysOpen) return undefined
    const picks = readJson(OPFS_PICKS_KEY)
    if (!Array.isArray(picks) || !picks.length) return undefined
    const [next, ...rest] = picks as unknown[]
    localStorage.setItem(OPFS_PICKS_KEY, JSON.stringify(rest))
    return typeof next === 'string' ? next : null
}

/** Adds a call to the picker log a spec reads (also used by the permission prompts). */
export const logPickerCall = (call: object) => {
    if (!testKeysOpen) return
    const calls = readJson(OPFS_PICKER_CALLS_KEY)
    const logged: unknown[] = Array.isArray(calls) ? calls : []
    localStorage.setItem(OPFS_PICKER_CALLS_KEY, JSON.stringify([...logged, call]))
}

const dismissed = () => new DOMException('The user aborted a request.', 'AbortError')

export const opfsSavePicker = async (options: SaveFilePickerOptions) => {
    logPickerCall({ picker: 'save', ...options })
    const pick = nextPick()
    if (pick === null) throw dismissed()
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(pick ?? options.suggestedName ?? 'Untitled', {
        create: true,
    })
    // Chromium empties an existing file the save picker returns (D5), so this does too.
    const writable = await handle.createWritable()
    await writable.close()
    return handle
}

export const opfsOpenPicker = async (options: OpenFilePickerOptions) => {
    logPickerCall({ picker: 'open', ...options })
    const name = nextPick()
    if (!name) throw dismissed()
    const root = await navigator.storage.getDirectory()
    return [await root.getFileHandle(name)]
}
