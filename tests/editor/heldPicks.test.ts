import assert from 'node:assert/strict'
import test from 'node:test'
import { trackHeldPicks } from '../../src/editor/levelInfo/heldPicks'
import type { Picked } from '../../src/editor/levelInfo/picked'
import { heldItem, holdMedia, resetHeldMediaForTests } from '../../src/local/heldMedia'

// What a Level Info dialog releases from the held media when it closes.

const pickOf = (hash: string, kind: 'cover' | 'preview' = 'cover'): Picked => ({
    ref: { hash, filename: `${hash}.bin`, size: 3, type: 'image/png' },
    item: { hash, bytes: new Uint8Array([1, 2, 3]).buffer, type: 'image/png', kind },
})

test.beforeEach(() => {
    resetHeldMediaForTests()
})

test('picks that a replacement or a discard leaves unused are released, and the map is as before', () => {
    const picks = trackHeldPicks()
    picks.hold(pickOf('a'))
    picks.hold(pickOf('b'))
    // The draft replaced "a" with "b".
    picks.release((hash) => hash === 'b')
    assert.equal(heldItem('a'), undefined)
    assert.ok(heldItem('b'))
    // Closed without Apply, with nothing in use.
    picks.release(() => false)
    assert.equal(heldItem('b'), undefined)
})

test('picks that Apply took stay held, and a later release leaves them', () => {
    const picks = trackHeldPicks()
    picks.hold(pickOf('a'))
    picks.hold(pickOf('b'))
    picks.release((hash) => hash === 'b')
    picks.applied()
    picks.release(() => false)
    assert.equal(heldItem('a'), undefined)
    assert.ok(heldItem('b'))
})

test('a hash held before the dialog survives the discard of the same pick', () => {
    holdMedia(pickOf('a').item)
    const picks = trackHeldPicks()
    picks.hold(pickOf('a'))
    picks.release(() => false)
    assert.ok(heldItem('a'))
})

test('a hash the opening values or the draft still name is kept', () => {
    const picks = trackHeldPicks()
    picks.hold(pickOf('a'))
    picks.release((hash) => hash === 'a')
    assert.ok(heldItem('a'))
})

test('a pick a step already names is adopted and not released', () => {
    const picks = trackHeldPicks()
    picks.hold(pickOf('a'))
    picks.adopt('a')
    picks.release(() => false)
    assert.ok(heldItem('a'))
})

test('the same file picked twice is released once the draft drops it', () => {
    const picks = trackHeldPicks()
    picks.hold(pickOf('a'))
    picks.hold(pickOf('a', 'preview'))
    picks.release(() => false)
    assert.equal(heldItem('a'), undefined)
})
