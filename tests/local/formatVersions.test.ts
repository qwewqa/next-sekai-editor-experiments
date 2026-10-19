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
    NXSP_VERSION,
} from '../../src/local/nxsp/version'
import { RECORDS_V, SESSION_V } from '../../src/local/records/version'

// The pinned constants (§1.6.11.8). Changing one means editing this test and the plan's
// table, and following Part 4, 4.9.4. The archetype, field and choice-value pin is
// `tests/editor/levelDataReport.test.ts`'s, which ties the declared table to `LEVEL_VERSION`.

test('the format constants have their v0.6.0 values', () => {
    assert.equal(NXSP_FORMAT, 'nxsp')
    assert.equal(NXSP_VERSION, 1)
    assert.equal(NXSP_MINOR, 1)
    assert.equal(LEVEL_VERSION, 1)
    assert.equal(MANIFEST_VERSION, 2)
    assert.equal(RECORDS_V, 1)
    assert.equal(SESSION_V, 2)
    assert.equal(JOURNAL_VERSION, 2)
    assert.equal(DB_VERSION, 2)
    assert.equal(FORMAT_VERSION, 1)
    assert.equal(DUMP_VERSION, 1)
})

test('each RECORDS_V stands for the engine revision its writer used', () => {
    // v1 → revision 2. A new LATEST_REVISION raises RECORDS_V (§1.6.11.8).
    const revisionOf: Record<number, number> = { 1: 2 }
    assert.equal(revisionOf[RECORDS_V], LATEST_REVISION)
})

test('the minor table: manifest generation 2 requires minor 1', () => {
    // Each levelVersion, root v, manifest version, entry kind, ZIP entry and parts key, and the
    // merge revision, mapped to the minor that introduced it. A later version adds its rows here.
    assert.deepEqual(MINOR_TABLE, {
        levelVersion: { 1: 0 },
        rootV: { 1: 0 },
        manifestVersion: { 2: 1 },
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
