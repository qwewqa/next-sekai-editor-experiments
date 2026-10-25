// America/St_Johns against the Date code it replaces. node:test runs each file in its own process.
process.env.TZ = 'America/St_Johns'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('America/St_Johns')
export {}
