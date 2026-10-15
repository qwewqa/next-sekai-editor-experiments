import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, reactive, shallowReactive, shallowRef } from 'vue'
import type { GroupId } from '../../src/chart/groups'
import type { StageId } from '../../src/chart/stages'
import type { EntityVisibility } from '../../src/editor/canvas/ordering'
import { SectionPlanner } from '../../src/editor/canvas/sections'
import { createScopeLookup, type ScopeInputs } from '../../src/editor/scopeRules'
import type { Entity, EntityType } from '../../src/state/entities'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import type { Store } from '../../src/state/store'

const groupA = 1 as GroupId
const groupB = 2 as GroupId
const stageA = 1 as StageId
const stageB = 2 as StageId

const fixture = () => {
    // Only fields consumed by the planner and pure ordering/scope rules are needed.
    const noteA = { type: 'note', beat: 1, groupId: groupA, stageId: stageA } as NoteEntity
    const noteB = { type: 'note', beat: 9, groupId: groupB, stageId: stageB } as NoteEntity
    const jointA = { type: 'stagePivotEventJoint', beat: 2, stageId: stageA } as Entity
    const jointAEnd = { type: 'stagePivotEventJoint', beat: 6, stageId: stageA } as Entity
    const jointB = { type: 'stagePivotEventJoint', beat: 3, stageId: stageB } as Entity
    const connectionA = {
        type: 'stagePivotEventConnection',
        beat: 2,
        min: jointA,
        max: jointAEnd,
    } as Entity
    const timeA = { type: 'timeScale', beat: 3, groupId: groupA } as Entity
    const timeB = { type: 'timeScale', beat: 7, groupId: groupB } as Entity
    const entities = [noteA, noteB, jointA, jointAEnd, jointB, connectionA, timeA, timeB]
    const grid: Partial<Record<EntityType, Map<number, Set<Entity>>>> = {}
    for (const entity of entities) {
        const buckets = (grid[entity.type] ??= new Map())
        const key = Math.floor(entity.beat)
        const bucket = buckets.get(key) ?? new Set<Entity>()
        bucket.add(entity)
        buckets.set(key, bucket)
    }
    const source = { grid } as Store
    const scopeInputs = shallowReactive<ScopeInputs>({
        groupId: undefined,
        stageId: undefined,
        groupVisibility: new Map(),
        stageVisibility: new Map(),
        showOtherGroups: true,
        showOtherStages: true,
        isDynamicStages: true,
    })
    // Production changes override Maps by replacement and captures a new scope lookup.
    const scope = computed(() => createScopeLookup({ ...scopeInputs }))
    const visibility = shallowReactive<EntityVisibility>({
        get scope() {
            return scope.value
        },
        visibilities: reactive(
            Object.fromEntries(Object.keys(grid).map((type) => [type, true])),
        ) as Record<EntityType, boolean>,
        showOtherObjects: true,
    })
    const selected = shallowRef<ReadonlySet<Entity>>(new Set())
    const chains = reactive(
        new Map<'stagePivotEventJoint' | 'timeScale', Set<StageId | GroupId> | 'all'>(),
    )
    const planner = new SectionPlanner()
    const plan = computed(() => planner.build(source, selected.value, visibility, chains))
    const steps = () => plan.value.sections.flatMap((section) => section.steps)
    const labels = () => plan.value.labelSections.flatMap((section) => section.steps)
    const noChangeBuild = () => {
        const before = plan.value
        const builds = planner.stats.builds
        // Force a computed evaluation while preserving the immutable selection's members.
        selected.value = new Set(selected.value)
        assert.deepEqual(plan.value, before)
        assert.equal(planner.stats.builds, builds + 1)
        assert.equal(planner.stats.projectedChunks, 0)
    }
    return {
        noteA,
        noteB,
        jointA,
        jointAEnd,
        jointB,
        connectionA,
        timeA,
        timeB,
        scopeInputs,
        visibility,
        selected,
        chains,
        planner,
        steps,
        labels,
        noChangeBuild,
    }
}

test('no-change builds retain reactive type visibility and Show Other dependencies', () => {
    const f = fixture()
    const notes = () => f.steps().filter((step) => step.entity.type === 'note')
    assert.deepEqual(
        notes().map((step) => step.opacity),
        [1, 1],
    )

    f.noChangeBuild()
    f.visibility.visibilities.note = false
    assert.deepEqual(
        notes().map((step) => step.opacity),
        [0.25, 0.25],
    )

    f.noChangeBuild()
    f.visibility.showOtherObjects = false
    assert.deepEqual(notes(), [])

    f.noChangeBuild()
    f.visibility.visibilities.note = true
    assert.deepEqual(
        notes().map((step) => step.opacity),
        [1, 1],
    )

    f.noChangeBuild()
    f.visibility.visibilities.timeScale = false
    assert.equal(
        f.steps().some((step) => step.entity.type === 'timeScale'),
        false,
    )
    assert.deepEqual(f.labels(), [])

    f.noChangeBuild()
    f.visibility.showOtherObjects = true
    assert.deepEqual(
        f.labels().map((step) => step.opacity),
        [0.25, 0.25],
    )
})

test('no-change builds retain raised-chain Map and nested Set dependencies for every part', () => {
    const f = fixture()
    const raised = (entity: Entity) => f.steps().find((step) => step.entity === entity)?.raised
    f.chains.set('stagePivotEventJoint', new Set([stageA]))
    assert.deepEqual(
        [raised(f.jointA), raised(f.jointAEnd), raised(f.connectionA)],
        [true, true, true],
    )
    assert.equal(raised(f.jointB), false)

    f.noChangeBuild()
    const stages = f.chains.get('stagePivotEventJoint')
    assert.ok(stages && stages !== 'all')
    stages.add(stageB)
    assert.equal(raised(f.jointB), true)

    f.noChangeBuild()
    stages.delete(stageA)
    assert.deepEqual(
        [raised(f.jointA), raised(f.jointAEnd), raised(f.connectionA)],
        [false, false, false],
    )
    assert.equal(raised(f.jointB), true)

    f.noChangeBuild()
    f.chains.set('timeScale', 'all')
    for (const entity of [f.timeA, f.timeB]) {
        const parts = [...f.steps(), ...f.labels()].filter((step) => step.entity === entity)
        assert.deepEqual(
            parts.map((step) => step.part),
            ['line', 'marker', 'label'],
        )
        assert.ok(parts.every((step) => step.raised && step.opacity === 1))
    }

    f.noChangeBuild()
    f.chains.delete('stagePivotEventJoint')
    assert.equal(raised(f.jointB), false)

    f.noChangeBuild()
    f.chains.clear()
    assert.ok([...f.steps(), ...f.labels()].every((step) => !step.raised))
})

test('no-change builds retain immutable scope snapshots for focus, masks, and dynamic stages', () => {
    const f = fixture()
    const opacity = (entity: Entity) => f.steps().find((step) => step.entity === entity)?.opacity
    f.noChangeBuild()
    f.scopeInputs.groupId = groupA
    assert.equal(opacity(f.noteA), 1)
    assert.equal(opacity(f.noteB), 0.25)

    f.noChangeBuild()
    f.scopeInputs.showOtherGroups = false
    assert.equal(opacity(f.noteB), undefined)

    f.noChangeBuild()
    f.scopeInputs.groupId = undefined
    assert.equal(opacity(f.noteB), 1)

    f.noChangeBuild()
    f.scopeInputs.groupVisibility = new Map([[groupA, 'hidden']])
    assert.equal(opacity(f.noteA), undefined)
    assert.equal(opacity(f.timeA), undefined)
    assert.equal(opacity(f.jointA), 1)

    f.noChangeBuild()
    f.scopeInputs.stageVisibility = new Map([[stageB, 'hidden']])
    assert.equal(opacity(f.noteB), undefined)
    assert.equal(opacity(f.jointB), undefined)
    assert.equal(opacity(f.timeB), 1)

    f.noChangeBuild()
    f.scopeInputs.isDynamicStages = false
    assert.equal(opacity(f.noteB), 1)
    assert.equal(opacity(f.jointB), 1)
    assert.equal(opacity(f.noteA), undefined)
})

test('equivalent immutable selections keep tracking later replacements without changing old plans', () => {
    const f = fixture()
    const firstSelection = new Set<Entity>([f.noteA])
    f.selected.value = firstSelection
    const first = f.steps()
    assert.deepEqual(
        first.filter((step) => step.highlighted).map((step) => step.entity),
        [f.noteA],
    )

    f.noChangeBuild()
    const secondSelection = new Set<Entity>([f.noteB])
    f.selected.value = secondSelection
    assert.deepEqual(
        f
            .steps()
            .filter((step) => step.highlighted)
            .map((step) => step.entity),
        [f.noteB],
    )
    assert.ok(f.steps().every((step) => !step.raised))
    assert.deepEqual(
        first.filter((step) => step.highlighted).map((step) => step.entity),
        [f.noteA],
    )
    assert.deepEqual([...firstSelection], [f.noteA])
    assert.deepEqual([...secondSelection], [f.noteB])

    f.noChangeBuild()
    f.selected.value = new Set()
    assert.ok(f.steps().every((step) => !step.highlighted && !step.raised))
})

test('localized non-note selections retain later nested-chain and visibility dependencies', () => {
    const f = fixture()
    const noteSteps = f.steps().filter((step) => step.entity.type === 'note')
    f.selected.value = new Set([f.jointA])
    f.chains.set('stagePivotEventJoint', new Set([stageA]))
    const selected = f.steps()
    assert.ok(selected.find((step) => step.entity === f.jointA)?.highlighted)
    assert.ok(selected.find((step) => step.entity === f.connectionA)?.raised)
    for (const step of noteSteps) assert.ok(selected.includes(step))
    assert.equal(f.planner.stats.projectedEntities, 4)

    f.noChangeBuild()
    f.selected.value = new Set([f.jointAEnd])
    const swapped = f.steps()
    assert.ok(swapped.find((step) => step.entity === f.jointAEnd)?.highlighted)
    assert.ok(swapped.find((step) => step.entity === f.jointA)?.raised)
    assert.equal(f.planner.stats.projectedEntities, 3)
    assert.equal(
        swapped.find((step) => step.entity === f.connectionA),
        selected.find((step) => step.entity === f.connectionA),
    )

    f.noChangeBuild()
    const stages = f.chains.get('stagePivotEventJoint')
    assert.ok(stages && stages !== 'all')
    stages.add(stageB)
    assert.ok(f.steps().find((step) => step.entity === f.jointB)?.raised)
    assert.equal(f.planner.stats.projectedEntities, 2)

    f.noChangeBuild()
    f.selected.value = new Set([f.timeA])
    f.chains.clear()
    f.chains.set('timeScale', new Set([groupA]))
    const parts = [...f.steps(), ...f.labels()].filter((step) => step.entity === f.timeA)
    assert.deepEqual(
        parts.map((step) => step.part),
        ['line', 'marker', 'label'],
    )
    assert.ok(parts.every((step) => step.highlighted && !step.raised))
    assert.ok(
        f
            .steps()
            .filter((step) => step.entity.type.startsWith('stagePivot'))
            .every((step) => !step.raised && !step.highlighted),
    )

    f.noChangeBuild()
    const groups = f.chains.get('timeScale')
    assert.ok(groups && groups !== 'all')
    groups.add(groupB)
    assert.ok(
        [...f.steps(), ...f.labels()]
            .filter((step) => step.entity === f.timeB)
            .every((step) => step.raised),
    )
    assert.equal(f.planner.stats.projectedEntities, 1)

    f.visibility.visibilities.note = false
    assert.ok(
        f
            .steps()
            .filter((step) => step.entity.type === 'note')
            .every((step) => step.opacity === 0.25),
    )
    f.visibility.showOtherObjects = false
    assert.equal(
        f.steps().some((step) => step.entity.type === 'note'),
        false,
    )
})
