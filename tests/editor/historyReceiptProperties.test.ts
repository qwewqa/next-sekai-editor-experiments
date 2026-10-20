import assert from 'node:assert/strict'
import test from 'node:test'
import type { NoteObject } from '../../src/chart/note'
import {
    nativeKinds,
    operationCodecs,
    type NativeCounts,
    type NativeKind,
    type Subject,
} from '../../src/history/operations'
import type { Entity } from '../../src/state/entities'
import { createSlideId } from '../../src/state/entities/slides'
import { addNote } from '../../src/state/mutations/slides/note'
import { flipVerticalWithReceipt } from '../../src/state/operations/flipVertical'
import {
    changedData,
    countNativeEntities,
    editInput,
    nativeKindOf,
} from '../../src/state/operations/historyReceipts'
import { planEdit } from '../../src/state/operations/properties/plan'
import { scaleSelectionWithReceipt } from '../../src/state/operations/scaleSelection'
import { getInStoreGrid } from '../../src/state/store/grid'
import { createTransaction } from '../../src/state/transaction'
import { add, baseState, groupId, kinds, stageId } from './sameBeatKinds'

// Random selections over random charts: whatever a producer reads off a receipt, the codec must
// accept it, because `createOperation` throws before `pushState` when it does not and the user's
// edit would be refused. The generator is seeded, so a failure repeats.

const random = (seed: number) => {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
type Random = ReturnType<typeof random>
const int = (rand: Random, max: number) => Math.floor(rand() * (max + 1))
const pick = <T>(rand: Random, items: readonly T[]) => items[int(rand, items.length - 1)]!
const chance = (rand: Random, p: number) => rand() < p

const noteObject = (beat: number, left: number): NoteObject => ({
    groupId: groupId(1),
    stageId: stageId(1),
    beat,
    elevation: 0,
    noteStyle: 'default',
    connectorStyle: 'default',
    noteType: 'default',
    isAttached: false,
    left,
    size: 3,
    isCritical: false,
    flickDirection: 'none',
    isFake: false,
    sfx: 'default',
    isConnectorSeparator: false,
    connectorType: 'active',
    connectorEase: 'linear',
    connectorIsFake: false,
    connectorActiveIsCritical: false,
    connectorGuideAlpha: 1,
    connectorLayer: 'top',
    connectorIsPassThrough: false,
    connectorPresentation: 'default',
})

/** A chart with notes, BPMs, time scales and events at a few shared beats, and a selection. */
const randomScene = (rand: Random) => {
    const transaction = createTransaction(baseState())
    const everything: Entity[] = []
    const beats = [0, 1, 2, 3, 4, 6, 8]
    for (let i = int(rand, 4) + 1; i > 0; i--) {
        const beat = pick(rand, beats)
        everything.push(
            ...addNote(transaction, createSlideId(), noteObject(beat, int(rand, 8) - 4)),
        )
    }
    for (const kind of kinds)
        for (let i = int(rand, 3); i > 0; i--) {
            // The initial BPM at 0 is already there.
            const beat = pick(rand, kind.name === 'BPM' ? beats.slice(1) : beats)
            if (kind.name === 'BPM' && everything.some((e) => e.type === 'bpm' && e.beat === beat))
                continue
            everything.push(...add(transaction, kind, beat, i + 1, 1))
        }
    const committed = transaction.commit(everything)
    const initial = [...committed.store.grid.bpm.values()].flatMap((cell) => [...cell])
    const pool = [...new Set([...everything, ...initial])]
    const selected = pool.filter(() => chance(rand, 0.55))
    return { state: committed, selected: selected.length ? selected : [pool[0]!] }
}

test('editInput builds data the codec accepts for every mix of counts, collateral and intent', () => {
    const rand = random(1)
    const entityTypes: Record<NativeKind, string> = {
        note: 'note',
        bpm: 'bpm',
        timeScale: 'timeScale',
        cameraEvent: 'cameraEventJoint',
        stageMaskEvent: 'stageMaskEventJoint',
        stagePivotEvent: 'stagePivotEventJoint',
        stageStyleEvent: 'stageStyleEventJoint',
        stageTransformEvent: 'stageTransformEventJoint',
    }
    for (let i = 0; i < 400; i++) {
        const changed: Partial<Record<NativeKind, number>> = {}
        for (const kind of nativeKinds) if (chance(rand, 0.3)) changed[kind] = int(rand, 5) + 1
        const displaced = nativeKinds
            .filter(() => chance(rand, 0.25))
            .map((kind) => ({ type: entityTypes[kind] }) as unknown as Entity)
        const empty = pick(rand, ['objects', ...nativeKinds] as readonly Subject[])
        const intent = pick(rand, ['edit', 'move'] as const)
        const operation = editInput(intent, changed, empty, {
            displaced,
            retainedInitialBpm: chance(rand, 0.4),
        })
        assert.equal(
            operationCodecs[operation.id].is(operation.data),
            true,
            JSON.stringify([operation, changed, empty]),
        )
        // No empty map is ever stored.
        if ('displaced' in operation.data)
            assert(Object.keys(operation.data.displaced as object).length > 0)
    }
})

test('vertical flip receipts are accepted for random selections, and name only what left the chart', () => {
    for (let seed = 0; seed < 150; seed++) {
        const rand = random(seed + 1000)
        const { state, selected } = randomScene(rand)
        const result = flipVerticalWithReceipt(state, selected)
        const data = { axis: 'vertical', ...changedData(result.counts, 'objects', result) } as const
        assert.equal(operationCodecs['nse.object.flip'].is(data), true, `seed ${seed}`)
        // Displaced objects were in the chart and are gone from the result.
        for (const entity of result.displaced) {
            assert(nativeKindOf(entity), `seed ${seed}`)
            assert(
                getInStoreGrid(state.store.grid, entity.type, entity.beat)?.includes(entity),
                `seed ${seed}: displaced objects were in the chart`,
            )
        }
        const total = Object.values(data.displaced ?? {}).reduce((sum, count) => sum + count, 0)
        assert.equal(total, new Set(result.displaced).size, `seed ${seed}`)
        // A horizontal-style record of the same counts is accepted too, and carries no collateral.
        const horizontal = { axis: 'horizontal', ...changedData(result.counts, 'objects') } as const
        assert.equal(operationCodecs['nse.object.flip'].is(horizontal), true)
    }
})

test('beat scale receipts are accepted for random selections and factors', () => {
    let displaced = 0
    for (let seed = 0; seed < 150; seed++) {
        const rand = random(seed + 2000)
        const { state, selected } = randomScene(rand)
        const anchor = Math.min(...selected.map((entity) => entity.beat))
        const factor = pick(rand, [0.5, 1.5, 2, 3])
        const result = scaleSelectionWithReceipt(state, selected, 'beat', factor, anchor)
        const data = {
            axis: 'beats',
            transform: { mode: 'composed' },
            ...changedData(result.counts, 'objects', result),
        } as const
        assert.equal(operationCodecs['nse.object.scale'].is(data), true, `seed ${seed}`)
        displaced += result.displaced.length
        const width = scaleSelectionWithReceipt(state, selected, 'width', factor, -4)
        const other = {
            axis: 'width',
            transform: { mode: 'composed' },
            ...changedData(width.counts, 'objects', width),
        } as const
        assert.equal(width.displaced.length, 0, `seed ${seed}`)
        assert.equal(operationCodecs['nse.object.scale'].is(other), true, `seed ${seed}`)
    }
    // The generator does reach the interesting case.
    assert(displaced > 0)
})

test('property receipts are accepted for random selections and edits', () => {
    const fields: ((rand: Random) => Record<string, unknown>)[] = [
        (rand) => ({ beat: pick(rand, [0, 1, 2, 3, 4, 6, 8, 10]) }),
        () => ({ isCritical: true }),
        (rand) => ({ left: int(rand, 6) - 3, size: int(rand, 3) + 1 }),
        (rand) => ({ bpm: 90 + int(rand, 60) }),
        (rand) => ({ beat: int(rand, 10), size: 2, eventEase: 'inQuad' }),
        () => ({ timeScale: 2, hideNotes: true }),
    ]
    let receipts = 0
    for (let seed = 0; seed < 200; seed++) {
        const rand = random(seed + 3000)
        const { state, selected } = randomScene(rand)
        const result = planEdit(state, selected, pick(rand, fields)(rand) as never, {
            single: chance(rand, 0.5),
        })
        if (!result.receipt) continue
        receipts++
        for (const id of ['nse.property.set', 'nse.object.brush'] as const)
            assert.equal(operationCodecs[id].is(result.receipt), true, `seed ${seed}`)
        assert.equal(
            result.receipt.subject,
            Object.keys(result.receipt.changed).length > 1
                ? 'objects'
                : Object.keys(result.receipt.changed)[0],
        )
    }
    assert(receipts > 50, `only ${receipts} receipts`)
})

test('counting entities twice or in any order gives the same positive counts', () => {
    for (let seed = 0; seed < 50; seed++) {
        const rand = random(seed + 4000)
        const { selected } = randomScene(rand)
        const once: NativeCounts = countNativeEntities(selected)
        const twice = countNativeEntities([...selected, ...[...selected].reverse()])
        assert.deepEqual(once, twice)
        for (const value of Object.values(once)) assert(value > 0)
    }
})
