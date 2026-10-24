// UTC against the Date code it replaces. node:test runs each file in its own process.
process.env.TZ = 'UTC'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('UTC')
export {}
