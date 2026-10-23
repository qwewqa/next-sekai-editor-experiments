import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import local from '../../scripts/eslint-plugin-local.mjs'
import { COVERED_READS } from '../../src/local/storedRead'
import type { StorageHandlers } from '../../src/local/worker/storage.worker'

// Every storage method is classified (Part 1 §1.6.5): a covered read goes through the `storedRead`
// gate; the others are other reads (handled where they are read), writes, lifecycle calls or test
// hooks. A method added to the worker fails to compile here until it is placed, and the runtime
// check below reads the worker's own handler modules, so the compiler is not the only guard.

type Class = 'covered' | 'read' | 'write' | 'lifecycle' | 'test'

const CLASSES = {
    // Covered reads: the empty answer is acted on.
    readHandle: 'covered',
    listHandleOwners: 'covered',
    readBindings: 'covered',
    readChainRecord: 'covered',
    replaceDecision: 'covered',
    openEarlierChains: 'covered',
    openPendingImports: 'covered',
    openImportTarget: 'covered',
    listRecovered: 'covered',
    readRecovered: 'covered',
    listKept: 'covered',
    findEdits: 'covered',
    checkStoredOpen: 'covered',
    checkStoredBatch: 'covered',
    listRecent: 'covered',
    // Other reads: a failure is handled in place, by review.
    readSnapshot: 'read',
    readSnapshotVerified: 'read',
    readEntry: 'read',
    readSession: 'read',
    readNewestSession: 'read',
    readMetaIds: 'read',
    migratedBefore: 'read',
    readTimeline: 'read',
    readTimelineIndex: 'read',
    readChanges: 'read',
    estimateSaveSize: 'read',
    saveNeeds: 'read',
    mediaHeld: 'read',
    readSessionStarts: 'read',
    openRead: 'read',
    checkFileOpen: 'read',
    checkFileBatch: 'read',
    diagnostics: 'read',
    buildSave: 'read',
    userAssetList: 'read',
    userAssetGet: 'read',
    // Writes.
    flush: 'write',
    storeMedia: 'write',
    importForeign: 'write',
    countDay: 'write',
    userAssetPut: 'write',
    userAssetPutMany: 'write',
    userAssetTouch: 'write',
    userAssetRemove: 'write',
    applyJournal: 'write',
    keepRecovered: 'write',
    syncStrict: 'write',
    writeChainFields: 'write',
    discardRecovered: 'write',
    migrateAutoSave: 'write',
    keepHandle: 'write',
    dropKept: 'write',
    takeOver: 'write',
    applyRevocation: 'write',
    unlinkChain: 'write',
    recordOwnSave: 'write',
    openDrop: 'write',
    openStore: 'write',
    openResume: 'write',
    openBatch: 'write',
    openUnlink: 'write',
    openAbandon: 'write',
    checkFinish: 'write',
    checkDrop: 'write',
    // Lifecycle.
    init: 'lifecycle',
    status: 'lifecycle',
    tryAgain: 'lifecycle',
    resume: 'lifecycle',
    // Test hooks.
    testHandleReads: 'test',
    testPut: 'test',
    testPutUnacknowledged: 'test',
    testGet: 'test',
    testCrash: 'test',
    testPoint: 'test',
    testPutThrough: 'test',
    testLocation: 'test',
    testArmCrash: 'test',
    testRows: 'test',
    testDamage: 'test',
    testThin: 'test',
    testSaveHooks: 'test',
} as const satisfies Record<keyof StorageHandlers, Class>

/** The handler modules `storage.worker.ts` spreads, each with the factory that makes them. */
const MODULES: [file: string, factory: string][] = [
    ['worker/handlers.ts', 'createContext'],
    ['worker/flushHandlers.ts', 'flushHandlers'],
    ['worker/userAssets.ts', 'userAssetHandlers'],
    ['journal/handlers.ts', 'journalHandlers'],
    ['worker/startupHandlers.ts', 'startupHandlers'],
    ['worker/timelineHandlers.ts', 'timelineHandlers'],
    ['worker/peekHandlers.ts', 'peekHandlers'],
    ['worker/changeHandlers.ts', 'changeHandlers'],
    ['worker/saveHandlers.ts', 'saveHandlers'],
    ['worker/bindHandlers.ts', 'bindHandlers'],
    ['worker/openHandlers.ts', 'openHandlers'],
    ['worker/checkHandlers.ts', 'checkHandlers'],
    ['worker/diagnosticHandlers.ts', 'diagnosticHandlers'],
]

const covered = (Object.keys(CLASSES) as (keyof typeof CLASSES)[]).filter(
    (key) => CLASSES[key] === 'covered',
)

test('the gate’s list is the covered class, and the lint rule’s list is the gate’s', () => {
    assert.deepEqual([...COVERED_READS].sort(), [...covered].sort())
    const source = readFileSync(
        new URL('../../scripts/eslint-plugin-local.mjs', import.meta.url),
        'utf8',
    )
    const list = /const COVERED_READS = \[([^\]]*)\]/.exec(source)?.[1]
    assert.ok(list)
    const named = [...list.matchAll(/'(\w+)'/g)].map((match) => match[1])
    assert.deepEqual([...named].sort(), [...COVERED_READS].sort())
    assert.ok('stored-reads' in local.rules)
})

test('every handler the worker serves is classified, and none twice', async () => {
    const worker = readFileSync(
        new URL('../../src/local/worker/storage.worker.ts', import.meta.url),
        'utf8',
    )
    // A handler module added to the worker is added to MODULES.
    const spread = [...worker.matchAll(/\.\.\.(\w+)\(context\)/g)].map((match) => match[1])
    assert.deepEqual(
        [...spread].sort(),
        MODULES.map(([, factory]) => factory)
            .filter((factory) => factory !== 'createContext')
            .sort(),
    )
    const context = {
        get core(): never {
            throw new Error('no core')
        },
        test: false,
        emit: () => undefined,
    }
    const served: string[] = []
    for (const [file, name] of MODULES) {
        const module = (await import(
            new URL(`../../src/local/${file}`, import.meta.url).href
        )) as Record<string, (arg: unknown) => unknown>
        const made = (
            name === 'createContext'
                ? (module[name]!(() => undefined) as { handlers: object }).handlers
                : module[name]!(context)
        ) as object
        served.push(...Object.keys(made))
    }
    assert.equal(new Set(served).size, served.length, 'a method is served twice')
    assert.deepEqual([...served].sort(), Object.keys(CLASSES).sort())
})
