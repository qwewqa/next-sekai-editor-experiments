// Pacific/Kiritimati against the Date code it replaces. node:test runs each file in its own process.
process.env.TZ = 'Pacific/Kiritimati'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('Pacific/Kiritimati')
export {}
