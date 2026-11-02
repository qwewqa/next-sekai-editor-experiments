import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, type Setup } from '../saveMatrix/world'

const { pickVideo } = await import('../../../src/editor/save/videoPick')
const pick = () =>
    pickVideo({
        name: 'clip.mp4',
        type: { description: 'MP4', extension: '.mp4' },
        ui: flow.pickUi,
    })

for (const [name, setup] of [
    ['clip.mp4', {}],
    ['own.nxsp', { own: 'bound' }],
    ['other.nxsp', { other: true }],
    ['target.nsld', { target: true }],
    ['opened.nsld', { opened: 'partial' }],
] satisfies [string, Setup][])
    test('a video pick accepts ' + name + ' and revokes its associations', async () => {
        const w = await createWorld(setup)
        w.pick(name)
        const result = await pick()
        assert.equal(result.kind, 'accepted')
        assert.equal(w.lockHeld(), false)
        assert.equal(w.writes.length, 0)
        assert.equal(w.mock.files.get(name)!.size, 0)
        for (const chain of await w.storedChains()) {
            assert.notEqual((chain.file as { name: string } | undefined)?.name, name)
            assert.notEqual((chain.exportTarget as { name: string } | undefined)?.name, name)
        }
        if (name === 'own.nxsp') assert.equal(w.session.chain?.file, undefined)
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

test('cancelling before a video pick opens leaves files untouched', async () => {
    const w = await createWorld()
    const result = await pickVideo({
        name: 'clip.mp4',
        type: { description: 'MP4', extension: '.mp4' },
        ui: flow.pickUi,
        signal: AbortSignal.abort(),
    })
    assert.equal(result.kind, 'cancelled')
    assert.equal(w.mock.pickerCalls.length, 0)
})
