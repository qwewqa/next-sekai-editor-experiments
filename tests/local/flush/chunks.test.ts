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
import { entitiesOf } from '../../../src/local/records/extract'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import type { State } from '../../../src/state'
import { createSlideId } from '../../../src/state/entities/slides'
import { addBpm, replaceBpm } from '../../../src/state/mutations/bpm'
import {
    addCameraEventJoint,
    replaceCameraEventJoint,
} from '../../../src/state/mutations/events/camera'
import { addStageMaskEventJoint } from '../../../src/state/mutations/events/stage/mask'
import { addStageStyleEventJoint } from '../../../src/state/mutations/events/stage/style'
import { addNote, replaceNote } from '../../../src/state/mutations/slides/note'
import { replaceTimeScale } from '../../../src/state/mutations/timeScale'
import { createTransaction, type Transaction } from '../../../src/state/transaction'
import '../../helpers/lockChecks'
import { camera, edgeChart, goldenChart, mask, note, stateOf, style } from '../records/charts'
import { samplePaths, sampleState } from '../records/samples'

// The identity memo and the extraction: the plan's chunks are exactly the snapshot
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
            extractor.settle(batch, hashes, { db: 'test', epoch })
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

test('outside release builds, a snapshot naming a group or stage its header lacks is refused', () => {
    const state = stateOf(goldenChart())
    const [note] = [...state.store.slides.note.values()].flat()
    assert.ok(note)
    const extractor = new Extractor()
    // Planned first whole, so the refusal comes from the header's ids changing.
    runToEnd(extractor.plan(state, new ChunkBatch()))
    const withoutGroup = {
        ...state,
        groups: new Map([...state.groups].filter(([id]) => id !== note.groupId)),
    } as State
    assert.throws(() => runToEnd(extractor.plan(withoutGroup, new ChunkBatch())), /groups/)
    const withoutStage = {
        ...state,
        stages: new Map([...state.stages].filter(([id]) => id !== note.stageId)),
    } as State
    assert.throws(() => runToEnd(new Extractor().plan(withoutStage, new ChunkBatch())), /stages/)
    // A release build doesn't check.
    runToEnd(new Extractor({ check: false }).plan(withoutStage, new ChunkBatch()))
})

/** A seeded generator, so the sequence is the same on every run. */
const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
}

test('across many kinds of edits, and back to earlier states, every plan is the snapshot encoding', () => {
    const next = random(7)
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]
    const extractor = new Extractor()
    const worker = store()
    const history: State[] = [stateOf(goldenChart())]
    let state = history[0]!
    for (let step = 0; step < 80; step++) {
        const roll = next()
        const grid = state.store.grid
        if (roll < 0.1 && history.length > 2) {
            // Undo or redo to an earlier state: its entities are the same objects again.
            state = pick(history)!
        } else if (roll < 0.15) {
            state = { ...state, initialLife: 900 + step }
        } else if (roll < 0.2) {
            const groups = new Map(state.groups)
            const [id, group] = [...groups][0]!
            groups.set(id, { ...group, name: `Group ${step}` })
            state = { ...state, groups }
        } else {
            state = edit(state, (t) => {
                const choice = next()
                if (choice < 0.25)
                    addNote(t, createSlideId(), note(1 + step / 4, { left: step % 5 }))
                else if (choice < 0.45) {
                    const target = pick([...state.store.slides.note.values()].flat())
                    if (target) replaceNote(t, target, { ...target, size: target.size + 0.5 })
                } else if (choice < 0.55) addCameraEventJoint(t, camera(2 + step / 8))
                else if (choice < 0.65) {
                    const target = pick(entitiesOf(grid.cameraEventJoint))
                    if (target) replaceCameraEventJoint(t, target, { ...target, cameraZoom: 2 })
                } else if (choice < 0.72) addStageMaskEventJoint(t, mask(3 + step / 8))
                else if (choice < 0.8) addStageStyleEventJoint(t, style(3 + step / 8))
                else if (choice < 0.88) {
                    const target = pick(entitiesOf(grid.bpm))
                    if (target) replaceBpm(t, target, { ...target, bpm: target.bpm + 1 })
                } else if (choice < 0.94) addBpm(t, { beat: 8 + step, bpm: 120, meter: 4 })
                else {
                    const target = pick(entitiesOf(grid.timeScale))
                    if (target)
                        replaceTimeScale(t, target, {
                            ...target,
                            timeScale: target.timeScale + 0.5,
                        })
                }
            })
            history.push(state)
        }
        const { batch, plan } = planOnce(extractor, state)
        worker.settle(extractor, batch)
        const want = expected(state)
        assert.deepEqual(
            worker.resolve(plan, batch),
            { header: want.header, kinds: want.kinds },
            `step ${step}`,
        )
        assert.equal(plan.noteCount, want.noteCount, `step ${step}`)
    }
})
