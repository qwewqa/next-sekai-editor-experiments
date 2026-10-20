import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { levelInfoInput } from '../../src/editor/headerLabelText'
import {
    captureOperationRecipe,
    describeOperation,
    operationDetails,
    type OperationTextContext,
} from '../../src/history/operationPresentation'
import {
    captureName,
    captureStep,
    createOperation,
    decodeOperation,
    operationCodecs,
    type NativeOperationInput,
} from '../../src/history/operations'
import { emptyLevelInfo, type LevelInfo, type MediaRef } from '../../src/state/levelInfo'

// `nse.levelInfo.set` (§1.4.12): one Apply of the Level Info dialog is one step, with a change per
// field that changed. No tool produces it yet; the receipt builder, the codec and the presentation
// are pinned now so that v0.6.0 renders it from the first file a later build writes.

const context = (locale = 'en'): OperationTextContext => ({
    locale,
    strings: JSON.parse(
        readFileSync(new URL(`../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8'),
    ),
    now: 1_700_000_000_000,
})
const en = context()
const ref = (hash: string, filename: string): MediaRef => ({
    hash: hash.repeat(32).slice(0, 32),
    filename,
    size: 1,
    type: 'image/png',
})
const info = (extra: Partial<LevelInfo> = {}): LevelInfo => ({ ...emptyLevelInfo, ...extra })

test('a changed field is one change each, in field order, with Initial Life among them', () => {
    const input = levelInfoInput(
        info({ title: 'Old', tags: [{ title: 'a' }], rating: 3 }),
        info({
            title: 'New',
            artists: 'Composer',
            description: 'Line',
            tags: [{ title: 'a' }, { title: 'b' }],
            cover: ref('c', 'cover.png'),
            preview: ref('d', 'preview.mp3'),
        }),
        { before: 1000, after: 900 },
    )
    assert.deepEqual(input, {
        id: 'nse.levelInfo.set',
        data: {
            changes: [
                { field: 'artists', before: captureName(''), after: captureName('Composer') },
                { field: 'cover', before: null, after: captureName('cover.png') },
                { field: 'description', before: captureName(''), after: captureName('Line') },
                { field: 'initialLife', before: 1000, after: 900 },
                { field: 'preview', before: null, after: captureName('preview.mp3') },
                { field: 'rating', before: 3, after: null },
                { field: 'tags', added: 1, removed: 0 },
                { field: 'title', before: captureName('Old'), after: captureName('New') },
            ],
        },
    })
    assert.equal(
        operationCodecs['nse.levelInfo.set'].is(input && 'data' in input && input.data),
        true,
    )
})

test('nothing changed is no step; Initial Life alone is nse.header.set', () => {
    assert.equal(levelInfoInput(info({ title: 'A' }), info({ title: 'A' })), undefined)
    assert.equal(levelInfoInput(info(), info(), { before: 1000, after: 1000 }), undefined)
    assert.deepEqual(levelInfoInput(info(), info(), { before: 1000, after: 900 }), {
        id: 'nse.header.set',
        data: { field: 'initialLife', before: 1000, after: 900 },
    })
    // With any other field it joins that step instead.
    const both = levelInfoInput(info(), info({ title: 'T' }), { before: 1000, after: 900 })
    assert.equal(both?.id, 'nse.levelInfo.set')
})

test('tags are compared by title as a multiset; icons are kept and not a change', () => {
    const tags = (...titles: string[]) => titles.map((title) => ({ title }))
    const change = (before: string[], after: string[]) => {
        const input = levelInfoInput(
            info({ tags: tags(...before) }),
            info({ tags: tags(...after) }),
        )
        return input?.id === 'nse.levelInfo.set' ? input.data.changes : undefined
    }
    assert.deepEqual(change(['a'], ['a', 'b', 'b']), [{ field: 'tags', added: 2, removed: 0 }])
    assert.deepEqual(change(['a', 'b'], ['a']), [{ field: 'tags', added: 0, removed: 1 }])
    assert.deepEqual(change(['a'], ['b']), [{ field: 'tags', added: 1, removed: 1 }])
    assert.deepEqual(change(['a', 'a'], ['a']), [{ field: 'tags', added: 0, removed: 1 }])
    assert.equal(change(['a', 'b'], ['b', 'a']), undefined)
    assert.equal(
        levelInfoInput(
            info({ tags: [{ title: 'a' }] }),
            info({ tags: [{ title: 'a', icon: 'star' }] }),
        ),
        undefined,
    )
})

test('a cover or preview is a change by its content, a rating by its value', () => {
    const only = (before: LevelInfo, after: LevelInfo) => {
        const input = levelInfoInput(before, after)
        return input?.id === 'nse.levelInfo.set' ? input.data.changes : undefined
    }
    // The same content under another name is no change; other content is one.
    assert.equal(
        only(info({ cover: ref('a', 'one.png') }), info({ cover: ref('a', 'two.png') })),
        undefined,
    )
    assert.deepEqual(
        only(info({ cover: ref('a', 'one.png') }), info({ cover: ref('b', 'two.png') })),
        [{ field: 'cover', before: captureName('one.png'), after: captureName('two.png') }],
    )
    assert.deepEqual(only(info({ preview: ref('a', 'p.mp3') }), info()), [
        { field: 'preview', before: captureName('p.mp3'), after: null },
    ])
    assert.deepEqual(only(info(), info({ rating: 0 })), [
        { field: 'rating', before: null, after: 0 },
    ])
    assert.equal(only(info({ rating: 2 }), info({ rating: 2 })), undefined)
    // A long text is captured cut, and still a change.
    const long = 'x'.repeat(300)
    const changes = only(info(), info({ description: long }))
    assert.equal(changes?.[0]?.field, 'description')
    assert.deepEqual(changes?.[0] && 'after' in changes[0] ? changes[0].after.truncated : 0, true)
})

const recipeOf = (input: NativeOperationInput, ctx = en) => {
    const operation = createOperation(input, {
        locale: ctx.locale,
        describe: (op) => describeOperation(op, ctx),
    })
    return captureOperationRecipe([{ description: captureStep({ kind: 'edit', operation }) }])
}

test('v0.6.0 renders it: the step reads Changed level info, and Details lists each field', () => {
    const input = levelInfoInput(
        info({ title: 'Old', tags: [{ title: 'a' }], rating: 3 }),
        info({
            title: 'New',
            artists: 'Composer',
            tags: [{ title: 'b' }],
            cover: ref('c', 'cover.png'),
        }),
        { before: 1000, after: 900 },
    )
    assert.ok(input)
    assert.equal(describeOperation(input, en), 'Changed level info')
    const details = operationDetails(recipeOf(input), en)
    assert.equal(details.description, 'Changed level info')
    assert.deepEqual(
        details.rows.map((row) => [row.kind, row.label]),
        [
            ['change', 'Artists'],
            ['change', 'Cover'],
            ['change', 'Initial Life'],
            ['change', 'Rating'],
            ['value', 'Tags: Added'],
            ['value', 'Tags: Removed'],
            ['change', 'Title'],
        ],
    )
    const rows = Object.fromEntries(details.rows.map((row) => [row.key, row]))
    assert.deepEqual(rows.artists, {
        kind: 'change',
        key: 'artists',
        label: 'Artists',
        before: { text: 'Not set', placeholder: true },
        after: { text: 'Composer' },
    })
    assert.deepEqual(rows.rating, {
        kind: 'change',
        key: 'rating',
        label: 'Rating',
        before: { text: '3' },
        after: { text: 'Not set', placeholder: true },
    })
    assert.deepEqual(rows.life, undefined)
    assert.deepEqual(rows.initialLife?.kind, 'change')
})

test('every locale renders the description and Details with no placeholder left', () => {
    const input = levelInfoInput(
        info({ title: 'Old' }),
        info({ title: 'New', rating: 5, tags: [{ title: 'a' }] }),
        { before: 1, after: 2 },
    )
    assert.ok(input)
    for (const locale of ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht']) {
        const ctx = context(locale)
        const text = describeOperation(input, ctx)
        assert.ok(text.length > 0 && !/\{\d+\}/.test(text), `${locale}: ${text}`)
        const details = operationDetails(recipeOf(input, ctx), ctx)
        assert.equal(details.description, text)
        assert.ok(details.rows.length >= 4)
        assert.ok(details.rows.every((row) => row.label.length > 0 && row.key.length > 0))
    }
})

test('stored data keeps its fallback: an older reader shows it, a changed shape reads unsupported', () => {
    const input = levelInfoInput(info({ title: 'a' }), info({ title: 'b' }))
    assert.ok(input)
    const operation = createOperation(input, {
        locale: 'en',
        describe: (op) => describeOperation(op, en),
    })
    const decoded = decodeOperation(operation)
    assert.equal(decoded.status, 'known')
    // The same id with a field this build does not know is unsupported, and keeps its fallback.
    const future = {
        ...JSON.parse(JSON.stringify(operation)),
        data: {
            changes: [
                { field: 'localizedTitle', before: captureName('a'), after: captureName('b') },
            ],
        },
    }
    const read = decodeOperation(future)
    assert.equal(read.status, 'unsupported')
    assert.equal(read.status === 'unsupported' && read.fallback?.text, 'Changed level info')
})
