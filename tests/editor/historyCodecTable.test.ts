import assert from 'node:assert/strict'
import test from 'node:test'
import {
    captureName,
    decodeOperation,
    nativeKinds,
    operationCodecs,
    type OperationId,
} from '../../src/history/operations'

// A table of valid and invalid data for every operation id. A producer's data must pass its codec
// or `createOperation` throws before `pushState`, so the rules are written down here once: counts
// are positive, optional maps are never empty, and the refinements agree with the counts.

const name = (text: string) => captureName(text)
const group = { kind: 'group', id: 1, name: name('Lead') } as const
const stage = { kind: 'stage', id: 1, name: name('Main') } as const
const groupFolder = { kind: 'groupFolder', id: 3, name: name('Folder') } as const
const uniform = (value: unknown) => ({ mode: 'uniform', value })
const varying = { mode: 'varying' }
const change = (field: string, before: unknown, after: unknown) => ({
    field,
    before: uniform(before),
    after: uniform(after),
})

type Row = {
    valid: readonly (readonly [string, unknown])[]
    invalid: readonly (readonly [string, unknown])[]
}

const table: Record<OperationId, Row> = {
    'nse.note.add': {
        valid: [
            ['one', { created: 1 }],
            ['zero', { created: 0 }],
        ],
        invalid: [
            ['negative', { created: -1 }],
            ['old field', { targets: 1 }],
            ['extra', { created: 1, x: 1 }],
        ],
    },
    'nse.note.generate': {
        valid: [['many', { created: 12 }]],
        invalid: [['fraction', { created: 1.5 }]],
    },
    'nse.object.add': {
        valid: [
            ['bpm', { subject: 'bpm', created: 2 }],
            ['event', { subject: 'cameraEvent', created: 1 }],
        ],
        invalid: [
            ['notes use note.add', { subject: 'note', created: 1 }],
            ['objects', { subject: 'objects', created: 1 }],
            ['displaced is gone', { subject: 'bpm', created: 1, displaced: { bpm: 1 } }],
        ],
    },
    'nse.object.edit': {
        valid: [
            ['one note', { subject: 'note', changed: { note: 1 } }],
            ['nothing changed', { subject: 'bpm', changed: {} }],
            ['mixed', { subject: 'objects', changed: { note: 2, bpm: 1 } }],
            [
                'collateral',
                {
                    subject: 'bpm',
                    changed: { bpm: 1 },
                    displaced: { bpm: 1 },
                    retainedInitialBpm: true,
                },
            ],
            [
                'objects with the initial BPM',
                { subject: 'objects', changed: { note: 1, bpm: 1 }, retainedInitialBpm: true },
            ],
        ],
        invalid: [
            ['targets is gone', { subject: 'note', targets: 1 }],
            ['zero count', { subject: 'note', changed: { note: 0 } }],
            ['negative count', { subject: 'note', changed: { note: -1 } }],
            ['unknown kind', { subject: 'note', changed: { slide: 1 } }],
            ['subject disagrees with the counts', { subject: 'note', changed: { bpm: 1 } }],
            ['mixed counts need objects', { subject: 'note', changed: { note: 1, bpm: 1 } }],
            ['objects for one kind', { subject: 'objects', changed: { note: 1 } }],
            ['empty displaced', { subject: 'note', changed: { note: 1 }, displaced: {} }],
            ['zero displaced', { subject: 'note', changed: { note: 1 }, displaced: { bpm: 0 } }],
            [
                'retained without a BPM',
                { subject: 'note', changed: { note: 1 }, retainedInitialBpm: true },
            ],
            ['retained false', { subject: 'bpm', changed: { bpm: 1 }, retainedInitialBpm: false }],
            [
                'unsafe total',
                { subject: 'objects', changed: { note: Number.MAX_SAFE_INTEGER, bpm: 1 } },
            ],
        ],
    },
    'nse.object.move': {
        valid: [
            ['one', { subject: 'timeScale', changed: { timeScale: 2 } }],
            [
                'displaced',
                { subject: 'objects', changed: { note: 1, bpm: 1 }, displaced: { bpm: 1 } },
            ],
            ['a resized note', { subject: 'note', changed: { note: 2 }, resized: true }],
            [
                'a resized camera event',
                { subject: 'cameraEvent', changed: { cameraEvent: 1 }, resized: true },
            ],
            [
                'a resized stage mask event',
                { subject: 'stageMaskEvent', changed: { stageMaskEvent: 1 }, resized: true },
            ],
        ],
        invalid: [
            ['empty displaced', { subject: 'timeScale', changed: { timeScale: 1 }, displaced: {} }],
            ['resized false', { subject: 'note', changed: { note: 1 }, resized: false }],
            ['resized BPM', { subject: 'bpm', changed: { bpm: 1 }, resized: true }],
            [
                'resized stage pivot event',
                { subject: 'stagePivotEvent', changed: { stagePivotEvent: 1 }, resized: true },
            ],
            [
                'resized mixed objects',
                { subject: 'objects', changed: { note: 1, bpm: 1 }, resized: true },
            ],
            [
                'resized with displaced',
                { subject: 'note', changed: { note: 1 }, displaced: { note: 1 }, resized: true },
            ],
        ],
    },
    'nse.object.replace': {
        valid: [
            ['bpm', { subject: 'bpm', changed: { bpm: 1 }, displaced: { bpm: 1 } }],
            [
                'time scale',
                { subject: 'timeScale', changed: { timeScale: 1 }, displaced: { timeScale: 2 } },
            ],
            [
                'with the initial BPM',
                {
                    subject: 'bpm',
                    changed: { bpm: 1 },
                    displaced: { bpm: 1 },
                    retainedInitialBpm: true,
                },
            ],
        ],
        invalid: [
            ['displaced is required', { subject: 'bpm', changed: { bpm: 1 } }],
            ['empty displaced', { subject: 'bpm', changed: { bpm: 1 }, displaced: {} }],
            [
                'displaced of another kind',
                { subject: 'bpm', changed: { bpm: 1 }, displaced: { timeScale: 1 } },
            ],
            [
                'changed of another kind',
                { subject: 'bpm', changed: { timeScale: 1 }, displaced: { bpm: 1 } },
            ],
            [
                'a note cannot be replaced',
                { subject: 'note', changed: { note: 1 }, displaced: { note: 1 } },
            ],
            [
                'the initial BPM needs a BPM',
                {
                    subject: 'timeScale',
                    changed: { timeScale: 1 },
                    displaced: { timeScale: 1 },
                    retainedInitialBpm: true,
                },
            ],
        ],
    },
    'nse.note.elevation': {
        valid: [['two', { targets: 2 }]],
        invalid: [['changed', { changed: { note: 1 } }]],
    },
    'nse.object.paste': {
        valid: [
            [
                'placed',
                {
                    placed: { note: 2, timeScale: 1 },
                    variant: 'composed',
                    flipped: false,
                    at: 'position',
                },
            ],
            [
                'replaced',
                {
                    placed: { bpm: 1 },
                    displaced: { bpm: 1 },
                    variant: 'basic',
                    flipped: true,
                    at: 'pointer',
                },
            ],
        ],
        invalid: [
            ['nothing placed', { placed: {}, variant: 'basic', flipped: false, at: 'pointer' }],
            [
                'empty displaced',
                {
                    placed: { note: 1 },
                    displaced: {},
                    variant: 'basic',
                    flipped: false,
                    at: 'pointer',
                },
            ],
            [
                'zero placed',
                { placed: { note: 0 }, variant: 'basic', flipped: false, at: 'pointer' },
            ],
            [
                'unknown variant',
                { placed: { note: 1 }, variant: 'other', flipped: false, at: 'pointer' },
            ],
        ],
    },
    'nse.object.brush': {
        valid: [
            [
                'uniform',
                {
                    subject: 'note',
                    changed: { note: 3 },
                    assignments: [change('isCritical', false, true)],
                },
            ],
            [
                'varying both sides',
                {
                    subject: 'note',
                    changed: { note: 3 },
                    assignments: [{ field: 'left', before: varying, after: varying }],
                },
            ],
            [
                'mixed kinds',
                {
                    subject: 'objects',
                    changed: { note: 1, timeScale: 1 },
                    assignments: [{ field: 'beat', before: varying, after: varying }],
                },
            ],
        ],
        invalid: [
            [
                'displaced without a Beat assignment',
                {
                    subject: 'objects',
                    changed: { note: 1, bpm: 1 },
                    assignments: [change('isCritical', false, true), change('bpm', 120, 150)],
                    displaced: { bpm: 1 },
                },
            ],
            [
                'a retained initial BPM without a Beat assignment',
                {
                    subject: 'bpm',
                    changed: { bpm: 1 },
                    assignments: [change('bpm', 120, 150)],
                    retainedInitialBpm: true,
                },
            ],
            [
                'value is renamed after',
                {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [{ field: 'left', value: uniform(1) }],
                },
            ],
            [
                'before is required',
                {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [{ field: 'left', after: uniform(1) }],
                },
            ],
            ['changed is required', { subject: 'note', assignments: [change('left', 1, 2)] }],
            [
                'subjects is gone',
                {
                    subject: 'objects',
                    subjects: ['note', 'timeScale'],
                    changed: { note: 1, timeScale: 1 },
                    assignments: [{ field: 'beat', before: varying, after: varying }],
                },
            ],
            [
                'empty changed',
                { subject: 'note', changed: {}, assignments: [change('left', 1, 2)] },
            ],
            [
                'a field that applies to no changed kind',
                {
                    subject: 'bpm',
                    changed: { bpm: 1 },
                    assignments: [change('flickDirection', 'none', 'up')],
                },
            ],
            [
                'a kind with no field',
                {
                    subject: 'objects',
                    changed: { note: 1, bpm: 1 },
                    assignments: [change('left', 1, 2)],
                },
            ],
            [
                'a value of the wrong type',
                {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [change('isCritical', false, 1)],
                },
            ],
            [
                'subject disagrees with the counts',
                { subject: 'bpm', changed: { note: 1 }, assignments: [change('left', 1, 2)] },
            ],
            [
                'empty displaced',
                {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [change('left', 1, 2)],
                    displaced: {},
                },
            ],
        ],
    },
    'nse.object.delete': {
        valid: [
            ['notes', { removed: { note: 3 } }],
            ['nothing removed', { removed: {} }],
        ],
        invalid: [
            ['zero', { removed: { note: 0 } }],
            ['unsafe total', { removed: { note: Number.MAX_SAFE_INTEGER, bpm: 1 } }],
        ],
    },
    'nse.object.cut': {
        valid: [['bpm', { removed: { bpm: 1 } }]],
        invalid: [['unknown kind', { removed: { connector: 1 } }]],
    },
    'nse.object.flip': {
        valid: [
            ['horizontal', { axis: 'horizontal', subject: 'note', changed: { note: 2 } }],
            [
                'vertical with collateral',
                {
                    axis: 'vertical',
                    subject: 'objects',
                    changed: { note: 1, bpm: 1 },
                    displaced: { bpm: 2 },
                    retainedInitialBpm: true,
                },
            ],
        ],
        invalid: [
            ['targets is gone', { axis: 'horizontal', subject: 'note', targets: 2 }],
            [
                'a horizontal flip displaces nothing',
                { axis: 'horizontal', subject: 'bpm', changed: { bpm: 1 }, displaced: { bpm: 1 } },
            ],
            [
                'a horizontal flip keeps no BPM',
                {
                    axis: 'horizontal',
                    subject: 'bpm',
                    changed: { bpm: 1 },
                    retainedInitialBpm: true,
                },
            ],
            [
                'empty displaced',
                { axis: 'vertical', subject: 'note', changed: { note: 1 }, displaced: {} },
            ],
            [
                'subject disagrees with the counts',
                { axis: 'vertical', subject: 'bpm', changed: { note: 1 } },
            ],
        ],
    },
    'nse.object.scale': {
        valid: [
            [
                'beats',
                {
                    axis: 'beats',
                    subject: 'timeScale',
                    changed: { timeScale: 2 },
                    transform: { mode: 'composed' },
                    displaced: { timeScale: 1 },
                },
            ],
            [
                'width',
                {
                    axis: 'width',
                    subject: 'note',
                    changed: { note: 2 },
                    transform: { mode: 'uniform', factor: 2, pivot: -1 },
                },
            ],
        ],
        invalid: [
            [
                'targets is gone',
                { axis: 'width', subject: 'note', targets: 2, transform: { mode: 'composed' } },
            ],
            [
                'only beats displace',
                {
                    axis: 'width',
                    subject: 'bpm',
                    changed: { bpm: 1 },
                    transform: { mode: 'composed' },
                    displaced: { bpm: 1 },
                },
            ],
            [
                'only beats keep the BPM',
                {
                    axis: 'elevation',
                    subject: 'bpm',
                    changed: { bpm: 1 },
                    transform: { mode: 'composed' },
                    retainedInitialBpm: true,
                },
            ],
            [
                'a non-finite factor',
                {
                    axis: 'width',
                    subject: 'note',
                    changed: { note: 1 },
                    transform: { mode: 'uniform', factor: Infinity, pivot: 0 },
                },
            ],
        ],
    },
    'nse.note.combine': {
        valid: [['three', { targets: 3 }]],
        invalid: [['notes is renamed', { notes: 3 }]],
    },
    'nse.note.split': {
        valid: [['two', { targets: 2 }]],
        invalid: [['points is renamed', { points: 2 }]],
    },
    'nse.note.vertical': { valid: [['two', { targets: 2 }]], invalid: [['none', {}]] },
    'nse.property.set': {
        valid: [
            [
                'one field',
                { subject: 'bpm', changed: { bpm: 1 }, assignments: [change('bpm', 120, 150)] },
            ],
            [
                'collateral',
                {
                    subject: 'objects',
                    changed: { note: 1, bpm: 1 },
                    assignments: [{ field: 'beat', before: varying, after: varying }],
                    displaced: { bpm: 1 },
                    retainedInitialBpm: true,
                },
            ],
            [
                'a group by name',
                {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [
                        change('groupId', group, { ...group, id: 2, name: name('Other') }),
                    ],
                },
            ],
        ],
        invalid: [
            [
                'displaced without a Beat assignment',
                {
                    subject: 'objects',
                    changed: { note: 1, bpm: 1 },
                    assignments: [change('isCritical', false, true), change('bpm', 120, 150)],
                    displaced: { bpm: 1 },
                },
            ],
            [
                'a retained initial BPM without a Beat assignment',
                {
                    subject: 'bpm',
                    changed: { bpm: 1 },
                    assignments: [change('bpm', 120, 150)],
                    retainedInitialBpm: true,
                },
            ],
            [
                'old shape',
                {
                    subject: 'note',
                    targets: 1,
                    assignments: [{ field: 'left', value: uniform(1) }],
                },
            ],
            [
                'retained without a BPM',
                {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [change('left', 1, 2)],
                    retainedInitialBpm: true,
                },
            ],
            [
                'duplicate fields',
                {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [change('left', 1, 2), change('left', 1, 2)],
                },
            ],
            [
                'fields out of order',
                {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [change('size', 1, 2), change('left', 1, 2)],
                },
            ],
        ],
    },
    'nse.header.set': {
        valid: [
            ['life', { field: 'initialLife', before: 1000, after: 900 }],
            ['offset', { field: 'bgmOffset', before: 0, after: 0.25 }],
        ],
        invalid: [
            ['unknown field', { field: 'title', before: 1, after: 2 }],
            ['not finite', { field: 'bgmOffset', before: 0, after: Infinity }],
        ],
    },
    'nse.bgm.change': {
        valid: [
            ['file', { file: { before: name('a.mp3'), after: name('b.mp3') } }],
            [
                'none to file with offset',
                { file: { before: null, after: name('b.mp3') }, offset: { before: 0, after: 1 } },
            ],
        ],
        invalid: [['no file', { offset: { before: 0, after: 1 } }]],
    },
    // One Level Info Apply: its changes in field order, each field once; Initial Life never alone.
    'nse.levelInfo.set': {
        valid: [
            [
                'a title',
                { changes: [{ field: 'title', before: name(''), after: name('Coconut') }] },
            ],
            [
                'every field, in field order',
                {
                    changes: [
                        { field: 'title', before: name('t'), after: name('u') },
                        { field: 'artists', before: name('A'), after: name('B') },
                        { field: 'author', before: name(''), after: name('C') },
                        { field: 'rating', before: null, after: 12 },
                        { field: 'tags', added: 2, removed: 1, changed: 1, reordered: true },
                        { field: 'description', before: name('x'), after: name('y') },
                        { field: 'cover', before: null, after: name('cover.png') },
                        { field: 'preview', before: name('a.mp3'), after: null },
                        { field: 'initialLife', before: 1000, after: 900 },
                    ],
                },
            ],
            [
                'a rating removed, a cut name',
                {
                    changes: [
                        { field: 'title', before: name('a'.repeat(300)), after: name('b') },
                        { field: 'rating', before: 3.5, after: null },
                    ],
                },
            ],
            [
                'Initial Life with another field',
                {
                    changes: [
                        { field: 'rating', before: null, after: 1 },
                        { field: 'initialLife', before: 1, after: 2 },
                    ],
                },
            ],
            [
                'tags moved only',
                { changes: [{ field: 'tags', added: 0, removed: 0, reordered: true }] },
            ],
            [
                'tags given another icon',
                { changes: [{ field: 'tags', added: 0, removed: 0, changed: 2 }] },
            ],
            [
                'the same cover under another name',
                { changes: [{ field: 'cover', before: name('a.png'), after: name('b.png') }] },
            ],
            [
                'a cut name that may hide a difference',
                {
                    changes: [
                        {
                            field: 'title',
                            before: name('a'.repeat(300)),
                            after: name('a'.repeat(300)),
                        },
                    ],
                },
            ],
        ],
        invalid: [
            ['no changes', { changes: [] }],
            ['no list', {}],
            [
                'Initial Life alone is nse.header.set',
                { changes: [{ field: 'initialLife', before: 1, after: 2 }] },
            ],
            [
                'fields out of order',
                {
                    changes: [
                        { field: 'artists', before: name('a'), after: name('b') },
                        { field: 'title', before: name('a'), after: name('b') },
                    ],
                },
            ],
            [
                'alphabetical, which is not the dialog’s order',
                {
                    changes: [
                        { field: 'artists', before: name('a'), after: name('b') },
                        { field: 'author', before: name('a'), after: name('b') },
                        { field: 'rating', before: null, after: 1 },
                        { field: 'title', before: name('a'), after: name('b') },
                    ],
                },
            ],
            [
                'a title that did not change',
                { changes: [{ field: 'title', before: name('a'), after: name('a') }] },
            ],
            [
                'a rating that did not change',
                {
                    changes: [
                        { field: 'rating', before: 2, after: 2 },
                        { field: 'tags', added: 1, removed: 0 },
                    ],
                },
            ],
            [
                'a cover that did not change',
                { changes: [{ field: 'cover', before: null, after: null }] },
            ],
            [
                'tags with a zero change count',
                { changes: [{ field: 'tags', added: 0, removed: 0, changed: 0 }] },
            ],
            [
                'tags reordered: false',
                { changes: [{ field: 'tags', added: 0, removed: 0, reordered: false }] },
            ],
            [
                'a field twice',
                {
                    changes: [
                        { field: 'title', before: name('a'), after: name('b') },
                        { field: 'title', before: name('b'), after: name('c') },
                    ],
                },
            ],
            [
                'an unknown field',
                { changes: [{ field: 'name', before: name('a'), after: name('b') }] },
            ],
            [
                'the BGM has its own operation',
                { changes: [{ field: 'bgm', before: null, after: name('a') }] },
            ],
            ['tags that changed nothing', { changes: [{ field: 'tags', added: 0, removed: 0 }] }],
            ['tags by the list', { changes: [{ field: 'tags', before: [], after: [name('a')] }] }],
            [
                'a rating that is not finite',
                { changes: [{ field: 'rating', before: null, after: Infinity }] },
            ],
            [
                'text that is not a name',
                { changes: [{ field: 'title', before: 'a', after: name('b') }] },
            ],
            [
                'a cover that is a bare string',
                { changes: [{ field: 'cover', before: null, after: 'a.png' }] },
            ],
            [
                'extra keys',
                { changes: [{ field: 'title', before: name('a'), after: name('b') }], x: 1 },
            ],
            [
                'extra change keys',
                { changes: [{ field: 'title', before: name('a'), after: name('b'), note: 1 }] },
            ],
        ],
    },
    'nse.dynamicStages.enable': {
        valid: [
            [
                'the default events',
                { created: { stageMaskEvent: 1, stagePivotEvent: 1, stageStyleEvent: 1 } },
            ],
            ['none created', { created: {} }],
        ],
        invalid: [
            ['old empty data', {}],
            ['zero', { created: { stageMaskEvent: 0 } }],
        ],
    },
    'nse.owner.create': {
        valid: [
            ['group', { target: group, destination: null, gathered: 0 }],
            ['folder with members', { target: groupFolder, destination: null, gathered: 3 }],
            ['group in a folder', { target: group, destination: groupFolder, gathered: 0 }],
        ],
        invalid: [['a group gathers nothing', { target: group, destination: null, gathered: 1 }]],
    },
    'nse.owner.rename': {
        valid: [['group', { target: group, before: name('A'), after: name('B') }]],
        invalid: [['missing after', { target: group, before: name('A') }]],
    },
    'nse.owner.set': {
        valid: [
            [
                'speed',
                { target: group, changes: [{ field: 'forceNoteSpeed', before: null, after: 1.5 }] },
            ],
        ],
        invalid: [
            [
                'a stage field on a group',
                { target: group, changes: [{ field: 'isFromStart', before: true, after: false }] },
            ],
        ],
    },
    'nse.owner.move': {
        valid: [
            [
                'reorder',
                { target: group, destination: null, category: 'reorder', fromIndex: 2, toIndex: 0 },
            ],
            ['into a folder', { target: group, destination: groupFolder, category: 'intoFolder' }],
        ],
        invalid: [
            ['into with no folder', { target: group, destination: null, category: 'intoFolder' }],
            [
                'a stage folder for a group',
                {
                    target: group,
                    destination: { kind: 'stageFolder', id: 1, name: name('S') },
                    category: 'intoFolder',
                },
            ],
        ],
    },
    'nse.owner.moveMany': {
        valid: [['groups', { domain: 'group', targets: 2, destination: groupFolder }]],
        invalid: [
            ['wrong folder domain', { domain: 'stage', targets: 2, destination: groupFolder }],
        ],
    },
    'nse.owner.duplicate': {
        valid: [
            ['one group', { domain: 'group', created: { group: 1 } }],
            [
                'with its objects',
                {
                    domain: 'group',
                    created: { group: 2, groupFolder: 1 },
                    source: groupFolder,
                    objects: { note: 12, timeScale: 2 },
                },
            ],
            [
                'a stage with its notes and stage events',
                {
                    domain: 'stage',
                    created: { stage: 1 },
                    objects: {
                        note: 4,
                        stageMaskEvent: 1,
                        stagePivotEvent: 1,
                        stageStyleEvent: 1,
                        stageTransformEvent: 1,
                    },
                },
            ],
        ],
        invalid: [
            ['nothing created', { domain: 'group', created: {} }],
            ['zero created', { domain: 'group', created: { group: 0 } }],
            ['empty objects', { domain: 'group', created: { group: 1 }, objects: {} }],
            ['a stage count in a group duplicate', { domain: 'group', created: { stage: 1 } }],
            [
                'a camera event among a group’s objects',
                { domain: 'group', created: { group: 1 }, objects: { note: 1, cameraEvent: 1 } },
            ],
            [
                'a BPM among a group’s objects',
                { domain: 'group', created: { group: 1 }, objects: { bpm: 1 } },
            ],
            [
                'a time scale among a stage’s objects',
                { domain: 'stage', created: { stage: 1 }, objects: { timeScale: 1 } },
            ],
            [
                'a camera event among a stage’s objects',
                { domain: 'stage', created: { stage: 1 }, objects: { cameraEvent: 1 } },
            ],
        ],
    },
    'nse.owner.delete': {
        valid: [
            ['one stage', { domain: 'stage', removed: { stage: 1 }, target: stage }],
            [
                'with objects and the default entry',
                {
                    domain: 'group',
                    removed: { group: 1 },
                    target: group,
                    objects: { note: 800 },
                    replacement: { kind: 'group', id: 2, name: name('Default') },
                },
            ],
            [
                'a stage with its notes and stage events',
                {
                    domain: 'stage',
                    removed: { stage: 1 },
                    target: stage,
                    objects: { note: 4, stageMaskEvent: 2 },
                },
            ],
            [
                'a group with its notes and time scales',
                {
                    domain: 'group',
                    removed: { group: 1, groupFolder: 1 },
                    objects: { note: 4, timeScale: 2 },
                },
            ],
        ],
        invalid: [
            ['nothing removed', { domain: 'group', removed: {} }],
            ['empty objects', { domain: 'group', removed: { group: 1 }, objects: {} }],
            [
                'a replacement of the other domain',
                { domain: 'group', removed: { group: 1 }, replacement: stage },
            ],
            [
                'a replacement that is a folder',
                { domain: 'group', removed: { group: 1 }, replacement: groupFolder },
            ],
            [
                'a camera event among a group’s objects',
                { domain: 'group', removed: { group: 1 }, objects: { cameraEvent: 1 } },
            ],
            [
                'a BPM among a group’s objects',
                { domain: 'group', removed: { group: 1 }, objects: { note: 1, bpm: 1 } },
            ],
            [
                'a time scale among a stage’s objects',
                { domain: 'stage', removed: { stage: 1 }, objects: { timeScale: 1 } },
            ],
            [
                'a camera event among a stage’s objects',
                { domain: 'stage', removed: { stage: 1 }, objects: { cameraEvent: 1 } },
            ],
        ],
    },
    'nse.owner.ungroup': {
        valid: [['three', { target: groupFolder, released: 3 }]],
        invalid: [['a group is not a folder', { target: group, released: 3 }]],
    },
    'nse.origin': {
        valid: [
            ['new', { origin: 'new' }],
            ['import with its file', { origin: 'import', source: name('song.sus') }],
            ['recovery', { origin: 'recovery' }],
        ],
        invalid: [
            ['unknown origin', { origin: 'other' }],
            ['a source on a new chart', { origin: 'new', source: name('song.sus') }],
            ['a source on an auto save', { origin: 'autoSave', source: name('song.sus') }],
            ['a source on a recovery', { origin: 'recovery', source: name('song.sus') }],
        ],
    },
    'nse.continue': {
        valid: [
            ['a time', { fromTime: 1_600_000_000_000 }],
            ['the largest date', { fromTime: 8.64e15 }],
        ],
        invalid: [
            ['source is gone', { fromTime: 1_600_000_000_000, source: name('a') }],
            ['beyond a date', { fromTime: 8.64e15 + 1 }],
            ['not an integer', { fromTime: 1.5 }],
        ],
    },
    'nse.file.save': {
        valid: [['file', { file: name('level.nse'), delivery: 'file' }]],
        invalid: [['unknown delivery', { file: name('level.nse'), delivery: 'cloud' }]],
    },
    'nse.file.export': {
        valid: [['download', { file: name('level.scp'), delivery: 'download' }]],
        invalid: [['no file', { delivery: 'download' }]],
    },
    'nse.restore': {
        valid: [['a time', { targetTime: 1_600_000_000_000 }]],
        invalid: [
            ['source is gone', { targetTime: 1, source: name('a') }],
            ['beyond a date', { targetTime: 8.64e15 + 1 }],
        ],
    },
    'nse.recovery': {
        valid: [
            ['none dropped', { droppedSteps: 0 }],
            ['three', { droppedSteps: 3 }],
        ],
        invalid: [
            ['source is gone', { source: 'journal', droppedSteps: 3 }],
            ['negative', { droppedSteps: -1 }],
        ],
    },
    'nse.externalChange': { valid: [['nothing', {}]], invalid: [['data', { x: 1 }]] },
}

test('the table covers every operation id', () => {
    assert.deepEqual(Object.keys(table).sort(), Object.keys(operationCodecs).sort())
    assert.equal(Object.keys(operationCodecs).length, 36)
    for (const [id, row] of Object.entries(table)) {
        assert(row.valid.length > 0, `${id} has a valid sample`)
        assert(row.invalid.length > 0, `${id} has an invalid sample`)
    }
})

for (const [id, row] of Object.entries(table) as [OperationId, Row][]) {
    test(`${id} accepts its valid data and rejects its invalid data`, () => {
        for (const [label, data] of row.valid)
            assert.equal(operationCodecs[id].is(data), true, `valid: ${label}`)
        for (const [label, data] of row.invalid)
            assert.equal(operationCodecs[id].is(data), false, `invalid: ${label}`)
    })
}

test('stored data that fails its codec decodes as unsupported, keeping its fallback', () => {
    const wire = (data: unknown) => ({
        id: 'nse.object.edit',
        version: 1,
        data,
        fallback: { text: 'Edited notes', locale: 'en' },
    })
    assert.equal(
        decodeOperation(wire({ subject: 'note', changed: { note: 1 } }) as never).status,
        'known',
    )
    for (const data of [
        { subject: 'note', targets: 1 },
        { subject: 'note', changed: { note: 0 } },
    ])
        assert.equal(decodeOperation(wire(data) as never).status, 'unsupported')
})

test('the removed fields are rejected at every id that carried them', () => {
    const removed: [OperationId, unknown][] = [
        ['nse.object.add', { subject: 'bpm', created: 1, displaced: { bpm: 1 } }],
        ['nse.continue', { fromTime: 1, source: name('x') }],
        ['nse.restore', { targetTime: 1, source: name('x') }],
        ['nse.recovery', { droppedSteps: 1, source: 'journal' }],
        ['nse.note.combine', { notes: 1 }],
        ['nse.note.split', { points: 1 }],
    ]
    for (const [id, data] of removed) assert.equal(operationCodecs[id].is(data), false, id)
    assert(nativeKinds.includes('note'))
})
