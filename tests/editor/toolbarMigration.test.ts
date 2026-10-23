import assert from 'node:assert/strict'
import test from 'node:test'
import { insertExportLevel } from '../../src/settings/toolbarExport'
import { insertMinimap } from '../../src/settings/toolbarMinimap'
import { insertPreviewAssets } from '../../src/settings/toolbarPreviewAssets'
import { insertSessionRestore } from '../../src/settings/toolbarSessionRestore'

const playback = [
    'offset',
    'bgm',
    'toggleSfxVolume',
    'toggleBgmVolume',
    'speedUp',
    'speedDown',
    'stop',
    'play',
]
const file = ['utilities', 'properties', 'reset', 'exportLevel', 'save', 'open']
const undo = ['paste', 'cut', 'copy', 'redo', 'undo']

const chain = (groups: unknown[][]) =>
    insertSessionRestore(insertPreviewAssets(insertExportLevel(groups)))

test('Save As and History join exactly matching default groups', () => {
    assert.deepEqual(insertSessionRestore([file, ['play'], undo]), [
        ['utilities', 'properties', 'reset', 'exportLevel', 'saveAs', 'save', 'open'],
        ['play'],
        ['paste', 'cut', 'copy', 'history', 'redo', 'undo'],
    ])
})

test('each command is added on its own: one matching group does not need the other', () => {
    assert.deepEqual(insertSessionRestore([file, ['undo']]), [
        ['utilities', 'properties', 'reset', 'exportLevel', 'saveAs', 'save', 'open'],
        ['undo'],
    ])
    assert.deepEqual(insertSessionRestore([['open'], undo]), [
        ['open'],
        ['paste', 'cut', 'copy', 'history', 'redo', 'undo'],
    ])
})

test('customised groups are left as they are', () => {
    for (const groups of [
        [
            ['reset', 'exportLevel', 'save', 'open'],
            ['paste', 'copy', 'redo', 'undo'],
        ],
        [
            [...file, 'play'],
            [...undo, 'cut'],
        ],
        [[...file].reverse(), [...undo].reverse()],
        [['save'], ['undo', 'redo']],
    ]) {
        assert.equal(insertSessionRestore(groups), groups)
    }
})

test('a toolbar that has the commands anywhere is left as it is', () => {
    const hasSaveAs = [file, ['saveAs'], undo.slice(1)]
    assert.equal(insertSessionRestore(hasSaveAs), hasSaveAs)
    // History elsewhere stops only History; Save As still joins its group.
    assert.deepEqual(insertSessionRestore([file, ['history'], undo]), [
        ['utilities', 'properties', 'reset', 'exportLevel', 'saveAs', 'save', 'open'],
        ['history'],
        undo,
    ])
})

test('the step is idempotent', () => {
    const once = insertSessionRestore([file, undo])
    assert.equal(insertSessionRestore(once), once)
})

test('the three steps in order take a v0.5.22 default to the new default', () => {
    assert.deepEqual(
        chain([['utilities', 'properties', 'reset', 'save', 'open'], playback, undo, ['select']]),
        [
            ['utilities', 'properties', 'reset', 'exportLevel', 'saveAs', 'save', 'open'],
            ['previewAssets', ...playback],
            ['paste', 'cut', 'copy', 'history', 'redo', 'undo'],
            ['select'],
        ],
    )
})

test('the three steps on a customised toolbar change only what each step promises', () => {
    // Export goes in front of Save wherever it is; the others need exact matches.
    assert.deepEqual(
        chain([
            ['undo', 'save'],
            ['play', 'stop'],
            ['copy', 'undo'],
        ]),
        [
            ['undo', 'exportLevel', 'save'],
            ['play', 'stop'],
            ['copy', 'undo'],
        ],
    )
    // A default File group that dropped Reset is not the old default, so it keeps its shape.
    assert.deepEqual(chain([['utilities', 'properties', 'save', 'open']]), [
        ['utilities', 'properties', 'exportLevel', 'save', 'open'],
    ])
})

const navigation = [
    'scrollLeft',
    'scrollRight',
    'jumpUp',
    'scrollPageUp',
    'scrollUp',
    'scrollDown',
    'scrollPageDown',
    'jumpDown',
]

test('Minimap goes first in the exact old navigation group, so Jump to Start stays its face', () => {
    assert.deepEqual(insertMinimap([['select'], navigation, ['play']]), [
        ['select'],
        ['minimap', ...navigation],
        ['play'],
    ])
})

test('a customised navigation group is left as it is', () => {
    for (const groups of [
        [navigation.slice(0, -1)],
        [[...navigation, 'zoomYIn']],
        [[...navigation].reverse()],
        [['jumpDown']],
    ]) {
        assert.equal(insertMinimap(groups), groups)
    }
})

test('a toolbar that has Minimap anywhere is left as it is', () => {
    const groups = [['minimap'], navigation]
    assert.equal(insertMinimap(groups), groups)
})

test('the Minimap step is idempotent', () => {
    const once = insertMinimap([navigation])
    assert.equal(insertMinimap(once), once)
})
