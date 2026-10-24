// Pacific/Pago_Pago against the Date code it replaces. node:test runs each file in its own process.
process.env.TZ = 'Pacific/Pago_Pago'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('Pacific/Pago_Pago')
export {}
