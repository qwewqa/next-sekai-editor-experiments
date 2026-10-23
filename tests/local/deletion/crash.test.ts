import assert from 'node:assert/strict'
import test from 'node:test'
import { checkStored } from '../../../src/local/testing/invariants'
import { crashSweep } from '../../../src/local/testing/sweep'
import type { World } from '../../../src/local/testing/world'
import { rows } from '../flush/harness'
import { closedChain, daysPass, MemoryStorage, openDeleter, visible } from './harness'

// Delete → sweep → GC killed at every await (deletion design §3.3's table): the next load's sweep
// and GC leave whole data, and the chain is either back unmarked or gone, never half-deleted.

type Setup = { storage: MemoryStorage; deleted: string; kept: string }

const setups = new WeakMap<World, Setup>()

test('a kill anywhere in Delete, the sweep or GC leaves a chain whole or gone, and the next load finishes it', async () => {
    const result = await crashSweep({
        seeds: [1, 2],
        checks: { lock: true, transitions: true },
        setup: async (world) => {
            const storage = new MemoryStorage()
            // Two chains of the same chart: the one kept shares every body with the one deleted.
            const deleted = await closedChain(world, storage)
            const kept = await closedChain(world, storage)
            await daysPass(world)
            setups.set(world, {
                storage,
                deleted: deleted.first.chainId,
                kept: kept.first.chainId,
            })
        },
        scenario: async ({ world, victim }) => {
            const { storage, deleted } = setups.get(world)!
            const deleter = await openDeleter(world, victim, storage)
            await deleter.mark(deleted)
            await deleter.sweep()
        },
        recover: async ({ world }) => {
            const { storage } = setups.get(world)!
            const next = await openDeleter(world, world.tab('next'), storage)
            await next.sweep()
            assert.equal((await next.gc()).kind, 'done')
        },
        check: async ({ world, killedAt }) => {
            const { deleted, kept } = setups.get(world)!
            const at = `killed at ${String(killedAt)}`
            assert.deepEqual(checkStored(world.memory), [], at)
            const chain = rows(world, 'chains').get(deleted)
            const sessions = [...rows(world, 'sessions').values()].filter(
                (row) => row.chainId === deleted,
            )
            if (chain) {
                assert.equal(chain.deleting, undefined, at)
                assert.equal(sessions.length, 2, at)
                assert.equal((await visible(world, deleted)).opens, true, at)
            } else assert.deepEqual(sessions, [], at)
            assert.equal((await visible(world, kept)).opens, true, at)
        },
    })
    assert.ok(result.every(({ points }) => points > 10))
})
