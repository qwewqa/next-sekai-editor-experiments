import assert from 'node:assert/strict'
import test from 'node:test'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import { stackMismatches, storedWindow } from '../../../src/local/timeline'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, originOperation } from '../../helpers/historySteps'
import { openPage, testId, type Page } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { replayed, storedStack, widen } from './helpers'

// The stored stack through the flush: it equals replay of the stored entries,
// within a window of at most 1,000 slots that always includes the index, and a flush rewrites
// only the blocks it touches.

const begin = (page: Page, state: State) =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })

/** Two states to alternate: a push of either is cheap through the identity memo. */
const states = () => {
    const a = stateOf(goldenChart())
    return [a, widen(a)] as const
}

/** The stored stack equals replay, and its window is the stored one. */
const assertStack = (world: World, sessionId: string) => {
    const stored = storedStack(world, sessionId)
    const expected = replayed(world, sessionId)
    assert.deepEqual(stackMismatches(stored, expected), [])
    assert.deepEqual(stored.window, storedWindow(expected.slots.length, expected.index))
    assert.deepEqual(checkStored(world.memory), [])
}

const cross = (page: Page, kind: 'undo' | 'redo', state: State | Uint8Array) => {
    const live = page.flusher.liveStack(page.flusher.session!)!
    const step = live.at(live.index + (kind === 'redo' ? 1 : 0))!.step
    page.flusher.append({ kind, step }, state, true)
}

/** A seeded run of pushes, undos and redos, as the undo stack emits them. */
const drive = (page: Page, seed: number, steps: number, [a, b]: readonly [State, State]) => {
    let random = seed
    const next = () => (random = (random * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const live = page.flusher.liveStack(page.flusher.session!)!
    let length = live.end
    let index = live.index
    for (let i = 0; i < steps; i++) {
        const roll = next()
        if (roll < 0.25 && index > 0) {
            index--
            cross(page, 'undo', index % 2 ? b : a)
        } else if (roll < 0.4 && index < length - 1) {
            index++
            cross(page, 'redo', index % 2 ? b : a)
        } else {
            index++
            length = index + 1
            page.flusher.append(
                { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) },
                index % 2 ? b : a,
                true,
            )
        }
    }
}

test('the stored stack equals replay through edits, undos, redos and dropped redo branches', async () => {
    for (const seed of [1, 2, 3]) {
        const world = createWorld({ seed })
        const page = await openPage(world, world.tab('a'))
        const pair = states()
        const session = begin(page, pair[0])
        for (let round = 0; round < 6; round++) {
            drive(page, seed * 100 + round, 40 + round * 30, pair)
            await page.flusher.flush()
            assert.deepEqual(page.errors, [])
            assertStack(world, session.id)
        }
    }
})

test('after a long undo and a push, the window is the newest 1,000 slots of the replayed stack', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openPage(world, world.tab('a'))
    const [a, b] = states()
    const session = begin(page, a)
    for (let i = 1; i < 2000; i++)
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) },
            i % 2 ? b : a,
            true,
        )
    await page.flusher.flush()
    assert.deepEqual(storedStack(world, session.id).window, {
        base: 1000,
        length: 1000,
        index: 1999,
    })
    // As far back as the tab's stack reaches: 999 undos, to slot 1,000.
    for (let i = 1998; i >= 1000; i--) cross(page, 'undo', i % 2 ? b : a)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assert.deepEqual(storedStack(world, session.id).window, {
        base: 1000,
        length: 1000,
        index: 1000,
    })
    assertStack(world, session.id)
    // A push there: the tab's stack holds 2 slots; the window is the newest 1,000 replayed slots.
    page.flusher.append({ kind: 'edit', step: editStep(futureFixtureOperation('After')) }, b, true)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assert.deepEqual(storedStack(world, session.id).window, { base: 2, length: 1000, index: 1001 })
    assertStack(world, session.id)
})

test('a 20,000-step stack’s flush rewrites only the block it touches', async () => {
    const world = createWorld({ seed: 5 })
    const page = await openPage(world, world.tab('a'))
    const [a, b] = states()
    const session = begin(page, a)
    for (let i = 1; i < 20_000; i++)
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) },
            i % 2 ? b : a,
            true,
        )
    await page.flusher.flush()
    assertStack(world, session.id)
    const blocks = () => page.reports.at(-1)?.stats.rowsByStore.stackBlocks ?? 0
    for (let i = 0; i < 5; i++) {
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation('One more')) },
            i % 2 ? a : b,
            true,
        )
        await page.flusher.flush()
        assert.equal(blocks(), 1)
    }
    cross(page, 'undo', a)
    await page.flusher.flush()
    assert.equal(blocks(), 0)
    assertStack(world, session.id)
})

test('an undo onto a slot not loaded is stored by its root, with the stack', async () => {
    const world = createWorld({ seed: 6 })
    const page = await openPage(world, world.tab('a'))
    const [a, b] = states()
    const session = begin(page, a)
    page.flusher.append({ kind: 'edit', step: editStep(futureFixtureOperation('B')) }, b, true)
    page.flusher.append({ kind: 'edit', step: editStep(futureFixtureOperation('A')) }, a, true)
    await page.flusher.flush()
    const [first, second] = replayed(world, session.id).slots
    cross(page, 'undo', second!.snapshot)
    cross(page, 'undo', a)
    cross(page, 'redo', second!.snapshot)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assertStack(world, session.id)
    assert.equal(replayed(world, session.id).index, 1)
    assert.ok(first)
})
