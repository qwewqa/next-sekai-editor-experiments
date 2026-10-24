import { writeFileSync } from 'node:fs'
import { cells, runCell, type CellResult } from './matrix'

// Runs every cell and writes the results as JSON (`OUT`, default survey.json): the matrix as a
// table, to compare before and after a change. `ONLY` keeps the cells whose id contains it.
//   npx tsx tests/editor/saveMatrix/survey.ts

const only = process.env.ONLY
const results: CellResult[] = []
for (const c of cells()) {
    if (only && !`${c.path.id} / ${c.plan.id} / ${c.fault.id}`.includes(only)) continue
    results.push(await runCell(c.path, c.plan, c.fault))
}
writeFileSync(process.env.OUT ?? 'survey.json', JSON.stringify(results, null, 1))
process.exit(0)
