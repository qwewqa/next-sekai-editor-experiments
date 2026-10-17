import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import {
    ChunkBatch,
    Extractor,
    runSliced,
    runToEnd,
    type SnapshotPlan,
} from '../../../src/local/chunks'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import type { State } from '../../../src/state'
import { createSlideId } from '../../../src/state/entities/slides'
import { addNote, replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction, type Transaction } from '../../../src/state/transaction'
import { edgeChart, goldenChart, note, stateOf } from '../records/charts'
import { samplePaths, sampleState } from '../records/samples'

// The identity memo and the extraction (§1.6.2): the plan's chunks are exactly the snapshot
// encoding's, and an edit sends only its changed windows.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A stand-in for the worker: hashes a batch's chunks, keeps their texts by hash. */
const store = () => {
    const texts = new Map<string, string>()
    return {
        texts,
        settle(extractor: Extractor, batch: ChunkBatch, epoch = 0) {
            const hashes = batch.texts.map((text) => {
                const hash = hash16Sync(encoder.encode(text))
                texts.set(toHex(hash), text)
                return hash
            })
            extractor.settle(batch, hashes, epoch)
            return hashes
        },
        /** A plan's header and chunk texts, kind by kind, once its batch is settled. */
        resolve(plan: SnapshotPlan, batch: ChunkBatch) {
            const text = (hash: Uint8Array) => {
                const found = texts.get(toHex(hash))
                if (found === undefined) throw new Error('Unknown chunk')
                return found
            }
            return {
                header: batch.texts[plan.header],
                kinds: plan.kinds.map(({ kind, chunks }) => ({
                    kind,
                    chunks: chunks.map((chunk) =>
                        text(chunk.t === 'stored' ? chunk.hash : chunk.memo.hash!),
                    ),
                })),
            }
        },
    }
}

const expected = (state: State) => {
    const encoded = encodeSnapshot(toRecords(state))
    return {
        header: decoder.decode(encoded.header.bytes),
        kinds: encoded.root.kinds.map(([kind]) => ({
            kind,
            chunks: encoded.chunks
                .filter((chunk) => chunk.kind === kind)
                .map((chunk) => decoder.decode(chunk.bytes)),
        })),
        noteCount: encoded.root.noteCount,
        media: encoded.root.media.map(toHex),
    }
}

const planOnce = (extractor: Extractor, state: State, batch = new ChunkBatch()) => ({
    batch,
    plan: runToEnd(extractor.plan(state, batch)),
})

const assertMatches = (state: State, name: string) => {
    const extractor = new Extractor()
    const worker = store()
    const { batch, plan } = planOnce(extractor, state)
    worker.settle(extractor, batch)
    const want = expected(state)
    assert.deepEqual(worker.resolve(plan, batch), { header: want.header, kinds: want.kinds }, name)
    assert.equal(plan.noteCount, want.noteCount, name)
    assert.deepEqual(plan.media, want.media, name)
}

const edit = (state: State, change: (transaction: Transaction) => void) => {
    const transaction = createTransaction(state)
    change(transaction)
    return transaction.commit([])
}

test('the plan holds exactly the snapshot encoding’s chunks, on the golden and edge charts', () => {
    assertMatches(stateOf(goldenChart()), 'golden')
    assertMatches(stateOf(edgeChart()), 'edge')
})

for (const path of samplePaths)
    test(`the plan holds exactly the snapshot encoding’s chunks on ${path}`, (t) => {
        if (!existsSync(path)) {
            t.skip(`${path} is absent`)
            return
        }
        assertMatches(sampleState(path), path)
    })

test('an unchanged state sends only its header, and encodes nothing again', () => {
    const state = sampleState('tests/fixtures/generated-large.json')
    const extractor = new Extractor()
    const worker = store()
    const first = planOnce(extractor, state)
    worker.settle(extractor, first.batch)
    const encoded = extractor.encoded

    const again = planOnce(extractor, state)
    assert.equal(again.batch.texts.length, 1)
    assert.equal(again.batch.kinds[0], 'header')
    assert.equal(extractor.encoded, encoded)
    assert.ok(again.plan.kinds.every(({ chunks }) => chunks.every((chunk) => chunk.t === 'stored')))
})

test('a one-note edit sends one chunk and encodes one record', () => {
    const state = sampleState('tests/fixtures/generated-large.json')
    const extractor = new Extractor()
    const worker = store()
    worker.settle(extractor, planOnce(extractor, state).batch)
    const encoded = extractor.encoded

    const [notes] = [...state.store.slides.note.values()]

    const target = notes![0]!
    const edited = edit(state, (t) => {
        replaceNote(t, target, { ...target, size: target.size + 0.25 })
    })
    const { batch, plan } = planOnce(extractor, edited)
    worker.settle(extractor, batch)
    assert.deepEqual(batch.kinds, ['header', 'slides'])
    assert.equal(extractor.encoded - encoded, 1)
    const want = expected(edited)
    assert.deepEqual(worker.resolve(plan, batch), {
        header: want.header,
        kinds: want.kinds,
    })
})

test('a note added to a dense window rewrites one chunk', () => {
    const state = stateOf(goldenChart())
    const extractor = new Extractor()
    const worker = store()
    worker.settle(extractor, planOnce(extractor, state).batch)
    const added = edit(state, (t) => {
        addNote(t, createSlideId(), note(3.25))
    })
    const { batch } = planOnce(extractor, added)
    assert.deepEqual(batch.kinds, ['header', 'slides'])
})

test('two states in one batch send a shared new chunk once', () => {
    const state = sampleState('tests/fixtures/generated-large.json')
    const extractor = new Extractor()
    const worker = store()
    worker.settle(extractor, planOnce(extractor, state).batch)

    const [notes] = [...state.store.slides.note.values()]

    const target = notes![0]!
    const first = edit(state, (t) => {
        replaceNote(t, target, { ...target, size: target.size + 0.25 })
    })
    // A selection change keeps every entity.
    const second = { ...first, selectedEntities: [] }
    const batch = new ChunkBatch()
    const a = runToEnd(extractor.plan(first, batch))
    const b = runToEnd(extractor.plan(second, batch))
    assert.deepEqual(batch.kinds, ['header', 'slides'])
    const pending = (plan: SnapshotPlan) =>
        plan.kinds.flatMap(({ chunks }) => chunks.filter((chunk) => chunk.t === 'pending'))
    assert.equal(pending(a).length, 1)
    assert.equal(pending(a)[0]?.memo, pending(b)[0]?.memo)
})

test('a failed batch is forgotten: its chunks are sent again and its promises reject', async () => {
    const state = stateOf(goldenChart())
    const extractor = new Extractor()
    const { batch, plan } = planOnce(extractor, state)
    const pending = plan.kinds[0]?.chunks[0]
    assert.equal(pending?.t, 'pending')
    extractor.fail(batch, new Error('paused'))

    await assert.rejects(pending!.memo.pending!.promise, /paused/)
    const again = planOnce(extractor, state)
    assert.equal(again.batch.texts.length, batch.texts.length)
})

test('a pending chunk from a batch in flight resolves to its hash once that batch is stored', async () => {
    const state = stateOf(goldenChart())
    const extractor = new Extractor()
    const worker = store()
    const inFlight = planOnce(extractor, state)
    // The next plan, made while the first batch is in flight, sends nothing it already sent.
    const next = planOnce(extractor, { ...state, selectedEntities: [] })
    assert.equal(next.batch.texts.length, 1)
    const chunk = next.plan.kinds[0]?.chunks[0]
    assert.equal(chunk?.t, 'pending')

    const pending = chunk!.memo.pending!
    assert.notEqual(pending.batch, next.batch)
    const hashes = worker.settle(extractor, inFlight.batch)
    assert.deepEqual(await pending.promise, hashes[1])
})

test('forgetting missing hashes re-sends only those windows', () => {
    const state = sampleState('tests/fixtures/generated-large.json')
    const extractor = new Extractor()
    const worker = store()
    const first = planOnce(extractor, state)
    worker.settle(extractor, first.batch)
    const again = planOnce(extractor, state)
    const stored = again.plan.kinds.flatMap(({ chunks }) => chunks)
    const lost = stored.slice(0, 3).map((chunk) => (chunk.t === 'stored' ? toHex(chunk.hash) : ''))
    extractor.forgetHashes(new Set(lost), [again.plan])
    const resent = planOnce(extractor, state)
    assert.equal(resent.batch.texts.length, 1 + 3)
    assert.deepEqual(
        resent.batch.texts.slice(1).map((text) => toHex(hash16Sync(encoder.encode(text)))),
        lost,
    )
})

test('a worker restart resets the memo: everything is sent again', () => {
    const state = stateOf(edgeChart())
    const extractor = new Extractor()
    const worker = store()
    const first = planOnce(extractor, state)
    worker.settle(extractor, first.batch)
    extractor.reset()
    assert.equal(planOnce(extractor, state).batch.texts.length, first.batch.texts.length)
})

test('a whole-chart extraction runs in slices of about 8 ms', async () => {
    const path = 'tests/fixtures/generated-large.json'
    const state = sampleState(path)
    const extractor = new Extractor()
    const slices: number[] = []
    const batch = new ChunkBatch()
    // A clock that moves 1 ms a step, so slices end on time whatever the machine's speed.
    let clock = 0
    const plan = await runSliced(extractor.plan(state, batch), {
        onSlice: (ms) => slices.push(ms),
        now: () => clock++,
    })
    assert.ok(slices.length > 1)
    assert.ok(slices.every((ms) => ms <= 8))
    const worker = store()
    worker.settle(extractor, batch)
    const want = expected(state)
    assert.deepEqual(worker.resolve(plan, batch), {
        header: want.header,
        kinds: want.kinds,
    })
})
