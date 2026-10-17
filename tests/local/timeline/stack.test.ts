import assert from 'node:assert/strict'
import test from 'node:test'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import { stackMismatches, storedWindow } from '../../../src/local/timeline'
import type { State } from '../../../src/state'
import { openPage, testId, type Page } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { replayed, storedStack, widen } from './helpers'

// The stored stack through the flush (Step 3b's exit): it equals replay of the stored entries,
// within a window of at most 5,000 slots that always includes the index, and a flush rewrites
// only the blocks it touches.

const begin = (page: Page, state: State) =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state,
        label: () => 'Initialize',
        dirty: false,
    })

/** Two states to alternate: a push of either is cheap through the identity memo. */
const states = () => {
    const a = stateOf(goldenChart())
    return [a, widen(a)] as const
}

/** The stored stack equals replay, and its window is the one §1.6.4 #6 gives. */
const assertStack = (world: World, sessionId: string) => {
    const stored = storedStack(world, sessionId)
    const expected = replayed(world, sessionId)
    assert.deepEqual(stackMismatches(stored, expected), [])
    assert.deepEqual(stored.window, storedWindow(expected.slots.length, expected.index))
    assert.deepEqual(checkStored(world.memory), [])
}

/** A seeded run of pushes, undos and redos, as the undo stack emits them. */
const drive = (page: Page, seed: number, steps: number, [a, b]: readonly [State, State]) => {
    let random = seed
    const next = () => (random = (random * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    let length = 1
    let index = 0
    for (let i = 0; i < steps; i++) {
        const roll = next()
        if (roll < 0.25 && index > 0) {
            index--
            page.flusher.append('undo', () => 'Undo', index % 2 ? b : a, true)
        } else if (roll < 0.4 && index < length - 1) {
            index++
            page.flusher.append('redo', () => 'Redo', index % 2 ? b : a, true)
        } else {
            index++
            length = index + 1
            page.flusher.append('edit', () => `Edit ${i}`, index % 2 ? b : a, true)
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

test('an 8,000-slot stack with the index at 1,000 stores slots 0–4,999', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openPage(world, world.tab('a'))
    const [a, b] = states()
    const session = begin(page, a)
    for (let i = 1; i < 8000; i++)
        page.flusher.append('edit', () => `Edit ${i}`, i % 2 ? b : a, true)
    await page.flusher.flush()
    assert.deepEqual(storedStack(world, session.id).window, {
        base: 3000,
        length: 5000,
        index: 7999,
    })
    for (let i = 7998; i >= 1000; i--)
        page.flusher.append('undo', () => 'Undo', i % 2 ? b : a, true)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assert.deepEqual(storedStack(world, session.id).window, { base: 0, length: 5000, index: 1000 })
    assertStack(world, session.id)
})

test('a 20,000-step stack’s flush rewrites only the block it touches', async () => {
    const world = createWorld({ seed: 5 })
    const page = await openPage(world, world.tab('a'))
    const [a, b] = states()
    const session = begin(page, a)
    for (let i = 1; i < 20_000; i++)
        page.flusher.append('edit', () => `Edit ${i}`, i % 2 ? b : a, true)
    await page.flusher.flush()
    assertStack(world, session.id)
    const blocks = () => page.reports.at(-1)?.stats.rowsByStore.stackBlocks ?? 0
    for (let i = 0; i < 5; i++) {
        page.flusher.append('edit', () => 'One more', i % 2 ? a : b, true)
        await page.flusher.flush()
        assert.equal(blocks(), 1)
    }
    page.flusher.append('undo', () => 'Undo', a, true)
    await page.flusher.flush()
    assert.equal(blocks(), 0)
    assertStack(world, session.id)
})
