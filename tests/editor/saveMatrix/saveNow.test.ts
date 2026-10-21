import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, settle } from './world'

// V-P5: a Save whose bound file's handle read fails is not a Save without a handle. Taken for
// "none stored", it downloaded the file and bound it as a download, which in real storage deletes
// the stored handle (`splitHandles`). The real `save()` runs here with the handle not held in this
// tab (as after a reload), and `readHandle` failing once.

const run = async (failures: number) => {
    // Bound to own.nxsp, the handle not held in memory, storage holds all the own file holds.
    const w = await createWorld({ own: 'bound', held: false, storage: 'holds' })
    w.behaviour.set('readHandle', (n) => (n <= failures ? 'throw' : undefined))
    const file = () => w.chains.get(w.session.chainId)?.file as { event?: string } | undefined
    const before = file()?.event
    await flow.save()
    await settle()
    return {
        w,
        before,
        after: file()?.event,
        downloads: w.mock.downloads.length,
        errors: w.dialogs.filter((dialog) => dialog.kind === 'error'),
    }
}

test('V-P5 (control): a Save with the handle read answering writes back in place', async () => {
    const r = await run(0)
    assert.equal(r.downloads, 0)
    assert.ok(r.w.writes.length > 0, 'written back')
    assert.deepEqual(r.errors, [])
})

test('V-P5: a Save whose handle read fails downloads nothing, rebinds nothing and says why', async () => {
    const r = await run(1)
    assert.equal(r.downloads, 0, 'the Save downloaded instead')
    assert.equal(r.w.writes.length, 0, 'nothing is written')
    assert.equal(r.after, r.before, 'the binding is as it was (not a download binding)')
    assert.ok(r.w.handleRows.has('chain-own:file'), 'the stored handle stays')
    assert.equal(r.errors.length, 1)
    assert.match(String(r.errors[0]?.args[0]), /^Not saved\. The editor could not access/)
})

test('V-P5: the next press reads again, and a handle read that answers writes back', async () => {
    const w = await createWorld({ own: 'bound', held: false, storage: 'holds' })
    w.behaviour.set('readHandle', (n) => (n === 1 ? 'throw' : undefined))
    await flow.save()
    await settle()
    assert.equal(w.mock.downloads.length, 0)
    await flow.save()
    await settle()
    assert.equal(w.mock.downloads.length, 0)
    assert.ok(w.writes.length > 0, 'the second press wrote the file back')
})

test('Open the Other Version: a handle read that fails says so, and is not the file being unreadable', async () => {
    const w = await createWorld({ own: 'bound', held: false, storage: 'holds' })
    w.behaviour.set('readHandle', () => 'throw')
    await flow.openOtherVersion()
    await settle()
    const errors = w.dialogs.filter((dialog) => dialog.kind === 'error')
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]?.args[0]), /^The editor could not access this browser’s storage/)
})

// Save to File… (spec D invariant 12): a session read that fails is a storage failure, not a
// session that is gone. It said "Use Export Level Data…" for both.

const saveToFileSays = async (readSession: () => Promise<unknown>) => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    const fake = w.worker.call
    w.worker.call = (method: string, arg?: unknown) =>
        method === 'readSession' ? (readSession() as Promise<never>) : fake(method, arg)
    await flow.saveToFile('session-other')
    await settle()
    const errors = w.dialogs.filter((dialog) => dialog.kind === 'error')
    assert.equal(errors.length, 1)
    return String(errors[0]?.args[0])
}

test('Save to File…: a session read that fails says the storage is not available, without the Save As… hint', async () => {
    const says = await saveToFileSays(() =>
        Promise.reject(new Error('The storage worker restarted')),
    )
    assert.match(says, /^The editor could not access this browser’s storage\. Try again\.$/)
})

test('Save to File…: a session that is gone keeps its own line (control)', async () => {
    const says = await saveToFileSays(() => Promise.resolve({ kind: 'missing' }))
    assert.doesNotMatch(says, /could not access this browser’s storage/)
})
