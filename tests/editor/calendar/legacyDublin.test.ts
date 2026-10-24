// Europe/Dublin against the Date code it replaces. node:test runs each file in its own process.
process.env.TZ = 'Europe/Dublin'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('Europe/Dublin')
export {}
