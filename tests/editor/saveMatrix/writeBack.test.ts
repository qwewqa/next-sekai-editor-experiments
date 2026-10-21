import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bytesOf, createWorld, flow, settle } from './world'

// A write-back whose record cannot be read (B0's WB-throw) used to end with nothing shown: the check
// threw out of the Save. It says the storage is not available, and writes nothing. The changed-on-
// disk check (R10) still stands on the next press: a file another chain wrote while storage failed
// meets the conflict dialog, and is never written over.

const ANOTHER = 'bytes another chain wrote to the file'

test('a write-back whose record cannot be read says so; the next press meets the conflict dialog for a file another chain wrote', async () => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    w.mock.writeFile('own.nxsp', new Blob([ANOTHER]))
    w.behaviour.set('readChainRecord', (n) => (n === 1 ? 'throw' : undefined))

    await flow.save()
    await settle()
    const shown = w.dialogs.filter((dialog) => dialog.kind === 'error')
    assert.equal(shown.length, 1)
    assert.match(String(shown[0]?.args[0]), /^Not saved\. The editor could not access/)
    assert.equal(w.writes.length, 0, 'nothing is written')
    assert.equal(w.errors.length, 0, 'the Save does not end in a throw')

    await flow.save()
    await settle()
    assert.ok(
        w.dialogs.some((dialog) => dialog.kind === 'conflict'),
        'the file now meets the conflict dialog',
    )
    assert.equal(w.writes.length, 0, 'it is never written over')
    assert.equal(new TextDecoder().decode(await bytesOf(w.mock.files.get('own.nxsp'))), ANOTHER)
})
