// The fixture hook (Part 1 §1.4.2's test hook): with this key seeded, every load starts blank,
// at once. Light, so the entry module reads it before the storage modules load.

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

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** Under the fixture hook, why the real startup failed, for the specs' fixture. */
        nseStartupError?: string
    }
}
