import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { gzip } from 'pako'
import {
    exportByPicker,
    exportToTarget,
    type ExportContext,
    type ExportUi,
} from '../../src/editor/commands/exportLevel/flow'
import {
    clearExportMemory,
    exportMemory,
    rememberExport,
    setExportPersister,
    setExportTargetReader,
    setUnregisteredTargetCheck,
} from '../../src/editor/commands/exportLevel/memory'
import { setPickLock, setTargetLock } from '../../src/editor/commands/exportLevel/pick'
import { setPlatformForTests } from '../../src/platform'
import { levelDataDiskState } from '../../src/platform/fingerprint'
import { createMockPlatform } from '../../src/platform/mock'

const gate = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
const body = (n: number) => new Blob([gzip(JSON.stringify({ bgmOffset: 0, entities: [{ n }] }))])
const ui = (): ExportUi => ({
    conflict: async () => undefined,
    notLevelData: async () => undefined,
    unsupportedParts: async () => undefined,
    notPutBack: async () => undefined,
    notFound: async () => undefined,
    denied: async () => undefined,
    failed: async () => undefined,
    exported: () => undefined,
    downloadStarted: () => undefined,
})
const context = (): ExportContext => ({
    ui: ui(),
    build: () => body(1),
    suggestedName: 'copy.nsld',
    types: [],
    leave: () => undefined,
})
const setup = async () => {
    const mock = createMockPlatform()
    setPlatformForTests(mock)
    const handle = mock.createHandle('LevelData')
    mock.writeFile('LevelData', body(0))
    const target = {
        name: 'LevelData',
        handle,
        disk: await levelDataDiskState(await handle.getFile()),
        exported: true,
    }
    exportMemory.target = target
    setTargetLock((run) => mock.locks.request('nse-bind', { mode: 'shared' }, run))
    setPickLock((run) => mock.locks.request('nse-bind', { mode: 'exclusive' }, run))
    return { mock, target }
}
afterEach(() => {
    setPlatformForTests(undefined)
    clearExportMemory()
    setExportPersister(undefined)
    setExportTargetReader(undefined)
    setUnregisteredTargetCheck(undefined)
    setTargetLock((run) => run())
    setPickLock((run) => run())
})

for (const picker of [false, true]) {
    test(`${picker ? 'picker' : 'remembered'} Export holds the binding lock through delayed bookkeeping`, async () => {
        const { mock, target } = await setup()
        const storing = gate()
        const finish = gate()
        setExportPersister(async () => {
            storing.resolve()
            await finish.promise
            return true
        })
        if (picker)
            mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('copy.nsld') })
        const exporting = picker ? exportByPicker(context()) : exportToTarget(context(), target)
        if (!picker) assert.equal(mock.calls[0], 'requestPermission:LevelData')
        await storing.promise
        let takeover = false
        const next = mock.locks.request('nse-bind', { mode: 'exclusive' }, async () => {
            takeover = true
        })
        const locks = await mock.locks.query()
        assert.equal(locks.held[0]?.mode, picker ? 'exclusive' : 'shared')
        assert.equal(locks.pending.length, 1)
        assert.equal(takeover, false)
        finish.resolve()
        assert.equal(await exporting, 'done')
        await next
        assert.equal(takeover, true)
        assert.equal((await mock.locks.query()).held.length, 0)
    })
}

test('ownership is read after the lock grants, so a queued revoked Export never writes', async () => {
    const { mock, target } = await setup()
    setExportPersister(async () => true)
    await rememberExport()
    let record: Record<string, unknown> = { exportTarget: { name: target.name, disk: target.disk } }
    setExportTargetReader(async () => record)
    const held = gate()
    const release = gate()
    const taking = mock.locks.request('nse-bind', { mode: 'exclusive' }, async () => {
        held.resolve()
        await release.promise
        record = {}
    })
    await held.promise
    mock.saveTargets.push('cancel')
    const exporting = exportToTarget(context(), target)
    release.resolve()
    await taking
    assert.equal(await exporting, 'back')
    assert.deepEqual(
        mock.calls.filter((call) => call.startsWith('write:')),
        [],
    )
    assert.equal(exportMemory.target, undefined)
})

test('cancelling a remembered Export queued behind a takeover writes nothing', async () => {
    const { mock, target } = await setup()
    const held = gate()
    const release = gate()
    const taking = mock.locks.request('nse-bind', { mode: 'exclusive' }, async () => {
        held.resolve()
        await release.promise
    })
    await held.promise
    const abort = new AbortController()
    const exporting = exportToTarget({ ...context(), signal: abort.signal }, target)
    abort.abort()
    release.resolve()
    await taking
    assert.equal(await exporting, 'cancelled')
    assert.deepEqual(
        mock.calls.filter((call) => call.startsWith('write:')),
        [],
    )
})

test('failed rewrite metadata retains registered ownership and accepts its older stored disk', async () => {
    const { mock, target } = await setup()
    setExportPersister(async () => true)
    await rememberExport()
    let record: Record<string, unknown> = { exportTarget: { name: target.name, disk: target.disk } }
    setExportTargetReader(async () => record)
    setExportPersister(async () => false)
    assert.equal(await exportToTarget(context(), target), 'done')
    const rewritten = exportMemory.target!
    assert.notEqual(rewritten, target)
    assert.equal(await exportToTarget(context(), rewritten), 'done')
    const bytes = await mock.files.get('LevelData')!.arrayBuffer()
    record = {}
    mock.saveTargets.push('cancel')
    const writes = mock.calls.filter((call) => call.startsWith('write:')).length
    assert.equal(await exportToTarget(context(), exportMemory.target!), 'back')
    assert.equal(mock.calls.filter((call) => call.startsWith('write:')).length, writes)
    assert.deepEqual(await mock.files.get('LevelData')!.arrayBuffer(), bytes)
})

test('a never-stored target can write until another owner is positively known', async () => {
    const { mock, target } = await setup()
    setExportPersister(async () => false)
    setExportTargetReader(async () => ({}))
    setUnregisteredTargetCheck(async () => true)
    assert.equal(await exportToTarget(context(), target), 'done')
    const bytes = await mock.files.get('LevelData')!.arrayBuffer()
    setUnregisteredTargetCheck(async () => false)
    mock.saveTargets.push('cancel')
    assert.equal(await exportToTarget(context(), exportMemory.target!), 'back')
    assert.deepEqual(await mock.files.get('LevelData')!.arrayBuffer(), bytes)
})

test('bookkeeping rejection releases the binding lock before reporting failure', async () => {
    const { mock, target } = await setup()
    setExportPersister(async () => {
        throw new Error('Storage interrupted')
    })
    const ctx = context()
    let reported = false
    ctx.ui.failed = async () => {
        assert.equal((await mock.locks.query()).held.length, 0)
        reported = true
        return undefined
    }
    assert.equal(await exportToTarget(ctx, target), 'cancelled')
    assert.equal(reported, true)
})
