import type { UseDay } from '../../../src/local/days'
import { writeMeta } from '../../../src/local/db'
import { createDeletion, runGc } from '../../../src/local/deletion'
import { journalHandlers } from '../../../src/local/journal/handlers'
import { replayJournal, type ReplayDeps } from '../../../src/local/journal/replay'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import type { KvTx } from '../../../src/local/kv/types'
import { readNewestSession, readSessionForOpen } from '../../../src/local/startup/stored'
import type { ReadWorker } from '../../../src/local/storedRead'
import type { Tab, World } from '../../../src/local/testing/world'
import { bindHandlers } from '../../../src/local/worker/bindHandlers'
import type { CoreDeps } from '../../../src/local/worker/core'
import { maintHandlers } from '../../../src/local/worker/maintHandlers'
import { openHandlers } from '../../../src/local/worker/openHandlers'
import { editStep, futureFixtureOperation, nativeOperation } from '../../helpers/historySteps'
import { rows, workerCore } from '../flush/harness'
import { append, beginSession, openJournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { continueIn, readOpen } from '../startup/harness'
import { widen } from '../timeline/helpers'

// Delete, Undo, the sweep and GC on the test core: a tab whose page and worker share an actor,
// with a journal store over the profile's localStorage, as `start.ts` wires them.

export const WALL = 1_792_130_500_000

export type Deleter = Awaited<ReturnType<typeof openDeleter>>

/** A tab with Delete set up over its own worker; `wall` is its clock. */
export const openDeleter = async (
    world: World,
    tab: Tab,
    storage: MemoryStorage,
    { core: coreDeps, replay }: { core?: Partial<CoreDeps>; replay?: 'fail' } = {},
) => {
    const core = workerCore(world, tab, coreDeps)
    await tab.run(() => core.start())
    const context = { core, test: true, emit: () => undefined }
    const handlers: Record<string, (arg: never) => unknown> = {
        ...maintHandlers(context),
        ...openHandlers(context, tab.waiter),
        ...bindHandlers(context),
        ...journalHandlers(context, tab.waiter),
    }
    const hooks: { before?: (method: string) => Promise<void> } = {}
    const worker: ReadWorker = {
        async call(method, arg) {
            await hooks.before?.(method)
            const handler = handlers[method]
            if (!handler) throw new Error(`No handler ${method}`)
            return tab.run(() => handler(arg as never))
        },
    }
    const store = storageJournalStore(() => storage, 'nse.')
    const replayDeps: ReplayDeps = {
        store,
        locks: tab.locks,
        appVersion: '0.6.0',
        operation: (droppedSteps) =>
            nativeOperation(
                { id: 'nse.recovery', data: { droppedSteps } },
                'Recovered last change',
            ),
        now: () => WALL,
        worker: {
            applyJournal: (batch) => worker.call('applyJournal', batch as never) as never,
            keepRecovered: (item) => worker.call('keepRecovered', item as never) as never,
        },
    }
    const clock = { wall: WALL }
    const updates = { count: 0 }
    const due: number[] = []
    const deletion = createDeletion({
        worker,
        locks: tab.locks,
        journal: store,
        replayJournal: async (sessionId) => {
            const found = (await store.read()).find((each) => each.sessionId === sessionId)
            if (!found) return
            if (replay === 'fail') return { sessionId, kind: 'failed', error: new Error('Failed') }
            return replayJournal(found, replayDeps, { held: true })
        },
        updated: () => {
            updates.count++
        },
        sweepAt: (at) => due.push(at),
        now: () => clock.wall,
    })
    return {
        tab,
        core,
        worker,
        hooks,
        clock,
        updates,
        due,
        mark: (chainId: string) => tab.run(() => deletion.markDeleted(chainId)),
        undo: (marks: Parameters<typeof deletion.undoDeleted>[0]) =>
            tab.run(() => deletion.undoDeleted(marks)),
        sweep: (minAgeMs = 0) => tab.run(() => deletion.sweepDeleted(minAgeMs)),
        remove: (request: Parameters<typeof deletion.removeLocked>[0]) =>
            tab.run(() => deletion.removeLocked(request)),
        gc: (always = true) => tab.run(() => runGc(worker, always)),
    }
}

/** Changes rows directly, as another build or a tab's stray write would. */
export const tamper = async (world: World, change: (tx: KvTx) => Promise<void>) => {
    const tab = world.tab(`tamper-${String(Math.random())}`)
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    await tab.run(() =>
        core.write(
            ['sessions', 'chains', 'entries', 'stackBlocks', 'nodes', 'chunks', 'media', 'meta'],
            change,
        ),
    )
}

/** Days of use move on, so bodies stored so far are past GC's grace period. */
export const daysPass = (world: World, days = 2) =>
    tamper(world, async (tx) => {
        const row = (await tx.get('meta', 'daysOfUse')) as { value: number }
        await writeMeta(tx, 'daysOfUse', (row.value + days) as UseDay)
        await writeMeta(tx, 'lastUseDate', '2099-01-01')
    })

/**
 * A chain of two sessions stored by a tab that then closed (killed, its locks gone), with
 * a journal of its head's last edit when `journal` is set.
 */
export const closedChain = async (world: World, storage: MemoryStorage, journal = false) => {
    const page = await openJournalPage(world, `writer-${String(Math.random())}`, storage)
    const a = stateOf(goldenChart())
    const first = beginSession(page, a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    await page.flusher.flush({ strict: true })
    const second = continueIn(page, await readOpen(page, first.id))
    const b = widen(widen(a), 1)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed BPM')) }, b)
    await page.flusher.flush({ strict: true })
    const c = widen(b, 2)
    if (journal) {
        append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Moved notes')) }, c)
        page.writer.write()
    }
    page.tab.kill()
    await world.idle()
    return { first, second, states: { a, b, c } }
}

/** Whether a load would show the chain: its head opens, or a new visit picks it. */
export const visible = async (world: World, chainId: string) => {
    const tab = world.tab(`reader-${String(Math.random())}`)
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    const chain = rows(world, 'chains').get(chainId)
    const newest = await tab.run(() =>
        core.read(['chains', 'sessions', 'entries', 'stackBlocks', 'nodes', 'meta'], (tx) =>
            readNewestSession(tx),
        ),
    )
    const head = typeof chain?.head === 'string' ? chain.head : undefined
    const read = head
        ? await tab.run(() =>
              core.read(['chains', 'sessions', 'entries', 'stackBlocks', 'nodes', 'meta'], (tx) =>
                  readSessionForOpen(tx, head),
              ),
          )
        : undefined
    return {
        opens: read?.kind === 'open',
        newest: newest.read?.chain.chainId === chainId,
    }
}

export { MemoryStorage }
