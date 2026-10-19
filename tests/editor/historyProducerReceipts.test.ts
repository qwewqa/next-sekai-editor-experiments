import assert from 'node:assert/strict'
import test from 'node:test'
import type { NoteObject } from '../../src/chart/note'
import { operationCodecs } from '../../src/history/operations'
import type { State } from '../../src/state'
import type { BpmEntity } from '../../src/state/entities/bpm'
import { createSlideId } from '../../src/state/entities/slides'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import type { TimeScaleEntity } from '../../src/state/entities/timeScale'
import { addBpm } from '../../src/state/mutations/bpm'
import { addNote } from '../../src/state/mutations/slides/note'
import { addTimeScale } from '../../src/state/mutations/timeScale'
import { editBpm, editBpmWithReceipt } from '../../src/state/operations/bpm'
import {
    changedNativeCounts,
    countNativeEntities,
    nativeKindOf,
} from '../../src/state/operations/historyReceipts'
import { planEdit } from '../../src/state/operations/properties/plan'
import { editTimeScale, editTimeScaleWithReceipt } from '../../src/state/operations/timeScale'
import { getInStoreGrid } from '../../src/state/store/grid'
import { createTransaction } from '../../src/state/transaction'
import { baseState, groupId, kinds, stageId } from './sameBeatKinds'

const noteObject = (extra: Partial<NoteObject> = {}): NoteObject => ({
    groupId: groupId(1),
    stageId: stageId(1),
    beat: 2,
    elevation: 0,
    noteStyle: 'default',
    connectorStyle: 'default',
    noteType: 'default',
    isAttached: false,
    left: -2,
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
    ...extra,
})

const withNotes = (objects: Partial<NoteObject>[], sameSlide = false) => {
    const transaction = createTransaction(baseState())
    const slide = createSlideId()
    const selected = objects.flatMap((object) =>
        addNote(transaction, sameSlide ? slide : createSlideId(), noteObject(object)),
    )
    return transaction.commit(selected)
}
const notes = (state: State) =>
    state.selectedEntities.filter((entity): entity is NoteEntity => entity.type === 'note')
const bpmAt = (state: State, beat: number) =>
    getInStoreGrid(state.store.grid, 'bpm', beat)!.filter((entity) => entity.beat === beat)
const scalesAt = (state: State, beat: number) =>
    (getInStoreGrid(state.store.grid, 'timeScale', beat) ?? []).filter(
        (entity) => entity.beat === beat,
    )

test('property receipts count actual native targets once and retain only applied primary fields', () => {
    const source = withNotes([{}])
    const note = notes(source)[0]!
    const initial = bpmAt(source, 0)[0]!
    const { state, changed, receipt } = planEdit(source, [note, initial, note], {
        size: 4,
        bpm: 180,
        flickDirection: 'none',
    })
    assert.equal(changed.length, 3)
    assert.deepEqual(receipt, {
        subject: 'objects',
        subjects: ['note', 'bpm'],
        targets: 2,
        assignments: [
            { field: 'bpm', value: { mode: 'uniform', value: 180 } },
            { field: 'size', value: { mode: 'uniform', value: 4 } },
        ],
    })
    assert.equal(operationCodecs['nse.property.set'].is(receipt), true)
    assert.equal(notes(state)[0]!.size, 4)
    assert.equal(bpmAt(state, 0)[0]!.bpm, 180)
    assert.equal(note.size, 3)
    assert.equal(initial.bpm, 120)
})

test('Fake and Critical primary fields include coupled-only effects without inventing collateral intent', () => {
    for (const [primary, coupled] of [
        ['isFake', 'connectorIsFake'],
        ['isCritical', 'connectorActiveIsCritical'],
    ] as const) {
        const source = withNotes(
            [{ beat: 0, [primary]: true, [coupled]: false }, { beat: 4 }],
            true,
        )
        const head = notes(source)[0]!
        const result = planEdit(source, [head], { [primary]: true })
        assert.equal(notes(result.state)[0]![coupled], true)
        assert.equal(head[coupled], false)
        assert.deepEqual(result.receipt, {
            subject: 'note',
            targets: 1,
            assignments: [{ field: primary, value: { mode: 'uniform', value: true } }],
        })
        const unchanged = planEdit(source, [head], { [primary]: true, [coupled]: false })
        assert.deepEqual(unchanged.changed, [])
        assert.equal(unchanged.receipt, undefined)
    }
})

test('relative and partial ease edits capture effective uniform or varying results', () => {
    const source = withNotes([
        { size: 3, connectorEase: 'outQuad' },
        { size: 5, connectorEase: 'outCubic' },
    ])
    const result = planEdit(
        source,
        source.selectedEntities,
        { size: 1, connectorEase: 'type:in' },
        {
            each: (entity) => ({ size: (entity as NoteEntity).size + 1, connectorEase: 'type:in' }),
        },
    )
    assert.deepEqual(
        notes(result.state).map(({ size, connectorEase }) => [size, connectorEase]),
        [
            [4, 'inQuad'],
            [6, 'inCubic'],
        ],
    )
    assert.deepEqual(result.receipt?.assignments, [
        { field: 'connectorEase', value: { mode: 'varying' } },
        { field: 'size', value: { mode: 'varying' } },
    ])
    const uniform = planEdit(source, source.selectedEntities, { connectorEase: 'linear' })
    assert.deepEqual(uniform.receipt?.assignments, [
        { field: 'connectorEase', value: { mode: 'uniform', value: 'linear' } },
    ])
    assert.deepEqual(
        notes(source).map(({ size, connectorEase }) => [size, connectorEase]),
        [
            [3, 'outQuad'],
            [5, 'outCubic'],
        ],
    )
})

test('primary assignment values include changed applicable targets already at the requested value', () => {
    const source = withNotes([{ size: 4 }, { size: 3 }])
    const result = planEdit(source, source.selectedEntities, { size: 4, isCritical: true })
    assert.equal(result.receipt?.targets, 2)
    assert.deepEqual(result.receipt?.assignments, [
        { field: 'isCritical', value: { mode: 'uniform', value: true } },
        { field: 'size', value: { mode: 'uniform', value: 4 } },
    ])
})

test('owner assignment captures bounded historical names without changing full chart names', () => {
    const source = withNotes([{}])
    const name = '😀'.repeat(300)
    source.groups = new Map(source.groups)
    source.groups.set(groupId(2), { name })
    source.stages = new Map(source.stages)
    source.stages.set(stageId(2), { ...source.stages.get(stageId(2))!, name: 'Other stage' })
    const result = planEdit(source, source.selectedEntities, {
        groupId: groupId(2),
        stageId: stageId(2),
    })
    assert.deepEqual(result.receipt?.assignments, [
        {
            field: 'groupId',
            value: {
                mode: 'uniform',
                value: { kind: 'group', id: 2, name: { text: '😀'.repeat(256), truncated: true } },
            },
        },
        {
            field: 'stageId',
            value: {
                mode: 'uniform',
                value: { kind: 'stage', id: 2, name: { text: 'Other stage' } },
            },
        },
    ])
    result.state.groups = new Map(result.state.groups)
    result.state.groups.set(groupId(2), { name: 'Renamed later' })
    assert.equal(source.groups.get(groupId(2))!.name, name)
    assert.equal(Object.isFrozen(result.receipt), true)
    assert.equal(operationCodecs['nse.property.set'].is(result.receipt), true)
})

test('attached geometry follows actual execution when a beat edit moves a tick beyond its slide', () => {
    const source = withNotes(
        [
            { beat: 0, left: -4, size: 2 },
            { beat: 2, isAttached: true, size: 0 },
            { beat: 4, left: 2, size: 4 },
        ],
        true,
    )
    const tick = notes(source)[1]!
    for (const field of ['left', 'size'] as const) {
        const ignored = planEdit(source, [tick], { [field]: 999 })
        assert.equal(ignored.receipt, undefined)
        assert.equal(notes(ignored.state)[0]![field], tick[field])
        const result = planEdit(source, [tick], { beat: 6, [field]: 999 })
        const moved = notes(result.state)[0]!
        assert.equal(moved.beat, 6)
        assert.equal(moved[field], 999)
        assert.deepEqual(result.receipt?.assignments, [
            { field: 'beat', value: { mode: 'uniform', value: 6 } },
            { field, value: { mode: 'uniform', value: 999 } },
        ])
        const interior = planEdit(source, [tick], { beat: 3, [field]: 999 })
        assert.notEqual(notes(interior.state)[0]![field], 999)
        const assignment = interior.receipt?.assignments.find((item) => item.field === field)
        if (notes(interior.state)[0]![field] === tick[field]) assert.equal(assignment, undefined)
        else
            assert.deepEqual(assignment?.value, {
                mode: 'uniform',
                value: notes(interior.state)[0]![field],
            })
    }
    assert.equal(tick.beat, 2)
})

test('each callback request keys are captured at execution without extra callback calls', () => {
    const source = withNotes([{}, {}])
    let calls = 0
    const shared: { size?: number; isCritical?: boolean } = {}
    const result = planEdit(
        source,
        source.selectedEntities,
        {},
        {
            each: (entity) => {
                calls++
                delete shared.size
                delete shared.isCritical
                if (entity === source.selectedEntities[0]) shared.size = 7
                else shared.isCritical = true
                return shared
            },
        },
    )
    assert.equal(calls, 4)
    assert.equal(notes(result.state)[0]!.size, 7)
    assert.equal(notes(result.state)[1]!.isCritical, true)
    assert.deepEqual(result.receipt?.assignments, [
        { field: 'isCritical', value: { mode: 'uniform', value: true } },
        { field: 'size', value: { mode: 'uniform', value: 7 } },
    ])
})

test('unchanged, excluded and unsupported targets produce no invented primary application', () => {
    const source = withNotes([{ beat: 0 }, { beat: 4 }], true)
    const note = notes(source)[0]!
    const connector = [...source.store.slides.connector.values()].flat()[0]!
    assert.equal(nativeKindOf(connector), undefined)
    assert.deepEqual(countNativeEntities([note, note, connector]), { note: 1 })
    assert.deepEqual(changedNativeCounts([{ before: note, after: { ...note } }]), {})
    for (const result of [
        planEdit(source, [note, connector], { size: note.size }),
        planEdit(source, [note], { size: 4 }, { only: () => false }),
        planEdit(source, [note], { bpm: 240 }),
    ]) {
        assert.equal(result.receipt, undefined)
        assert.equal(notes(result.state)[0]!.size, note.size)
    }
})

test('connector properties are receipted on their owning native note while derived connector operands stay unsupported', () => {
    const source = withNotes([{ beat: 0 }, { beat: 4 }], true)
    const head = notes(source)[0]!
    const connector = [...source.store.slides.connector.values()].flat()[0]!
    const result = planEdit(source, [head, connector], {
        connectorStyle: 'red',
        connectorType: 'guide',
    })
    assert.equal(notes(result.state)[0]!.connectorStyle, 'red')
    assert.equal(notes(result.state)[0]!.connectorType, 'guide')
    assert.equal(head.connectorStyle, 'default')
    assert.deepEqual(result.receipt, {
        subject: 'note',
        targets: 1,
        assignments: [
            { field: 'connectorStyle', value: { mode: 'uniform', value: 'red' } },
            { field: 'connectorType', value: { mode: 'uniform', value: 'guide' } },
        ],
    })
})

test('duplicate operands use the rebuilt effective note instead of a stale precommit replacement', () => {
    const source = withNotes(
        [
            { beat: 0, isAttached: true, size: 2 },
            { beat: 1, size: 4 },
            { beat: 4, size: 6 },
        ],
        true,
    )
    const head = notes(source)[0]!
    const result = planEdit(source, [head, head], { beat: 2, size: 9 })
    const effective = notes(result.state)[0]!
    assert.notEqual(effective.size, 9)
    assert.equal(result.receipt?.targets, 1)
    assert.deepEqual(
        result.receipt?.assignments.find(({ field }) => field === 'size'),
        {
            field: 'size',
            value: { mode: 'uniform', value: effective.size },
        },
    )
    assert.equal(head.size, 2)
})

test('initial BPM move reports its retained anchor, fresh target and one displaced member of a destination pair', () => {
    const transaction = createTransaction(baseState())
    addBpm(transaction, { beat: 4, bpm: 130, meter: 4 })
    addBpm(transaction, { beat: 4, bpm: 140, meter: 4 })
    const source = transaction.commit([])
    const edit = createTransaction(source)
    const outcome = editBpmWithReceipt(edit, bpmAt(source, 0)[0]!, { beat: 4 })
    const state = edit.commit(outcome.entities)
    assert.deepEqual(outcome.receipt, {
        subject: 'bpm',
        targets: 1,
        created: { bpm: 1 },
        displaced: { bpm: 1 },
        retainedInitialBpm: true,
    })
    assert.deepEqual(
        bpmAt(state, 0).map(({ bpm }) => bpm),
        [120],
    )
    assert.deepEqual(
        bpmAt(state, 4).map(({ bpm }) => bpm),
        [140, 120],
    )
    assert.deepEqual(
        bpmAt(source, 4).map(({ bpm }) => bpm),
        [130, 140],
    )
    const legacy = createTransaction(source)
    const legacyState = legacy.commit(editBpm(legacy, bpmAt(source, 0)[0]!, { beat: 4 }))
    assert.deepEqual(legacyState.bpms, state.bpms)
})

test('ordinary BPM move/replacement does not describe internal remove-and-add as fresh creation', () => {
    const transaction = createTransaction(baseState())
    const [before] = addBpm(transaction, { beat: 2, bpm: 160, meter: 4 })
    addBpm(transaction, { beat: 4, bpm: 130, meter: 4 })
    const source = transaction.commit([before!])
    const edit = createTransaction(source)
    const outcome = editBpmWithReceipt(edit, before as BpmEntity, { beat: 4 })
    const state = edit.commit(outcome.entities)
    assert.deepEqual(outcome.receipt, {
        subject: 'bpm',
        targets: 1,
        created: {},
        displaced: { bpm: 1 },
    })
    assert.deepEqual(
        bpmAt(state, 4).map(({ bpm }) => bpm),
        [160],
    )
    const noChange = editBpmWithReceipt(createTransaction(source), before as BpmEntity, {
        bpm: 160,
    })
    assert.equal(noChange.receipt.targets, 0)
    assert.deepEqual(noChange.receipt.created, {})
})

const scaleObject = (beat: number, group = 1, timeScale = 1) => ({
    groupId: groupId(group),
    beat,
    editorLane: -6,
    timeScale,
    skip: 0,
    timeScaleEase: 'none' as const,
    timeScaleTransition: 'timeScale' as const,
    hideNotes: false,
})

test('event and time-scale partial ease receipts use effective values for every native event kind', () => {
    for (const kind of kinds.filter(({ type }) => type.endsWith('EventJoint'))) {
        const transaction = createTransaction(baseState())
        const event = kind.add(transaction, {
            ...kind.make(2, 1, 1),
            eventEase: 'outQuad',
        } as never)![0]!
        const [scale] = addTimeScale(transaction, { ...scaleObject(2), timeScaleEase: 'outCubic' })
        const source = transaction.commit([event, scale!])
        const result = planEdit(source, source.selectedEntities, {
            eventEase: 'type:in',
            timeScaleEase: 'type:in',
        })
        assert.equal(
            (result.state.selectedEntities[0] as unknown as { eventEase: string }).eventEase,
            'inQuad',
        )
        assert.equal((result.state.selectedEntities[1] as TimeScaleEntity).timeScaleEase, 'inCubic')
        assert.deepEqual(result.receipt?.assignments, [
            { field: 'eventEase', value: { mode: 'uniform', value: 'inQuad' } },
            { field: 'timeScaleEase', value: { mode: 'uniform', value: 'inCubic' } },
        ])
        assert.equal(result.receipt?.targets, 2)
        assert.equal(operationCodecs['nse.property.set'].is(result.receipt), true)
    }
})

test('time-scale moves count every actually displaced destination pair and preserve other groups', () => {
    const transaction = createTransaction(baseState())
    const [before] = addTimeScale(transaction, scaleObject(2))
    addTimeScale(transaction, scaleObject(4, 1, 2))
    addTimeScale(transaction, scaleObject(4, 1, 3))
    addTimeScale(transaction, scaleObject(4, 2, 4))
    const source = transaction.commit([before!])
    const edit = createTransaction(source)
    const outcome = editTimeScaleWithReceipt(edit, before as TimeScaleEntity, { beat: 4 })
    const state = edit.commit(outcome.entities)
    assert.deepEqual(outcome.receipt, {
        subject: 'timeScale',
        targets: 1,
        created: {},
        displaced: { timeScale: 2 },
    })
    assert.deepEqual(
        scalesAt(state, 4).map(({ timeScale }) => timeScale),
        [4, 1],
    )
    assert.deepEqual(
        scalesAt(source, 4).map(({ timeScale }) => timeScale),
        [2, 3, 4],
    )
    const legacy = createTransaction(source)
    const selected = editTimeScale(legacy, before as TimeScaleEntity, { beat: 4 })
    assert.deepEqual(
        scalesAt(legacy.commit(selected), 4).map(({ timeScale }) => timeScale),
        [4, 1],
    )
})

test('a same-beat time-scale group reassignment retains existing destination pairs without displacement', () => {
    const transaction = createTransaction(baseState())
    const [before] = addTimeScale(transaction, scaleObject(4))
    addTimeScale(transaction, scaleObject(4, 2, 2))
    addTimeScale(transaction, scaleObject(4, 2, 3))
    const source = transaction.commit([before!])
    const edit = createTransaction(source)
    const outcome = editTimeScaleWithReceipt(edit, before as TimeScaleEntity, {
        groupId: groupId(2),
    })
    assert.deepEqual(outcome.receipt, {
        subject: 'timeScale',
        targets: 1,
        created: {},
        displaced: {},
    })
    assert.deepEqual(
        scalesAt(edit.commit(outcome.entities), 4).map(({ timeScale }) => timeScale),
        [2, 3, 1],
    )
})
