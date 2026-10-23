import assert from 'node:assert/strict'
import test from 'node:test'
import { displayName, forkNameOf } from '../../src/local/names'

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
