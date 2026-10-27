import assert from 'node:assert/strict'
import test from 'node:test'
import {
    isKnownEntryKind,
    isKnownNodeType,
    isNewerRootVersion,
    isNewerSessionVersion,
    isReadableChain,
    isReadableRootVersion,
    isReadableSession,
    readFileEvent,
    readMediaKind,
    readOrigin,
    sessionReadability,
} from '../../../src/local/records/unknownValues'
import { RECORDS_V, SESSION_V } from '../../../src/local/records/version'

test('only the current session generation is readable, including in its chain', () => {
    for (const v of [undefined, 0, SESSION_V + 1, String(SESSION_V)])
        assert.equal(isReadableSession({ row: { v } }), false, String(v))
    assert.equal(isReadableSession({ row: {} }), false)
    assert.equal(isReadableSession({ row: { v: SESSION_V } }), true)
    const readable = { row: { v: SESSION_V } }
    assert.equal(isReadableChain([readable, readable]), true)
    assert.equal(isReadableChain([readable, { row: { v: SESSION_V + 1 } }]), false)
    assert.equal(isReadableChain([readable, { row: {} }]), false)
    assert.equal(isReadableChain([readable, { row: { v: 0 } }]), false)
})

test('an unknown entry kind or a newer root makes a session, and its chain, unreadable', () => {
    const row = { v: SESSION_V }
    assert.equal(isReadableSession({ row, entryKinds: ['init', 'edit', 'save'] }), true)
    assert.equal(isReadableSession({ row, entryKinds: ['init', 'merge'] }), false)
    assert.equal(isReadableSession({ row, rootVersions: [1, 1] }), true)
    assert.equal(isReadableSession({ row, rootVersions: [1, 2] }), false)
    assert.equal(isReadableChain([{ row }, { row, rootVersions: [2] }]), false)
    for (const v of [0, 2, 1.5, '1', undefined])
        assert.equal(isReadableRootVersion(v), false, String(v))
    assert.equal(isKnownEntryKind('recovered'), true)
})

test('unknown enum values follow the field table', () => {
    assert.equal(readOrigin('continued'), 'continued')
    assert.equal(readOrigin('fallback'), undefined)
    assert.deepEqual(readFileEvent('saved'), 'saved')
    assert.deepEqual(readFileEvent('downloaded'), 'downloaded')
    assert.deepEqual(readFileEvent('synced'), 'downloaded')
    assert.equal(readMediaKind('cover'), 'cover')
    assert.equal(readMediaKind('thumbnail'), undefined)
    assert.equal(isKnownNodeType('root'), true)
    assert.equal(isKnownNodeType('tree'), false)
})

test('readability splits what a newer build wrote from what is merely not supported', () => {
    const row = { v: SESSION_V }
    assert.equal(sessionReadability({ row }), 'readable')
    // Newer: a session v above this build's, an unknown entry kind, a root v above RECORDS_V.
    assert.equal(sessionReadability({ row: { v: SESSION_V + 1 } }), 'newer')
    assert.equal(sessionReadability({ row, entryKinds: ['init', 'merge'] }), 'newer')
    assert.equal(sessionReadability({ row, rootVersions: [1, 2] }), 'newer')
    assert.equal(sessionReadability({ row, rootVersions: [RECORDS_V + 5] }), 'newer')
    // Not newer, and not read either: a malformed `v`.
    for (const v of [0, -1, 1.5, '1', undefined])
        assert.equal(sessionReadability({ row: { v } }), 'unsupported', String(v))
    for (const v of [0, -1, 1.5, '1', undefined])
        assert.equal(sessionReadability({ row, rootVersions: [v] }), 'unsupported', String(v))
    // Newer wins when both are found: the chain "Needs a newer version".
    assert.equal(sessionReadability({ row: { v: 0 }, entryKinds: ['merge'] }), 'newer')
    assert.equal(sessionReadability({ row, rootVersions: [0, 2] }), 'newer')
    assert.equal(isNewerSessionVersion(SESSION_V + 1), true)
    assert.equal(isNewerSessionVersion(SESSION_V), false)
    assert.equal(isNewerSessionVersion(0), false)
    assert.equal(isNewerSessionVersion('3'), false)
    assert.equal(isNewerRootVersion(2), true)
    assert.equal(isNewerRootVersion(1), false)
    assert.equal(isNewerRootVersion(0), false)
    assert.equal(isNewerRootVersion(undefined), false)
    // `isReadableSession` is exactly "readable".
    assert.equal(isReadableSession({ row, rootVersions: [1] }), true)
    assert.equal(isReadableSession({ row, rootVersions: [2] }), false)
})
