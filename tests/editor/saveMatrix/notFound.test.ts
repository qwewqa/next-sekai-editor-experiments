import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, settle, type World } from './world'

const { FileError } = await import('../../../src/platform')
const { diskFinding, setDiskFinding } = await import('../../../src/editor/file/state')

// A not-found marks the bound file missing only when it is about that file, and names the file
// that was not found. A Save As whose picked file was not found used to mark the file the session
// is still bound to, and a picked file gone before it was inspected was named as typed.

const world = async (own: 'bound' | 'missing') => {
    const w = await createWorld({ own, storage: 'holds' })
    setDiskFinding(undefined)
    return w
}

const notFound = (w: World) =>
    w.dialogs.filter((dialog) => dialog.kind === 'notFound').map((dialog) => dialog.args)

/** Save As to fresh.nxsp, whose write reports it not found. */
const saveAsNotFound = async (w: World) => {
    let fired = false
    w.mock.fault = (point, name) => {
        if (point !== 'checked' || name !== 'fresh.nxsp' || fired) return
        fired = true
        throw new FileError('not-found', 'Not found')
    }
    w.pick('fresh.nxsp')
    w.answers.saveDialog.push({ action: 'save', fileName: 'fresh.nxsp', history: true, bgm: true })
    await flow.saveAs()
    await settle()
    assert.deepEqual(notFound(w), [['fresh.nxsp']])
}

test('a Save whose bound file is gone marks it missing (control)', async () => {
    const w = await world('missing')
    await flow.save()
    await settle()
    assert.deepEqual(notFound(w), [['own.nxsp']])
    assert.equal(diskFinding.value, 'missing')
})

test('a Save As bound to the picked file, then not found at the write, marks it missing (control)', async () => {
    const w = await world('bound')
    await saveAsNotFound(w)
    assert.equal(w.boundName(), 'fresh.nxsp')
    assert.equal(diskFinding.value, 'missing')
})

test('a Save As whose binding was not recorded, then not found at the write, leaves the bound file unmarked', async () => {
    const w = await world('bound')
    w.behaviour.set('takeOver', () => 'throw')
    await saveAsNotFound(w)
    assert.equal(w.boundName(), 'own.nxsp')
    assert.equal(diskFinding.value, undefined)
})

/** Save As with `typed` typed and `picked` picked, which is gone before it is inspected. */
const goneBeforeInspected = async (w: World, typed: string, picked: string) => {
    w.pick(picked)
    w.answers.saveDialog.push({ action: 'save', fileName: typed, history: true, bgm: true })
    const gone = w.atPoint('picked', () => {
        w.mock.files.delete(picked)
    })
    await flow.saveAs()
    await gone
    await settle()
    assert.deepEqual(notFound(w), [[picked]])
    assert.equal(w.boundName(), 'own.nxsp')
}

test('a Save As whose picked file is gone before it is inspected leaves the bound file unmarked', async () => {
    const w = await world('bound')
    await goneBeforeInspected(w, 'fresh.nxsp', 'fresh.nxsp')
    assert.equal(diskFinding.value, undefined)
})

test("a gone pick under the bound file's typed name is named as picked and leaves the bound file unmarked", async () => {
    const w = await world('bound')
    await goneBeforeInspected(w, 'own.nxsp', 'fresh.nxsp')
    assert.equal(diskFinding.value, undefined)
})

test('a gone pick of the bound file under another typed name is named as picked and marks it missing', async () => {
    const w = await world('bound')
    await goneBeforeInspected(w, 'suggested.nxsp', 'own.nxsp')
    assert.equal(diskFinding.value, 'missing')
})
