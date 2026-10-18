/** How long a card stays (Part 1 §1.4.1, §1.4.3). */
export const NOTICE_MS = 6000
export const STARTUP_NOTICE_MS = 8000
/** A long message gets this plus a little per character, up to the cap. */
const READ_BASE_MS = 2000
const READ_MS_PER_CHAR = 60
export const NOTICE_MAX_MS = 12_000
/** The least a card has left once a hold lets go, so it can still be read. */
export const RESUME_MIN_MS = 1500

/** The longer of the base time and the reading time for `length` characters, at most 12 s. */
export const noticeDuration = (startup: boolean, length: number) =>
    Math.min(
        NOTICE_MAX_MS,
        Math.max(startup ? STARTUP_NOTICE_MS : NOTICE_MS, READ_BASE_MS + READ_MS_PER_CHAR * length),
    )
