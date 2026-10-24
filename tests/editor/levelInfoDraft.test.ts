import assert from 'node:assert/strict'
import test from 'node:test'
import { changedFields, draftOf, draftOver } from '../../src/editor/levelInfo/draft'
import type { State } from '../../src/state'
import { emptyLevelInfo, type LevelInfo, type MediaRef } from '../../src/state/levelInfo'

// What a Level Info Apply writes: the fields the user changed, laid over the live
// state, so a change made meanwhile (the dialog's own BGM steps, a rating set elsewhere) stays.

const file = (hash: string, filename = 'cover.png'): MediaRef => ({
    hash,
    filename,
    size: 3,
    type: 'image/png',
})

const live = (info: Partial<LevelInfo>, initialLife = 1000) =>
    ({ levelInfo: { ...emptyLevelInfo, ...info }, initialLife }) as State

test('an unchanged draft changes no field', () => {
    const opening = draftOf({ ...emptyLevelInfo, title: 'Coconut', cover: file('a') }, 1000)
    assert.deepEqual(changedFields(opening, { ...opening }), [])
})

test('a cover of the same content under another name is a change', () => {
    const opening = draftOf({ ...emptyLevelInfo, cover: file('a', 'one.png') }, 1000)
    assert.deepEqual(changedFields(opening, { ...opening, cover: file('a', 'two.png') }), ['cover'])
})

test('only the changed fields are laid over the live state', () => {
    const opening = draftOf({ ...emptyLevelInfo, title: 'Coconut', artists: 'A' }, 1000)
    const draft = { ...opening, title: 'Coconut (Master)' }
    // The live state moved on while the dialog was open: another artist, a rating, a cover.
    const now = live({ title: 'Coconut', artists: 'B', rating: 29, cover: file('a') }, 800)
    const { levelInfo, life } = draftOver(opening, draft, now)
    assert.equal(levelInfo.title, 'Coconut (Master)')
    assert.equal(levelInfo.artists, 'B')
    assert.equal(levelInfo.rating, 29)
    assert.deepEqual(levelInfo.cover, file('a'))
    assert.equal(life, 800)
})

test('a changed Initial Life, rating and removed cover are written; an emptied text is unset', () => {
    const opening = draftOf(
        { ...emptyLevelInfo, title: 'Coconut', rating: 12, cover: file('a') },
        1000,
    )
    const draft = { ...opening, title: '', rating: undefined, cover: undefined, life: 500 }
    const { levelInfo, life } = draftOver(
        opening,
        draft,
        live({ title: 'Coconut', rating: 12, cover: file('a') }),
    )
    assert.equal(levelInfo.title, '')
    assert.equal('rating' in levelInfo, false)
    assert.equal('cover' in levelInfo, false)
    assert.equal(life, 500)
})

test('tags are parsed only when the line was edited, against the live tags', () => {
    const tags = [{ title: 'Fan-made', icon: 'star' }, { title: 'Expert' }]
    const opening = draftOf({ ...emptyLevelInfo, tags }, 1000)
    const kept = draftOver(opening, { ...opening }, live({ tags }))
    assert.equal(kept.levelInfo.tags, tags)
    const edited = draftOver(opening, { ...opening, tags: 'Expert, Hard' }, live({ tags }))
    assert.deepEqual(edited.levelInfo.tags, [{ title: 'Expert' }, { title: 'Hard' }])
})
