import { setStartBlankHandler } from '../../startup/gate'

// The storage side of the startup gate (Part 1 §1.4.2; the gate itself is `src/startup/gate.ts`):
// the fixture hook, and Start Blank, which leaves the stored session untouched.

export { START_BLANK_TEST_KEY, startsBlankForTests } from '../../startup/testHook'

let blankRequested = false

/** Whether Start Blank was pressed before the session opened. */
export const isBlankRequested = () => blankRequested

// Start Blank: the startup sequence stops before it opens the stored session (§1.4.2).
setStartBlankHandler(() => {
    blankRequested = true
})
