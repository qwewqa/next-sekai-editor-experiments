import assert from 'node:assert/strict'
import test from 'node:test'
import { fromHex16, toHex } from '../../../src/local/hash'
import { executePlan, planNxsp } from '../../../src/local/nxsp'
import {
    isImporting,
    resumeImports,
    startImport,
    whenImported,
    type ImportJob,
    type ImportOutcome,
} from '../../../src/local/open/importLoop'
import type { OpenStoreRequest } from '../../../src/local/open/importWrite'
import type { OpenReadReply } from '../../../src/local/open/opened'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { WorkerContext } from '../../../src/local/worker/handlers'
import { readHandle } from '../../../src/local/worker/handlers'
import { openHandlers } from '../../../src/local/worker/openHandlers'
import { RpcError } from '../../../src/local/worker/rpc'
import type { LockService } from '../../../src/platform/types'
import '../../editor/saveMatrix/env'
import { nativeOperation, originOperation } from '../../helpers/historySteps'
import { openPage, rows, storedRecords } from '../flush/harness'
import { fresh } from '../nxsp/chain'
import { damagedFile } from './files'

// An open's import when the storage worker restarts under it: a call the restart cuts off, or one
// that reaches the new worker, which has forgotten the file. The fake worker runs the real open
// handlers; a restart drops every file the worker opened, as a new worker starts with none.

// The Save's wait and `storeKept` load the editor's modules: the stubs above make that work in Node.
const { waitForChainImports } = await import('../../../src/editor/save/imports')
const { readProjectFile, storeKept } = await import('../../../src/local/open/project')
const { setSessionContext } = await import('../../../src/local/startup/api')

type When =
    /** The restart comes before the call commits: it rejects. */
    | 'before'
    /** The call commits, then the restart: its answer is lost. */
    | 'after'
    /** The restart comes first, and the call reaches the new worker. */
    | 'between'
    /** A storage failure: the call rejects, and the worker keeps its files. */
    | 'fails'

type Fault = { method: string; n?: number; when: When }

const ids = { chainId: 'chain-1', sessionId: 'session-1', docId: 'doc', lineageId: 'lineage' }

const locks: LockService = {
    request: (_name, _options, callback) => callback(true),
    query: () => Promise.resolve({ held: [], pending: [] }),
}

const setup = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openPage(world, world.tab('a'))
    const context: WorkerContext = { core: page.core, test: true, emit: () => undefined }
    const open = openHandlers(context, page.tab.waiter)
    const handlers: Record<string, (arg: unknown) => unknown> = {
        ...(open as unknown as Record<string, (arg: unknown) => unknown>),
        readHandle: (arg) => readHandle(page.core, arg as Parameters<typeof readHandle>[1]),
    }
    const calls: string[] = []
    const faults: Fault[] = []
    const known = new Set<string>()
    /** What a new worker knows of the files the last one opened: nothing. */
    const restart = () => {
        for (const id of known) open.openDrop(id)
    }
    const run = (method: string, arg: unknown) =>
        page.tab.run(async () => {
            const handler = handlers[method]
            if (!handler) throw new Error(`Unexpected call: ${method}`)
            const value = await handler(arg)
            const id = (value as { id?: unknown } | undefined)?.id
            if (typeof id === 'string' && (method === 'openRead' || method === 'openResume'))
                known.add(id)
            return value
        })
    const worker: ImportJob['worker'] = {
        call: (async (method: string, arg: unknown) => {
            calls.push(method)
            const n = (arg as { n?: unknown } | undefined)?.n
            const at = faults.findIndex(
                (fault) => fault.method === method && (fault.n === undefined || fault.n === n),
            )
            const fault = at < 0 ? undefined : faults.splice(at, 1)[0]
            const restarted = () => new RpcError('WorkerRestartedError', 'restarted (test)')
            switch (fault?.when) {
                case undefined:
                    return run(method, arg)
                case 'before':
                    restart()
                    throw restarted()
                case 'after':
                    await run(method, arg)
                    restart()
                    throw restarted()
                case 'between':
                    restart()
                    return run(method, arg)
                case 'fails':
                    throw new Error('Storage failed (test)')
            }
        }) as ImportJob['worker']['call'],
    }
    return { world, page, open, worker, calls, faults, run }
}

type Setup = Awaited<ReturnType<typeof setup>>

const storeRequest = (id: string): OpenStoreRequest => ({
    id,
    ids,
    chain: { name: 'Coconut (Master)', file: { name: 'coconut.nxsp', event: 'opened' } },
    operations: {
        opened: originOperation('import'),
        changedOutside: nativeOperation(
            { id: 'nse.externalChange', data: {} },
            'Changed outside the editor',
        ),
    },
    wall: 2_000_000,
    appVersion: '0.6.0',
})

/** Opens `file` as an input's pick does (no handle), stores its head, and gives the job. */
const opened = async (s: Setup, file: Blob, extra: Partial<ImportJob> = {}) => {
    const reply = (await s.worker.call('openRead', file)) as OpenReadReply
    if (reply.kind !== 'nxsp') throw new Error('not nxsp')
    const stored = await s.worker.call('openStore', storeRequest(reply.id))
    if (stored.kind !== 'stored') throw new Error('not stored')
    const job: ImportJob = {
        worker: s.worker,
        locks,
        sessionId: ids.sessionId,
        chainId: ids.chainId,
        id: reply.id,
        batches: stored.batches,
        source: {
            file,
            ...(reply.disk ? { disk: reply.disk } : {}),
            ...(reply.project?.revision ? { revisionId: reply.project.revision.id } : {}),
        },
        appVersion: '0.6.0',
        ...extra,
    }
    return { reply, stored, job }
}

const freshFile = async () => {
    const chain = fresh()
    return { ...chain, file: await executePlan(planNxsp(chain.input).plan, new Map()) }
}

const sessionRow = (world: World) => rows(world, 'sessions').get(ids.sessionId)
const ownEntries = (world: World, sessionId = ids.sessionId) =>
    [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number))

/** The whole import arrived: no `kept: false`, every row once, every state's records stored. */
const assertWhole = (world: World, hashes: string[], sessionId = ids.sessionId) => {
    const session = rows(world, 'sessions').get(sessionId)
    assert.equal(session?.importPending, undefined)
    const entries = ownEntries(world, sessionId)
    assert.deepEqual(
        entries.map((row) => [row.seq, row.kept]),
        [1, 2, 3, 4, 5].map((seq) => [seq, true]),
    )
    assert.equal(session?.entryCount, 5)
    for (const hex of hashes) assert.ok(storedRecords(world, fromHex16(hex)), hex)
}

for (const when of ['before', 'after'] as const)
    test(`a restart ${when} a batch commits: the import reads the file again and finishes`, async () => {
        const s = await setup(when === 'before' ? 1 : 2)
        const { file, hashes } = await freshFile()
        const { job, stored } = await opened(s, file)
        assert.ok(stored.batches > 0)
        s.faults.push({ method: 'openBatch', n: 0, when })
        assert.deepEqual(await startImport(job), { kind: 'done' })
        assertWhole(s.world, hashes)
        assert.ok(!s.calls.includes('openAbandon'))
        assert.equal(s.calls.filter((call) => call === 'openResume').length, 1)
    })

test('a batch that reaches a restarted worker runs the whole resumed plan, not the rest of the first', async () => {
    const s = await setup(3)
    const { file, hashes } = await freshFile()
    const { job, stored } = await opened(s, file)
    // The first plan leaves out what the open's first transaction stored; the resumed one does not.
    assert.equal(stored.batches, 2)
    s.faults.push({ method: 'openBatch', n: 1, when: 'between' })
    assert.deepEqual(await startImport(job), { kind: 'done' })
    assertWhole(s.world, hashes)
    assert.ok(!s.calls.includes('openAbandon'))
})

test('a restart just after the last batch committed ends the import as done', async () => {
    const s = await setup(4)
    const { file, hashes } = await freshFile()
    const { job, stored } = await opened(s, file)
    s.faults.push({ method: 'openBatch', n: stored.batches - 1, when: 'after' })
    assert.deepEqual(await startImport(job), { kind: 'done' })
    assertWhole(s.world, hashes)
    assert.ok(!s.calls.includes('openAbandon'))
})

/** The batch of a damaged file's import that answers `damaged`, from an import run aside. */
const damagedBatch = async (file: Blob) => {
    const aside = await setup(50)
    const { job, stored } = await opened(aside, file)
    for (let n = 0; n < stored.batches; n++) {
        const outcome = (await aside.run('openBatch', { id: job.id, n })) as { kind: string }
        if (outcome.kind === 'damaged') return n
    }
    throw new Error('No batch was damaged')
}

for (const fault of [
    { method: 'openBatch', when: 'after' },
    { method: 'openUnlink', when: 'before' },
    { method: 'openUnlink', when: 'after' },
] as const)
    test(`a restart ${fault.when} ${fault.method} on damage unlinks the chain once, as one docId`, async () => {
        const s = await setup(5)
        const { file, bad } = await damagedFile()
        let minted = 0
        const unlinks: [unknown, boolean][] = []
        const { job } = await opened(s, file, {
            newId: () => `doc-${++minted}`,
            onUnlink: (record, first) => unlinks.push([record.docId, first]),
        })
        const at = await damagedBatch(file)
        s.faults.push({
            method: fault.method,
            ...(fault.method === 'openBatch' ? { n: at } : {}),
            when: fault.when,
        })
        assert.deepEqual(await startImport(job), { kind: 'unlinked', docId: 'doc-1' })
        assert.equal(minted, 1)
        assert.deepEqual(
            unlinks.filter(([, first]) => first),
            [['doc-1', true]],
        )
        const chain = rows(s.world, 'chains').get(ids.chainId)!
        assert.equal(chain.docId, 'doc-1')
        assert.equal(toHex(chain.badChunks as Uint8Array), bad)
        assert.equal(sessionRow(s.world)?.importPending, undefined)
        assert.ok(!s.calls.includes('openAbandon'))
    })

test('restarts past the bound leave the import pending: nothing is abandoned', async () => {
    const s = await setup(7)
    const { file } = await freshFile()
    const { job } = await opened(s, file)
    for (let i = 0; i < 6; i++) s.faults.push({ method: 'openBatch', when: 'before' })
    assert.deepEqual(await startImport(job), { kind: 'failed' })
    assert.equal(s.calls.filter((call) => call === 'openResume').length, 2)
    assert.ok(!s.calls.includes('openAbandon'))
    assert.equal(sessionRow(s.world)?.importPending, true)
    assert.ok(ownEntries(s.world).every((row) => row.kept !== false))
})

for (const [name, change] of [
    [
        'changed',
        (job: ImportJob) => ({
            ...job.source,
            disk: { ...job.source.disk!, fingerprint: 'zip:other' },
        }),
    ],
    ['unreadable', (job: ImportJob) => ({ ...job.source, file: new Blob(['not a zip']) })],
] as const)
    test(`a resume that finds the file ${name} ends the import as before`, async () => {
        const s = await setup(8)
        const { file } = await freshFile()
        const { job } = await opened(s, file)
        s.faults.push({ method: 'openBatch', n: 0, when: 'before' })
        assert.deepEqual(await startImport({ ...job, source: change(job) }), { kind: 'stopped' })
        assert.ok(s.calls.includes('openAbandon'))
        assert.equal(sessionRow(s.world)?.importPending, undefined)
        assert.ok(ownEntries(s.world).some((row) => row.kept === false))
    })

test('a failed import is resumed from the file this tab holds, never abandoned', async () => {
    const s = await setup(9)
    const { file, hashes } = await freshFile()
    const { job } = await opened(s, file)
    s.faults.push({ method: 'openBatch', n: 0, when: 'fails' })
    assert.deepEqual(await startImport(job), { kind: 'failed' })
    assert.equal(sessionRow(s.world)?.importPending, true)
    // A Save's or a Check's resume, in the same tab: no handle is bound.
    await resumeImports({ worker: s.worker, locks, appVersion: '0.6.0' })
    assertWhole(s.world, hashes)
    assert.ok(!s.calls.includes('openAbandon'))
    assert.ok(!s.calls.includes('readHandle'))
})

test('the next load, with no handle and no file held, still ends the import', async () => {
    const s = await setup(10)
    const { file } = await freshFile()
    // Another tab's import: this tab never held its file.
    await opened(s, file)
    await resumeImports({ worker: s.worker, locks, appVersion: '0.6.0' })
    assert.ok(s.calls.includes('openAbandon'))
    assert.equal(sessionRow(s.world)?.importPending, undefined)
    assert.ok(ownEntries(s.world).some((row) => row.kept === false))
})

test('a Save waiting for the import waits through its resume and never resumes it itself', async () => {
    const s = await setup(11)
    const { file, hashes } = await freshFile()
    const { job } = await opened(s, file)
    s.faults.push({ method: 'openBatch', n: 0, when: 'before' })
    // The resume is held, so the Save starts waiting while the import retries.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reached!: () => void
    const resuming = new Promise<void>((resolve) => (reached = resolve))
    const call = s.worker.call
    s.worker.call = (async (method: string, arg: unknown, options: unknown) => {
        if (method === 'openResume') {
            reached()
            await gate
        }
        return (call as (...args: unknown[]) => unknown)(method, arg, options)
    }) as typeof call
    const outcome: Promise<ImportOutcome> = startImport(job)
    const ended = await Promise.race([resuming.then(() => false), outcome.then(() => true)])
    assert.equal(ended, false, 'the import ended instead of resuming')
    assert.equal(isImporting(ids.sessionId), true)
    let resumes = 0
    let importedWhenDone: unknown
    // The Save shows the import's progress once it waits on this tab's import.
    let followed!: () => void
    const following = new Promise<void>((resolve) => (followed = resolve))
    const waiting = waitForChainImports(
        { worker: s.worker, session: { id: ids.sessionId } as never, chainId: ids.chainId },
        {
            name: 'coconut.nxsp',
            ui: {
                preparing: () => ({
                    signal: new AbortController().signal,
                    importing: () => {
                        followed()
                    },
                    built: () => undefined,
                    ready: () => Promise.resolve(true),
                    close: () => undefined,
                }),
            },
            cancel: new AbortController(),
        },
        () => {
            resumes++
            return Promise.resolve()
        },
    ).then((result) => {
        importedWhenDone = sessionRow(s.world)?.importPending
        return result
    })
    await following
    assert.equal(isImporting(ids.sessionId), true)
    release()
    assert.equal(await waiting, 'done')
    assert.deepEqual(await whenImported(ids.sessionId), { kind: 'none' })
    assert.deepEqual(await outcome, { kind: 'done' })
    assert.equal(resumes, 0)
    // The Save went on only once the import had finished.
    assert.equal(importedWhenDone, undefined)
    assertWhole(s.world, hashes)
})

test('Replace’s kept version resumes after a restart', async () => {
    const s = await setup(12)
    const { file, hashes } = await freshFile()
    setSessionContext({ worker: s.worker, locks } as never, {} as never)
    // Replace reads the `File` its check pinned, and keeps that same `File`.
    const picked = new File([file], 'coconut.nxsp', { lastModified: 5000 })
    const read = await readProjectFile(picked)
    if (read.kind !== 'nxsp') throw new Error('not nxsp')
    s.faults.push({ method: 'openBatch', n: 0, when: 'before' })
    const kept = await storeKept({
        read,
        file: picked,
        sourceName: 'coconut.nxsp',
        name: 'Coconut (replaced Oct 16)',
        operations: storeRequest(read.id).operations,
        appVersion: '0.6.0',
    })
    assert.equal(kept, true)
    const session = [...rows(s.world, 'sessions').values()].find(
        (row) => row.origin === 'replaced',
    )!
    assertWhole(s.world, hashes, session.id as string)
    assert.ok(!s.calls.includes('openAbandon'))
})
