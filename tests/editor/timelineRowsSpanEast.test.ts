// Kiritimati, UTC+14: the zone farthest east. node:test runs each file in its own process.
process.env.TZ = 'Pacific/Kiritimati'
const { runSpanTests } = await import('../helpers/timelineRowsSpan')
await runSpanTests('Pacific/Kiritimati')
