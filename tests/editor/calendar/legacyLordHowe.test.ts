// Australia/Lord_Howe against the Date code it replaces (I-2). node:test runs each file in its own process.
process.env.TZ = 'Australia/Lord_Howe'
const { runLegacyTests } = await import('../../helpers/calendarLegacy')
await runLegacyTests('Australia/Lord_Howe')
export {}
