// What the client may read from the local-data modules: a named, read-only view. It re-exports
// values and listeners and writes nothing; the lint lets only this file import `local/`.
// docs/analytics.md ("No effect on the user") explains why.

export { pressureRuns } from '../local/pressure'
export { loadEvents, recentSessionCount, storageStatus } from '../local/startup/events'
export { isSafeMode } from '../safe'
