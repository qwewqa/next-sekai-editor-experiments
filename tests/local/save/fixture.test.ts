import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSave } from '../../../src/local/save/execute'
import { checkStored } from '../../../src/local/testing/invariants'
import { rows } from '../flush/harness'
import { Fixture, saveOptions } from './fixture'

// The Fixture writes a session's rows itself, so its rows have to be the ones the product
// leaves (spec E, E-7): `lastSeq` and `updatedAt` from the greatest `seq` and time, whatever
// order the rows were added in.

test('a Save reserved before an edit leaves lastSeq at the edit and the rows in seq order (E-F4)', async () => {
    const fixture = await Fixture.create(81)
    await fixture.storeMedia()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    // The Save reserves seq 3, an edit takes seq 4 while the file is built, and the Save's row
    // is recorded after it.
    const { options, reserved } = saveOptions(fixture)
    assert.equal(reserved.seq, 3)
    await fixture.edit(2)
    const built = await buildSave(fixture.store, fixture.chainId, { kind: 'copy' }, options, [])
    assert.ok(!('refused' in built))
    fixture.recordSave(built, reserved)
    await fixture.flush()
    const stored = (await fixture.entries()).filter((row) => row.sessionId === reserved.sessionId)
    assert.deepEqual(
        stored.map((row) => [row.seq, row.kind]),
        [
            [1, 'init'],
            [2, 'edit'],
            [3, 'save'],
            [4, 'edit'],
        ],
    )
    const session = rows(fixture.world, 'sessions').get(reserved.sessionId)
    assert.equal(session?.lastSeq, 4)
    assert.equal(session?.updatedAt, Math.max(...stored.map((row) => row.time)))
    assert.deepEqual(checkStored(fixture.world.memory, fixture.world.sessionOptions), [])
})
