import assert from 'node:assert/strict'
import test from 'node:test'
import { handleReadsForTests, readHandleRow, type HandleRole } from '../../src/local/handleRows'
import { handleOf, resolveHandle } from '../../src/local/handles'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import type { OpenStoreRequest } from '../../src/local/open/importWrite'
import { checkStored } from '../../src/local/testing/invariants'
import { createWorld, type World } from '../../src/local/testing/world'
import type { WorkerContext } from '../../src/local/worker/handlers'
import { openHandlers } from '../../src/local/worker/openHandlers'
import { editStep, futureFixtureOperation, nativeOperation } from '../helpers/historySteps'
import { openPage, rows, workerCore, type Page } from './flush/harness'
import { append, beginSession, openJournalPage } from './journal/harness'
import { fresh } from './nxsp/chain'
import { goldenChart, stateOf } from './records/charts'
import { beginIn, handlersOf } from './startup/harness'
import { load, openSession } from './startup/load'
import { widen } from './timeline/helpers'

// The `handles` store (D24): a chain's file handles by role, never on the chain record or the
// journal descriptor, written in the transaction that writes their field, removed with it, and
// read only when a Save, an Export or a resumed import asks: never by startup or recovery.

type Row = Record<string, unknown>

const handleRows = (world: World) => [...rows(world, 'handles').values()]

const readHandle = (page: Page, chainId: string, role: HandleRole) =>
    page.tab.run(() =>
        page.core.read(['chains', 'handles'], (tx) => readHandleRow(tx, chainId, role)),
    )

// Mid-import, the stack's roots wait for their chunks: only the handles' invariants here.
const handleViolations = (world: World) =>
    checkStored(world.memory).filter((violation) => violation.startsWith('handle'))

const disk = { fingerprint: 'sha256:ab', size: 10, lastModified: 1 }
const target = { name: 'LevelData', disk }

test('an open stores the binding’s handle in its own store, and an unlink removes it', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('a'))
    const context: WorkerContext = { core: page.core, test: true, emit: () => undefined }
    const open = openHandlers(context, page.tab.waiter)
    const file = await executePlan(planNxsp(fresh().input).plan, new Map())
    const reply = await page.tab.run(() => open.openRead(file))
    if (reply.kind !== 'nxsp') throw new Error('not nxsp')
    const ids = { chainId: 'chain-1', sessionId: 'session-1', docId: 'doc', lineageId: 'lineage' }
    const request: OpenStoreRequest = {
        id: reply.id,
        ids,
        chain: {
            file: {
                name: 'coconut.nxsp',
                handle: { testHandle: 'coconut.nxsp' },
                event: 'opened',
            },
        },
        operations: {
            opened: futureFixtureOperation('handle-open', {}, 'Opened coconut.nxsp'),
            changedOutside: futureFixtureOperation(
                'handle-external-change',
                {},
                'Changed outside the editor',
            ),
        },
        wall: 2_000_000,
        appVersion: '0.6.0',
    }
    const stored = await page.tab.run(() => open.openStore(request))
    assert.equal(stored.kind, 'stored')
    if (stored.kind !== 'stored') return
    const chain = rows(world, 'chains').get(ids.chainId)!
    assert.equal((chain.file as Row).name, 'coconut.nxsp')
    assert.ok(!('handle' in (chain.file as Row)))
    assert.ok(!('handle' in (stored.chain.file as Row)))
    assert.deepEqual(handleRows(world), [
        {
            chainId: ids.chainId,
            role: 'file',
            name: 'coconut.nxsp',
            handle: { testHandle: 'coconut.nxsp' },
        },
    ])
    assert.deepEqual(await readHandle(page, ids.chainId, 'file'), { testHandle: 'coconut.nxsp' })
    assert.deepEqual(handleViolations(world), [])

    await page.tab.run(() =>
        open.openUnlink({
            id: reply.id,
            chainId: ids.chainId,
            docId: 'doc-2',
            hashes: [],
            appVersion: '0.6.0',
        }),
    )
    assert.equal(rows(world, 'chains').get(ids.chainId)?.file, undefined)
    assert.deepEqual(handleRows(world), [])
    assert.equal(await readHandle(page, ids.chainId, 'file'), undefined)
    assert.deepEqual(handleViolations(world), [])
})

test('Export’s target keeps its handle beside the record, until the target changes or goes', async () => {
    const world = createWorld({ seed: 2 })
    const page: Page = await openPage(world, world.tab('a'), {
        writeChain: (request) => page.tab.run(() => handlersOf(page).writeChainFields(request)),
    })
    const session = beginIn(page, stateOf(goldenChart()))
    const targetOf = (name: string, handle?: unknown) => ({
        name,
        ...(handle ? { handle } : {}),
        disk,
    })
    // Before the session's first write: the batch's chain fields carry it.
    assert.equal(
        await page.flusher.setChainFields({
            exportTarget: targetOf('LevelData', { testHandle: 'LevelData' }),
        }),
        true,
    )
    const record = () => rows(world, 'chains').get(session.chainId)!
    assert.deepEqual(record().exportTarget, targetOf('LevelData'))
    assert.deepEqual(await readHandle(page, session.chainId, 'exportTarget'), {
        testHandle: 'LevelData',
    })
    assert.deepEqual(checkStored(world.memory), [])
    // Another field's write leaves it.
    assert.equal(await page.flusher.setChainFields({ exportName: 'Coconut' }), true)
    assert.equal(handleRows(world).length, 1)
    // A target without a handle (a private window) loses it; one with a handle stores it again.
    assert.equal(await page.flusher.setChainFields({ exportTarget: targetOf('Other') }), true)
    assert.deepEqual(handleRows(world), [])
    assert.equal(
        await page.flusher.setChainFields({
            exportTarget: targetOf('Other', { testHandle: 'Other' }),
        }),
        true,
    )
    assert.deepEqual(await readHandle(page, session.chainId, 'exportTarget'), {
        testHandle: 'Other',
    })
    assert.deepEqual(checkStored(world.memory), [])
    // A row stored for another name is never handed out.
    await page.tab.run(() =>
        page.core.write(['handles'], async (tx) => {
            await tx.put('handles', {
                chainId: session.chainId,
                role: 'exportTarget',
                name: 'LevelData',
                handle: { testHandle: 'LevelData' },
            })
        }),
    )
    assert.equal(await readHandle(page, session.chainId, 'exportTarget'), undefined)
    // The target removed removes its row.
    assert.equal(await page.flusher.setChainFields({ exportTarget: undefined }), true)
    assert.equal(record().exportTarget, undefined)
    assert.deepEqual(handleRows(world), [])
    assert.deepEqual(checkStored(world.memory), [])
})

test('startup and recovery read no stored handle; a Save’s write-back after them finds it', async () => {
    const world = createWorld({ seed: 3 })
    const first = await openJournalPage(world, 'first')
    const a = stateOf(goldenChart())
    const session = beginSession(first, a)
    await first.flusher.flush({ strict: true })
    const other = world.tab('other')
    const core = workerCore(world, other)
    await other.run(() => core.start())
    const binding = { name: 'coconut.nxsp', event: 'opened', at: 1, options: {} }
    await other.run(() =>
        core.write(['chains', 'handles'], async (tx) => {
            const chain = (await tx.get('chains', session.chainId)) as Row
            await tx.put('chains', { ...chain, file: binding, exportTarget: target })
            await tx.put('handles', {
                chainId: session.chainId,
                role: 'file',
                name: 'coconut.nxsp',
                handle: { testHandle: 'coconut.nxsp' },
            })
            await tx.put('handles', {
                chainId: session.chainId,
                role: 'exportTarget',
                name: 'LevelData',
                handle: { testHandle: 'LevelData' },
            })
        }),
    )
    // A change only the journal holds: the next load replays it, then continues the session.
    append(
        first,
        {
            kind: 'edit',
            step: editStep(
                nativeOperation(
                    { id: 'nse.object.edit', data: { subject: 'note', changed: { note: 1 } } },
                    'Changed note',
                ),
            ),
        },
        widen(a),
    )
    assert.equal(first.writer.write(), true)
    first.tab.kill()

    const before = handleReadsForTests()
    const visit = await load(world, 'visit', first.storage)
    assert.equal(visit.recovery.outcomes.length, 1)
    assert.equal(openSession(visit).chainId, session.chainId)
    assert.equal(handleReadsForTests(), before)

    // The Save's write-back reads the binding's handle when it needs it.
    const read = (role: HandleRole) =>
        visit.deps.worker.call('readHandle' as never, { chainId: session.chainId, role } as never)
    assert.deepEqual(await read('file'), { testHandle: 'coconut.nxsp' })
    assert.deepEqual(await read('exportTarget'), { testHandle: 'LevelData' })
    assert.equal(handleReadsForTests(), before + 2)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a failed handle read and an absent handle are different answers', async () => {
    const failing = {
        call: () =>
            Promise.reject(
                Object.assign(new Error('restarted (handles test)'), {
                    name: 'WorkerRestartedError',
                }),
            ),
    }
    const absent = { call: () => Promise.resolve(undefined) }
    const held = { kind: 'file', name: 'a.nxsp', getFile: () => undefined }
    const stored = { call: () => Promise.resolve(held) }
    const failed = await handleOf(failing, 'c1', 'file')
    assert.equal(failed.storedRead, 'failed')
    assert.deepEqual(await handleOf(absent, 'c1', 'file'), {
        storedRead: 'value',
        storedValue: undefined,
    })
    assert.deepEqual(await handleOf(stored, 'c1', 'file'), {
        storedRead: 'value',
        storedValue: held,
    })
    // A stored value this page cannot hold is an answer too: none.
    const token = { call: () => Promise.resolve({ testHandle: 'a.nxsp' }) }
    assert.deepEqual(await handleOf(token, 'c1', 'file'), {
        storedRead: 'value',
        storedValue: undefined,
    })
})

test('a stored token or handle resolves to a handle; anything else to none', () => {
    const handle = { kind: 'file', name: 'a.nxsp', getFile: () => undefined }
    assert.equal(resolveHandle(handle), handle)
    assert.equal(resolveHandle({ kind: 'file', name: 'a.nxsp' }), undefined)
    assert.equal(resolveHandle(undefined), undefined)
    // A token this page holds no handle for, outside the specs' override.
    assert.equal(resolveHandle({ testHandle: 'a.nxsp' }), undefined)
})
