import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectSummary, listTests, makeList, shardSummary } from '../../scripts/flaky-report.mjs'

const result = (status, retry = 0, message = '') => ({
    status,
    retry,
    ...(message ? { error: { message } } : {}),
})
const spec = (title, status, results) => ({
    title,
    file: 'a.spec.ts',
    tests: [{ projectName: 'chromium', status, results }],
})
// The shape of Playwright's JSON reporter: a file's suite holds its describe blocks.
const report = {
    suites: [
        {
            title: 'a.spec.ts',
            file: 'a.spec.ts',
            specs: [spec('plain', 'expected', [result('passed')])],
            suites: [
                {
                    title: 'group | one',
                    file: 'a.spec.ts',
                    specs: [
                        spec('needs a retry', 'flaky', [
                            result('failed', 0, '\u001b[31mTimeout 15000ms\u001b[39m\nmore'),
                            result('passed', 1),
                        ]),
                        spec('breaks', 'unexpected', [
                            result('failed', 0, 'Boom'),
                            result('failed', 1, 'Boom'),
                            result('failed', 2, 'Boom'),
                        ]),
                        spec('skips', 'skipped', [result('skipped')]),
                    ],
                },
            ],
        },
    ],
}

test('the tests of a report get a describe-path title, a status, retries and the first error', () => {
    const tests = listTests(report)
    assert.deepEqual(
        tests.map((entry) => [entry.title, entry.status, entry.retries, entry.error]),
        [
            ['plain', 'expected', 0, ''],
            ['group | one > needs a retry', 'flaky', 1, 'Timeout 15000ms'],
            ['group | one > breaks', 'unexpected', 2, 'Boom'],
            ['group | one > skips', 'skipped', 0, ''],
        ],
    )
})

test('a shard lists its flaky tests and failures, and says nothing when there are none', () => {
    const list = makeList('chromium 3/16', 'shard', report)
    assert.deepEqual(list.counts, { passed: 1, flaky: 1, failed: 1, skipped: 1 })
    assert.deepEqual(list.passed, [])
    const text = shardSummary(list)
    assert.match(text, /### chromium 3\/16: 1 flaky, 1 failed/)
    assert.match(
        text,
        /\| Flaky \| chromium \| `a\.spec\.ts > group \\| one > needs a retry` \| 1 \| Timeout 15000ms \|/,
    )
    assert.match(text, /\| Failed \| chromium \|/)
    const quiet = makeList('formats', 'shard', {
        suites: [{ title: 'a.spec.ts', specs: [report.suites[0].specs[0]] }],
    })
    assert.equal(shardSummary(quiet), '')
})

test('the collected summary has one table over every shard, and the excluded tests that pass', () => {
    const lists = [
        makeList('chromium 1/16', 'shard', report),
        makeList('chromium 2/16', 'shard', { suites: [] }),
        makeList('excluded', 'excluded', report),
    ]
    const text = collectSummary(lists)
    assert.match(text, /1 flaky and 1 failed of 3 tests, from 2 reports/)
    assert.match(text, /\| chromium 1\/16 \| Flaky \|/)
    assert.match(text, /### Excluded tests\n\n1 pass now, 2 still fail/)
    assert.match(text, /\*\*Pass now\*\*[\s\S]*`a\.spec\.ts > plain`/)
    assert.match(collectSummary([]), /0 flaky and 0 failed of 0 tests, from 0 reports/)
})

const script = fileURLToPath(new URL('../../scripts/flaky-report.mjs', import.meta.url))
const run = (cwd, ...args) =>
    spawnSync(process.execPath, [script, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    })

test('a shard writes flaky-list/<label>.json from flaky/raw.json, and succeeds without a report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-'))
    const missing = run(dir, 'shard', 'chromium 1/16')
    assert.equal(missing.status, 0)
    assert.match(missing.stdout, /No Playwright report was written/)
    mkdirSync(join(dir, 'flaky'))
    writeFileSync(join(dir, 'flaky', 'raw.json'), JSON.stringify(report))
    const shard = run(dir, 'shard', 'firefox storage 1/2')
    assert.equal(shard.status, 0, shard.stderr)
    const list = JSON.parse(
        readFileSync(join(dir, 'flaky-list', 'firefox-storage-1-2.json'), 'utf8'),
    )
    assert.equal(list.label, 'firefox storage 1/2')
    assert.equal(list.flaky.length, 1)
    assert.match(
        run(dir, 'collect', 'flaky-list').stdout,
        /1 flaky and 1 failed of 3 tests, from 1 reports/,
    )
    assert.match(run(dir, 'collect', 'nothing-here').stdout, /from 0 reports/)
    assert.notEqual(run(dir, 'shard').status, 0)
})

test('a file suite titled with a Windows path adds nothing to a test title', () => {
    const windows = {
        suites: [
            {
                title: 'formats\\a.spec.ts',
                file: 'formats/a.spec.ts',
                specs: [
                    { ...spec('plain', 'expected', [result('passed')]), file: 'formats/a.spec.ts' },
                ],
            },
        ],
    }
    assert.equal(listTests(windows)[0].title, 'plain')
})
