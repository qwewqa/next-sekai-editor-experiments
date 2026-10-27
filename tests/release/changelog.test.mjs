import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { checkChangelog } from '../../scripts/release/changelog.mjs'

const valid = `# Changelog

## Unreleased

- (Apps) Fixed: the Trash count did not update after Delete Forever.

## 0.10.0 (2027-03-02)

- An app for Windows, with a project library.
- (Web) Fixed: Level Info did not show the BGM’s length.

## 0.9.0 (2027-02-01)

- Something else.
`

test('CHANGELOG.md follows its format', () => {
    const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')
    assert.deepEqual(checkChangelog(text), [])
})

test('a changelog in the documented form passes, with 0.10.0 above 0.9.0', () => {
    assert.deepEqual(checkChangelog(valid), [])
    assert.deepEqual(checkChangelog('# Changelog\n\n## Unreleased\n'), [])
})

test('a code span may hold an apostrophe or a contraction, and the prose around it may not', () => {
    const span = valid.replace(
        '- Something else.',
        "- Fixed importing an author named `O'Connor` and the literal `'`.",
    )
    assert.notEqual(span, valid)
    assert.deepEqual(checkChangelog(span), [])
    const double = valid.replace(
        '- Something else.',
        "- Fixed importing ``O'Connor`` and ``a`b'c``.",
    )
    assert.deepEqual(checkChangelog(double), [])
    const prose = span.replace('Fixed importing', "Fixed importing, as it isn't, ")
    assert.ok(checkChangelog(prose).some((problem) => problem.includes('contractions')))
    const mixed = span.replace('author named', "author's name")
    assert.ok(checkChangelog(mixed).some((problem) => problem.includes('apostrophe')))
})

// Each case is a slip a hand edit could make; the last item is a part of the expected problem.
const broken = [
    [
        'a release above Unreleased',
        valid.replace('## Unreleased', '## 0.11.0 (2027-04-01)'),
        'first',
    ],
    ['Unreleased missing', valid.replace(/## Unreleased\n\n.*\n\n/, ''), 'must come first'],
    ['a heading without a date', valid.replace(' (2027-02-01)', ''), 'Not "## X.Y.Z'],
    ['a date that does not exist', valid.replace('2027-02-01', '2027-02-30'), 'Not a date'],
    [
        'versions sorted as text',
        valid.replace('0.10.0', '0.9.0').replace('0.9.0 (2027-02-01)', '0.10.0 (2027-02-01)'),
        'decrease',
    ],
    ['a repeated version', valid.replace('0.9.0', '0.10.0'), 'decrease'],
    [
        'an older release listed first',
        valid.replace('0.10.0 (2027-03-02)', '0.8.0 (2027-03-02)'),
        'decrease',
    ],
    [
        'a nested bullet',
        valid.replace('- Something else.', '- Something else.\n  - Detail.'),
        'bullet',
    ],
    ['a wrapped line', valid.replace('- Something else.', '- Something\n  else.'), 'bullet'],
    ['a star bullet', valid.replace('- Something else.', '* Something else.'), 'bullet'],
    ['an unknown platform prefix', valid.replace('(Web)', '(Mobile)'), 'bullet'],
    ['a prefix without its space', valid.replace('(Web) Fixed', '(Web)Fixed'), 'bullet'],
    ['an ASCII apostrophe', valid.replace('BGM’s', "BGM's"), 'apostrophe'],
    ['a contraction', valid.replace('did not show', 'didn’t show'), 'contractions'],
    [
        'a contraction with the ASCII mark',
        valid.replace('did not show', "didn't show"),
        'contractions',
    ],
    ['it’s for it is', valid.replace('Something else', 'It’s fixed'), 'contractions'],
    [
        'no blank line before a heading',
        valid.replace('length.\n\n## 0.9.0', 'length.\n## 0.9.0'),
        'Layout',
    ],
    [
        'no blank line after a heading',
        valid.replace('(2027-02-01)\n\n', '(2027-02-01)\n'),
        'Layout',
    ],
    [
        'two blank lines between sections',
        valid.replace('length.\n\n## 0.9.0', 'length.\n\n\n## 0.9.0'),
        'Layout',
    ],
    [
        'a blank line between bullets',
        valid.replace('library.\n- (Web)', 'library.\n\n- (Web)'),
        'Layout',
    ],
    ['a released section with no lines', valid.replace('- Something else.\n', ''), 'no lines'],
    [
        'text after the title',
        valid.replace('# Changelog\n\n', '# Changelog\n\nNotes.\n\n'),
        'Text before',
    ],
    ['a missing final newline', valid.trimEnd(), 'newline'],
    ['a second final newline', valid + '\n', 'newline'],
    ['CRLF line ends', valid.replaceAll('\n', '\r\n'), 'LF'],
    ['a different title', valid.replace('# Changelog', '# Changes'), 'Changelog'],
    ['a sub-heading', valid.replace('- Something else.', '### Fixed\n\n- Something else.'), 'Not'],
]
for (const [name, text, expected] of broken) {
    test(`rejects ${name}`, () => {
        assert.notEqual(text, valid)
        const problems = checkChangelog(text)
        assert.ok(
            problems.some((problem) => problem.includes(expected)),
            `${expected} not in ${JSON.stringify(problems)}`,
        )
    })
}
