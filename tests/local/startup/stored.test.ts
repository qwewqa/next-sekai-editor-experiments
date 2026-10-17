import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../../src/local/hash'
import { createWorld, type World } from '../../../src/local/testing/world'
import { openPage, rows, workerCore } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { replayed, widen } from '../timeline/helpers'
import { beginIn, handlersOf } from './harness'

// Reading a stored session to open it (§1.4.2, §1.6.4 #6): its row, chain and stack in one read;
// a removed or deleted session, or one this build can't read, is never opened; a missing stack is
// rebuilt by replay; the most recent session skips what can't be opened.

/** Two stored sessions in two chains, the second newer. */
const twoChains = async (world: World) => {
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const older = beginIn(page, a)
    page.flusher.append('edit', () => 'Edit', widen(a), true)
    await page.flusher.flush()
    const newer = beginIn(page, widen(a, 1))
    page.flusher.append('edit', () => 'Edit', widen(a, 2), true)
    await page.flusher.flush()
    return { page, older, newer }
}

/** Changes rows directly, as another build or tab would. */
const tamper = async (
    world: World,
    change: (tx: import('../../../src/local/kv/types').KvTx) => Promise<void>,
) => {
    const tab = world.tab('tamper')
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    await tab.run(() => core.write(['sessions', 'chains', 'entries', 'tombstones'], change))
}

test('a stored session reads with its chain, its stack and its head', async () => {
    const world = createWorld({ seed: 1 })
    const { page, newer } = await twoChains(world)
    const read = await page.tab.run(() => handlersOf(page).readSession(newer.id))
    assert.equal(read.kind, 'open')
    if (read.kind !== 'open') return
    assert.equal(read.isHead, true)
    assert.equal(read.chain.chainId, newer.chainId)
    assert.deepEqual(read.stack.window, { base: 0, length: 2, index: 1 })
    assert.equal(read.stack.blocks.length, 1)
    const stack = replayed(world, newer.id)
    assert.equal(toHex(read.head), toHex(stack.slots[1]!.snapshot))
})

test('missing, removed, deleting and newer sessions are never opened', async () => {
    const world = createWorld({ seed: 2 })
    const { page, older, newer } = await twoChains(world)
    const read = (id: string) => page.tab.run(() => handlersOf(page).readSession(id))
    assert.equal((await read('nobody')).kind, 'missing')
    await tamper(world, async (tx) => {
        await tx.put('tombstones', {
            id: older.id,
            kind: 'session',
            removedAt: 1,
            chainId: older.chainId,
        })
    })
    assert.equal((await read(older.id)).kind, 'deleted')
    await tamper(world, async (tx) => {
        const chain = (await tx.get('chains', newer.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...chain, deleting: { at: 1 } })
    })
    assert.equal((await read(newer.id)).kind, 'deleted')
    await tamper(world, async (tx) => {
        const chain = (await tx.get('chains', newer.chainId)) as Record<string, unknown>
        const { deleting: _, ...rest } = chain
        await tx.put('chains', rest)
        const session = (await tx.get('sessions', newer.id)) as Record<string, unknown>
        await tx.put('sessions', { ...session, v: 2 })
    })
    assert.equal((await read(newer.id)).kind, 'later')
})

test('a session without a stored stack has it rebuilt by replay', async () => {
    const world = createWorld({ seed: 3 })
    const { page, newer } = await twoChains(world)
    await tamper(world, async (tx) => {
        const session = (await tx.get('sessions', newer.id)) as Record<string, unknown>
        const { stack: _, ...rest } = session
        await tx.put('sessions', rest)
    })
    const read = await page.tab.run(() => handlersOf(page).readSession(newer.id))
    assert.equal(read.kind, 'open')
    if (read.kind !== 'open') return
    assert.deepEqual(read.stack.window, { base: 0, length: 2, index: 1 })
    assert.deepEqual(read.stack.blocks, [])
})

test('the most recent session skips chains being deleted and chains this build can’t read', async () => {
    const world = createWorld({ seed: 4 })
    const { page, older, newer } = await twoChains(world)
    const newest = () => page.tab.run(() => handlersOf(page).readNewestSession())
    assert.equal((await newest())?.session.id, newer.id)
    await tamper(world, async (tx) => {
        const entry = (await tx.get('entries', [newer.id, 2])) as Record<string, unknown>
        await tx.put('entries', { ...entry, kind: 'futureKind' })
    })
    assert.equal((await newest())?.session.id, older.id)
    await tamper(world, async (tx) => {
        const chain = (await tx.get('chains', older.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...chain, deleting: { at: 1 } })
    })
    assert.equal(await newest(), undefined)
    assert.equal(rows(world, 'chains').size, 2)
})
