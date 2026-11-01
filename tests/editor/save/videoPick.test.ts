import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bytesOf, createWorld, flow, type Setup } from '../saveMatrix/world'

const { pickVideo } = await import('../../../src/editor/save/videoPick')
const { FileError } = await import('../../../src/platform')
const pick = () =>
    pickVideo({
        name: 'clip.mp4',
        type: { description: 'MP4', extension: '.mp4' },
        ui: flow.pickUi,
    })

test('a video pick accepts only an unknown empty file and releases the bind lock', async () => {
    const w = await createWorld()
    w.pick('clip.mp4')
    const result = await pick()
    assert.equal(result.kind, 'accepted')
    assert.equal(w.lockHeld(), false)
    assert.equal(w.writes.length, 0)
    assert.equal(w.mock.files.get('clip.mp4')!.size, 0)
    assert.deepEqual(w.mock.pickerCalls[0]!.picker, {
        id: 'nse-video',
        types: [{ description: 'MP4', extension: '.mp4' }],
        excludeAll: true,
    })
})

for (const storage of ['holds', 'lacks'] as const)
    test(`a video pick rewrites the chain's own project when storage ${storage} its base`, async () => {
        const w = await createWorld({ own: 'bound', storage })
        w.pick('own.nxsp')
        const result = await pick()
        assert.deepEqual(result, { kind: 'ownProject', name: 'own.nxsp' })
        assert.ok(w.mock.files.get('own.nxsp')!.size > 0)
        assert.equal(w.writes.length, 1)
        assert.equal(w.writes[0]!.exclusive, true)
        assert.equal(w.lockHeld(), false)
    })

for (const opened of ['notProject', 'levelData', 'partial'] as const)
    test(`a video pick restores an opened ${opened} file byte for byte`, async () => {
        const w = await createWorld({ opened })
        const before = await bytesOf(w.mock.files.get('opened.nsld'))
        w.pick('opened.nsld')
        assert.equal((await pick()).kind, 'refused')
        assert.deepEqual(await bytesOf(w.mock.files.get('opened.nsld')), before)
    })

for (const setup of [{ target: true }, { other: true }] satisfies Setup[])
    test(`a video pick refuses ${setup.target ? 'an Export target' : 'another project'} without revoking its owner`, async () => {
        const w = await createWorld(setup)
        const before = await w.storedChains()
        const name = setup.target ? 'target.nsld' : 'other.nxsp'
        w.pick(name)
        assert.equal((await pick()).kind, 'refused')
        assert.deepEqual(await w.storedChains(), before)
        assert.equal(w.mock.files.get(name)!.size, 0)
        if (setup.target) assert.ok(w.dialogs.some((dialog) => dialog.kind === 'notPutBack'))
    })

test('a video pick leaves bytes written after the picker untouched', async () => {
    const w = await createWorld()
    w.pick('clip.mp4')
    const filled = w.atPoint('picked', () =>
        w.mock.writeFile('clip.mp4', new Blob(['other writer'])),
    )
    const result = await pick()
    await filled
    assert.equal(result.kind, 'failed')
    if (result.kind === 'failed') assert.equal(result.error.code, 'conflict')
    assert.equal(await w.mock.files.get('clip.mp4')!.text(), 'other writer')
    assert.equal(w.writes.length, 0)
})

test('a failed own-file rewrite keeps the empty-file offer before the Save failure', async () => {
    const w = await createWorld({ own: 'bound', storage: 'holds' })
    w.pick('own.nxsp')
    w.mock.fault = (point) => {
        if (point === 'beforeClose') throw new FileError('no-space', 'Full')
    }
    const result = await pick()
    assert.equal(result.kind, 'show')
    assert.ok(w.dialogs.some((dialog) => dialog.kind === 'notPutBack'))
    if (result.kind === 'show') await result.show()
    assert.equal(w.mock.files.get('own.nxsp')!.size, 0)
    assert.equal(w.dialogs.at(-1)?.kind, 'failed')
})

test('cancelling before a video pick opens leaves files untouched', async () => {
    const w = await createWorld()
    const signal = AbortSignal.abort()
    const result = await pickVideo({
        name: 'clip.mp4',
        type: { description: 'MP4', extension: '.mp4' },
        ui: flow.pickUi,
        signal,
    })
    assert.equal(result.kind, 'cancelled')
    assert.equal(w.mock.pickerCalls.length, 0)
})
