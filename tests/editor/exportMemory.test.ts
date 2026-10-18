import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
    clearExportMemory,
    exportMemory,
    rememberExport,
    restoreExportMemory,
    setExportPersister,
} from '../../src/editor/commands/exportLevel/memory'

// Export's memory as chain fields (Part 1 §1.4.8, §1.6.11.2): read back when a stored session
// opens, and stored whenever it changes, never dropping a field this tab didn't change.

const stored = {
    exportTarget: { name: 'LevelData', disk: { size: 10, lastModified: 1, sha256: 'ab' } },
    exportName: 'Coconut',
    partialImport: true,
}

afterEach(() => {
    clearExportMemory()
    setExportPersister(undefined)
})

test('after a reload, an export by download keeps the stored target it has no handle for', () => {
    restoreExportMemory(stored)
    assert.equal(exportMemory.target, undefined)
    assert.equal(exportMemory.partial, true)
    const persisted: Record<string, unknown>[] = []
    setExportPersister((fields) => persisted.push(fields))
    exportMemory.exportName = 'Coconut (Master)'
    rememberExport()
    assert.deepEqual(persisted, [
        {
            exportTarget: stored.exportTarget,
            exportName: 'Coconut (Master)',
            partialImport: true,
        },
    ])
})

test('the opened file’s target names the picker’s suggestion, and a new chart forgets it', () => {
    restoreExportMemory({ exportTarget: { ...stored.exportTarget, opened: true } })
    assert.equal(exportMemory.sourceName, 'LevelData')
    clearExportMemory()
    const persisted: Record<string, unknown>[] = []
    setExportPersister((fields) => persisted.push(fields))
    rememberExport()
    assert.deepEqual(persisted, [
        { exportTarget: undefined, exportName: undefined, partialImport: undefined },
    ])
})
