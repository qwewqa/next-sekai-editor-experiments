import { shallowRef } from 'vue'

// What the startup gate shows (Part 1 §1.4.2): until the session is open the editor refuses input.
// Light on purpose (Vue only), so the gate can import it from the first frame, before the
// storage modules load after first paint.

export type StartupPhase =
    /** Opening: input is swallowed; `name` once the session to open is known. */
    | { phase: 'opening'; name?: string }
    | { phase: 'open' }
    /** Startup threw: "The editor could not open your stored work." and the error's own text. */
    | { phase: 'failed'; error: string }

/** The fixture hook (§1.4.2's test hook): every load starts blank, and at once. */
export const START_BLANK_TEST_KEY = 'nse.test.startBlank'

const readFlag = (key: string) => {
    try {
        return localStorage.getItem(key) !== null
    } catch {
        return false
    }
}

/** Whether this load runs in safe mode (`?safe`, §1.4.2). */
export const isSafeMode = () => {
    try {
        return new URLSearchParams(location.search).has('safe')
    } catch {
        return false
    }
}

/** Whether the fixture hook asks for a blank start. */
export const startsBlankForTests = () =>
    typeof window !== 'undefined' && readFlag(START_BLANK_TEST_KEY)

export const startup = shallowRef<StartupPhase>(
    startsBlankForTests() ? { phase: 'open' } : { phase: 'opening' },
)

const blankListeners = new Set<() => void>()

/** Whether Start Blank was pressed before the session opened. */
export let blankRequested = false

/**
 * [Start Blank] (§1.4.2): gives up opening the stored session, which stays untouched, and opens
 * the editor blank. Ignored once the session is open.
 */
export const startBlank = () => {
    if (startup.value.phase === 'open') return
    blankRequested = true
    for (const listener of [...blankListeners]) listener()
    startup.value = { phase: 'open' }
}

/** Runs when Start Blank is pressed while opening. */
export const onStartBlank = (listener: () => void) => {
    blankListeners.add(listener)
    return () => {
        blankListeners.delete(listener)
    }
}

/** Startup shows a name while opening it ("Opening "Coconut (Master)"…"). */
export const openingName = (name: string) => {
    if (startup.value.phase === 'opening') startup.value = { phase: 'opening', name }
}

/** The session is open: input goes through. */
export const opened = () => {
    if (startup.value.phase !== 'failed') startup.value = { phase: 'open' }
}

/** Startup threw: the gate shows the error with Open in Safe Mode and Export Raw Data…. */
export const failed = (error: unknown) => {
    startup.value = {
        phase: 'failed',
        error: error instanceof Error ? error.message || error.name : String(error),
    }
}
