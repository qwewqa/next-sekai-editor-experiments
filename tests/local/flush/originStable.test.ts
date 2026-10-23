import assert from 'node:assert/strict'
import test from 'node:test'
import { DB_VERSION } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { MemoryStorage } from '../../../src/local/journal/store'
import type { KvTx } from '../../../src/local/kv/types'
import { executePlan, planNxsp } from '../../../src/local/nxsp'
import type { OpenStoreRequest } from '../../../src/local/open/importWrite'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { ORIGIN_RULE, readOrigin } from '../../../src/local/records/unknownValues'
import { BIND_STORES, recordOwnSave } from '../../../src/local/save/bind'
import { stateBatch } from '../../../src/local/stateBatch'
import { createWorld, type World } from '../../../src/local/testing/world'
import { StorageCore } from '../../../src/local/worker/core'
import { openHandlers } from '../../../src/local/worker/openHandlers'
import type { State } from '../../../src/state'
import {
    editStep,
    futureFixtureOperation,
    nativeOperation,
    originOperation,
} from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import {
    append,
    beginSession,
    openJournalPage,
    openSplitJournalPage,
    replayAll,
} from '../journal/harness'
import { fresh } from '../nxsp/chain'
import { goldenChart, stateOf } from '../records/charts'
import { beginIn, continueIn, readOpen } from '../startup/harness'
import { widen } from '../timeline/helpers'
import { openPage, rows, workerCore } from './harness'

// P0 and P3 of spec-C invariant 10: a session's `origin` is set when it is created and never changes,
// and rows copied from a file are written only in sessions of a `file` origin. Go To's binary
// search is exact only under them. Every transaction of every worker in a run is checked as it
// writes: a `put` of an existing session row keeps its origin, and while an open copies a file's
// rows, only into a session whose origin `ORIGIN_RULE` calls `file`. The runs go through every
// writer that rewrites a session row: a flush (`updated`), a journal apply, Try Again's move
// (`copyIntoStorage`), the open's head and batches (`writeOpenHead`, `writeBatch`, `endImport`, an
// abandon) and a Save's recording (`recordOwnSave`, `bind.ts`).

type Seen = { created: Map<string, unknown>; puts: number; violations: string[] }

/** Patches every core's `write` so a transaction's `put` of a session row is judged. */
const guarded = async (run: (seen: Seen, copying: { on: boolean }) => Promise<void>) => {
    const seen: Seen = { created: new Map(), puts: 0, violations: [] }
    const copying = { on: false }
    const original = StorageCore.prototype.write
    const guard = (tx: KvTx): KvTx =>
        new Proxy(tx, {
            get: (target, key) => {
                const value = Reflect.get(target, key) as unknown
                if (typeof value !== 'function') return value
                if (key !== 'put') return (value as (...a: unknown[]) => unknown).bind(target)
                return async (store: string, row: Record<string, unknown>, ...rest: unknown[]) => {
                    if (store === 'sessions' && typeof row.id === 'string') {
                        seen.puts++
                        const before = (await target.get('sessions', row.id)) as
                            Record<string, unknown> | undefined
                        if (before && before.origin !== row.origin)
                            seen.violations.push(
                                `session ${row.id}: origin ${String(before.origin)} became ${String(row.origin)}`,
                            )
                        if (!seen.created.has(row.id)) seen.created.set(row.id, row.origin)
                        else if (seen.created.get(row.id) !== row.origin)
                            seen.violations.push(
                                `session ${row.id}: origin changed from its first write`,
                            )
                        // P3: while an open copies a file's rows, the session is a file's.
                        if (copying.on) {
                            const origin = readOrigin(row.origin)
                            if (!origin || ORIGIN_RULE[origin] !== 'file')
                                seen.violations.push(
                                    `session ${row.id}: rows copied from a file into origin ${String(row.origin)}`,
                                )
                        }
                    }
                    if (store === 'entries' && copying.on && typeof row.sessionId === 'string') {
                        const session = (await target.get('sessions', row.sessionId)) as
                            Record<string, unknown> | undefined
                        const origin = readOrigin(session?.origin)
                        if (session && (!origin || ORIGIN_RULE[origin] !== 'file'))
                            seen.violations.push(
                                `entry ${row.sessionId}:${String(row.seq)}: copied into origin ${String(session.origin)}`,
                            )
                    }
                    return (value as (...a: unknown[]) => unknown).apply(target, [
                        store,
                        row,
                        ...rest,
                    ])
                }
            },
        })
    StorageCore.prototype.write = function patched(this: StorageCore, stores, fn, options) {
        return original.call(this, stores, (tx: KvTx) => fn(guard(tx)), options)
    } as typeof original
    try {
        await run(seen, copying)
    } finally {
        StorageCore.prototype.write = original
    }
    return seen
}

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

const originsOf = (world: World) =>
    new Map([...rows(world, 'sessions').entries()].map(([id, row]) => [id, row.origin]))

test('a flush, a continuation, a fork and a Save’s recording keep every session’s origin', async () => {
    const seen = await guarded(async () => {
        const world = createWorld({ seed: 51 })
        const page = await openPage(world, world.tab('a'))
        let state = stateOf(goldenChart())
        const created = beginIn(page, state, 'new')
        await page.flusher.flush({ strict: true })
        for (let i = 0; i < 3; i++) {
            state = widen(state, i)
            page.flusher.append(
                { kind: 'edit', step: editStep(futureFixtureOperation(`E${i}`)) },
                state,
                true,
            )
            await page.flusher.flush({ strict: i % 2 === 0 })
        }
        // recordOwnSave writes the chain record and no session (`bind.ts`).
        const unit = {
            docId: 'doc',
            revision: { id: 'rev-1', n: 1, ancestors: [] },
            file: {
                name: 'coconut.nxsp',
                event: 'saved',
                at: 5,
                hash: fromHex16(rootOf(state)),
                options: { history: true, bgm: true },
            },
            marks: [],
            from: {},
        }
        assert.equal(
            await page.core.write(
                BIND_STORES,
                (tx) =>
                    recordOwnSave(tx, {
                        chainId: created.chainId,
                        writer: { sessionId: created.id },
                        unit,
                    }),
                { durability: 'strict' },
            ),
            'recorded',
        )
        const next = await openPage(world, world.tab('b'))
        const read = await readOpen(next, created.id)
        continueIn(next, read)
        state = widen(state, 4)
        next.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation('C')) },
            state,
            true,
        )
        await next.flusher.flush({ strict: true })
        const third = await openPage(world, world.tab('c'))
        const forkRead = await readOpen(third, created.id)
        continueIn(third, forkRead, { asFork: true })
        third.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation('F')) },
            widen(state, 5),
            true,
        )
        await third.flusher.flush({ strict: true })
        assert.deepEqual([...originsOf(world).values()].sort(), ['continued', 'continued', 'new'])
        assert.equal(rows(world, 'entries').size >= 8, true)
    })
    assert.deepEqual(seen.violations, [])
    assert.ok(seen.puts >= 5, `${seen.puts} session writes judged`)
})

test('a journal apply and a recovery session keep their origins', async () => {
    const seen = await guarded(async () => {
        const world = createWorld({ seed: 52 })
        const storage = new MemoryStorage()
        const page = await openJournalPage(world, 'a', storage)
        const a = stateOf(goldenChart())
        const session = beginSession(page, a)
        await page.flusher.flush({ strict: true })
        append(page, { kind: 'edit', step: editStep(futureFixtureOperation('X')) }, widen(a))
        assert.equal(page.writer.write(), true)
        page.tab.kill()
        const applied = await replayAll(world, storage)
        assert.equal(applied.outcomes[0]?.kind, 'applied')
        assert.equal(originsOf(world).get(session.id), 'import')

        // A second tab's journal for a chain marked for Delete meanwhile: a recovery session.
        const second = await openJournalPage(world, 'b', storage)
        const other = beginSession(second, stateOf(goldenChart()))
        await second.flusher.flush({ strict: true })
        append(second, { kind: 'edit', step: editStep(futureFixtureOperation('Y')) }, widen(a, 2))
        assert.equal(second.writer.write(), true)
        second.tab.kill()
        const sweeper = world.tab('sweeper')
        const core = workerCore(world, sweeper)
        await sweeper.run(() => core.start())
        await sweeper.run(() =>
            core.write(['chains'], async (tx) => {
                const chain = (await tx.get('chains', other.chainId)) as Record<string, unknown>
                await tx.put('chains', { ...chain, deleting: { at: 1 } })
            }),
        )
        const recovered = await replayAll(world, storage, 'next2')
        assert.ok(recovered.outcomes.some((outcome) => outcome.kind === 'recovery'))
        assert.ok([...originsOf(world).values()].includes('journal'))
    })
    assert.deepEqual(seen.violations, [])
    assert.ok(seen.puts >= 3, `${seen.puts} session writes judged`)
})

test('an open’s head, its batches, an ended import and an abandoned one: a file’s rows, only in a file’s session', async () => {
    const ids = (n: number) => ({
        chainId: `chain-${n}`,
        sessionId: `session-${n}`,
        docId: 'doc',
        lineageId: 'lineage',
    })
    const request = (
        id: string,
        n: number,
        extra: Partial<OpenStoreRequest>,
    ): OpenStoreRequest => ({
        id,
        ids: ids(n),
        chain: {
            name: 'Coconut (Master)',
            file: { name: 'coconut.nxsp', event: 'opened', options: { history: true, bgm: true } },
        },
        operations: {
            opened: originOperation('import'),
            changedOutside: nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Changed outside the editor',
            ),
        },
        wall: 2_000_000,
        appVersion: '0.6.0',
        ...extra,
    })
    const seen = await guarded(async (_, copying) => {
        const world = createWorld({ seed: 53 })
        const page = await openPage(world, world.tab('a'))
        const open = openHandlers(
            { core: page.core, test: true, emit: () => undefined },
            page.tab.waiter,
        )
        const run = <T>(fn: () => Promise<T>) => page.tab.run(fn)
        const file = await executePlan(planNxsp(fresh().input).plan, new Map())
        const level = stateBatch(widen(stateOf(goldenChart()), 3))
        const variants: [string, Partial<OpenStoreRequest>][] = [
            ['nxsp', {}],
            ['nxsp', { level }],
            ['replaced', { origin: 'replaced' }],
            ['replaced', { origin: 'replaced', level }],
        ]
        for (const [i, [origin, extra]] of variants.entries()) {
            const reply = await run(() => open.openRead(file))
            if (reply.kind !== 'nxsp') throw new Error('not nxsp')
            copying.on = true
            const stored = await run(() => open.openStore(request(reply.id, i, extra)))
            if (stored.kind !== 'stored') throw new Error('not stored')
            // The last variant stops after its first batch, then is abandoned.
            const last = i === variants.length - 1
            const batches = last ? 1 : (stored.batches ?? 0)
            for (let n = 0; n < batches; n++) await run(() => open.openBatch({ id: reply.id, n }))
            if (last) assert.equal(await run(() => open.openAbandon(ids(i).sessionId)), true)
            copying.on = false
            assert.equal(originsOf(world).get(ids(i).sessionId), origin)
        }
        // The page edits an opened session: its own rows, no file's, so the check is off.
        const tab = await openPage(world, world.tab('b'))
        const read = await readOpen(tab, ids(0).sessionId)
        const { resumeIn } = await import('../startup/harness')
        resumeIn(tab, read)
        tab.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation('Own')) },
            widen(stateOf(goldenChart()), 6),
            true,
        )
        await tab.flusher.flush({ strict: true })
        assert.equal(originsOf(world).get(ids(0).sessionId), 'nxsp')
    })
    assert.deepEqual(seen.violations, [])
    assert.ok(seen.puts >= 8, `${seen.puts} session writes judged`)
})

test('Try Again’s move into the database keeps the origin of every session it copies', async () => {
    const seen = await guarded(async () => {
        const world = createWorld({ seed: 54 })
        const frozen = world.tab('frozen')
        const frozenCore = workerCore(world, frozen, { flags: { ignoreVersionChange: true } })
        await frozen.run(() => frozenCore.start())
        // A newer tab behind the frozen current one runs in memory.
        const opening = openSplitJournalPage(world, { flags: { dbVersion: DB_VERSION + 1 } })
        await world.clock.run()
        const page = await opening
        assert.deepEqual(page.status, { mode: 'memory', reason: 'olderTabs' })
        let state = stateOf(goldenChart())
        const session = beginSession(page, state)
        await page.flusher.flush()
        state = widen(state)
        append(page, { kind: 'edit', step: editStep(futureFixtureOperation('M')) }, state)
        await page.flusher.flush()
        frozen.kill()
        await world.idle()
        const trying = page.host.call((_, core) => core.tryAgain())
        await world.clock.run()
        await world.idle()
        assert.deepEqual(await trying, { mode: 'stored' })
        assert.equal(originsOf(world).get(session.id), 'import')
        assert.equal(rows(world, 'entries').size, 2)
    })
    assert.deepEqual(seen.violations, [])
})

test('the guard names an origin that changes and a file’s rows in a session of its own', async () => {
    const seen = await guarded(async (_, copying) => {
        const world = createWorld({ seed: 55 })
        const page = await openPage(world, world.tab('a'))
        const first = stateOf(goldenChart())
        const created = beginIn(page, first, 'new')
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation('W')) },
            widen(first),
            true,
        )
        await page.flusher.flush({ strict: true })
        await page.tab.run(() =>
            page.core.write(['sessions'], async (tx) => {
                const row = (await tx.get('sessions', created.id)) as Record<string, unknown>
                await tx.put('sessions', { ...row, origin: 'nxsp' })
            }),
        )
        copying.on = true
        await page.tab.run(() =>
            page.core.write(['sessions', 'entries'], async (tx) => {
                const row = (await tx.get('sessions', created.id)) as Record<string, unknown>
                await tx.put('sessions', { ...row, origin: 'new' })
                await tx.put('entries', {
                    sessionId: created.id,
                    seq: 99,
                    time: 1,
                    kind: 'edit',
                    step: editStep(futureFixtureOperation('Z')),
                    snapshot: new Uint8Array(32),
                })
            }),
        )
        copying.on = false
    })
    assert.equal(seen.violations.length >= 3, true)
    assert.match(seen.violations.join('\n'), /origin new became nxsp/)
    assert.match(seen.violations.join('\n'), /rows copied from a file into origin new/)
    assert.match(seen.violations.join('\n'), /copied into origin new/)
})
