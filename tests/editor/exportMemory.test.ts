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
} from '../../src/editor/commands/exportLevel/memory'

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
        return Promise.resolve(handle)
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
    setExportHandleReader(() => Promise.resolve(undefined))
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
