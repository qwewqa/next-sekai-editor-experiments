// Writes infra/stats/host/allowlist.sql from the usage statistics' catalogue. Run with tsx
// (`npm run analytics:allowlist`) after changing src/analytics/catalogue.ts or the built-in commands.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowlistSql, commandNamesFrom } from '../src/analytics/allowlist.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const names = commandNamesFrom(readFileSync(resolve(root, 'src/editor/commands/index.ts'), 'utf8'))
writeFileSync(resolve(root, 'infra/stats/host/allowlist.sql'), allowlistSql(names))
console.log('Wrote infra/stats/host/allowlist.sql')
