import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Code, tests and docs cite only what is in the repository (CONTRIBUTING, "Docs"). These are the
// forms a citation of something outside it takes; a doc's own section ("history-format.md §4.6")
// passes.

const root = fileURLToPath(new URL('..', import.meta.url))

const DOC_NAME =
    /\b(?:colou?r[- ]system|design[- ]language|engineering[- ]principles|format[- ]versioning|history[- ]format|nxsp[- ]format|performance[- ]testing|rendering|ui-review-checklist|writing)(?:\.md)?\b/

const RULES = [
    { name: 'a numbered part', pattern: /\bPart [0-6],? ?(?:§|[0-6]\.\d|#\d)/ },
    { name: 'a three-level section', pattern: /(?:§ ?|\b[Ss]ections? )[0-6]\.\d+\.\d+/ },
    {
        name: 'a section with no doc named',
        pattern: /§ ?\d/,
        applies: (path, line) => !/^docs\/[^/]+\.md$/.test(path) && !DOC_NAME.test(line),
    },
    {
        name: 'a decision or entry id',
        // Not a quoted label in test data, or the CIE illuminant D65.
        pattern: /(?<!['"`])\b(?:D(?!65\b)|U)\d{1,3}\b|\bX-\d+\b|\bI-\d+\b/,
    },
    {
        name: 'an invariant id',
        pattern: /\bI\d{1,3}\b/,
        // The fault matrix names its own invariants I1 to I10.
        applies: (path, line) =>
            !path.startsWith('tests/editor/saveMatrix/') && !line.includes('saveMatrix'),
    },
    {
        name: 'a build step',
        pattern: /\bSteps? \d+[a-z]\b|\(Step \d+[,)]|\bStep \d+(?:'s| design)\b/,
    },
    {
        name: 'a review round',
        pattern: /\b[Rr]ound \d+\b|\br\d+-[a-z]+/,
        // Its rounds are the perf plans in scripts/perf/plans/.
        applies: (path) => path !== 'docs/performance-testing.md',
    },
    {
        name: 'a decision record',
        pattern: /\(owner,(?: \d{4}-|\s*$)|\bowner decision\b|\bdecision log\b|\bspec[- ][A-Z]\b/,
    },
    {
        name: 'a path outside the repository',
        pattern:
            /\b[A-Za-z]:[\\/]sonolus\b|\bnse-next[\\/]|\bwork\/[\w.-]|\bplan\/parts\b|\b[Pp]lan §/,
    },
]

const SCANNED = /\.(?:ts|mts|mjs|cjs|js|vue|css|html|md|py|toml|yml|yaml)$/

test('code, tests and docs cite nothing outside the repository', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
        .split('\0')
        .filter((path) => SCANNED.test(path) && path !== 'tests/citations.test.mjs')
    const found = []
    for (const path of tracked) {
        const lines = readFileSync(`${root}/${path}`, 'utf8').split('\n')
        lines.forEach((line, index) => {
            for (const rule of RULES) {
                const match = line.match(rule.pattern)
                if (match && (!rule.applies || rule.applies(path, line)))
                    found.push(`${path}:${index + 1}: ${rule.name}: ${match[0]}`)
            }
        })
    }
    assert.deepEqual(found, [])
})
