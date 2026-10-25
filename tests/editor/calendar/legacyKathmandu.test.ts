// Asia/Kathmandu against the Date code it replaces. node:test runs each file in its own process.
process.env.TZ = 'Asia/Kathmandu'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('Asia/Kathmandu', 'Asia/Katmandu')
export {}
