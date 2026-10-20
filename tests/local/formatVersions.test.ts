import assert from 'node:assert/strict'
import test from 'node:test'
import { LEVEL_VERSION } from '../../src/levelData/levelVersion'
import { LATEST_REVISION } from '../../src/levelData/revision'
import { DB_VERSION, FORMAT_VERSION } from '../../src/local/db'
import { DUMP_VERSION } from '../../src/local/dump'
import { JOURNAL_VERSION } from '../../src/local/journal/format'
import {
    MANIFEST_VERSION,
    MINOR_TABLE,
    NXSP_FORMAT,
    NXSP_MINOR,
    NXSP_PATCH,
    NXSP_VERSION,
    PATCH_TABLE,
    minorOf,
    patchOf,
} from '../../src/local/nxsp/version'
import { RECORDS_V, SESSION_V } from '../../src/local/records/version'

// The pinned constants (§1.6.11.8). Changing one means editing this test and the plan's
// table, and following Part 4, 4.9.4. The archetype, field and choice-value pin is
// `tests/editor/levelDataReport.test.ts`'s, which ties the declared table to `LEVEL_VERSION`.

test('the format constants have their v0.6.0 values', () => {
    assert.equal(NXSP_FORMAT, 'nxsp')
    assert.equal(NXSP_VERSION, 1)
    assert.equal(NXSP_MINOR, 0)
    assert.equal(NXSP_PATCH, 0)
    assert.equal(LEVEL_VERSION, 1)
    assert.equal(MANIFEST_VERSION, 1)
    assert.equal(RECORDS_V, 1)
    assert.equal(SESSION_V, 1)
    assert.equal(JOURNAL_VERSION, 1)
    assert.equal(DB_VERSION, 1)
    assert.equal(FORMAT_VERSION, 1)
    assert.equal(DUMP_VERSION, 1)
})

test('each RECORDS_V stands for the engine revision its writer used', () => {
    // v1 → revision 2. A new LATEST_REVISION raises RECORDS_V (§1.6.11.8).
    const revisionOf: Record<number, number> = { 1: 2 }
    assert.equal(revisionOf[RECORDS_V], LATEST_REVISION)
})

test('the minor table: every v1 thing maps to minor 0', () => {
    // Each levelVersion, root v, manifest version, entry kind, ZIP entry and parts key, and the
    // merge revision, mapped to the minor that introduced it. A later version adds its rows here.
    assert.deepEqual(MINOR_TABLE, {
        levelVersion: { 1: 0 },
        rootV: { 1: 0 },
        manifestVersion: { 1: 0 },
        entryKind: {
            init: 0,
            continue: 0,
            edit: 0,
            undo: 0,
            redo: 0,
            restore: 0,
            save: 0,
            export: 0,
            recovered: 0,
        },
        zipEntry: {
            'project.json': 0,
            'level.json': 0,
            'history/segments/': 0,
            'history/manifest.json': 0,
            'history/chunks.bin': 0,
            'assets/cover.': 0,
            'assets/preview.': 0,
            'bgm/': 0,
        },
        partsKey: {},
        merge: undefined,
    })
    // The reader generation is the highest minor any table row names.
    const { levelVersion, rootV, manifestVersion, entryKind, zipEntry, partsKey } = MINOR_TABLE
    const rows = [levelVersion, rootV, manifestVersion, entryKind, zipEntry, partsKey].flatMap(
        (table) => Object.values(table as Record<string, number>),
    )
    assert.equal(Math.max(...rows), NXSP_MINOR)
    assert.deepEqual(Object.keys(MINOR_TABLE.levelVersion).map(Number), [LEVEL_VERSION])
    assert.deepEqual(Object.keys(MINOR_TABLE.rootV).map(Number), [RECORDS_V])
    assert.deepEqual(Object.keys(MINOR_TABLE.manifestVersion).map(Number), [MANIFEST_VERSION])
})

test('the patch table: every additive thing a file can hold, and the patch that introduced it', () => {
    // A new ZIP entry kind or `parts` key goes in both tables: the `minor` row is 0 (an older
    // reader leaves it out, it does not misread what remains) and the `patch` row names the
    // `patch` it ships in (docs/format-versioning.md).
    assert.deepEqual(Object.keys(PATCH_TABLE.zipEntry), Object.keys(MINOR_TABLE.zipEntry))
    assert.deepEqual(Object.keys(PATCH_TABLE.partsKey), Object.keys(MINOR_TABLE.partsKey))
    assert.ok(Object.values(MINOR_TABLE.zipEntry).every((minor) => minor === 0))
    assert.ok(Object.values(MINOR_TABLE.partsKey).every((minor) => minor === 0))
    // The generation is the highest patch any row names.
    const rows = [...Object.values(PATCH_TABLE.zipEntry), ...Object.values(PATCH_TABLE.partsKey)]
    assert.equal(Math.max(0, ...rows), NXSP_PATCH)
    // The writer writes the maximum over what it writes, and refuses what the table lacks.
    assert.equal(
        patchOf({ zipEntries: ['project.json', 'bgm/a.mp3', 'history/segments/3.json'] }),
        0,
    )
    assert.throws(() => patchOf({ zipEntries: ['video/a.mp4'] }), /No patch for video\/a\.mp4/)
    assert.throws(() => patchOf({ zipEntries: [], partsKeys: ['video'] }), /No patch for parts/)
    assert.throws(
        () =>
            minorOf({
                levelVersion: 1,
                rootVs: [],
                entryKinds: [],
                zipEntries: ['video/a.mp4'],
            }),
        /No minor for video\/a\.mp4/,
    )
})

test('the patch table names every x carrier, and a carrier row raises the written patch', () => {
    assert.deepEqual(Object.keys(PATCH_TABLE.carrier).sort(), [
        'context.x',
        'entry.x',
        'item.x',
        'part.x',
        'slot.x',
        'stack.x',
        'step.x',
        'undoStack.x',
    ])
    assert.ok(Object.values(PATCH_TABLE.carrier).every((patch) => patch === 0))
    assert.equal(patchOf({ zipEntries: ['project.json'], carriers: ['step.x', 'entry.x'] }), 0)
    assert.throws(() => patchOf({ zipEntries: [], carriers: ['file.x'] }), /No patch for file\.x/)
    // The first build to write a step `x` raises that row; the writer's patch follows from it.
    const raised = { ...PATCH_TABLE, carrier: { ...PATCH_TABLE.carrier, 'step.x': 2 } }
    assert.equal(patchOf({ zipEntries: ['project.json'], carriers: ['step.x'] }, raised), 2)
    assert.equal(patchOf({ zipEntries: ['project.json'], carriers: ['entry.x'] }, raised), 0)
    assert.equal(patchOf({ zipEntries: ['project.json'] }, raised), 0)
})
