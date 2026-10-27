import assert from 'node:assert/strict'
import test from 'node:test'
import { captureStep, createRecoveryContext } from '../../../src/history/operations'
import { hashKey } from '../../../src/local/db'
import { toHex } from '../../../src/local/hash'
import { createWorld, type World } from '../../../src/local/testing/world'
import { editStep, futureFixtureOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { openPage, rows, workerCore } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { replayed, widen } from '../timeline/helpers'
import { beginIn, continueIn, handlersOf, readOpen } from './harness'

// Reading a stored session to open it: its row, chain and stack in one read;
// a removed or deleted session, or one this build can't read, is never opened; a missing stack is
// rebuilt by replay; the most recent session skips what can't be opened.

/** Two stored sessions in two chains, the second newer. */
const twoChains = async (world: World) => {
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const older = beginIn(page, a)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(a),
        true,
    )
    await page.flusher.flush()
    const newer = beginIn(page, widen(a, 1))
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(a, 2),
        true,
    )
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
    await tab.run(() => core.write(['sessions', 'chains', 'entries'], change))
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

test('missing, deleting and newer sessions are never opened', async () => {
    const world = createWorld({ seed: 2 })
    const { page, newer } = await twoChains(world)
    const read = (id: string) => page.tab.run(() => handlersOf(page).readSession(id))
    assert.equal((await read('nobody')).kind, 'missing')
    await tamper(world, async (tx) => {
        const chain = (await tx.get('chains', newer.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...chain, deleting: { at: 1 } })
    })
    assert.equal((await read(newer.id)).kind, 'deleted')
    await tamper(world, async (tx) => {
        const chain = (await tx.get('chains', newer.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...chain, deleting: undefined })
        const session = (await tx.get('sessions', newer.id)) as Record<string, unknown>
        await tx.put('sessions', { ...session, v: 3 })
    })
    assert.equal((await read(newer.id)).kind, 'later')
})

test('a session without a stored stack has it rebuilt by replay', async () => {
    const world = createWorld({ seed: 3 })
    const { page, newer } = await twoChains(world)
    await tamper(world, async (tx) => {
        const session = (await tx.get('sessions', newer.id)) as Record<string, unknown>
        const rest = { ...session }
        Reflect.deleteProperty(rest, 'stack')
        await tx.put('sessions', rest)
    })
    const read = await page.tab.run(() => handlersOf(page).readSession(newer.id))
    assert.equal(read.kind, 'open')
    if (read.kind !== 'open') return
    assert.deepEqual(read.stack.window, { base: 0, length: 2, index: 1 })
    assert.deepEqual(read.stack.blocks, [])
})

test("the most recent session skips chains being deleted and chains this build can't read", async () => {
    const world = createWorld({ seed: 4 })
    const { page, older, newer } = await twoChains(world)
    const newest = () => page.tab.run(() => handlersOf(page).readNewestSession(undefined))
    assert.equal((await newest()).read?.session.id, newer.id)
    // A newer build's entry.
    await tamper(world, async (tx) => {
        const entry = (await tx.get('entries', [newer.id, 2])) as Record<string, unknown>
        await tx.put('entries', { ...entry, kind: 'futureKind' })
    })
    assert.deepEqual(
        { id: (await newest()).read?.session.id, skipped: (await newest()).skipped },
        { id: older.id, skipped: 'later' },
    )
    await tamper(world, async (tx) => {
        const chain = (await tx.get('chains', older.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...chain, deleting: { at: 1 } })
    })
    assert.deepEqual(await newest(), { skipped: 'later' })
    assert.equal(rows(world, 'chains').size, 2)
})

test("a continuation's missing stack is rebuilt over its parent's stored one, not the whole chain's replay", async () => {
    const world = createWorld({ seed: 5 })
    const { page, newer } = await twoChains(world)
    const read = await readOpen(page, newer.id)
    const continuation = continueIn(page, read)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Again')) },
        widen(stateOf(goldenChart()), 5),
        true,
    )
    await page.flusher.flush()
    await tamper(world, async (tx) => {
        const session = (await tx.get('sessions', continuation.id)) as Record<string, unknown>
        const rest = { ...session }
        Reflect.deleteProperty(rest, 'stack')
        await tx.put('sessions', rest)
        // The parent's own entries can't be replayed: only its stored stack is read.
        const first = (await tx.get('entries', [newer.id, 1])) as Record<string, unknown>
        await tx.put('entries', { ...first, kind: 'edit' })
    })
    const rebuilt = await page.tab.run(() => handlersOf(page).readSession(continuation.id))
    assert.equal(rebuilt.kind, 'open')
    if (rebuilt.kind !== 'open') return
    assert.deepEqual(rebuilt.stack.window, { base: 0, length: 3, index: 2 })
})

test('a stack rebuilt over a stored parent that a later entry cuts below its window falls back to the whole replay', async () => {
    const world = createWorld({ seed: 6 })
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const b = widen(a)
    const parent = beginIn(page, a)
    // Over 1,000 slots: the parent's stored window starts above slot 0.
    for (let i = 1; i < 1_200; i++)
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) },
            i % 2 ? b : a,
            true,
        )
    await page.flusher.flush()
    const read = await readOpen(page, parent.id)
    assert.ok(read.stack.window.base > 0)
    const continuation = continueIn(page, read)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(a, 2),
        true,
    )
    await page.flusher.flush()
    // A journal applied with an unmatched stack keeps no slot; then the stack is lost.
    await tamper(world, async (tx) => {
        const session = (await tx.get('sessions', continuation.id)) as Record<string, unknown>
        const seq = (session.lastSeq as number) + 1
        await tx.put('entries', {
            sessionId: continuation.id,
            seq,
            time: 1,
            day: 0,
            kind: 'recovered',
            operation: futureFixtureOperation('collapsed-recovery'),
            recoveryContext: createRecoveryContext(read.stack.slots.at(-1)!.step, [], 0),
            snapshot: read.head,
            noteCount: 0,
            dirty: true,
            kept: true,
            stack: {
                keep: 0,
                push: [
                    {
                        snapshot: read.head,
                        step: captureStep({
                            kind: 'edit',
                            operation: futureFixtureOperation('collapsed-recovery'),
                            recoveryContext: createRecoveryContext(
                                read.stack.slots.at(-1)!.step,
                                [],
                                0,
                            ),
                        }),
                    },
                ],
                index: 0,
            },
        })
        const rest: Record<string, unknown> = { ...session, lastSeq: seq }
        Reflect.deleteProperty(rest, 'stack')
        await tx.put('sessions', rest)
    })
    const rebuilt = await page.tab.run(() => handlersOf(page).readSession(continuation.id))
    assert.equal(rebuilt.kind, 'open')
    if (rebuilt.kind !== 'open') return
    assert.deepEqual(rebuilt.stack.window, { base: 0, length: 1, index: 0 })
})

// Versions: a newer build's data is "Needs a newer version", never damaged; a
// malformed version is not newer, and is not read either.

const tamperNodes = async (
    world: World,
    change: (tx: import('../../../src/local/kv/types').KvTx) => Promise<void>,
) => {
    const tab = world.tab('tamper-nodes')
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    await tab.run(() => core.write(['sessions', 'nodes'], change))
}

test('a head root a newer build wrote reads as later, a malformed one as damaged', async () => {
    const world = createWorld({ seed: 21 })
    const { page, newer } = await twoChains(world)
    const read = (id: string) => page.tab.run(() => handlersOf(page).readSession(id))
    const opened = await read(newer.id)
    assert.equal(opened.kind, 'open')
    if (opened.kind !== 'open') return
    const key = hashKey(opened.head)
    const setV = (v: unknown) =>
        tamperNodes(world, async (tx) => {
            const row = (await tx.get('nodes', key)) as Record<string, unknown>
            await tx.put('nodes', { ...row, v }, key)
        })
    await setV(2)
    assert.deepEqual(await read(newer.id), { kind: 'later', why: 'its head needs a newer version' })
    await setV(99)
    assert.equal((await read(newer.id)).kind, 'later')
    for (const v of [0, -1, 1.5, '1', undefined]) {
        await setV(v)
        assert.equal((await read(newer.id)).kind, 'damaged', String(v))
    }
    await setV(1)
    assert.equal((await read(newer.id)).kind, 'open')
})

test('a session of a malformed version is damaged, only a newer one later', async () => {
    const world = createWorld({ seed: 22 })
    const { page, newer } = await twoChains(world)
    const read = (id: string) => page.tab.run(() => handlersOf(page).readSession(id))
    const setV = (v: unknown) =>
        tamper(world, async (tx) => {
            const session = (await tx.get('sessions', newer.id)) as Record<string, unknown>
            await tx.put('sessions', { ...session, v })
        })
    for (const [v, kind] of [
        [0, 'damaged'],
        [undefined, 'damaged'],
        ['1', 'damaged'],
        [2, 'later'],
        [3, 'later'],
        [100, 'later'],
        [1, 'open'],
    ] as const) {
        await setV(v)
        assert.equal((await read(newer.id)).kind, kind, String(v))
    }
})

test('a newer session anywhere in a chain makes the whole chain newer; a malformed one, damaged', async () => {
    const world = createWorld({ seed: 23 })
    const { page, newer } = await twoChains(world)
    const read = (id: string) => page.tab.run(() => handlersOf(page).readSession(id))
    const child = continueIn(page, await readOpen(page, newer.id))
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(stateOf(goldenChart()), 5),
        true,
    )
    await page.flusher.flush()
    const setV = (v: unknown) =>
        tamper(world, async (tx) => {
            const session = (await tx.get('sessions', child.id)) as Record<string, unknown>
            await tx.put('sessions', { ...session, v })
        })
    await setV(3)
    assert.equal((await read(newer.id)).kind, 'later')
    assert.equal((await read(child.id)).kind, 'later')
    await setV(0)
    assert.equal((await read(newer.id)).kind, 'damaged')
    await setV(1)
    assert.equal((await read(newer.id)).kind, 'open')
})

/** Sessions of `newer`'s chain, each continuing the one before with no stack or entries of its own. */
const continuations = async (
    world: World,
    from: { id: string; chainId: string },
    count: number,
    cycle = false,
) => {
    const ids = Array.from({ length: count }, (_, i) => `link-${i}`)
    await tamper(world, async (tx) => {
        const base = (await tx.get('sessions', from.id)) as Record<string, unknown>
        for (const [i, id] of ids.entries()) {
            const rest = { ...base, id }
            Reflect.deleteProperty(rest, 'stack')
            const parent = i === 0 ? (cycle ? ids.at(-1)! : from.id) : ids[i - 1]!
            await tx.put('sessions', { ...rest, parent: { id: parent, uptoSeq: base.lastSeq } })
        }
    })
    return ids
}

test('a stack is rebuilt over a chain of more than 256 parent links', async () => {
    const world = createWorld({ seed: 7 })
    const { page, newer } = await twoChains(world)
    const ids = await continuations(world, newer, 300)
    const read = await page.tab.run(() => handlersOf(page).readSession(ids.at(-1)!))
    assert.equal(read.kind, 'open')
    if (read.kind !== 'open') return
    assert.deepEqual(read.stack.window, { base: 0, length: 2, index: 1 })
})

test('a cycle of parent links is damaged, not followed for ever', async () => {
    const world = createWorld({ seed: 8 })
    const { page, newer } = await twoChains(world)
    const ids = await continuations(world, newer, 5, true)
    const read = await page.tab.run(() => handlersOf(page).readSession(ids[2]!))
    assert.equal(read.kind, 'damaged')
    if (read.kind !== 'damaged') return
    assert.match(read.why, /Parent cycle/)
})
