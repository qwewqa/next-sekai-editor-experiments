// Asia/Kolkata against the Date code it replaces. node:test runs each file in its own process.
process.env.TZ = 'Asia/Kolkata'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('Asia/Kolkata', 'Asia/Calcutta')
export {}
