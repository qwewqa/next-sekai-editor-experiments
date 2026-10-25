import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createWorld, flow, settle } from './world'

const { storageStatus } = await import('../../../src/local/startup/events')

// A Save refused while an open's import is pending says storage is full when storing is paused
// full (the import cannot store then); every other pending case keeps the line about the file.

afterEach(() => {
    storageStatus.value = undefined
})

const refusedLine = async (status: (typeof storageStatus)['value']) => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    storageStatus.value = status
    w.behaviour.set('buildSave', () => ({ refuse: 'importing' }))
    await flow.save()
    await settle()
    const errors = w.dialogs.filter((dialog) => dialog.kind === 'error')
    assert.equal(errors.length, 1)
    return String(errors[0]?.args[0])
}

test('a Save refused for a pending import while storage is full says so', async () => {
    assert.match(
        await refusedLine({ mode: 'stored', reason: 'full' }),
        /^Not saved\. Browser storage is full\. Delete sessions in Settings › Local Data/,
    )
})

test('a Save refused for an import still running keeps the line about the file', async () => {
    for (const status of [
        { mode: 'stored' },
        { mode: 'stored', reason: 'upgrading' },
        { mode: 'memory' },
        undefined,
    ] as const)
        assert.match(await refusedLine(status), /^Not saved\. ".*" could not be read completely\.$/)
})
