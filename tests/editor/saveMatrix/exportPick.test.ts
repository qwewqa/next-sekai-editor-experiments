import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PATHS } from './matrix'
import { createWorld } from './world'

// Export's pick of another chain's file (spec B4-lite, AR-B13): a file filled after the pick is
// known to be filled before anything is taken from its owner, so its owner keeps its binding.

test('Export’s pick of another chain’s file that was filled meanwhile revokes nothing and writes nothing', async () => {
    const w = await createWorld({ own: 'bound', storage: 'lacks' })
    w.pick('other.nxsp')
    // Another tab, or a sync client, writes into the picked file after the pick.
    const filled = w.atPoint('picked', () =>
        w.mock.writeFile('other.nxsp', new Blob(['bytes another tab wrote'])),
    )
    await PATHS.find((path) => path.id === 'export')!.run(w)
    await filled
    const other = (await w.storedChains()).find((record) => record.chainId === 'chain-other')
    assert.ok(other?.file, 'the other chain keeps its binding')
    assert.deepEqual(
        w.dialogs.map((dialog) => dialog.kind),
        ['export.failed'],
    )
    assert.equal(await w.mock.files.get('other.nxsp')!.text(), 'bytes another tab wrote')
})
