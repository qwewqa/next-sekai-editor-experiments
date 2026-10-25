import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTags, tagsText } from '../../src/editor/levelInfo/tags'
import type { LevelInfoTag } from '../../src/state/levelInfo'

// Level Info's Tags field: one comma-separated line, and what an Apply makes of it.

const old: readonly LevelInfoTag[] = [
    { title: 'Fan-made' },
    { title: 'Expert' },
    { title: 'Fan-made' },
]

test('the line shows the titles joined with commas', () => {
    assert.equal(tagsText(old), 'Fan-made, Expert, Fan-made')
    assert.equal(tagsText([]), '')
})

test('a line left as shown keeps the tags as they were', () => {
    assert.equal(parseTags(tagsText(old), old), old)
    // A comma inside a title is not split when the line is not edited.
    const comma: readonly LevelInfoTag[] = [{ title: 'Rock, Pop' }]
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

test('an edited line gives one tag per typed title, in the typed order', () => {
    // Removing the Expert tag keeps both Fan-made tags.
    assert.deepEqual(parseTags('Fan-made, Fan-made', old), [
        { title: 'Fan-made' },
        { title: 'Fan-made' },
    ])
    assert.deepEqual(parseTags('Expert, Fan-made, Hard', old), [
        { title: 'Expert' },
        { title: 'Fan-made' },
        { title: 'Hard' },
    ])
})

test('an edit that splits a title with a comma makes two tags', () => {
    const comma: readonly LevelInfoTag[] = [{ title: 'Rock, Pop' }]
    assert.deepEqual(parseTags('Rock, Pop ', comma), [{ title: 'Rock' }, { title: 'Pop' }])
})
