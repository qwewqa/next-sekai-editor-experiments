import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSave } from '../../../src/local/save/execute'
import { Fixture, heldRows, saveOptions } from './fixture'

// A chain storage holds nothing of (storing paused or full since the session's start
// "Storage unavailable or paused"): the Save core's seam `unstored` plans the write from this
// tab's rows alone, so such a session can still be saved to a file.

test('a chain storage never held is written from its pending rows and record', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    await fixture.store.write(['chains'], (tx) => tx.delete('chains', fixture.chainId))
    const pending = fixture.pending(0)

    const { options } = saveOptions(fixture, { pending })
    const refused = await buildSave(fixture.store, fixture.chainId, { kind: 'copy' }, options)
    assert.deepEqual(refused, { refused: 'noChain' })

    const { options: rescue } = saveOptions(fixture, {
        pending,
        sessionId: fixture.session.id,
        unstored: { chainId: fixture.chainId, docId: fixture.docId, lineageId: 'lineage' },
    })
    const built = await buildSave(fixture.store, fixture.chainId, { kind: 'copy' }, rescue)
    assert.ok(!('refused' in built), JSON.stringify(built))
    const { history } = await heldRows(built.blob)
    assert.deepEqual(
        history.entries.map((entry) => entry.kind),
        ['init', 'edit', 'edit', 'save'],
    )
    assert.equal(built.identity.docId, fixture.docId)
    assert.equal(built.stepsLine, 'none')
})
