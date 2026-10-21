import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
    clearExportMemory,
    exportMemory,
    loadExportTarget,
    rememberExport,
    restoreExportMemory,
    setExportHandleReader,
    setExportPersister,
    setExportTargetReader,
} from '../../src/editor/commands/exportLevel/memory'
import { readValue } from '../../src/local/storedRead'

// Export's memory as chain fields (Part 1 §1.4.8, §1.6.11.2): read back when a stored session
// opens, and stored whenever it changes, never dropping a field this tab didn't change. The
// target's handle is read only when Export needs it (D24).

const stored = {
    exportTarget: { name: 'LevelData', disk: { size: 10, lastModified: 1, sha256: 'ab' } },
    exportName: 'Coconut',
    partialImport: true,
}

afterEach(() => {
    clearExportMemory()
    setExportPersister(undefined)
    setExportHandleReader(undefined)
    setExportTargetReader(undefined)
})

test('after a reload, an export by download keeps the stored target it has no handle for', () => {
    restoreExportMemory(stored)
    assert.equal(exportMemory.target, undefined)
    assert.equal(exportMemory.partial, true)
    const persisted: Record<string, unknown>[] = []
    setExportPersister(async (fields) => {
        persisted.push(fields)
        return true
    })
    exportMemory.exportName = 'Coconut (Master)'
    rememberExport()
    // The target, and its stored handle, stay as they are.
    assert.deepEqual(persisted, [{ exportName: 'Coconut (Master)', partialImport: true }])
})

test('the stored target’s handle is read when Export needs it, never when the session opens', async () => {
    const handle = { kind: 'file', name: 'LevelData' } as unknown as FileSystemFileHandle
    let reads = 0
    setExportHandleReader(() => {
        reads++
        return Promise.resolve(readValue(handle))
    })
    restoreExportMemory(stored)
    assert.equal(reads, 0)
    const target = await loadExportTarget()
    assert.equal(reads, 1)
    assert.deepEqual(target, {
        name: 'LevelData',
        handle,
        disk: stored.exportTarget.disk,
        exported: true,
    })
    assert.equal(await loadExportTarget(), target)
    assert.equal(reads, 1)
})

test('without a stored handle, Export has no target and asks where', async () => {
    setExportHandleReader(() => Promise.resolve(readValue(undefined)))
    restoreExportMemory(stored)
    assert.equal(await loadExportTarget(), undefined)
})

test('the opened file’s target names the picker’s suggestion, and a new chart forgets it', () => {
    restoreExportMemory({ exportTarget: { ...stored.exportTarget, opened: true } })
    assert.equal(exportMemory.sourceName, 'LevelData')
    clearExportMemory()
    const persisted: Record<string, unknown>[] = []
    setExportPersister(async (fields) => {
        persisted.push(fields)
        return true
    })
    rememberExport()
    assert.deepEqual(persisted, [
        { exportTarget: undefined, exportName: undefined, partialImport: undefined },
    ])
})

const failed = { storedRead: 'failed', storedError: new Error('stopped (export test)') } as const

test('a failed read of the stored target’s handle is no target: the picker asks where', async () => {
    setExportHandleReader(() => Promise.resolve(failed))
    restoreExportMemory(stored)
    assert.equal(await loadExportTarget(), undefined)
})

test('a failed read of the chain record never authorizes a registered target', async () => {
    const handle = { kind: 'file', name: 'LevelData' } as unknown as FileSystemFileHandle
    setExportHandleReader(() => Promise.resolve(readValue(handle)))
    setExportTargetReader(() => Promise.resolve(failed))
    restoreExportMemory(stored)
    assert.equal(await loadExportTarget(), undefined)
    assert.equal(exportMemory.target, undefined)
    // The control: the record answers with the target it holds.
    setExportTargetReader(() =>
        Promise.resolve(
            readValue({ exportTarget: { name: 'LevelData', disk: stored.exportTarget.disk } }),
        ),
    )
    restoreExportMemory(stored)
    assert.equal((await loadExportTarget())?.name, 'LevelData')
})
