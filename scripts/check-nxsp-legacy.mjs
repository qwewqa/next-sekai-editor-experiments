import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corpus = join(root, 'tests/local/nxsp/legacy-test20f')
const files = readdirSync(corpus)
    .filter((name) => name.endsWith('.nxsp'))
    .sort()
    .map((name) => join(corpus, name))
assert.ok(files.length > 0, 'The legacy project corpus is empty')
const checked = spawnSync(
    'uv',
    ['run', 'python', '-I', join(root, 'tools/nxsp_check.py'), '--read', ...files],
    { cwd: root, encoding: 'utf8' },
)
assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`)
const reports = checked.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
assert.equal(reports.length, files.length, 'Each legacy file needs a reader result')
for (const [index, report] of reports.entries()) {
    assert.equal(report.kind, 'nxsp', files[index])
    assert.equal(report.open, 'full', files[index])
    assert.deepEqual(report.report, [], files[index])
}
console.log(`Checked ${files.length} legacy project files in reader mode`)
