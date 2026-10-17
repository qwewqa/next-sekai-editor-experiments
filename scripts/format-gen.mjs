// Writes the files generated from `src/local/records/schema.ts` (§1.6.11.1). Run with tsx.
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatFiles } from '../src/local/records/fieldsTable.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const [path, text] of Object.entries(formatFiles())) {
    writeFileSync(resolve(root, path), text)
    console.log(`Wrote ${path}`)
}
