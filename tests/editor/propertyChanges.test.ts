import assert from 'node:assert/strict'
import test from 'node:test'
import {
    comparePropertyChanges,
    formatPropertyNumber,
    propertyItems,
    propertyPage,
    propertyRowKey,
    propertySectionKey,
    propertyTagIcon,
    type PropertyChanges,
    type PropertyField,
    type PropertySectionKind,
} from '../../src/editor/history/propertyChanges'
import { stateFromRecords, toRecords } from '../../src/local/records/records'
import type { State } from '../../src/state'
import { folder, goldenChart, group, mediaHash, stage, stateOf } from '../local/records/charts'

const state = () => stateOf(goldenChart())
const section = (changes: PropertyChanges, kind: PropertySectionKind, id?: number) => {
    const value = changes.sections.find((value) => value.kind === kind && value.id === id)
    assert.ok(value, `${kind}:${id}`)
    return value
}
const row = (
    changes: PropertyChanges,
    kind: PropertySectionKind,
    field: PropertyField,
    id?: number,
) => {
    const value = section(changes, kind, id).rows.find((value) => value.field === field)
    assert.ok(value, `${kind}:${field}`)
    return value
}

const cases: [string, (value: State) => void, PropertySectionKind, PropertyField, number?][] = [
    [
        'initial life zero',
        (s) => {
            s.initialLife = 0
        },
        'level',
        'initialLife',
    ],
    [
        'dynamic stages false',
        (s) => {
            s.isDynamicStages = false
        },
        'level',
        'dynamicStages',
    ],
    [
        'offset zero',
        (s) => {
            s.bgm = { ...s.bgm, offset: 0 }
        },
        'bgm',
        'offset',
    ],
    ...(['title', 'artists', 'author', 'description'] as const).map(
        (field): (typeof cases)[number] => [
            field,
            (s) => {
                s.levelInfo = { ...s.levelInfo, [field]: ' ' }
            },
            'levelInfo',
            field,
        ],
    ),
    [
        'tag title',
        (s) => {
            s.levelInfo = { ...s.levelInfo, tags: [{ title: 'changed' }] }
        },
        'levelInfo',
        'tags',
    ],
    [
        'tag order',
        (s) => {
            s.levelInfo = { ...s.levelInfo, tags: [...s.levelInfo.tags].reverse() }
        },
        'levelInfo',
        'tags',
    ],
    [
        'tag icon',
        (s) => {
            s.levelInfo = {
                ...s.levelInfo,
                tags: s.levelInfo.tags.map((tag) => ({ ...tag, icon: '' })),
            }
        },
        'levelInfo',
        'tags',
    ],
    [
        'rating zero',
        (s) => {
            s.levelInfo = { ...s.levelInfo, rating: 0 }
        },
        'levelInfo',
        'rating',
    ],
    [
        'group name',
        (s) => {
            s.groups.set(group(1), { ...s.groups.get(group(1))!, name: 'renamed' })
        },
        'groups',
        'name',
        1,
    ],
    [
        'group speed',
        (s) => {
            s.groups.set(group(1), { ...s.groups.get(group(1))!, forceNoteSpeed: 0.00000001 })
        },
        'groups',
        'forceNoteSpeed',
        1,
    ],
    [
        'group membership',
        (s) => {
            s.groups.set(group(1), { name: 'Default' })
        },
        'groups',
        'folder',
        1,
    ],
    [
        'stage name',
        (s) => {
            s.stages.set(stage(1), { ...s.stages.get(stage(1))!, name: 'renamed' })
        },
        'stages',
        'name',
        1,
    ],
    [
        'stage starts',
        (s) => {
            s.stages.set(stage(1), { ...s.stages.get(stage(1))!, isFromStart: false })
        },
        'stages',
        'fromStart',
        1,
    ],
    [
        'stage ends',
        (s) => {
            s.stages.set(stage(1), { ...s.stages.get(stage(1))!, isUntilEnd: false })
        },
        'stages',
        'untilEnd',
        1,
    ],
    [
        'stage lines',
        (s) => {
            s.stages.set(stage(1), { ...s.stages.get(stage(1))!, generateSimLines: 'isolated' })
        },
        'stages',
        'simLines',
        1,
    ],
    [
        'stage membership',
        (s) => {
            s.stages.set(stage(1), { ...s.stages.get(stage(1))!, folderId: folder(2) })
        },
        'stages',
        'folder',
        1,
    ],
]

for (const kind of ['bgm', 'cover', 'preview'] as const) {
    for (const [key, value, field] of [
        ['hash', mediaHash('changed'), 'contents'],
        ['filename', '', 'filename'],
        ['size', 0, 'size'],
        ['type', '', 'type'],
        ...(kind === 'bgm' ? [['durationMs', 0, 'duration']] : []),
    ] as const)
        cases.push([
            `${kind} ${key}`,
            (s) => {
                if (kind === 'bgm') s.bgm = { ...s.bgm, meta: { ...s.bgm.meta!, [key]: value } }
                else
                    s.levelInfo = {
                        ...s.levelInfo,
                        [kind]: { ...s.levelInfo[kind]!, [key]: value },
                    }
            },
            kind,
            field as PropertyField,
        ])
}
for (const kind of ['groupFolders', 'stageFolders'] as const) {
    const id = kind === 'groupFolders' ? 1 : 2
    for (const [key, value, field] of [
        ['name', 'new name', 'name'],
        ['index', 7, 'order'],
        ['folderId', folder(99), 'folder'],
    ] as const)
        cases.push([
            `${kind} ${key}`,
            (s) => {
                s[kind].set(folder(id), { ...s[kind].get(folder(id))!, [key]: value })
            },
            kind,
            field,
            id,
        ])
}
for (const kind of ['groups', 'stages', 'groupFolders', 'stageFolders'] as const)
    cases.push([
        `${kind} map order`,
        (s) => {
            if (s[kind].size === 1) s[kind].set(99 as never, { name: 'Second', index: 0 } as never)
            s[kind] = new Map<number, { name: string }>([...s[kind]].reverse()) as never
        },
        kind,
        'order',
    ])

for (const [name, mutate, kind, field, id] of cases)
    test(`canonical property: ${name}`, () => {
        const before = state(),
            after = state()
        if (name.endsWith('map order') && before[kind as 'groupFolders'].size === 1) {
            before[kind as 'groupFolders'].set(folder(99), { name: 'Second', index: 0 })
            after[kind as 'groupFolders'].set(folder(99), { name: 'Second', index: 0 })
        }
        mutate(after)
        const changes = comparePropertyChanges(before, after, { expectedDifference: true })
        assert.equal(changes.rowCount, 1)
        assert.equal(row(changes, kind, field, id).field, field)
    })

test('normalization, required empty strings, whitespace, false and zero remain distinct', () => {
    const before = state(),
        after = state()
    after.groups.set(group(1), { ...after.groups.get(group(1))!, forceNoteSpeed: -0 })
    assert.deepEqual(comparePropertyChanges(before, after), { sections: [], rowCount: 0 })
    before.levelInfo = { ...before.levelInfo, title: '', rating: undefined }
    after.levelInfo = { ...after.levelInfo, title: ' ', rating: 0 }
    before.bgm = { offset: 0 }
    after.bgm = { offset: -0 }
    const changes = comparePropertyChanges(before, after)
    assert.deepEqual(row(changes, 'levelInfo', 'title'), {
        field: 'title',
        before: { kind: 'notSet' },
        after: { kind: 'text', value: ' ' },
    })
    assert.deepEqual(row(changes, 'levelInfo', 'rating'), {
        field: 'rating',
        before: { kind: 'notSet' },
        after: { kind: 'number', value: 0 },
    })
    assert.equal(changes.rowCount, 2)
    assert.deepEqual(propertyTagIcon({ kind: 'tag', title: '' }), { kind: 'notSet' })
    assert.deepEqual(propertyTagIcon({ kind: 'tag', title: '', icon: '' }), { kind: 'empty' })
    assert.deepEqual(propertyTagIcon({ kind: 'tag', title: '', icon: ' ' }), {
        kind: 'text',
        value: ' ',
    })
})

test('optional tag icon presence and tag order survive the unformatted projection', () => {
    const before = state(),
        after = state()
    before.levelInfo = { ...before.levelInfo, tags: [{ title: ' A ' }, { title: 'B', icon: '' }] }
    after.levelInfo = {
        ...after.levelInfo,
        tags: [
            { title: 'B', icon: '' },
            { title: ' A ', icon: '' },
        ],
    }
    const change = row(comparePropertyChanges(before, after), 'levelInfo', 'tags')
    assert.deepEqual(change.before, {
        kind: 'list',
        items: [
            { kind: 'tag', title: ' A ' },
            { kind: 'tag', title: 'B', icon: '' },
        ],
    })
    assert.deepEqual(change.after, {
        kind: 'list',
        items: [
            { kind: 'tag', title: 'B', icon: '' },
            { kind: 'tag', title: ' A ', icon: '' },
        ],
    })
})

test('recorded contents can change with the same filename and no cached media bytes', () => {
    const before = state(),
        after = state()
    before.bgm = {
        ...before.bgm,
        buffer: { duration: 8 } as AudioBuffer,
        source: new ArrayBuffer(1),
        filename: 'live-cache.mp3',
    }
    after.bgm = { ...after.bgm, meta: { ...after.bgm.meta!, hash: mediaHash('new') } }
    const changes = comparePropertyChanges(before, after)
    assert.deepEqual(row(changes, 'bgm', 'contents'), {
        field: 'contents',
        before: { kind: 'text', value: 'song.mp3' },
        after: { kind: 'text', value: 'song.mp3' },
    })
    assert.equal(changes.rowCount, 1)
    after.bgm = { ...after.bgm, meta: before.bgm.meta }
    assert.equal(comparePropertyChanges(before, after).rowCount, 0)
})

test('media removal and added groups expose complete fields with an absent side', () => {
    const before = state(),
        after = state()
    after.levelInfo = { ...after.levelInfo, cover: undefined }
    after.groups.set(group(8), { name: '', forceNoteSpeed: 0 })
    const changes = comparePropertyChanges(before, after)
    const cover = section(changes, 'cover')
    assert.equal(cover.status, 'removed')
    assert.deepEqual(
        cover.rows.map(({ field }) => field),
        ['filename', 'size', 'type'],
    )
    assert.ok(cover.rows.every(({ after }) => after.kind === 'notPresent'))
    const added = section(changes, 'groups', 8)
    assert.equal(added.status, 'added')
    assert.deepEqual(
        added.rows.map(({ field }) => field),
        ['name', 'folder', 'forceNoteSpeed'],
    )
    assert.ok(added.rows.every(({ before }) => before.kind === 'notPresent'))
    assert.deepEqual(row(changes, 'groups', 'folder', 8).after, { kind: 'noFolder' })
    assert.equal(
        changes.sections.some((s) => s.kind === 'groups' && s.id === undefined),
        false,
    )
})

test('removed stages and added folders expose zero, false, empty names and parent membership', () => {
    const before = state(),
        after = state()
    after.stages.delete(stage(1))
    after.stageFolders.set(folder(9), { name: '', index: 0 })
    const changes = comparePropertyChanges(before, after)
    const removed = section(changes, 'stages', 1)
    assert.equal(removed.status, 'removed')
    assert.equal(removed.rows.length, 5)
    assert.ok(removed.rows.every(({ after }) => after.kind === 'notPresent'))
    const added = section(changes, 'stageFolders', 9)
    assert.equal(added.status, 'added')
    assert.equal(added.rows.length, 3)
    assert.deepEqual(row(changes, 'stageFolders', 'order', 9).after, { kind: 'number', value: 0 })
})

test('order uses shared stable IDs without insertion ripple and disambiguates duplicate names', () => {
    const before = state(),
        after = state()
    before.groups = new Map([
        [group(1), { name: 'Same', folderId: folder(1) }],
        [group(2), { name: 'Same' }],
    ])
    after.groups = new Map([[group(3), { name: 'New' }], ...before.groups])
    assert.equal(comparePropertyChanges(before, after).rowCount, 3)
    after.groups = new Map([
        [group(3), { name: 'New' }],
        [group(2), before.groups.get(group(2))!],
        [group(1), before.groups.get(group(1))!],
    ])
    const order = row(comparePropertyChanges(before, after), 'groups', 'order')
    assert.equal(order.before.kind, 'list')
    assert.equal(order.after.kind, 'list')
    if (order.before.kind !== 'list' || order.after.kind !== 'list') return
    assert.deepEqual(
        order.before.items.map((item) => item.kind === 'reference' && [item.id, item.disambiguate]),
        [
            [1, true],
            [2, true],
        ],
    )
    assert.deepEqual(
        order.after.items.map((item) => item.kind === 'reference' && item.id),
        [3, 2, 1],
    )
    assert.ok(order.before.items[0]?.kind === 'reference' && order.before.items[0].folder?.name)
})

test('renaming a folder does not pretend its unchanged members moved', () => {
    const before = state(),
        after = state()
    after.groupFolders.set(folder(1), { ...after.groupFolders.get(folder(1))!, name: 'Renamed' })
    assert.equal(comparePropertyChanges(before, after).rowCount, 1)
})

test('stored reconstruction and raw memory state produce the same property projection', () => {
    const before = state(),
        after = state()
    after.levelInfo = { ...after.levelInfo, tags: [{ title: '', icon: '' }], rating: 0 }
    after.bgm = { ...after.bgm, offset: 1e-12, meta: { ...after.bgm.meta!, durationMs: 0 } }
    assert.deepEqual(
        comparePropertyChanges(
            stateFromRecords(toRecords(before)),
            stateFromRecords(toRecords(after)),
        ),
        comparePropertyChanges(before, after),
    )
    assert.throws(
        () => comparePropertyChanges(before, before, { expectedDifference: true }),
        /do not differ/,
    )
})

test('number formatting retains unequal small, large, byte and duration values in every locale', () => {
    for (const locale of ['en', 'fr', 'ja', 'ko', 'tr', 'zh-CN', 'zh-TW']) {
        for (const [a, b] of [
            [0, Number.MIN_VALUE],
            [1e-9, 2e-9],
            [1024, 1025],
            [123456, 123457],
            [1, 1.0000000000000002],
            [Number.MAX_VALUE, Number.MAX_VALUE / 2],
        ]) {
            assert.notEqual(formatPropertyNumber(a!, locale), formatPropertyNumber(b!, locale))
            assert.notEqual(
                formatPropertyNumber(a!, locale, 3),
                formatPropertyNumber(b!, locale, 3),
            )
        }
        assert.equal(formatPropertyNumber(-0, locale), formatPropertyNumber(0, locale))
        assert.notEqual(
            formatPropertyNumber(-0.0000001, locale, 3),
            formatPropertyNumber(0.0000001, locale, 3),
        )
    }
    assert.equal(formatPropertyNumber(-0.0000001, 'en', 3), '-0.0001')
    assert.equal(formatPropertyNumber(1.0000000000000002, 'en', 3), '1,000.0000000000002')
    assert.equal(formatPropertyNumber(1234.0001, 'fr'), '1\u202f234,0001')
    assert.throws(() => formatPropertyNumber(Infinity, 'en'), /finite/)
})

test('progressive row and list disclosure uses stable identities without formatting hidden values', () => {
    const before = state(),
        after = state()
    for (let id = 100; id < 180; id++) after.groups.set(group(id), { name: `Group ${id}` })
    after.levelInfo = {
        ...after.levelInfo,
        tags: Array.from({ length: 201 }, (_, id) => ({ title: `Tag ${id}` })),
    }
    const changes = comparePropertyChanges(before, after)
    const first = propertyPage(changes),
        second = propertyPage(changes, 200)
    assert.equal(first.shown, 100)
    assert.equal(second.shown, 200)
    assert.equal(first.total, 241)
    const keys = (page: typeof first) =>
        page.sections.flatMap((s) => s.rows.map((r) => propertyRowKey(s, r)))
    assert.deepEqual(keys(first), keys(second).slice(0, 100))
    assert.equal(new Set(keys(second)).size, 200)
    assert.equal(new Set(changes.sections.map(propertySectionKey)).size, changes.sections.length)
    const tags = row(changes, 'levelInfo', 'tags').after
    assert.equal(tags.kind, 'list')
    if (tags.kind !== 'list') return
    assert.equal(propertyItems(tags).items.length, 100)
    assert.equal(propertyItems(tags, 200).items.length, 200)
    assert.equal(propertyItems(tags, 300).items.length, 201)
    assert.equal(propertyItems(tags).total, 201)
    assert.deepEqual(propertyPage(changes, 0), { sections: [], shown: 0, total: 241 })
})
