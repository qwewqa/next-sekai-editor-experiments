import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTags, tagsText } from '../../src/editor/levelInfo/tags'
import type { LevelInfoTag } from '../../src/state/levelInfo'

// Level Info's Tags field: one comma-separated line, and what an Apply makes of it.

const old: readonly LevelInfoTag[] = [
    { title: 'Fan-made', icon: 'star' },
    { title: 'Expert' },
    { title: 'Fan-made', icon: 'heart' },
]

test('the line shows the titles joined with commas', () => {
    assert.equal(tagsText(old), 'Fan-made, Expert, Fan-made')
    assert.equal(tagsText([]), '')
})

test('a line left as shown keeps the tags as they were, icons and all', () => {
    assert.equal(parseTags(tagsText(old), old), old)
    // A comma inside a title is not split when the line is not edited.
    const comma: readonly LevelInfoTag[] = [{ title: 'Rock, Pop', icon: 'note' }]
    assert.equal(parseTags(tagsText(comma), comma), comma)
    assert.equal(parseTags('', []).length, 0)
})

test('an edited line splits on commas, trims and drops empty entries', () => {
    assert.deepEqual(parseTags('  A ,, B,  ,C  ', []), [
        { title: 'A' },
        { title: 'B' },
        { title: 'C' },
    ])
    assert.deepEqual(parseTags(' , ', old), [])
})

test('a title that survives an edit keeps its icon, each old tag used once', () => {
    // Removing the Expert tag keeps both Fan-made tags, in order, with their own icons.
    assert.deepEqual(parseTags('Fan-made, Fan-made', old), [old[0], old[2]])
    // A third Fan-made has no old tag left and is plain.
    assert.deepEqual(parseTags('Fan-made, Fan-made, Fan-made', old), [
        old[0],
        old[2],
        { title: 'Fan-made' },
    ])
    // Reordering keeps the icons with their titles.
    assert.deepEqual(parseTags('Expert, Fan-made', old), [old[1], old[0]])
    // A new title is plain.
    assert.deepEqual(parseTags('Expert, Hard', old), [old[1], { title: 'Hard' }])
})

test('an edit that splits a title with a comma makes two tags', () => {
    const comma: readonly LevelInfoTag[] = [{ title: 'Rock, Pop' }]
    assert.deepEqual(parseTags('Rock, Pop ', comma), [{ title: 'Rock' }, { title: 'Pop' }])
})
