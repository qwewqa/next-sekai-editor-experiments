import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, exportPick, flow, settle, type World } from './world'

// A pending list that cannot be read counts as pending (spec D invariant 11): `waitForChainImports`
// reads it again within the bound it uses for a real pending import, for every caller. At the
// bound the Save family's build refuses with `importing` and Export goes on to its picker. Treated
// as "no import pending", a failed read let a Save build over a chain whose file rows were still
// being copied in.

const { waitForChainImports } = await import('../../../src/editor/save/imports')
const { exportByPicker } = await import('../../../src/editor/commands/exportLevel/flow')

const slot = () => ({ name: 'coconut.nxsp', cancel: new AbortController() })
const environment = (w: World) => ({
    worker: w.worker as never,
    session: w.session,
    chainId: w.session.chainId,
})

/** Counts the reads of the list; it fails for the first `failures`, or always. */
const failList = (w: World, failures = Infinity) => {
    let reads = 0
    w.behaviour.set('openPendingImports', (n) => {
        reads = n
        return n <= failures ? 'throw' : undefined
    })
    return () => reads
}

test('the wait reads a failed pending list again, and goes on once it answers', async () => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    const reads = failList(w, 2)
    const started = Date.now()
    const outcome = await waitForChainImports(environment(w), slot())
    assert.equal(outcome, 'done')
    assert.equal(reads(), 3, 'read until it answered')
    assert.ok(Date.now() - started < 2500, 'not held to the bound')
})

test('the wait reads a pending list that keeps failing for the bound, then goes on', async () => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    const reads = failList(w)
    const started = Date.now()
    const outcome = await waitForChainImports(environment(w), slot())
    const waited = Date.now() - started
    assert.equal(outcome, 'done')
    assert.ok(waited >= 3500 && waited < 8000, `waited ${waited} ms`)
    assert.ok(reads() > 8, `read ${reads()} times`)
})

test('a Save whose pending list cannot be read is refused at the bound, writing nothing', async () => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    // The build refuses what the world marks as an import that never ended.
    w.pendingImports.add(w.session.id)
    failList(w)
    await flow.save()
    await settle()
    assert.equal(w.writes.length, 0)
    assert.equal(w.mock.downloads.length, 0)
    assert.equal(w.builtLog.length, 0, 'nothing was built')
    assert.equal(w.dialogs.filter((dialog) => dialog.kind === 'error').length, 1)
})

test('Export whose pending list cannot be read goes on to its picker at the bound', async () => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'lacks' })
    failList(w)
    w.pick('own.nxsp')
    exportPick.exportDialogOpened()
    exportPick.exportFlowRunning(true)
    const controller = new AbortController()
    try {
        await exportByPicker({
            ui: w.exportUi,
            build: () => w.exportBuild(),
            suggestedName: 'LevelData.nsld',
            types: [],
            leave: () => undefined,
            ready: () => w.exportReady(),
            signal: controller.signal,
            committed: () => undefined,
        } as never)
    } finally {
        exportPick.exportDialogClosed()
        exportPick.exportFlowRunning(false)
    }
    assert.equal(w.openings.length, 1, 'the picker opened')
})
