import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    checkChangelog,
    cutChangelog,
    formatDate,
    messageLines,
    unreleasedLines,
} from '../../scripts/release/changelog.mjs'
import {
    ReleaseError,
    changedFormatVersions,
    checkNewVersion,
    checkPatchFormats,
    formatConstants,
    isPatchVersion,
    newestTag,
    parseArgs,
    readFormatVersions,
} from '../../scripts/release/rules.mjs'

const refuses = (run, pattern) =>
    assert.throws(run, (error) => error instanceof ReleaseError && pattern.test(error.message))

test('arguments: the version, --commit in both forms and --edit', () => {
    assert.deepEqual(parseArgs(['0.7.0']), { version: '0.7.0', commit: undefined, edit: false })
    assert.deepEqual(parseArgs(['--edit', '0.7.0', '--commit', 'abc1234']), {
        version: '0.7.0',
        commit: 'abc1234',
        edit: true,
    })
    assert.equal(parseArgs(['0.7.0', '--commit=ABC1234']).commit, 'ABC1234')
    assert.deepEqual(parseArgs(['0.7.0', '--help']), { help: true })
})

test('arguments: a slip that would tag the wrong thing stops', () => {
    // v0.7.0 would make the tag vv0.7.0.
    refuses(() => parseArgs(['v0.7.0']), /no "v"/)
    refuses(() => parseArgs(['0.7']), /X\.Y\.Z/)
    refuses(() => parseArgs(['0.7.0-beta']), /X\.Y\.Z/)
    refuses(() => parseArgs(['0.07.0']), /X\.Y\.Z/)
    refuses(() => parseArgs([]), /missing/)
    refuses(() => parseArgs(['0.7.0', '0.7.1']), /Unexpected/)
    refuses(() => parseArgs(['0.7.0', '--force']), /Unknown option/)
    // The flag after a bare --commit must not become the commit; HEAD is not a hash.
    refuses(() => parseArgs(['0.7.0', '--commit', '--edit']), /--commit takes/)
    refuses(() => parseArgs(['0.7.0', '--commit']), /--commit takes/)
    refuses(() => parseArgs(['0.7.0', '--commit', 'HEAD']), /--commit takes/)
    refuses(() => parseArgs(['0.7.0', '--commit', 'abc1234', '--commit', 'def5678']), /twice/)
})

test('the version is new and above the newest tag, by number', () => {
    assert.equal(checkNewVersion('0.6.0', ['v0.5.22']), 'v0.5.22')
    assert.equal(checkNewVersion('0.10.0', ['v0.9.9', 'v0.9.10']), 'v0.9.10')
    assert.equal(checkNewVersion('0.5.22', []), undefined)
    refuses(() => checkNewVersion('0.6.0', ['v0.6.0']), /exists/)
    // A fix tag from an older line after the next line shipped never deploys.
    refuses(() => checkNewVersion('0.5.23', ['v0.5.22', 'v0.6.0']), /greater than v0\.6\.0/)
    // As text, 0.9.0 is above 0.10.0.
    refuses(() => checkNewVersion('0.9.0', ['v0.10.0']), /greater than v0\.10\.0/)
    refuses(() => checkNewVersion('0.5.9', ['v0.5.10']), /greater/)
})

test('tags that are not versions are ignored', () => {
    assert.equal(newestTag(['v0.5.22', 'v0.6', 'vnext', 'v1.0.0-beta', 'v0.6.0.1']), 'v0.5.22')
    assert.equal(newestTag(['vnext']), undefined)
    assert.equal(checkNewVersion('0.5.23', ['v0.5.22', 'v1.0.0-beta']), 'v0.5.22')
})

test('a patch version is a non-zero last number', () => {
    assert.equal(isPatchVersion('0.6.1'), true)
    assert.equal(isPatchVersion('0.6.10'), true)
    assert.equal(isPatchVersion('0.7.0'), false)
    assert.equal(isPatchVersion('1.0.0'), false)
})

const defaults = {
    LEVEL_VERSION: 1,
    RECORDS_V: 1,
    NXSP_VERSION: 1,
    NXSP_MINOR: 0,
    NXSP_PATCH: 0,
    MANIFEST_VERSION: 1,
}
const sources = (numbers) => {
    const n = { ...defaults, ...numbers }
    return {
        'src/levelData/levelVersion.ts': `/** Notes */\nexport const LEVEL_VERSION = ${n.LEVEL_VERSION}\n`,
        'src/local/records/version.ts': `export const RECORDS_V = ${n.RECORDS_V}\n\nexport const SESSION_V = 1\n`,
        'src/local/nxsp/version.ts': [
            `export const NXSP_VERSION = ${n.NXSP_VERSION}`,
            `export const NXSP_MINOR = ${n.NXSP_MINOR}`,
            `export const NXSP_PATCH = ${n.NXSP_PATCH}`,
            `export const MANIFEST_VERSION = ${n.MANIFEST_VERSION}`,
        ].join('\n\n'),
    }
}
const versionsOf = (numbers) => {
    const files = sources(numbers)
    return readFormatVersions((file) => files[file] ?? null)
}

test('the format constants are read from source text', () => {
    assert.deepEqual(versionsOf({ RECORDS_V: 3, NXSP_PATCH: 2 }), {
        ...defaults,
        RECORDS_V: 3,
        NXSP_PATCH: 2,
    })
})

test('every format constant is found in the current source', () => {
    // A renamed or moved constant would otherwise turn the patch check off without a sign.
    const versions = readFormatVersions((file) =>
        readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'),
    )
    for (const { name } of formatConstants) assert.equal(typeof versions[name], 'number', name)
})

test('a revision before the files existed reads as no numbers; a moved constant stops', () => {
    const none = readFormatVersions(() => null)
    assert.ok(formatConstants.every(({ name }) => none[name] === null))
    refuses(
        () => readFormatVersions((file) => (file.endsWith('version.ts') ? 'export {}' : null)),
        /Cannot find (LEVEL_VERSION|RECORDS_V)/,
    )
    // A constant in a comment or declared differently is not its definition.
    refuses(
        () =>
            readFormatVersions((file) =>
                file.includes('levelVersion')
                    ? '// LEVEL_VERSION = 2\nconst LEVEL_VERSION = 2'
                    : null,
            ),
        /Cannot find LEVEL_VERSION/,
    )
})

test('a patch version is refused when any written format changed', () => {
    const before = versionsOf({})
    for (const name of Object.keys(defaults)) {
        const after = versionsOf({ [name]: defaults[name] + 1 })
        refuses(() => checkPatchFormats('0.6.1', 'v0.6.0', before, after), new RegExp(name))
    }
    // Lowering a number changes what the build writes too.
    refuses(
        () => checkPatchFormats('0.6.1', 'v0.6.0', versionsOf({ RECORDS_V: 2 }), before),
        /RECORDS_V 2 to 1/,
    )
})

test('a patch version passes with unchanged formats, and a minor version always passes', () => {
    const before = versionsOf({})
    assert.doesNotThrow(() => checkPatchFormats('0.6.1', 'v0.6.0', before, versionsOf({})))
    assert.doesNotThrow(() =>
        checkPatchFormats('0.7.0', 'v0.6.1', before, versionsOf({ LEVEL_VERSION: 2 })),
    )
})

test('files that exist only at the commit count as a change', () => {
    // An old tag without the files is a baseline of none; a patch cannot introduce them.
    const none = readFormatVersions(() => null)
    refuses(() => checkPatchFormats('0.5.23', 'v0.5.22', none, versionsOf({})), /formats changed/)
    assert.deepEqual(changedFormatVersions(none, none), [])
})

const changelog = `# Changelog

## Unreleased

- First line.
- (Web) Second line.

## 0.6.0 (2027-01-05)

- Older line.
`

test('the notes are the Unreleased lines', () => {
    assert.deepEqual(unreleasedLines(changelog), ['- First line.', '- (Web) Second line.'])
    const empty = '# Changelog\n\n## Unreleased\n\n## 0.6.0 (2027-01-05)\n\n- A.\n'
    assert.deepEqual(unreleasedLines(empty), [])
    refuses(() => unreleasedLines(changelog.replace('- First', '* First')), /format/)
})

test('a tag message edit must stay bullets', () => {
    assert.deepEqual(messageLines('- A.\n- B.\n\n'), ['- A.', '- B.'])
    // A line of prose would reach the changelog as a line that is not a bullet.
    refuses(() => messageLines('- A.\nSee the issue.\n'), /bullets/)
})

const cut = (text, options) =>
    cutChangelog(text, { version: '0.7.0', date: '2027-02-01', ...options })

test('the cut moves the released lines under a dated heading', () => {
    const notes = ['- First line.', '- (Web) Second line.']
    const result = cut(changelog, { released: notes, notes })
    assert.equal(
        result,
        `# Changelog

## Unreleased

## 0.7.0 (2027-02-01)

- First line.
- (Web) Second line.

## 0.6.0 (2027-01-05)

- Older line.
`,
    )
    assert.deepEqual(checkChangelog(result), [])
})

test('lines added after the tagged commit stay under Unreleased', () => {
    const notes = ['- First line.']
    const result = cut(changelog, { released: notes, notes })
    assert.match(
        result,
        /## Unreleased\n\n- \(Web\) Second line\.\n\n## 0\.7\.0 \(2027-02-01\)\n\n- First line\.\n\n## 0\.6\.0/,
    )
    assert.deepEqual(checkChangelog(result), [])
})

test('a released line that was reworded or removed since stops the cut', () => {
    const released = ['- First line.', '- (Web) Second line.']
    const reworded = changelog.replace('First line', 'First line, reworded')
    refuses(() => cut(reworded, { released, notes: released }), /by hand: - First line\./)
    const removed = changelog.replace('- (Web) Second line.\n', '')
    refuses(() => cut(removed, { released, notes: released }), /by hand: - \(Web\) Second line\./)
})

test('a line repeated since is removed once', () => {
    const text = changelog.replace('- First line.\n', '- First line.\n- First line.\n')
    const result = cut(text, { released: ['- First line.'], notes: ['- First line.'] })
    assert.match(result, /## Unreleased\n\n- First line\.\n- \(Web\) Second line\.\n\n## 0\.7\.0/)
})

test('the section holds the tag message when it was edited', () => {
    const result = cut(changelog, {
        released: ['- First line.', '- (Web) Second line.'],
        notes: ['- First line, edited.'],
    })
    assert.match(result, /## 0\.7\.0 \(2027-02-01\)\n\n- First line, edited\.\n\n## 0\.6\.0/)
    // The removal still follows the lines at the tagged commit.
    assert.match(result, /## Unreleased\n\n## 0\.7\.0/)
})

test('an edit that breaks the house rules stops the cut', () => {
    const released = ['- First line.', '- (Web) Second line.']
    refuses(() => cut(changelog, { released, notes: ['- It didn’t work.'] }), /contractions/)
})

test('a version already in the changelog stops the cut', () => {
    const notes = ['- First line.']
    const again = { version: '0.6.0', released: notes, notes }
    refuses(() => cut(changelog, again), /already has 0\.6\.0/)
})

test('a changelog that breaks its format stops the cut', () => {
    const notes = ['- First line.']
    refuses(
        () => cut(changelog.replace('## Unreleased', '## Soon'), { released: notes, notes }),
        /format/,
    )
})

test('the cut works on today’s changelog', () => {
    const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')
    const notes = ['- A new line.']
    const result = cut(text.replace('## Unreleased\n', '## Unreleased\n\n- A new line.\n'), {
        released: notes,
        notes,
    })
    assert.deepEqual(checkChangelog(result), [])
})

test('the date is the local calendar date with padding', () => {
    assert.equal(formatDate(new Date(2027, 2, 2)), '2027-03-02')
    assert.equal(formatDate(new Date(2027, 11, 31, 23, 59)), '2027-12-31')
})
