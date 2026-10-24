// Repeats a level's notes, connectors and sim lines `copies` times, `offset` beats apart, as the
// stress chart (docs/performance-testing.md). Events and stages are not repeated.
//   npm run perf:stress -- <level.json> <out.json> [copies = 8] [offset = 400]
import { readFileSync, writeFileSync } from 'node:fs'

const [input, output, copies = '8', offset = '400'] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: npm run perf:stress -- <level.json> <out.json>')
const level = JSON.parse(readFileSync(input, 'utf8'))
const repeated = level.entities.filter(
    ({ archetype }) =>
        archetype.includes('Note') || archetype === 'Connector' || archetype === 'SimLine',
)
const names = new Set(repeated.flatMap(({ name }) => (name ? [name] : [])))
const extra = []
for (let copy = 1; copy < Number(copies); copy++)
    for (const entity of repeated)
        extra.push({
            archetype: entity.archetype,
            ...(entity.name ? { name: `${entity.name}_c${copy}` } : {}),
            data: entity.data.map((field) =>
                'ref' in field && names.has(field.ref)
                    ? { ...field, ref: `${field.ref}_c${copy}` }
                    : field.name === '#BEAT'
                      ? { ...field, value: field.value + copy * Number(offset) }
                      : field,
            ),
        })
writeFileSync(output, JSON.stringify({ ...level, entities: [...level.entities, ...extra] }))
console.log(`${level.entities.length} entities, ${extra.length} added`)
