import { testKeysOpen } from './testKeys'

// A spec's pause at a named point of a write (Part 1 §1.11.6's save-picker faults): the point
// waits while `nse.test.savePause` names it, until the spec calls `nseSaveTest.release()`. Every
// point reached is logged. Nothing pauses unless a spec set the key.

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        nseSaveTest?: { reached: string[]; release: () => void }
    }
}

export const SAVE_PAUSE_KEY = 'nse.test.savePause'

export const savePoint = async (name: string) => {
    let paused: string | null
    try {
        paused = testKeysOpen ? localStorage.getItem(SAVE_PAUSE_KEY) : null
    } catch {
        return
    }
    if (paused === null) return
    const test = (window.nseSaveTest ??= { reached: [], release: () => undefined })
    test.reached.push(name)
    if (paused !== name) return
    await new Promise<void>((resolve) => {
        test.release = resolve
    })
}
