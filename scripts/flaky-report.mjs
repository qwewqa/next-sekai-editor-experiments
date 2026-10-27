import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Makes flaky tests visible in a CI run. Playwright's JSON reporter writes flaky/raw.json (CI only);
// a test that passes only on a retry is green, so nobody looks at it otherwise.
//   node scripts/flaky-report.mjs shard <label> [--excluded]   one job: write flaky-list/<label>.json and a summary
//   node scripts/flaky-report.mjs collect <dir>                the jobs' lists in <dir>: one summary
// The summary goes to $GITHUB_STEP_SUMMARY, or to the output when that is not set. The script never fails
// a job: an error prints one line and exits 0.

const rawFile = 'flaky/raw.json'
const listDir = 'flaky-list'
const maxRows = 100

const stripAnsi = (text) =>
    text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const firstLine = (result) => {
    const message = stripAnsi(result?.error?.message ?? result?.errors?.[0]?.message ?? '')
    const line = message.split('\n').find((text) => text.trim()) ?? ''
    return line.trim().slice(0, 200)
}

// A file's own suite is titled with its path (backslashes on Windows); only describe blocks belong in a test title.
const isFileSuite = (suite) => suite.title?.replaceAll('\\', '/') === suite.file

// The tests of a Playwright JSON report: file, title (describe titles joined with " > "), project, status
// ('expected', 'unexpected', 'flaky' or 'skipped'), retries used and the first failed attempt's error.
export function listTests(report) {
    const tests = []
    const walk = (suite, titles) => {
        for (const spec of suite.specs ?? [])
            for (const test of spec.tests ?? []) {
                const failed = (test.results ?? []).find(
                    (result) => result.status !== 'passed' && result.status !== 'skipped',
                )
                tests.push({
                    project: test.projectName ?? '',
                    file: spec.file ?? suite.file ?? '',
                    title: [...titles, spec.title].join(' > '),
                    status: test.status,
                    retries: Math.max(0, (test.results ?? []).length - 1),
                    error: test.status === 'expected' ? '' : firstLine(failed),
                })
            }
        for (const child of suite.suites ?? [])
            walk(child, isFileSuite(child) ? titles : [...titles, child.title])
    }
    for (const suite of report.suites ?? []) walk(suite, isFileSuite(suite) ? [] : [suite.title])
    return tests
}

export function makeList(label, mode, report) {
    const tests = listTests(report)
    const only = (status) => tests.filter((test) => test.status === status)
    return {
        label,
        mode,
        counts: {
            passed: only('expected').length,
            flaky: only('flaky').length,
            failed: only('unexpected').length,
            skipped: only('skipped').length,
        },
        flaky: only('flaky'),
        failed: only('unexpected'),
        // The excluded tests are all listed, so a reader sees which ones pass now.
        passed: mode === 'excluded' ? only('expected') : [],
    }
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/`/g, "'")

const testCell = (test) => `\`${cell(`${test.file} > ${test.title}`)}\``

// The cells are escaped by the caller.
function rowsTable(header, rows) {
    const shown = rows.slice(0, maxRows)
    const lines = [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...shown.map((row) => `| ${row.join(' | ')} |`),
    ]
    if (rows.length > shown.length)
        lines.push('', `${rows.length - shown.length} more are not shown.`)
    return lines
}

const problemRows = (list, withLabel) =>
    [
        ...list.failed.map((test) => ['Failed', test]),
        ...list.flaky.map((test) => ['Flaky', test]),
    ].map(([result, test]) => [
        ...(withLabel ? [cell(list.label)] : []),
        result,
        cell(test.project),
        testCell(test),
        String(test.retries),
        cell(test.error),
    ])

export function shardSummary(list) {
    if (list.mode === 'excluded') return excludedSummary([list])
    if (!list.flaky.length && !list.failed.length) return ''
    return [
        `### ${list.label}: ${list.flaky.length} flaky, ${list.failed.length} failed`,
        '',
        ...rowsTable(
            ['Result', 'Project', 'Test', 'Retries', 'First error'],
            problemRows(list, false),
        ),
        '',
    ].join('\n')
}

function excludedSummary(lists) {
    const passed = lists.flatMap((list) => list.passed)
    const failed = lists.flatMap((list) => [...list.failed, ...list.flaky])
    const lines = [
        '### Excluded tests',
        '',
        `${passed.length} pass now, ${failed.length} still fail. A test that passes can be dropped from \`ciExclusions\` in \`playwright.config.ts\`. Each test ran once, with no retry.`,
        '',
    ]
    if (passed.length)
        lines.push(
            '**Pass now**',
            '',
            ...rowsTable(
                ['Project', 'Test'],
                passed.map((test) => [cell(test.project), testCell(test)]),
            ),
            '',
        )
    if (failed.length)
        lines.push(
            '**Still fail**',
            '',
            ...rowsTable(
                ['Project', 'Test', 'First error'],
                failed.map((test) => [cell(test.project), testCell(test), cell(test.error)]),
            ),
            '',
        )
    return lines.join('\n')
}

export function collectSummary(lists) {
    const shards = lists.filter((list) => list.mode !== 'excluded')
    const excluded = lists.filter((list) => list.mode === 'excluded')
    const flaky = shards.reduce((sum, list) => sum + list.flaky.length, 0)
    const failed = shards.reduce((sum, list) => sum + list.failed.length, 0)
    const ran = shards.reduce(
        (sum, list) => sum + list.counts.passed + list.counts.flaky + list.counts.failed,
        0,
    )
    const lines = [
        '## Flaky tests',
        '',
        `${flaky} flaky and ${failed} failed of ${ran} tests, from ${shards.length} reports. A report is missing when its job stopped before the end.`,
        '',
    ]
    const rows = shards.flatMap((list) => problemRows(list, true))
    if (rows.length)
        lines.push(
            ...rowsTable(['Job', 'Result', 'Project', 'Test', 'Retries', 'First error'], rows),
            '',
            'A flaky test passed only on a retry. Fix it; do not leave it.',
            '',
        )
    if (excluded.length) lines.push(excludedSummary(excluded))
    return lines.join('\n')
}

function write(text) {
    if (!text) return
    if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
    else console.log(text)
}

function main([command, ...args]) {
    if (command === 'shard') {
        const label = args.find((arg) => !arg.startsWith('--'))
        if (!label) throw new Error('Usage: flaky-report.mjs shard <label> [--excluded]')
        const mode = args.includes('--excluded') ? 'excluded' : 'shard'
        if (!existsSync(rawFile)) {
            write(`### ${label}\n\nNo Playwright report was written.\n`)
            return
        }
        const list = makeList(label, mode, JSON.parse(readFileSync(rawFile, 'utf8')))
        mkdirSync(listDir, { recursive: true })
        writeFileSync(
            join(listDir, `${label.replace(/[^\w.-]+/g, '-')}.json`),
            `${JSON.stringify(list, null, 2)}\n`,
        )
        write(shardSummary(list))
    } else if (command === 'collect') {
        const [dir] = args
        if (!dir) throw new Error('Usage: flaky-report.mjs collect <dir>')
        const names = existsSync(dir)
            ? readdirSync(dir)
                  .filter((name) => name.endsWith('.json'))
                  .sort()
            : []
        const lists = names.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
        write(collectSummary(lists))
    } else {
        throw new Error('Usage: flaky-report.mjs shard|collect ...')
    }
}

// The report is a courtesy: whatever goes wrong here, the job's own result stays what the tests made it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main(process.argv.slice(2))
    } catch (error) {
        console.log(`flaky-report: ${error instanceof Error ? error.message : error}`)
    }
}
