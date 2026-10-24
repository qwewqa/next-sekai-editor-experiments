import assert from 'node:assert/strict'
import test from 'node:test'
import { asFile, Fixture, heldRows, save } from './fixture'

// A fork whose parent chain was deleted: its stored sessions are
// all that is left, and Save writes them whole. The file says nothing of what was deleted, and a
// file saved earlier from the chain says its steps were not kept (the known loss).

const forkOfDeleted = async (earlierFile: boolean) => {
    const fixture = await Fixture.create(90)
    await fixture.storeMedia()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    if (earlierFile) await save(fixture, { kind: 'copy' })
    await fixture.start()
    await fixture.edit(2)
    await fixture.flush()
    await fixture.deleteSession(0)
    return { fixture }
}

test('Save of a fork whose parent chain was deleted writes what is stored, without a line', async () => {
    const { fixture } = await forkOfDeleted(false)
    const { built, file } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(!('refused' in built) && file)
    assert.equal(built.stepsLine, 'none')
    // The fork's own two rows, then the write's `save` row: no row of the deleted parent.
    const held = await heldRows(asFile(built.blob))
    assert.deepEqual(
        held.history.entries.map((entry) => entry.kind),
        ['continue', 'edit', 'save'],
    )
})

test('Save of a fork whose parent chain was deleted, over a file saved before, says steps were not kept', async () => {
    const { fixture } = await forkOfDeleted(true)
    const { built } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(!('refused' in built))
    assert.equal(built.stepsLine, 'notKept')
})
