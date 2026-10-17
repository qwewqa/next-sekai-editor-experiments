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

test('a session row whose v is 2 is Needs a newer version, and so is its chain', () => {
    assert.equal(isReadableSession({ row: {} }), true)
    assert.equal(isReadableSession({ row: { v: 1 } }), true)
    assert.equal(isReadableSession({ row: { v: 2 } }), false)
    assert.equal(isReadableSession({ row: { v: '1' } }), false)
    const readable = { row: {} }
    assert.equal(isReadableChain([readable, readable]), true)
    assert.equal(isReadableChain([readable, { row: { v: 2 } }]), false)
})

test('an unknown entry kind or a newer root makes a session, and its chain, unreadable', () => {
    assert.equal(isReadableSession({ row: {}, entryKinds: ['init', 'edit', 'save'] }), true)
    assert.equal(isReadableSession({ row: {}, entryKinds: ['init', 'merge'] }), false)
    assert.equal(isReadableSession({ row: {}, rootVersions: [1, 1] }), true)
    assert.equal(isReadableSession({ row: {}, rootVersions: [1, 2] }), false)
    assert.equal(isReadableChain([{ row: {} }, { row: {}, rootVersions: [2] }]), false)
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
