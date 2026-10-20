import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { NoteObject } from '../../src/chart/note'
import {
    bgmInput,
    bgmOffsetInput,
    groupEditInput,
    initialLifeInput,
    levelInfoInput,
    stageEditInput,
} from '../../src/editor/headerLabelText'
import {
    captureName,
    createOperation,
    equalJson,
    operationCodecs,
    type NativeOperationInput,
} from '../../src/history/operations'
import type { State } from '../../src/state'
import type { Entity } from '../../src/state/entities'
import type { BpmEntity } from '../../src/state/entities/bpm'
import { createSlideId } from '../../src/state/entities/slides'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import type { TimeScaleEntity } from '../../src/state/entities/timeScale'
import { emptyLevelInfo } from '../../src/state/levelInfo'
import { addBpm, removeBpm } from '../../src/state/mutations/bpm'
import { addNote, removeNote } from '../../src/state/mutations/slides/note'
import { addTimeScale } from '../../src/state/mutations/timeScale'
import { editBpm, editBpmWithReceipt } from '../../src/state/operations/bpm'
import { duplicateOwnedWithReceipt } from '../../src/state/operations/duplicateOwned'
import { flipVerticalWithReceipt } from '../../src/state/operations/flipVertical'
import {
    changedData,
    changedNativeCounts,
    countNativeEntities,
    editInput,
    editOutcomeInput,
    kindCounts,
    nativeKindOf,
    nonEmpty,
    optionalCounts,
    ownerCountsOf,
    removedEntities,
} from '../../src/state/operations/historyReceipts'
import { planEdit } from '../../src/state/operations/properties/plan'
import { scaleSelectionWithReceipt } from '../../src/state/operations/scaleSelection'
import { editTimeScale, editTimeScaleWithReceipt } from '../../src/state/operations/timeScale'
import { getInStoreGrid } from '../../src/state/store/grid'
import { createTransaction } from '../../src/state/transaction'
import { add, baseState, groupId, kinds, stageId } from './sameBeatKinds'

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
        changed: { note: 1, bpm: 1 },
        assignments: [
            {
                field: 'bpm',
                before: { mode: 'uniform', value: 120 },
                after: { mode: 'uniform', value: 180 },
            },
            {
                field: 'size',
                before: { mode: 'uniform', value: 3 },
                after: { mode: 'uniform', value: 4 },
            },
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
            changed: { note: 1 },
            assignments: [
                {
                    field: primary,
                    before: { mode: 'uniform', value: true },
                    after: { mode: 'uniform', value: true },
                },
            ],
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
        { field: 'connectorEase', before: { mode: 'varying' }, after: { mode: 'varying' } },
        { field: 'size', before: { mode: 'varying' }, after: { mode: 'varying' } },
    ])
    const uniform = planEdit(source, source.selectedEntities, { connectorEase: 'linear' })
    assert.deepEqual(uniform.receipt?.assignments, [
        {
            field: 'connectorEase',
            before: { mode: 'varying' },
            after: { mode: 'uniform', value: 'linear' },
        },
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
    assert.deepEqual(result.receipt?.changed, { note: 2 })
    assert.deepEqual(result.receipt?.assignments, [
        {
            field: 'isCritical',
            before: { mode: 'uniform', value: false },
            after: { mode: 'uniform', value: true },
        },
        {
            field: 'size',
            before: { mode: 'varying' },
            after: { mode: 'uniform', value: 4 },
        },
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
            before: {
                mode: 'uniform',
                value: {
                    kind: 'group',
                    id: 1,
                    name: captureName(source.groups.get(groupId(1))!.name),
                },
            },
            after: {
                mode: 'uniform',
                value: { kind: 'group', id: 2, name: { text: '😀'.repeat(256), truncated: true } },
            },
        },
        {
            field: 'stageId',
            before: {
                mode: 'uniform',
                value: {
                    kind: 'stage',
                    id: 1,
                    name: captureName(source.stages.get(stageId(1))!.name),
                },
            },
            after: {
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
            {
                field: 'beat',
                before: { mode: 'uniform', value: tick.beat },
                after: { mode: 'uniform', value: 6 },
            },
            {
                field,
                before: { mode: 'uniform', value: tick[field] },
                after: { mode: 'uniform', value: 999 },
            },
        ])
        const interior = planEdit(source, [tick], { beat: 3, [field]: 999 })
        assert.notEqual(notes(interior.state)[0]![field], 999)
        const assignment = interior.receipt?.assignments.find((item) => item.field === field)
        if (notes(interior.state)[0]![field] === tick[field]) assert.equal(assignment, undefined)
        else
            assert.deepEqual(assignment?.after, {
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
        {
            field: 'isCritical',
            before: { mode: 'uniform', value: false },
            after: { mode: 'uniform', value: true },
        },
        {
            field: 'size',
            before: { mode: 'uniform', value: 3 },
            after: { mode: 'uniform', value: 7 },
        },
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
        changed: { note: 1 },
        assignments: [
            {
                field: 'connectorStyle',
                before: { mode: 'uniform', value: 'default' },
                after: { mode: 'uniform', value: 'red' },
            },
            {
                field: 'connectorType',
                before: { mode: 'uniform', value: 'active' },
                after: { mode: 'uniform', value: 'guide' },
            },
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
    assert.deepEqual(result.receipt?.changed, { note: 1 })
    assert.deepEqual(
        result.receipt?.assignments.find(({ field }) => field === 'size'),
        {
            field: 'size',
            before: { mode: 'uniform', value: 2 },
            after: { mode: 'uniform', value: effective.size },
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
    assert.deepEqual(
        { ...outcome.receipt, displaced: countNativeEntities(outcome.receipt.displaced) },
        {
            subject: 'bpm',
            changed: { bpm: 1 },
            displaced: { bpm: 1 },
            retainedInitialBpm: true,
        },
    )
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
    assert.deepEqual(
        { ...outcome.receipt, displaced: countNativeEntities(outcome.receipt.displaced) },
        {
            subject: 'bpm',
            changed: { bpm: 1 },
            displaced: { bpm: 1 },
            retainedInitialBpm: false,
        },
    )
    assert.deepEqual(
        bpmAt(state, 4).map(({ bpm }) => bpm),
        [160],
    )
    const noChange = editBpmWithReceipt(createTransaction(source), before as BpmEntity, {
        bpm: 160,
    })
    assert.deepEqual(noChange.receipt.changed, {})
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
            {
                field: 'eventEase',
                before: { mode: 'uniform', value: 'outQuad' },
                after: { mode: 'uniform', value: 'inQuad' },
            },
            {
                field: 'timeScaleEase',
                before: { mode: 'uniform', value: 'outCubic' },
                after: { mode: 'uniform', value: 'inCubic' },
            },
        ])
        assert.equal(
            Object.values(result.receipt?.changed ?? {}).reduce((sum, count) => sum + count, 0),
            2,
        )
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
    assert.deepEqual(
        { ...outcome.receipt, displaced: countNativeEntities(outcome.receipt.displaced) },
        {
            subject: 'timeScale',
            changed: { timeScale: 1 },
            displaced: { timeScale: 2 },
            retainedInitialBpm: false,
        },
    )
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
        changed: { timeScale: 1 },
        displaced: [],
        retainedInitialBpm: false,
    })
    assert.deepEqual(
        scalesAt(edit.commit(outcome.entities), 4).map(({ timeScale }) => timeScale),
        [2, 3, 1],
    )
})

// ---------------------------------------------------------------------------------------------
// One receipt test per operation id. A producer builds its data from a fixture state, and
// `createOperation` must accept it: a producer that fails its codec would throw before
// `pushState` and refuse the user's edit. Producers that cannot run outside the browser (they
// reach Vue components or the live history) are covered by the browser spec named for them, and
// the completeness test below reads that spec for the id.
// ---------------------------------------------------------------------------------------------

const seen = new Set<string>()
const accepted = <T extends NativeOperationInput>(operation: T): T => {
    const made = createOperation(operation, { locale: 'en', describe: () => operation.id })
    assert(equalJson(made.data as never, operation.data as never))
    seen.add(operation.id)
    return operation
}
/** Count keys as an empty map reads when nothing is stored for them. */
const keysOf = (value: object | undefined) => Object.keys(value ?? {})

const bpmEntity = (state: State, beat: number) => bpmAt(state, beat)[0]!

test('note.add and note.generate: created counts the notes actually added', () => {
    const transaction = createTransaction(baseState())
    const added = addNote(transaction, createSlideId(), noteObject())
    const created = countNativeEntities(added).note ?? 0
    assert.equal(created, 1)
    assert.deepEqual(accepted({ id: 'nse.note.add', data: { created } }).data, { created: 1 })
    accepted({ id: 'nse.note.generate', data: { created: 12 } })
    // A tool step that added nothing is still valid data.
    accepted({ id: 'nse.note.add', data: { created: 0 } })
})

test('object.add: a BPM, a time scale and every event kind', () => {
    for (const kind of kinds) {
        if (kind.name === 'BPM' || kind.name === 'time scale') continue
        const transaction = createTransaction(baseState())
        const added = kind.add(transaction, kind.make(4, 1, 1) as never) ?? []
        const key = nativeKindOf(added[0]!)!
        const data = { subject: key, created: countNativeEntities(added)[key] ?? 0 }
        assert.equal(data.created, 1, kind.name)
        accepted({ id: 'nse.object.add', data: data as never })
    }
    const transaction = createTransaction(baseState())
    const bpms = addBpm(transaction, { beat: 4, bpm: 90, meter: 4 })
    assert.deepEqual(
        accepted({
            id: 'nse.object.add',
            data: { subject: 'bpm', created: countNativeEntities(bpms).bpm ?? 0 },
        }).data,
        { subject: 'bpm', created: 1 },
    )
})

test('object.edit and object.move: a step that changed nothing carries no count, never zero', () => {
    const source = baseState()
    // Zero-change: the tool re-applies the same values.
    const unchanged = editBpmWithReceipt(createTransaction(source), bpmEntity(source, 0), {
        bpm: 120,
    })
    const none = accepted(editOutcomeInput('edit', unchanged.receipt))
    assert.equal(none.id, 'nse.object.edit')
    assert.deepEqual(none.data, { subject: 'bpm', changed: {} })
    // One kind: an in-place edit.
    const edited = editBpmWithReceipt(createTransaction(source), bpmEntity(source, 0), { bpm: 140 })
    assert.deepEqual(accepted(editOutcomeInput('edit', edited.receipt)).data, {
        subject: 'bpm',
        changed: { bpm: 1 },
    })
    // Moving onto an empty beat is a move with no `displaced` key at all (it was an empty map).
    const transaction = createTransaction(source)
    const [moving] = addBpm(transaction, { beat: 2, bpm: 90, meter: 4 })
    const withMoving = transaction.commit([moving!])
    const moved = editBpmWithReceipt(createTransaction(withMoving), moving as BpmEntity, {
        beat: 8,
    })
    const move = accepted(editOutcomeInput('move', moved.receipt))
    assert.equal(move.id, 'nse.object.move')
    assert.deepEqual(move.data, { subject: 'bpm', changed: { bpm: 1 } })
    assert.deepEqual(keysOf(move.data), ['subject', 'changed'])
    // Every event kind and a time scale: one count under their own key.
    for (const kind of kinds.filter(({ name }) => name !== 'BPM')) {
        const tx = createTransaction(baseState())
        const [entity] = add(tx, kind, 4, 1)
        const key = nativeKindOf(entity!)!
        const op = accepted(
            editInput('move', kindCounts(key, 1), key) as Extract<
                NativeOperationInput,
                { id: 'nse.object.move' }
            >,
        )
        assert.deepEqual(op.data, { subject: key, changed: { [key]: 1 } }, kind.name)
    }
    // Mixed kinds with a displaced object, from the Select tool: counts per kind.
    const mixed = accepted(
        editInput('move', { note: 8, bpm: 3, cameraEvent: 1 }, 'objects', {
            displaced: [moving!],
            retainedInitialBpm: true,
        }),
    )
    assert.equal(mixed.id, 'nse.object.move')
    assert.deepEqual(mixed.data, {
        subject: 'objects',
        changed: { note: 8, bpm: 3, cameraEvent: 1 },
        displaced: { bpm: 1 },
        retainedInitialBpm: true,
    })
})

test('object.replace: one id for one result, whichever tool made it', () => {
    const transaction = createTransaction(baseState())
    const [moving] = addBpm(transaction, { beat: 2, bpm: 90, meter: 4 })
    addBpm(transaction, { beat: 4, bpm: 130, meter: 4 })
    const source = transaction.commit([moving!])
    const outcome = editBpmWithReceipt(createTransaction(source), moving as BpmEntity, { beat: 4 })
    const fromTool = accepted(editOutcomeInput('move', outcome.receipt))
    assert.equal(fromTool.id, 'nse.object.replace')
    assert.deepEqual(fromTool.data, {
        subject: 'bpm',
        changed: { bpm: 1 },
        displaced: { bpm: 1 },
    })
    // The Select tool reports the same facts through the same helper, so it is the same id.
    const fromSelect = editInput('move', { bpm: 1 }, 'objects', {
        displaced: outcome.receipt.displaced,
    })
    assert.deepEqual(fromSelect, fromTool)
    // A time scale replaces the same way.
    const scaleTx = createTransaction(baseState())
    const [scale] = addTimeScale(scaleTx, scaleObject(2))
    addTimeScale(scaleTx, scaleObject(4, 1, 2))
    const scaleSource = scaleTx.commit([scale!])
    const scaleOutcome = editTimeScaleWithReceipt(
        createTransaction(scaleSource),
        scale as TimeScaleEntity,
        { beat: 4 },
    )
    const replaced = accepted(editOutcomeInput('move', scaleOutcome.receipt))
    assert.equal(replaced.id, 'nse.object.replace')
    // A BPM and a time scale moved together are a move, with the displaced one recorded.
    const mixed = editInput('move', { bpm: 1, timeScale: 1 }, 'objects', {
        displaced: [...outcome.receipt.displaced, ...scaleOutcome.receipt.displaced],
    })
    assert.equal(mixed.id, 'nse.object.move')
    assert.deepEqual(accepted(mixed).data, {
        subject: 'objects',
        changed: { bpm: 1, timeScale: 1 },
        displaced: { bpm: 1, timeScale: 1 },
    })
    // An edit in place never replaces, even if told of a displaced object.
    assert.equal(
        editInput('edit', { bpm: 1 }, 'bpm', { displaced: outcome.receipt.displaced }).id,
        'nse.object.edit',
    )
})

test('object.replace: the initial BPM moved onto an occupied beat keeps its anchor', () => {
    const transaction = createTransaction(baseState())
    addBpm(transaction, { beat: 4, bpm: 130, meter: 4 })
    const source = transaction.commit([])
    const outcome = editBpmWithReceipt(createTransaction(source), bpmEntity(source, 0), { beat: 4 })
    const op = accepted(editOutcomeInput('move', outcome.receipt))
    assert.equal(op.id, 'nse.object.replace')
    assert.deepEqual(op.data, {
        subject: 'bpm',
        changed: { bpm: 1 },
        displaced: { bpm: 1 },
        retainedInitialBpm: true,
    })
})

test('note.elevation, note.vertical, note.combine, note.split: a count of the notes', () => {
    accepted({ id: 'nse.note.elevation', data: { targets: 2 } })
    accepted({ id: 'nse.note.vertical', data: { targets: 3 } })
    accepted({ id: 'nse.note.combine', data: { targets: 3 } })
    accepted({ id: 'nse.note.split', data: { targets: 2 } })
})

test('object.paste: placed is never empty, and nothing replaced is not a key', () => {
    const transaction = createTransaction(baseState())
    const placed = countNativeEntities(addNote(transaction, createSlideId(), noteObject()))
    const displaced = countNativeEntities([])
    assert.equal(nonEmpty(displaced), undefined)
    const data = {
        placed: nonEmpty(placed)!,
        ...optionalCounts('displaced', displaced),
        variant: 'basic',
        flipped: false,
        at: 'pointer',
    } as const
    assert.deepEqual(keysOf(accepted({ id: 'nse.object.paste', data }).data), [
        'placed',
        'variant',
        'flipped',
        'at',
    ])
    // With a replaced BPM the key appears.
    const [oldBpm] = addBpm(createTransaction(baseState()), { beat: 4, bpm: 90, meter: 4 })
    const replaced = optionalCounts('displaced', countNativeEntities([oldBpm!]))
    assert.deepEqual(replaced, { displaced: { bpm: 1 } })
    accepted({ id: 'nse.object.paste', data: { ...data, ...replaced } })
    // Nothing placed has no data at all: the producer leaves no step (browser spec).
    assert.equal(nonEmpty(countNativeEntities([])), undefined)
})

test('object.brush and property.set: zero change, one kind, mixed kinds and a collateral Beat edit', () => {
    const source = withNotes([{}, { beat: 4 }])
    // Zero change: no receipt, so the producer pushes no step.
    assert.equal(planEdit(source, source.selectedEntities, { size: 3 }).receipt, undefined)
    // One kind.
    const single = planEdit(source, source.selectedEntities, { isCritical: true }).receipt!
    assert.deepEqual(single.changed, { note: 2 })
    accepted({ id: 'nse.object.brush', data: single })
    accepted({ id: 'nse.property.set', data: single })
    // Mixed kinds.
    const initial = bpmAt(source, 0)[0]!
    const mixed = planEdit(source, [...source.selectedEntities, initial], {
        size: 4,
        bpm: 150,
    }).receipt!
    assert.equal(mixed.subject, 'objects')
    accepted({ id: 'nse.property.set', data: mixed })
    // Collateral: a Beat edit that moves the initial BPM along with a note puts it back at 0.
    const moved = planEdit(source, [source.selectedEntities[0]!, initial], { beat: 6 })
    assert.deepEqual(moved.receipt?.changed, { note: 1, bpm: 1 })
    assert.equal(moved.receipt?.retainedInitialBpm, true)
    assert.equal(bpmAt(moved.state, 0).length, 1)
    accepted({ id: 'nse.property.set', data: moved.receipt! })
    // Neither pending case stores an empty map.
    for (const receipt of [single, mixed]) assert.equal('displaced' in receipt, false)
})

test('object.delete and object.cut: counts are what left the grid, and nothing removable is valid data', () => {
    const source = withNotes([{}, { beat: 4 }])
    const bpmTx = createTransaction(source)
    const [extra] = addBpm(bpmTx, { beat: 6, bpm: 90, meter: 4 })
    const withExtra = bpmTx.commit([...source.selectedEntities, extra!])
    const entities = [...withExtra.selectedEntities]
    const transaction = createTransaction(withExtra)
    for (const entity of entities) {
        if (entity.type === 'note') removeNote(transaction, entity)
        if (entity.type === 'bpm') removeBpm(transaction, entity)
    }
    const result = transaction.commit([])
    const removed = countNativeEntities(removedEntities(withExtra, result, entities))
    assert.deepEqual(removed, { note: 2, bpm: 1 })
    accepted({ id: 'nse.object.delete', data: { removed } })
    accepted({ id: 'nse.object.cut', data: { removed } })
    // An entity that did not leave the grid is not counted, whatever was asked.
    assert.deepEqual(removedEntities(withExtra, withExtra, entities), [])
    accepted({ id: 'nse.object.delete', data: { removed: countNativeEntities([]) } })
})

// A chart with one BPM at beat 4 beside the selection, for the flip and scale cases.
const withOccupied = () => {
    const transaction = createTransaction(baseState())
    const slide = createSlideId()
    const [note] = addNote(transaction, slide, noteObject({ beat: 6 }))
    const [moving] = addBpm(transaction, { beat: 2, bpm: 90, meter: 4 })
    const [occupant] = addBpm(transaction, { beat: 6, bpm: 140, meter: 4 })
    const source = transaction.commit([note!, moving!])
    return { source, note: note!, moving: moving!, occupant: occupant! }
}

test('object.flip: horizontal records nothing else, vertical records the occupant it replaced', () => {
    const { source } = withOccupied()
    const result = flipVerticalWithReceipt(source, source.selectedEntities)
    assert.deepEqual(result.counts, { note: 1, bpm: 1 })
    assert.deepEqual(countNativeEntities(result.displaced), { bpm: 1 })
    assert.equal(result.retainedInitialBpm, false)
    const vertical = accepted({
        id: 'nse.object.flip',
        data: {
            axis: 'vertical',
            ...changedData(result.counts, 'objects', result),
        },
    })
    assert.deepEqual(vertical.data, {
        axis: 'vertical',
        subject: 'objects',
        changed: { note: 1, bpm: 1 },
        displaced: { bpm: 1 },
    })
    accepted({
        id: 'nse.object.flip',
        data: { axis: 'horizontal', ...changedData({ note: 2 }, 'objects') },
    })
    // A flip that moved the initial BPM puts it back, and says so.
    const transaction = createTransaction(baseState())
    const [note] = addNote(transaction, createSlideId(), noteObject({ beat: 4 }))
    const initialSource = transaction.commit([note!, bpmEntity(baseState(), 0)])
    const flipped = flipVerticalWithReceipt(
        { ...initialSource, selectedEntities: [note!, ...bpmAt(initialSource, 0)] },
        [note!, ...bpmAt(initialSource, 0)],
    )
    assert.equal(flipped.retainedInitialBpm, true)
    accepted({
        id: 'nse.object.flip',
        data: { axis: 'vertical', ...changedData(flipped.counts, 'objects', flipped) },
    })
})

test('object.scale: beats record the occupant it replaced, width records none', () => {
    // The note holds the pivot at beat 2; the BPM at 4 lands on the one at 6.
    const transaction = createTransaction(baseState())
    const [note] = addNote(transaction, createSlideId(), noteObject({ beat: 2 }))
    const [moving] = addBpm(transaction, { beat: 4, bpm: 90, meter: 4 })
    addBpm(transaction, { beat: 6, bpm: 140, meter: 4 })
    const source = transaction.commit([note!, moving!])
    const result = scaleSelectionWithReceipt(source, [note!, moving!], 'beat', 2, 2)
    assert.deepEqual(countNativeEntities(result.displaced), { bpm: 1 })
    const beats = accepted({
        id: 'nse.object.scale',
        data: {
            axis: 'beats',
            transform: { mode: 'uniform', factor: 2, pivot: 2 },
            ...changedData(result.counts, 'objects', result),
        },
    })
    assert.deepEqual(beats.data.displaced, { bpm: 1 })
    const width = scaleSelectionWithReceipt(source, [note!], 'width', 2, -2)
    assert.equal(width.displaced.length, 0)
    accepted({
        id: 'nse.object.scale',
        data: {
            axis: 'width',
            transform: { mode: 'composed' },
            ...changedData(width.counts, 'objects', width),
        },
    })
})

test('header.set, bgm.change, owner.rename and owner.set come from the label builders', () => {
    accepted(initialLifeInput(1000, 900))
    accepted(bgmOffsetInput(0, 0.25))
    const same = { buffer: {}, filename: 'a.mp3', offset: 0 }
    assert.equal(bgmInput(same, { ...same, offset: 1 }).id, 'nse.header.set')
    const changed = accepted(bgmInput(same, { buffer: {}, filename: 'b.mp3', offset: 1 }))
    assert.equal(changed.id, 'nse.bgm.change')
    accepted(bgmInput({ offset: 0 }, { buffer: {}, filename: 'b.mp3', offset: 0 }))
    const group = { name: 'Lead', forceNoteSpeed: 1 }
    assert.equal(accepted(groupEditInput(1, group, 'name', 'Lead 2')).id, 'nse.owner.rename')
    assert.equal(accepted(groupEditInput(1, group, 'forceNoteSpeed', 2)).id, 'nse.owner.set')
    const stage = {
        name: 'Main',
        isFromStart: true,
        isUntilEnd: true,
        generateSimLines: 'global',
    } as const
    assert.equal(accepted(stageEditInput(1, stage, 'name', 'Main 2')).id, 'nse.owner.rename')
    for (const key of ['isFromStart', 'isUntilEnd', 'generateSimLines'] as const)
        assert.equal(
            accepted(stageEditInput(1, stage, key, key === 'generateSimLines' ? 'isolated' : false))
                .id,
            'nse.owner.set',
        )
})

test('levelInfo.set: one Apply of the Level Info dialog is one step, built from the two level infos', () => {
    const before = { ...emptyLevelInfo, title: 'Old', tags: [{ title: 'a' }], rating: 3 }
    const after = { ...emptyLevelInfo, title: 'New', tags: [{ title: 'a' }, { title: 'b' }] }
    const receipt = levelInfoInput(before, after, { before: 1000, after: 900 })
    assert(receipt)
    assert.equal(accepted(receipt).id, 'nse.levelInfo.set')
    // A lone Initial Life change keeps nse.header.set, and no change pushes no step.
    assert.equal(
        accepted(levelInfoInput(before, before, { before: 1, after: 2 })!).id,
        'nse.header.set',
    )
    assert.equal(levelInfoInput(before, before, { before: 1, after: 1 }), undefined)
})

test('dynamicStages.enable: the default events are counted from what was added', () => {
    const transaction = createTransaction(baseState())
    const created: Entity[] = []
    for (const kind of kinds.filter(({ name }) => ['mask', 'pivot', 'style'].includes(name)))
        created.push(...add(transaction, kind, 0, 0, 1))
    const data = { created: countNativeEntities(created) }
    assert.deepEqual(data, {
        created: { stageMaskEvent: 1, stagePivotEvent: 1, stageStyleEvent: 1 },
    })
    accepted({ id: 'nse.dynamicStages.enable', data })
})

test('owner.duplicate: the copies of the objects are counted, and nothing copied adds no key', () => {
    const base = withNotes([{}, { beat: 4 }])
    const tx = createTransaction(base)
    addTimeScale(tx, scaleObject(2))
    const source = tx.commit([...base.selectedEntities])
    source.groups = new Map(source.groups).set(groupId(3), { name: 'Copy' })
    const copy = duplicateOwnedWithReceipt(source, {
        key: 'groupId',
        copies: new Map([[groupId(1), groupId(3)]]),
    })
    assert.deepEqual(copy.objects, { note: 2, timeScale: 1 })
    const data = {
        domain: 'group',
        created: ownerCountsOf('group', 1)!,
        ...optionalCounts('objects', copy.objects),
    } as const
    accepted({ id: 'nse.owner.duplicate', data })
    const empty = duplicateOwnedWithReceipt(source, {
        key: 'groupId',
        copies: new Map([[groupId(2), groupId(3)]]),
    })
    assert.deepEqual(empty.objects, {})
    assert.deepEqual(optionalCounts('objects', empty.objects), {})
    // Nothing created at all: no counts, so the manager makes no step.
    assert.equal(ownerCountsOf('group', 0, 0), undefined)
    assert.deepEqual(ownerCountsOf('stage', 2, 1), { stage: 2, stageFolder: 1 })
})

test('origin, continue, restore, recovery and the file events carry their own fields only', () => {
    accepted({ id: 'nse.origin', data: { origin: 'new' } })
    accepted({ id: 'nse.origin', data: { origin: 'import', source: captureName('song.sus') } })
    accepted({ id: 'nse.continue', data: { fromTime: 1_600_000_000_000 } })
    accepted({ id: 'nse.restore', data: { targetTime: 1_600_000_000_000 } })
    accepted({ id: 'nse.recovery', data: { droppedSteps: 0 } })
    accepted({ id: 'nse.file.save', data: { file: captureName('a.nse'), delivery: 'file' } })
    accepted({ id: 'nse.file.export', data: { file: captureName('a.scp'), delivery: 'download' } })
    accepted({ id: 'nse.externalChange', data: {} })
})

// The owner operations that the manager makes need its Vue components, so they cannot run here.
// One browser test runs their producers, asserts that each id comes out known and decoded, and
// fails when the registry holds an owner id that neither it nor a receipt here covers. This file
// checks that the test is declared, with each of the ids in its body, rather than that an id is
// mentioned anywhere in a spec.
const managerSpec = 'historyManagerProducers.spec.ts'
const managerTest = 'every owner operation id comes out of a manager producer, known and decoded'
const browserCovered = [
    'nse.owner.create',
    'nse.owner.move',
    'nse.owner.moveMany',
    'nse.owner.delete',
    'nse.owner.ungroup',
]

test('every operation id has a receipt test, in this file or in the browser test that runs its producer', () => {
    const text = readFileSync(new URL(`../browser/${managerSpec}`, import.meta.url), 'utf8')
    const declaration = `\ntest('${managerTest}'`
    const start = text.indexOf(declaration)
    assert(start >= 0, `${managerSpec} declares no test named "${managerTest}"`)
    // The test ends where the next top-level statement starts.
    const end = text.indexOf('\n})\n', start)
    const body = text.slice(start + 1, end)
    for (const id of browserCovered) {
        assert(body.includes(`'${id}'`), `"${managerTest}" does not check ${id}`)
        seen.add(id)
    }
    assert.deepEqual([...seen].sort(), Object.keys(operationCodecs).sort())
    assert.equal(seen.size, 36)
})
