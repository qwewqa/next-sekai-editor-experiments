// Asia/Kathmandu against the Date code it replaces (I-2). node:test runs each file in its own process.
process.env.TZ = 'Asia/Kathmandu'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('Asia/Kathmandu', 'Asia/Katmandu')
export {}
