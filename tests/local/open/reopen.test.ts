import assert from 'node:assert/strict'
import test from 'node:test'
import { reopensOwnFile, type ReopenFacts } from '../../../src/local/open/reopen'

// Open of the file the open session's chain last wrote (Part 1 §1.5.4): it keeps the session only
// when every fact holds. Each fact false sends the open the usual way, which makes a new chain:
// the bug each catches is an Open that skips a changed file, or another file, and drops the new
// chain that would have held it.

const disk = (lastModified: number, cd = '0a0b0c0d') => ({
    revisionId: 'r2',
    fingerprint: `zip:100:${lastModified}:${cd}`,
    size: 100,
    lastModified,
})

/** A download browser's facts that match: no handle on either side. */
const download = (): ReopenFacts => ({
    identity: true,
    asHead: true,
    file: { docId: 'doc', revisionId: 'r2', head: 'aa', handle: false },
    binding: {
        docId: 'doc',
        revisionId: 'r2',
        replaced: false,
        file: { event: 'downloaded', hash: 'aa', handle: false },
    },
    changed: false,
    sameEntry: false,
    badChunks: false,
    mediaHeld: true,
})

/** A save picker's facts that match: both handles name one file with the same content. */
const picked = (): ReopenFacts => ({
    ...download(),
    file: { docId: 'doc', revisionId: 'r2', head: 'aa', disk: disk(1), handle: true },
    binding: {
        docId: 'doc',
        revisionId: 'r2',
        replaced: false,
        file: { event: 'saved', hash: 'aa', disk: disk(1), handle: true },
    },
    sameEntry: true,
})

const withFile = (facts: ReopenFacts, file: Partial<ReopenFacts['file']>): ReopenFacts => ({
    ...facts,
    file: { ...facts.file, ...file },
})

const withBound = (
    facts: ReopenFacts,
    bound: Partial<NonNullable<NonNullable<ReopenFacts['binding']>['file']>>,
): ReopenFacts => ({
    ...facts,
    binding: { ...facts.binding!, file: { ...facts.binding!.file!, ...bound } },
})

test('the session’s own last write, unchanged, matches with or without handles', () => {
    assert.equal(reopensOwnFile(download()), true)
    assert.equal(reopensOwnFile(picked()), true)
})

test('each fact that does not hold sends the open the usual way', () => {
    const cases: [string, ReopenFacts][] = [
        ['a partial open, or one bound in another tab', { ...download(), identity: false }],
        ['a level that is not its history’s head', { ...download(), asHead: false }],
        ['a binding that could not be read', { ...download(), binding: undefined }],
        [
            'a session with no binding',
            { ...download(), binding: { ...download().binding!, file: undefined } },
        ],
        [
            'a binding taken over',
            { ...download(), binding: { ...download().binding!, replaced: true } },
        ],
        // An open's import may have ended short of the file: a fresh import is its repair.
        ['a binding an open made', withBound(download(), { event: 'opened' })],
        ['another document', withFile(download(), { docId: 'other' })],
        ['no document id', withFile(download(), { docId: undefined })],
        ['another revision', withFile(download(), { revisionId: 'r3' })],
        ['no revision', withFile(download(), { revisionId: undefined })],
        ['a head the binding does not hold', withFile(download(), { head: 'bb' })],
        ['a file without history', withFile(download(), { head: undefined })],
        ['changes since the write', { ...download(), changed: true }],
        ['chunks found bad', { ...download(), badChunks: true }],
        ['media storage lacks', { ...download(), mediaHeld: false }],
        ['another file at another path', { ...picked(), sameEntry: false }],
        ['content changed on disk', withFile(picked(), { disk: disk(1, 'ffffffff') })],
        ['no disk state for the opened file', withFile(picked(), { disk: undefined })],
    ]
    for (const [name, facts] of cases) assert.equal(reopensOwnFile(facts), false, name)
})

test('a handle on one side only does not match: the next Save would write another file', () => {
    assert.equal(reopensOwnFile(withFile(download(), { handle: true, disk: disk(1) })), false)
    assert.equal(reopensOwnFile(withBound(download(), { handle: true, disk: disk(1) })), false)
})

test('the same content with a new modification time matches, as the write-back check does', () => {
    // A sync folder touches the time: no spurious new chain, and no conflict at the next Save.
    assert.equal(reopensOwnFile(withFile(picked(), { disk: disk(99) })), true)
})
