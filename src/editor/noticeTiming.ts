/** How long a card stays. */
export const NOTICE_MS = 6000
export const STARTUP_NOTICE_MS = 8000
/** A long message gets this plus a little per character, up to the cap. */
const READ_BASE_MS = 2000
const READ_MS_PER_CHAR = 60
export const NOTICE_MAX_MS = 12_000
/** The least a card has left once a hold lets go, so it can still be read. */
export const RESUME_MIN_MS = 1500

/** How long after the startup gate lifts its start-up toast may still become the start-up card. */
export const STARTUP_WINDOW_MS = 12_000

/**
 * When the start-up toast may still become the start-up card: within 12 s of the startup gate
 * lifting. A hold keeps it open, as while the agreement dialog covers the page, and its release
 * starts the 12 s again, since that is when the page first becomes usable.
 */
export const createStartupWindow = () => {
    let from: number | undefined
    let held = false
    return {
        /** The gate lifted; a later call changes nothing. */
        start: (now: number) => {
            from ??= now
        },
        hold: (on: boolean, now: number) => {
            held = on
            if (!on && from !== undefined) from = now
        },
        isOpen: (now: number) => held || from === undefined || now - from < STARTUP_WINDOW_MS,
    }
}

/** The longer of the base time and the reading time for `length` characters, at most 12 s. */
export const noticeDuration = (startup: boolean, length: number) =>
    Math.min(
        NOTICE_MAX_MS,
        Math.max(startup ? STARTUP_NOTICE_MS : NOTICE_MS, READ_BASE_MS + READ_MS_PER_CHAR * length),
    )
