import { setStartBlankHandler } from '../../startup/gate'

// The storage side of the startup gate (Part 1 §1.4.2; the gate itself is `src/startup/gate.ts`):
// the fixture hook, and Start Blank, which leaves the stored session untouched.

/** The fixture hook (§1.4.2's test hook): every load starts blank, and at once. */
export const START_BLANK_TEST_KEY = 'nse.test.startBlank'

/** Whether the fixture hook asks for a blank start. */
export const startsBlankForTests = () => {
    try {
        return (
            typeof localStorage !== 'undefined' &&
            localStorage.getItem(START_BLANK_TEST_KEY) !== null
        )
    } catch {
        return false
    }
}

/** Whether Start Blank was pressed before the session opened. */
export let blankRequested = false

// Start Blank: the startup sequence stops before it opens the stored session (§1.4.2).
setStartBlankHandler(() => {
    blankRequested = true
})
