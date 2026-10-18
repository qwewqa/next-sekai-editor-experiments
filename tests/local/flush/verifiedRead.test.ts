import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PeekError, entryKey } from '../../../src/history/peek'
import {
    liveState,
    resetStates,
    restoreStates,
    setSlotLoader,
    undoState,
} from '../../../src/history/stack'
import { hashKey } from '../../../src/local/db'
import { toHex } from '../../../src/local/hash'
import { createPeekSource, readStoredState, slotLoader } from '../../../src/local/peekSource'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot, type EncodedSnapshot } from '../../../src/local/records/snapshot'
import { createWorld } from '../../../src/local/testing/world'
import type { StorageWorker } from '../../../src/local/worker/client'
import { peekHandlers } from '../../../src/local/worker/peekHandlers'
import type { State } from '../../../src/state'
import { goldenChart, stateOf } from '../records/charts'
import { beginIn } from '../startup/harness'
import { storedEntries, widen } from '../timeline/helpers'
import { openPage, type Page } from './harness'

// The verified snapshot read (Part 1 §1.4.11, §1.6.2) on the test core: a part whose bytes
// changed, a part gone or a malformed row reads `damaged`, for peek and for the undo stack's
// restored slots, which become the live head (§1.6.4 #6).

const encoded = (state: State) => encodeSnapshot(toRecords(state))

const hexOf = (state: State) => toHex(encoded(state).root.hash)

/** A stored session of three states, and the page's verified reads. */
const stored = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const b = widen(a)
    const c = widen(b, 1)
    const session = beginIn(page, a)
    page.flusher.append('edit', () => 'B', b, true)
    page.flusher.append('edit', () => 'C', c, true)
    await page.flusher.flush({ strict: true })
    const handlers = peekHandlers({ core: page.core, test: true, emit: () => undefined })
    const read = (hex: string) => page.tab.run(() => handlers.readSnapshotVerified(hex))
    const worker = {
        call: (method: 'readEntry' | 'readSnapshotVerified', arg: never) =>
            page.tab.run(() => handlers[method](arg)),
    } as unknown as StorageWorker
    const seqOf = (state: State) =>
        storedEntries(world, session.id).find((entry) => toHex(entry.snapshot) === hexOf(state))!
            .seq
    return { world, page, a, b, c, session, read, worker, seqOf }
}

/** Rows written straight to the store, as damage on disk would be. */
const putRow = (page: Page, store: string, key: ArrayBuffer, value: unknown) =>
    page.tab.run(() => page.core.write([store], (tx) => tx.put(store, value, key)))

const getRow = (page: Page, store: string, key: ArrayBuffer) =>
    page.tab.run(() => page.core.read([store], (tx) => tx.get(store, key))) as Promise<
        Record<string, unknown>
    >

const deleteRow = (page: Page, store: string, key: ArrayBuffer) =>
    page.tab.run(() => page.core.write([store], (tx) => tx.delete(store, key)))

/** A body chunk of `to` that `from` doesn't share, and `from`'s chunk of the same kind and place. */
const changedChunk = (from: EncodedSnapshot, to: EncodedSnapshot) => {
    const shared = new Set(from.chunks.map((chunk) => toHex(chunk.hash)))
    const at = to.chunks.findIndex((chunk) => !shared.has(toHex(chunk.hash)))
    return { mine: to.chunks[at]!, theirs: from.chunks[at]! }
}

const quietly = async <T>(run: () => Promise<T>) => {
    const error = console.error
    console.error = () => undefined
    try {
        return await run()
    } finally {
        console.error = error
    }
}

const rejectsWith = (promise: Promise<unknown>, reason: string) =>
    assert.rejects(promise, (error) => error instanceof PeekError && error.reason === reason)

test('a stored snapshot reads verified and builds its state', async () => {
    const { b, read } = await stored(1)
    const result = await readStoredState(read, hexOf(b))
    assert.equal(result.kind, 'found')
    if (result.kind === 'found') assert.equal(hexOf(result.state), hexOf(b))
})

test('a chunk whose bytes changed reads damaged: peek rejects, and Undo never lands on it', async () => {
    const { page, a, b, c, session, read, worker, seqOf } = await stored(2)
    // B's changed chunk holds A's bytes: a valid deflate stream of the same kind.
    const { mine, theirs } = changedChunk(encoded(a), encoded(b))
    const row = await getRow(page, 'chunks', hashKey(mine.hash))
    const other = await getRow(page, 'chunks', hashKey(theirs.hash))
    await putRow(page, 'chunks', hashKey(mine.hash), { ...row, bytes: other.bytes })

    assert.deepEqual(await read(hexOf(b)), { kind: 'damaged' })
    assert.deepEqual(await readStoredState(read, hexOf(b)), { kind: 'damaged' })
    const source = createPeekSource(worker, () => undefined)
    await rejectsWith(source.load(entryKey(session.id, seqOf(b))), 'damaged')
    await assert.rejects(slotLoader(read)(encoded(b).root.hash))

    // The restored stack's slot for B fails to load: the move is cancelled, C stays live.
    resetStates({ isDirty: false, name: () => 'Reset', state: a })
    setSlotLoader(slotLoader(read))
    const slots = [a, b, c].map((state) => ({
        snapshot: encoded(state).root.hash,
        label: 'Step',
        isDirty: false,
    }))
    await quietly(async () => {
        restoreStates(slots, 2, c)
        undoState()
        for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    })
    assert.equal(liveState.value, c)
    setSlotLoader(undefined)
    resetStates({ isDirty: false, name: () => 'Reset', state: a })
})

test('a missing node reads damaged', async () => {
    const { page, b, read } = await stored(3)
    const [node] = encoded(b).nodes
    await deleteRow(page, 'nodes', hashKey(node!.hash))
    assert.deepEqual(await read(hexOf(b)), { kind: 'damaged' })
})

test('a root gone reads removed for an entry not kept, damaged for one kept', async () => {
    const { world, page, a, session, worker, seqOf } = await stored(4)
    const seq = seqOf(a)
    await deleteRow(page, 'nodes', hashKey(encoded(a).root.hash))
    const source = createPeekSource(worker, () => undefined)
    await rejectsWith(source.load(entryKey(session.id, seq)), 'damaged')
    const entry = storedEntries(world, session.id).find((each) => each.seq === seq)!
    await page.tab.run(() =>
        page.core.write(['entries'], (tx) => tx.put('entries', { ...entry, kept: false })),
    )
    await rejectsWith(source.load(entryKey(session.id, seq)), 'removed')
})

test('a malformed root or node row reads damaged', async () => {
    const { page, b, c, read } = await stored(5)
    const root = await getRow(page, 'nodes', hashKey(encoded(b).root.hash))
    await putRow(page, 'nodes', hashKey(encoded(b).root.hash), {
        ...root,
        refs: new Uint8Array(15),
    })
    assert.deepEqual(await read(hexOf(b)), { kind: 'damaged' })

    const [node] = encoded(c).nodes
    const row = await getRow(page, 'nodes', hashKey(node!.hash))
    await putRow(page, 'nodes', hashKey(node!.hash), { ...row, refs: new Uint8Array(17) })
    assert.deepEqual(await read(hexOf(c)), { kind: 'damaged' })
})

test('storing loads restored undo slots through the verified read', () => {
    const source = readFileSync(new URL('../../../src/local/storing.ts', import.meta.url), 'utf8')
    assert.match(
        source,
        /setSlotLoader\(slotLoader\(\(hex\) => worker\.call\('readSnapshotVerified', hex\)\)\)/,
    )
})
