// America/New_York against the Date code it replaces. node:test runs each file in its own process.
process.env.TZ = 'America/New_York'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('America/New_York')
export {}
