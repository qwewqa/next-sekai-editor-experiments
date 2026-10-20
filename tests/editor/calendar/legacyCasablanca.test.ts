// Africa/Casablanca against the Date code it replaces (I-2). node:test runs each file in its own process.
process.env.TZ = 'Africa/Casablanca'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('Africa/Casablanca')
export {}
