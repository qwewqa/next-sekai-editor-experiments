import assert from 'node:assert/strict'
import test from 'node:test'
import {
    isKnownEntryKind,
    isKnownNodeType,
    isListedUserAsset,
    isReadableChain,
    isReadableRootVersion,
    isReadableSession,
    isShownTombstone,
    readFileEvent,
    readMediaKind,
    readOrigin,
} from '../../../src/local/records/unknownValues'
import { SESSION_V } from '../../../src/local/records/version'

test('only the current session generation is readable, including in its chain', () => {
    for (const v of [undefined, 1, SESSION_V + 1, String(SESSION_V)])
        assert.equal(isReadableSession({ row: { v } }), false, String(v))
    assert.equal(isReadableSession({ row: {} }), false)
    assert.equal(isReadableSession({ row: { v: SESSION_V } }), true)
    const readable = { row: { v: SESSION_V } }
    assert.equal(isReadableChain([readable, readable]), true)
    assert.equal(isReadableChain([readable, { row: { v: SESSION_V + 1 } }]), false)
    assert.equal(isReadableChain([readable, { row: {} }]), false)
    assert.equal(isReadableChain([readable, { row: { v: 1 } }]), false)
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

test('unknown enum values follow §1.6.11.2’s table', () => {
    assert.equal(readOrigin('continued'), 'continued')
    assert.equal(readOrigin('fallback'), undefined)
    assert.deepEqual(readFileEvent('saved', undefined), { event: 'saved', confirmed: false })
    assert.deepEqual(readFileEvent('downloaded', true), { event: 'downloaded', confirmed: true })
    assert.deepEqual(readFileEvent('synced', true), { event: 'downloaded', confirmed: false })
    assert.equal(readMediaKind('cover'), 'cover')
    assert.equal(readMediaKind('thumbnail'), undefined)
    assert.equal(isListedUserAsset('skin'), true)
    assert.equal(isListedUserAsset('font'), false)
    assert.equal(isShownTombstone('session'), true)
    assert.equal(isShownTombstone('chain'), false)
    assert.equal(isKnownNodeType('root'), true)
    assert.equal(isKnownNodeType('tree'), false)
})
