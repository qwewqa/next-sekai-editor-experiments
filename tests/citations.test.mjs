import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { sourceWithout } from './platform/sourceText.ts'

// Code, tests and docs cite only what is in the repository (CONTRIBUTING, "Docs"). These are the
// forms a citation of something outside it takes, looked for in comments and in docs; a doc's
// own section ("history-format.md §4.6") passes. Code and string data are not scanned: a label
// such as 'Round 2' in a test is not a citation.

const root = fileURLToPath(new URL('..', import.meta.url))

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)

// A repository document by name: the bare names of the design docs, or any tracked Markdown file
// as `name.md` or `docs/name`.
const docNames = tracked
    .filter((path) => path.endsWith('.md'))
    .map((path) => path.replace(/^.*\//, '').replace(/\.md$/, ''))
const DOC = new RegExp(
    String.raw`(?:\b(?:colou?r[- ]system|design[- ]language|engineering[- ]principles|format[- ]versioning|history[- ]format|nxsp[- ]format|performance[- ]testing|rendering|ui-review-checklist|writing)(?:\.md)?\b|\b(?:${docNames.join('|')})\.md\b|\bdocs/(?:${docNames.join('|')})\b)`,
    'i',
)
const SECTION = String.raw`(?:§ ?|\b[Ss]ections? |\b[Ii]nvariants? |\b[Rr]ules? )\d+(?:\.\d+)*[a-z]?(?:(?:,| and| or) \d+(?:\.\d+)*)*`
// A section or rule number right after, or right before, a named repository document.
const DOC_REFERENCE = new RegExp(
    `${DOC.source}[ ,:(]{0,3}${SECTION}|${SECTION} (?:of|in) ${DOC.source}`,
    'gi',
)

const RULES = [
    { name: 'a numbered part', pattern: /\bPart [0-6],? ?(?:§|[0-6]\.\d|#\d)/ },
    {
        name: 'a three-level section',
        pattern: /(?:§ ?|\b[Ss]ections? )[0-6]\.\d+\.\d+/,
        afterDocs: true,
    },
    {
        name: 'a section with no doc named',
        pattern: /§ ?\d/,
        afterDocs: true,
        applies: (path) => !/^docs\/[^/]+\.md$/.test(path),
    },
    {
        name: 'a decision or entry id',
        // Not a quoted label in test data, or a CIE illuminant (D50, D65) in a color comment.
        pattern: /(?<!['"`])\b(?:D(?!65\b)|U)\d{1,3}\b|\bX-\d+\b|\bI-\d+\b/,
        applies: (path, line) => !/white ?point|illuminant|\bCIE\b/i.test(line),
    },
    {
        name: 'a review finding id',
        pattern: /\b(?:ADV|SF|UI|AR|HS|PF|SP|DEF|INV|RM|TH)\d*-\d+[a-z]?\b|\bWS-\d+\b/,
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
    { name: 'a review round', pattern: /\b[Rr]ound \d+\b|\br\d+-[a-z]+/ },
    {
        name: 'a decision record',
        pattern: /\(owner,?(?: \d{4}-|\s*$)|\bowner decision\b|\bdecision log\b|\bspec[- ][A-Z]\b/i,
    },
    {
        name: 'a numbered invariant or rule',
        pattern: /\binvariants? \d+|\brules? \d+(?: and \d+)?\b/i,
        afterDocs: true,
    },
    {
        name: 'a plan section with a step',
        pattern: /\b[0-6]\.\d+\.\d+(?:'s)? step\b|\bfollows [0-6]\.\d+\.\d+/,
    },
    {
        name: 'a path outside the repository',
        pattern:
            /\b[A-Za-z]:[\\/]sonolus\b|\bnse-next[\\/]|\bwork\/[\w.-]|\bplan\/parts\b|\b[Pp]lan §/,
    },
]

const SCANNED =
    /\.(?:ts|mts|mjs|cjs|js|vue|css|html|md|py|toml|yml|yaml|sh|sql|ps1|service|timer|env)$|(?:^|\/)Caddyfile$/

/** The text with every character that fails `kept` replaced by a space, line breaks aside. */
const keepOnly = (text, kept) =>
    [...text].map((char, i) => (char === '\n' || char === '\r' || kept(i) ? char : ' ')).join('')

/** The comments of one file, in place; a doc is all comment. */
export const commentsOf = (path, text) => {
    if (path.endsWith('.md')) return text
    if (/\.(?:ts|mts|mjs|cjs|js|vue|html)$/.test(path)) {
        // A comment is what the source loses when its comments are blanked.
        const without = sourceWithout(path, text, false)
        return keepOnly(text, (i) => without[i] !== text[i])
    }
    if (path.endsWith('.css')) {
        const spans = [...text.matchAll(/\/\*[\s\S]*?\*\//g)]
        return keepOnly(text, (i) => spans.some((s) => i >= s.index && i < s.index + s[0].length))
    }
    // The rest comment with `#` (`--` in SQL), from the mark to the end of the line.
    const mark = path.endsWith('.sql') ? /(?:^|\s)--/ : /(?:^|\s)#/
    return text
        .split('\n')
        .map((line) => {
            const found = mark.exec(line)
            const at = found ? found.index : line.length
            return line.slice(0, at).replace(/[^\r]/g, ' ') + line.slice(at)
        })
        .join('\n')
}

/** What a file cites from outside the repository, as `path:line: rule: match`. */
export const citationsIn = (path, text) => {
    const found = []
    commentsOf(path, text)
        .split('\n')
        .forEach((line, index) => {
            const withoutDocs = line.replace(DOC_REFERENCE, (match) => ' '.repeat(match.length))
            for (const rule of RULES) {
                const match = (rule.afterDocs ? withoutDocs : line).match(rule.pattern)
                if (match && (!rule.applies || rule.applies(path, line)))
                    found.push(`${path}:${index + 1}: ${rule.name}: ${match[0]}`)
            }
        })
    return found
}

test('code, tests and docs cite nothing outside the repository', () => {
    const found = tracked
        .filter((path) => SCANNED.test(path) && path !== 'tests/citations.test.mjs')
        .flatMap((path) => citationsIn(path, readFileSync(`${root}/${path}`, 'utf8')))
    assert.deepEqual(found, [])
})

// Each probe is a line a writer could add. A reference to a repository doc passes. A reference
// to the plan, the workspace or a decision record fails, in a comment and only there.
const probes = [
    ['a CIE illuminant in a comment', 'src/c.ts', '// Convert the D50 white point.', []],
    ['a review label in a string', 'tests/c.spec.ts', "const label = 'Round 2'", []],
    ['a review round in a comment', 'src/c.ts', '// Fixed in round 2.', ['a review round']],
    ['a doc and a section', 'src/c.ts', '// See docs/analytics.md §1 for the payload.', []],
    [
        'a section with no doc',
        'src/c.ts',
        '// See §1 for the payload.',
        ['a section with no doc named'],
    ],
    ['a doc and an invariant', 'docs/c.md', 'See docs/history-format.md, invariant 1.', []],
    [
        'an invariant with no doc',
        'docs/c.md',
        'Invariant 1 holds.',
        ['a numbered invariant or rule'],
    ],
    ['a doc and a three-level section', 'src/c.ts', '// See nxsp-format.md section 3.1.1.', []],
    [
        'a plan section',
        'src/c.ts',
        '// See Part 1 §1.6.11.',
        ['a numbered part', 'a three-level section', 'a section with no doc named'],
    ],
    [
        'a plan section beside a doc',
        'src/c.ts',
        '// See writing.md and section 1.6.11.',
        ['a three-level section'],
    ],
    ['a decision id', 'src/c.ts', '// Kept as decided (D12).', ['a decision or entry id']],
    ['a workspace path', 'src/c.ts', '// See work/STATE.md.', ['a path outside the repository']],
    ['a workspace path in a string', 'src/c.ts', "const path = 'work/STATE.md'", []],
    [
        'a hash comment',
        'infra/run.sh',
        'echo ok # see work/STATE.md',
        ['a path outside the repository'],
    ],
]
for (const [name, path, text, rules] of probes)
    test(`the guard on ${name}`, () => {
        const names = citationsIn(path, text).map((entry) => entry.split(': ')[1])
        assert.deepEqual(names, rules)
    })
