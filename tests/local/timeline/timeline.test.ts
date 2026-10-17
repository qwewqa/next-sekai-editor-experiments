import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BLOCK_SLOTS,
    blockRow,
    chainFlagsAtCreation,
    replay,
    ReplayError,
    SessionStack,
    STACK_CAP,
    stackMismatches,
    storedSlots,
    storedWindow,
    type ModelSlot,
    type ReplayEntry,
} from '../../../src/local/timeline'

// The stack's pure rules (§1.3.9, §1.6.4 #6): the stored window, replay, and which blocks a flush
// rewrites.

const hash = (n: number) => {
    const bytes = new Uint8Array(16)
    new DataView(bytes.buffer).setUint32(0, n)
    return bytes
}

let seq = 0
const entry = (kind: string, n: number, extra: Partial<ReplayEntry> = {}): ReplayEntry => ({
    seq: ++seq,
    kind,
    label: `${kind} ${n}`,
    snapshot: hash(n),
    ...extra,
})

test('the stored window is the newest 5,000 slots, or the 5,000 that keep the index', () => {
    assert.deepEqual(storedWindow(10, 9), { base: 0, length: 10, index: 9 })
    assert.deepEqual(storedWindow(5000, 0), { base: 0, length: 5000, index: 0 })
    assert.deepEqual(storedWindow(20_000, 19_999), { base: 15_000, length: 5000, index: 19_999 })
    // An 8,000-slot stack with the index at 1,000 stores slots 0–4,999.
    assert.deepEqual(storedWindow(8000, 1000), { base: 0, length: 5000, index: 1000 })
    // Below the newest 5,000 and past 5,000: the window ends at the index.
    assert.deepEqual(storedWindow(20_000, 6000), { base: 1001, length: 5000, index: 6000 })
    // A restored stack's own base is a floor.
    assert.deepEqual(storedWindow(9000, 3500, 3000), { base: 3000, length: 5000, index: 3500 })
    for (const [length, index] of [
        [1, 0],
        [5001, 0],
        [12_345, 7000],
        [12_345, 12_344],
        [7000, 4999],
    ] as const) {
        const window = storedWindow(length, index)
        assert.ok(window.length <= STACK_CAP)
        assert.ok(window.base <= index && index < window.base + window.length)
    }
    assert.throws(() => storedWindow(3, 3), RangeError)
})

test('replay follows §1.3.9’s example: the stack after a save is the one the user had', () => {
    const entries = [
        entry('init', 1),
        entry('edit', 2),
        entry('edit', 3),
        entry('undo', 2),
        entry('edit', 4),
        entry('undo', 2),
        entry('save', 2),
    ]
    const stack = replay(entries)
    assert.deepEqual(
        stack.slots.map((slot) => slot.snapshot),
        [hash(1), hash(2), hash(4)],
    )
    assert.equal(stack.index, 1)
    assert.deepEqual(
        stack.slots.map((slot) => slot.label),
        ['init 1', 'edit 2', 'edit 4'],
    )
})

test('replay takes a recovered entry’s stack as it is, and continues from an inherited one', () => {
    const entries = [
        entry('init', 1),
        entry('edit', 2),
        entry('edit', 3),
        entry('edit', 4),
        entry('recovered', 9, {
            stack: { keep: 2, push: [{ snapshot: hash(9), label: 'Changed BPM' }], index: 2 },
        }),
        entry('undo', 2),
    ]
    const stack = replay(entries)
    assert.deepEqual(
        stack.slots.map((slot) => slot.snapshot),
        [hash(1), hash(2), hash(9)],
    )
    assert.equal(stack.index, 1)
    // A head that was a stored slot: push is empty, and the index moves only.
    const moved = replay([
        ...entries.slice(0, 4),
        entry('recovered', 2, { stack: { keep: 4, push: [], index: 1 } }),
    ])
    assert.equal(moved.slots.length, 4)
    assert.equal(moved.index, 1)
    // keep longer than the stack keeps all of it.
    const longer = replay([
        entry('init', 1),
        entry('recovered', 5, {
            stack: { keep: 10, push: [{ snapshot: hash(5), label: 'x' }], index: 1 },
        }),
    ])
    assert.equal(longer.slots.length, 2)
    // A recovered session's only entry (a journal whose session never flushed).
    assert.equal(
        replay([
            entry('recovered', 7, {
                stack: { keep: 0, push: [{ snapshot: hash(7), label: 'x' }], index: 0 },
            }),
        ]).slots.length,
        1,
    )
    // A continuation keeps what it inherits; a continuation of nothing starts from its own.
    const inherited = replay([entry('init', 1), entry('edit', 2)])
    assert.equal(replay([entry('continue', 2), entry('edit', 3)], inherited).slots.length, 3)
    assert.equal(replay([entry('continue', 5)]).slots.length, 1)
})

test('replay refuses entries that don’t describe a stack', () => {
    assert.throws(() => replay([entry('edit', 1)]), ReplayError)
    assert.throws(() => replay([entry('init', 1), entry('undo', 1)]), ReplayError)
    assert.throws(() => replay([entry('init', 1), entry('init', 2)]), ReplayError)
    assert.throws(() => replay([entry('init', 1), entry('edit', 2), entry('undo', 2)]), ReplayError)
    assert.throws(() => replay([entry('init', 1), entry('redo', 1)]), ReplayError)
    assert.throws(() => replay([entry('init', 1), entry('save', 3)]), ReplayError)
    assert.throws(() => replay([entry('init', 1), entry('future', 2)]), ReplayError)
    assert.throws(
        () => replay([entry('recovered', 1, { stack: { keep: 0, push: [], index: 0 } })]),
        ReplayError,
    )
})

test('chain flags at creation follow the origin', () => {
    assert.deepEqual(chainFlagsAtCreation('new'), { hasContent: false, edited: false })
    assert.deepEqual(chainFlagsAtCreation('continued'), { hasContent: false, edited: false })
    assert.deepEqual(chainFlagsAtCreation('import'), { hasContent: true, edited: false })
    assert.deepEqual(chainFlagsAtCreation('journal'), { hasContent: true, edited: true })
    assert.deepEqual(chainFlagsAtCreation('migrated'), { hasContent: true, edited: true })
})

test('stored slots read back from blocks, and a mismatch is named', () => {
    const slots = Array.from({ length: 600 }, (_, i) => ({ snapshot: hash(i), label: `s${i}` }))
    const window = storedWindow(600, 599)
    const blocks = new Map(
        [0, 1, 2].map((block) => [
            block,
            blockRow('s', block, block * BLOCK_SLOTS, slots.slice(block * 256, block * 256 + 256)),
        ]),
    )
    const read = storedSlots(window, (block) => blocks.get(block))
    assert.equal(read?.length, 600)
    assert.deepEqual(stackMismatches({ window, slots: read }, { slots, index: 599 }), [])
    const other = slots.map((slot, i) => (i === 300 ? { ...slot, snapshot: hash(9999) } : slot))
    assert.equal(stackMismatches({ window, slots: read }, { slots: other, index: 599 }).length, 1)
    blocks.delete(1)
    assert.equal(
        storedSlots(window, (block) => blocks.get(block)),
        undefined,
    )
})

type E = { kind: string; n: number }

/** A model driven by entries, committing each plan as a worker would, with its rows. */
const model = () => {
    const stack = new SessionStack<E>()
    const rows = new Map<number, { first: number; slots: string[] }>()
    let writes: number[] = []
    const run = (entries: E[]) => {
        const replayed = stack.replay(entries, (e) => ({ entry: e, label: `${e.kind} ${e.n}` }))
        assert.ok(replayed)
        const plan = stack.plan(replayed.stack, replayed.changedFrom)
        writes = plan.writes.map((write) => write.block)
        for (const write of plan.writes) {
            const slots: string[] = []
            for (let slot = write.first; slot < write.end; slot++) {
                const at = plan.stack.at(slot) as ModelSlot<E>
                slots.push(
                    at.entry
                        ? String(at.entry.n)
                        : new DataView(at.hash!.buffer).getUint32(0).toString(),
                )
            }
            rows.set(write.block, { first: write.first, slots })
        }
        for (const block of [...rows.keys()])
            if (
                block < Math.floor(plan.window.base / 256) ||
                block > Math.floor((plan.window.base + plan.window.length - 1) / 256)
            )
                rows.delete(block)
        stack.commit(plan, (e) => ({ hash: hash(e.n), label: `${e.kind} ${e.n}` }), {
            written: true,
            durable: true,
            at: { db: 'db', epoch: 0 },
        })
        return plan
    }
    return { stack, rows, run, writes: () => writes }
}

test('a flush rewrites only the blocks whose slots changed, normally the last', () => {
    const m = model()
    m.run([{ kind: 'init', n: 0 }])
    const pushes = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({ kind: 'edit', n: from + i }))
    m.run(pushes(1, 999))
    assert.deepEqual(m.writes(), [0, 1, 2, 3])
    // One more edit: only its block.
    m.run(pushes(1000, 1))
    assert.deepEqual(m.writes(), [3])
    // An undo moves the index only: nothing.
    m.run([{ kind: 'undo', n: 0 }])
    assert.deepEqual(m.writes(), [])
    // An edit after undoing: the dropped redo slot is cut from the block's tail.
    m.run([{ kind: 'edit', n: 5000 }])
    assert.deepEqual(m.writes(), [3])
    // Past the cap: the window's base moves, and its first block isn't rewritten for it.
    m.run(pushes(6000, 5000))
    const window = m.stack.window!
    assert.equal(window.length, STACK_CAP)
    m.run(pushes(20_000, 1))
    assert.deepEqual(m.writes(), [blockOf(m.stack.window!.base + STACK_CAP - 1)])
    // Blocks wholly below the window are deleted.
    assert.ok([...m.rows.keys()].every((block) => block >= blockOf(m.stack.window!.base)))
    // After a restart the next flush rewrites the whole window.
    m.stack.unsync()
    m.run(pushes(30_000, 1))
    assert.equal(m.writes().length, Math.ceil(STACK_CAP / 256) + 1)
})

const blockOf = (slot: number) => Math.floor(slot / 256)

test('after a long undo the window keeps the index, and the blocks it moves into are written', () => {
    const m = model()
    m.run([{ kind: 'init', n: 0 }])
    m.run(Array.from({ length: 7999 }, (_, i) => ({ kind: 'edit', n: i + 1 })))
    assert.deepEqual(m.stack.window, { base: 3000, length: 5000, index: 7999 })
    m.run(Array.from({ length: 6999 }, () => ({ kind: 'undo', n: 0 })))
    assert.deepEqual(m.stack.window, { base: 0, length: 5000, index: 1000 })
    assert.deepEqual(
        [...m.rows.keys()].sort((a, b) => a - b),
        Array.from({ length: 20 }, (_, i) => i),
    )
    assert.equal(m.rows.get(0)?.slots[0], '0')
    assert.equal(m.rows.get(19)?.slots.at(-1), '4999')
})
