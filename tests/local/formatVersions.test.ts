import assert from 'node:assert/strict'
import test from 'node:test'
import { LEVEL_VERSION } from '../../src/levelData/levelVersion'
import { LATEST_REVISION } from '../../src/levelData/revision'
import { RECORDS_V, SESSION_V } from '../../src/local/records/version'

// The pinned constants (§1.6.11.8). Changing one means editing this test and the plan's
// table, and following Part 4, 4.9.4. Started in Step 3 with these; Step 6 completes it.

test('the format constants have their v0.6.0 values', () => {
    assert.equal(RECORDS_V, 1)
    assert.equal(SESSION_V, 1)
    assert.equal(LEVEL_VERSION, 1)
})

test('each RECORDS_V stands for the engine revision its writer used', () => {
    // v1 → revision 2. A new LATEST_REVISION raises RECORDS_V (§1.6.11.8).
    const revisionOf: Record<number, number> = { 1: 2 }
    assert.equal(revisionOf[RECORDS_V], LATEST_REVISION)
})
