// Pinned format constants (§1.6.11.8); `tests/local/formatVersions.test.ts` asserts each.

/** The record format: a root's `v` and journals' `recordsV`. Stands for engine revision 2. */
export const RECORDS_V = 1

/** How a session's stack and entries are read: a session row's `v`, absent meaning 1. */
export const SESSION_V = 1
