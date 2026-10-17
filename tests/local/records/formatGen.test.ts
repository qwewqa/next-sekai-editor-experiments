import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { formatFiles } from '../../../src/local/records/fieldsTable'

const root = join(import.meta.dirname, '..', '..', '..')

test('the files npm run format:gen writes match schema.ts', () => {
    for (const [path, text] of Object.entries(formatFiles()))
        assert.equal(
            readFileSync(join(root, path), 'utf8'),
            text,
            `${path} drifted from schema.ts: run npm run format:gen`,
        )
})
