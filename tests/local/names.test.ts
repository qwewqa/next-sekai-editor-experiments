import assert from 'node:assert/strict'
import test from 'node:test'
import {
    displayName,
    forkNameOf,
    hasCopyNumber,
    keptNameOf,
    nextCopyName,
    prefillOf,
} from '../../src/local/names'

// The displayed name (Part 1 §1.3.5): the bound file's stem outranks the chain's Name, which is
// now only a copy's automatic "<name> (2)".

test('a copy later saved as a file is named by the file, not by its automatic name', () => {
    assert.deepEqual(displayName({ name: 'Coconut (2)', fileName: 'melt.nxsp' }), {
        kind: 'file',
        text: 'melt',
    })
})

test('a copy that is not bound keeps its automatic name, and it ranks above the title', () => {
    assert.deepEqual(displayName({ name: 'Coconut (2)', title: 'Coconut' }), {
        kind: 'name',
        text: 'Coconut (2)',
    })
})

test('the rest of the order stands: title, source, BGM, then the date', () => {
    assert.equal(displayName({ title: 'T', sourceName: 'S', bgmName: 'b.mp3' }).kind, 'title')
    assert.equal(displayName({ sourceName: 'S', bgmName: 'b.mp3' }).kind, 'source')
    assert.equal(displayName({ sourceName: 'LevelData', bgmName: 'b.mp3' }).kind, 'bgm')
    assert.equal(displayName({}).kind, 'date')
})

test('a fork of a bound chain is named from its file', () => {
    assert.equal(forkNameOf({ name: 'Coconut (2)', fileName: 'melt.nxsp' }), 'melt (2)')
})

test('a copy of a copy counts upward: "Coconut (3)", not "Coconut (2) (2)"', () => {
    assert.equal(forkNameOf({ name: 'Coconut (2)' }), 'Coconut (3)')
    assert.equal(forkNameOf({ fileName: 'coconut (9).nxsp' }), 'coconut (10)')
    assert.equal(nextCopyName('coconut'), 'coconut (2)')
})

test('only a 1–2 digit " (n)" is a copy number: a year in a name stays', () => {
    assert.equal(nextCopyName('Song (2020)'), 'Song (2020) (2)')
    assert.equal(forkNameOf({ title: 'Song (2020)' }), 'Song (2020) (2)')
    assert.equal(hasCopyNumber('Song (2020)'), false)
    assert.equal(hasCopyNumber('Song(2)'), false)
    assert.equal(hasCopyNumber('Song (12)'), true)
})

test('the prefill is the displayed name as shown: a dotted name is not cut again', () => {
    // displayName already took the extension off; "feat. Miku" has no second one to take.
    assert.equal(prefillOf(displayName({ fileName: 'feat. Miku.nxsp' })), 'feat. Miku')
    assert.equal(prefillOf(displayName({ bgmName: 'song.v2.mp3' })), 'song.v2')
    assert.equal(prefillOf(displayName({ sourceName: 'feat. Miku' })), 'feat. Miku')
    assert.equal(prefillOf(displayName({ fileName: 'LevelData.nxsp' })), '')
    assert.equal(prefillOf(displayName({})), '')
})

test('a chain that loses its file takes its stem, over any name it had', () => {
    assert.equal(keptNameOf(undefined, 'feat. Miku.nxsp'), 'feat. Miku')
    assert.equal(keptNameOf('Coconut (2)', 'melt.nxsp'), 'melt')
    assert.equal(keptNameOf('Coconut (2)', undefined), 'Coconut (2)')
    assert.equal(keptNameOf(undefined, undefined), undefined)
})
