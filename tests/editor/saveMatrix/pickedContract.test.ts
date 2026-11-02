import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, sameBytes, settle, type Setup } from './world'

const answer = (fileName: string) => ({
    action: 'save',
    fileName,
    history: false,
    bgm: true,
})

for (const [name, setup] of [
    ['own.nxsp', {}],
    ['other.nxsp', { other: true }],
    ['target.nsld', { target: true }],
    ['opened.nsld', { opened: 'levelData' }],
    ['opened.nsld', { opened: 'notProject' }],
    ['opened.nsld', { opened: 'partial' }],
    ['unknown.nxsp', {}],
    ['fresh.nxsp', {}],
] satisfies [string, Setup][])
    test(`Save As writes the requested document to ${name} (${setup.opened ?? 'project'})`, async () => {
        const w = await createWorld({ own: 'bound', storage: 'lacks', held: true, ...setup })
        const options: { history: boolean; bgm: boolean }[] = []
        w.on('worker:buildSave', (_n, arg) => {
            options.push((arg as { options: (typeof options)[number] }).options)
        })
        w.pick(name)
        w.answers.saveDialog.push(answer(name))
        await flow.saveAs()
        await settle()
        assert.equal(w.builtLog.length, 1)
        assert.equal(w.builtLog[0]?.target, 'new')
        assert.equal(w.builtLog[0]?.sources, 0)
        assert.ok(options.every((value) => !value.history && value.bgm))
        assert.ok(sameBytes((await w.fileBytes(name))!, w.builtLog[0]!.bytes))
        assert.equal(w.boundName(), name)
        assert.notEqual(w.session.docId, 'doc-own')
        assert.equal(
            w.dialogs.some((dialog) => ['refused', 'notPutBack'].includes(dialog.kind)),
            false,
        )
    })

test("Save refuses a picked file filled by its owner's Save while the pick waited", async () => {
    const w = await createWorld({ own: 'bound', other: true })
    const original = w.files['other.nxsp']!
    w.pick('other.nxsp')
    w.answers.saveDialog.push(answer('other.nxsp'))
    const filled = w.atPoint('picked', () => {
        w.mock.writeFile('other.nxsp', new Blob([new Uint8Array(original)]))
    })
    await flow.saveAs()
    await filled
    await settle()
    assert.deepEqual(await w.fileBytes('other.nxsp'), original)
    assert.equal(w.boundName(), 'own.nxsp')
    assert.equal(w.writes.length, 0)
    assert.equal(
        w.dialogs.some((dialog) => dialog.kind === 'failed'),
        true,
    )
})

test('a revocation that cannot be stored does not block the picked write', async () => {
    const w = await createWorld({ own: 'bound', other: true })
    w.behaviour.set('takeOver', () => 'throw')
    w.pick('other.nxsp')
    w.answers.saveDialog.push(answer('other.nxsp'))
    await flow.saveAs()
    await settle()
    assert.ok(sameBytes((await w.fileBytes('other.nxsp'))!, w.builtLog[0]!.bytes))
    assert.equal(w.boundName(), 'other.nxsp')
    assert.equal(
        w.dialogs.some((dialog) => dialog.kind === 'saved'),
        true,
    )
})
