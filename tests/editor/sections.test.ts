import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { GroupId } from '../../src/chart/groups'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import {
    orderEntities,
    raisedChains,
    toDrawSteps,
    type EntityVisibility,
    type RaisedChains,
} from '../../src/editor/canvas/ordering'
import { SectionPlanner, selectSections, type SectionPlan } from '../../src/editor/canvas/sections'
import { isEntityInBeatRange } from '../../src/editor/entities/visibility'
import { createScopeLookup } from '../../src/editor/scopeRules'
import { createState, type State } from '../../src/state'
import type { Entity, EntityType } from '../../src/state/entities'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import { replaceStagePivotEventJoint } from '../../src/state/mutations/events/stage/pivot'
import { replaceNote } from '../../src/state/mutations/slides/note'
import { replaceTimeScale } from '../../src/state/mutations/timeScale'
import type { Store } from '../../src/state/store'
import { createTransaction } from '../../src/state/transaction'

const groupA = 1 as GroupId
const groupB = 2 as GroupId
const stageA = 1 as StageId
const stageB = 2 as StageId

const note = (beat: number, left: number, groupId = groupA, stageId = stageA): NoteObject => ({
    beat,
    left,
    groupId,
    stageId,
    size: 2,
    noteStyle: 'default',
    connectorStyle: 'default',
    noteType: 'default',
    isAttached: false,
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

const fixture = (extraNotes: NoteObject[] = [], overrides: Partial<Chart> = {}) => {
    const chart: Chart = {
        initialLife: 1000,
        isDynamicStages: true,
        bpms: [
            { beat: 0, bpm: 120 },
            { beat: 16, bpm: 180 },
        ],
        groups: new Map([
            [groupA, { name: 'A' }],
            [groupB, { name: 'B' }],
        ]),
        stages: new Map(
            [stageA, stageB].map((id) => [
                id,
                {
                    name: String(id),
                    isFromStart: true,
                    isUntilEnd: true,
                    generateSimLines: 'global',
                },
            ]),
        ),
        cameraEvents: [],
        stageMaskEvents: [],
        stagePivotEvents: [],
        stageStyleEvents: [],
        stageTransformEvents: [0, 64].map((beat) => ({
            stageId: stageA,
            beat,
            rotation: 0,
            xTranslation: beat / 16,
            yTranslation: 0,
            elevation: 0,
            anchor: 'default',
            eventEase: 'linear',
        })),
        timeScales: [0, 16, 32].flatMap((beat) =>
            [groupA, groupB].map((groupId) => ({
                groupId,
                beat,
                editorLane: 0,
                timeScale: 1,
                skip: 0,
                timeScaleEase: 'linear',
                timeScaleTransition: 'timeScale',
                hideNotes: false,
            })),
        ),
        slides: [
            [note(0, -4), note(64, -2)],
            [note(0, 1, groupB, stageB), note(32, 3, groupB, stageB)],
            [note(0.5, -3)],
            [note(16, -1)],
            [note(16, 1)],
            [note(16, 3, groupB, stageB)],
            [note(32, 0)],
            [note(48, 2)],
            ...extraNotes.map((note) => [note]),
        ],
        ...overrides,
    }
    return createState(chart, 0)
}

const visibilityOf = (state: State): EntityVisibility => ({
    scope: createScopeLookup({}),
    visibilities: Object.fromEntries(
        Object.keys(state.store.grid).map((type) => [type, true]),
    ) as Record<EntityType, boolean>,
    showOtherObjects: true,
})

// This is the pre-section cullGrids traversal in history/store.ts. Importing
// that module would also initialize the browser-only editor and settings.
// Keep the viewport-first traversal independent from the planner's all-chart walk.
const oldVisibleSteps = (
    source: Store,
    min: number,
    max: number,
    selected: ReadonlySet<Entity>,
    visibility: EntityVisibility,
    chains: RaisedChains,
    minKey = Math.floor(min),
    maxKey = Math.floor(max),
) => {
    const culled = new Set<Entity>()
    for (const grid of Object.values(source.grid))
        for (let key = minKey; key <= maxKey; key++)
            for (const entity of grid.get(key) ?? []) culled.add(entity)
    return toDrawSteps(
        orderEntities(
            [...culled].filter((entity) => isEntityInBeatRange(entity, min, max)),
            selected,
            visibility,
            chains,
        ),
    )
}

const assertSelection = (
    plan: SectionPlan,
    min: number,
    max: number,
    selected: ReadonlySet<Entity>,
    visibility: EntityVisibility,
    chains: RaisedChains,
    minKey = Math.floor(min),
    maxKey = Math.floor(max),
) => {
    const expected = oldVisibleSteps(
        plan.source,
        min,
        max,
        selected,
        visibility,
        chains,
        minKey,
        maxKey,
    )
    const actual = selectSections(plan, min, max, minKey, maxKey)
    assert.deepEqual(actual.objects, expected.objects, 'exact body painter order and opacity')
    assert.deepEqual(actual.labels, expected.labels, 'BPM labels remain below time-scale labels')
    assert.equal(
        actual.raisedAt,
        expected.raisedAt,
        'normal and raised passes have the same boundary',
    )
    assert.deepEqual([...actual.owners], [...new Set(expected.objects.map(({ entity }) => entity))])
    assert.deepEqual(
        actual.sections.flatMap((section) => actual.visibleBySection.get(section) ?? []),
        expected.objects,
        'visible metadata follows the complete section order',
    )
    return actual
}

test('section selection preserves inclusive fractional boundaries without rebuilding the source plan', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const planner = new SectionPlanner()
    const plan = planner.build(state.store, selected, visibility, chains)
    const references = [...plan.sections, ...plan.labelSections]
    for (const [min, max] of [
        [-1, -0.001],
        [0, 0],
        [0.499, 0.5],
        [0.5, 0.5],
        [0.501, 15.999],
        [15.999, 16],
        [16, 16],
        [16.001, 17],
        [31.999, 32],
        [32, 32],
        [63.999, 64],
        [64.001, 80],
    ]) {
        assert.ok(min !== undefined && max !== undefined)
        assertSelection(plan, min, max, selected, visibility, chains)
    }
    assert.equal(planner.stats.builds, 1)
    assert.deepEqual([...plan.sections, ...plan.labelSections], references)
    const again = planner.build(state.store, selected, visibility, chains)
    assert.equal(again.sections.length + again.labelSections.length, references.length)
    for (const [index, section] of [...again.sections, ...again.labelSections].entries())
        assert.equal(section, references[index], 'unchanged sections retain object identity')
    assert.equal(new Set(references.map(({ key }) => key)).size, references.length)
})

test('a viewport inside long connectors and event connections retains crossing geometry exactly once', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const plan = new SectionPlanner().build(state.store, selected, visibility, chains)
    const actual = assertSelection(plan, 20.25, 20.75, selected, visibility, chains)
    const connectors = actual.objects.filter(({ entity }) => entity.type === 'connector')
    assert.equal(connectors.length, 2)
    assert.equal(
        actual.objects.filter(({ entity }) => entity.type === 'stageTransformEventConnection')
            .length,
        1,
    )
    assert.ok(actual.objects.every(({ entity }) => entity.type !== 'note'))
    assert.equal(new Set(actual.objects.map(({ entity }) => entity)).size, actual.objects.length)
    for (const step of connectors) {
        const section = actual.sections.find(({ steps }) => steps.includes(step))
        assert.ok(section && section.minBeat === 0 && section.maxBeat >= 32)
        assert.ok(section.steps.length > 0)
    }
})

test('equal-beat order, selection, raised chains, dimmed scopes and hidden types match the existing painter', () => {
    const state = fixture()
    const notes = [...state.store.slides.note.values()].flat()
    const tied = notes.filter(({ beat }) => beat === 16)
    assert.equal(tied.length, 3)
    const joint = [...state.store.grid.stageTransformEventJoint.get(0)!][0]!
    const all = visibilityOf(state)
    const dimmed: EntityVisibility = {
        ...all,
        scope: createScopeLookup({ groupId: groupA, stageId: stageA }),
        visibilities: { ...all.visibilities, timeScale: false },
    }
    const hidden: EntityVisibility = {
        ...dimmed,
        scope: createScopeLookup({
            groupId: groupA,
            stageId: stageA,
            showOtherGroups: false,
            showOtherStages: false,
        }),
        showOtherObjects: false,
    }
    for (const visibility of [all, dimmed, hidden])
        for (const selected of [new Set<Entity>(), new Set<Entity>([tied[1]!, joint])]) {
            const chains = raisedChains(selected, ['timeScale', groupA])
            const plan = new SectionPlanner().build(state.store, selected, visibility, chains)
            for (const [min, max] of [
                [0, 64],
                [16, 16],
                [15.9, 16.1],
                [31, 33],
            ]) {
                assert.ok(min !== undefined && max !== undefined)
                assertSelection(plan, min, max, selected, visibility, chains)
            }
        }
    const plan = new SectionPlanner().build(state.store, new Set(), all, raisedChains([]))
    const actual = selectSections(plan, 16, 16)
    assert.deepEqual(
        actual.objects.filter(({ entity }) => entity.type === 'note').map(({ entity }) => entity),
        tied,
        'same-beat notes keep their stored insertion order',
    )
})

test('same-count immutable note edits replace only affected sections and undo restores exact order', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const planner = new SectionPlanner()
    const original = planner.build(state.store, selected, visibility, chains)
    const moved = [...state.store.slides.note.values()][0]![0]!
    const transaction = createTransaction(state)
    replaceNote(transaction, moved, { ...moved, left: moved.left + 1 })
    const edited = transaction.commit([])
    const next = planner.build(edited.store, selected, visibility, chains)
    assert.equal(
        next.sections.reduce((count, section) => count + section.steps.length, 0),
        original.sections.reduce((count, section) => count + section.steps.length, 0),
    )
    const oldSections = new Map(original.sections.map((section) => [section.key, section]))
    let reused = 0
    let replaced = 0
    for (const section of next.sections) {
        const old = oldSections.get(section.key)
        assert.ok(old)
        if (old.steps.every((step, index) => step.entity === section.steps[index]?.entity)) {
            assert.equal(section, old)
            reused++
        } else {
            assert.notEqual(section, old, 'unchanged counts cannot hide new entity identities')
            replaced++
        }
    }
    assert.ok(reused > 0 && replaced > 0)
    for (const [index, section] of next.labelSections.entries())
        assert.equal(
            section,
            original.labelSections[index],
            'unrelated labels retain their sections',
        )
    assertSelection(next, 0, 64, selected, visibility, chains)
    const undo = planner.build(state.store, selected, visibility, chains)
    assertSelection(undo, 0, 64, selected, visibility, chains)
    assert.deepEqual(selectSections(undo, 0, 64).objects, selectSections(original, 0, 64).objects)
})

test('same-count equal-beat insertion-order edits invalidate section references', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const planner = new SectionPlanner()
    const original = planner.build(state.store, selected, visibility, chains)
    const grid = new Map(state.store.grid.note)
    const oldBucket = [...grid.get(16)!]
    grid.set(16, new Set([...oldBucket].reverse()))
    const source: Store = { ...state.store, grid: { ...state.store.grid, note: grid } }
    const next = planner.build(source, selected, visibility, chains)
    const oldSection = original.sections.find(({ steps }) =>
        steps.some(({ entity }) => entity === oldBucket[0]),
    )
    const newSection = next.sections.find(({ steps }) =>
        steps.some(({ entity }) => entity === oldBucket[0]),
    )
    assert.ok(oldSection && newSection)
    assert.notEqual(newSection, oldSection)
    const actual = assertSelection(next, 16, 16, selected, visibility, chains)
    assert.deepEqual(
        actual.objects.filter(({ entity }) => entity.type === 'note').map(({ entity }) => entity),
        [...oldBucket].reverse(),
    )
})

test('ambiguous cross-cell connector ties use viewport-first order and remain live', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const grid = new Map(state.store.grid.connector)
    const bucket = [...grid.get(20)!]
    assert.equal(bucket.length, 2)
    assert.equal(bucket[0]!.beat, bucket[1]!.beat)
    grid.set(20, new Set([...bucket].reverse()))
    const source: Store = { ...state.store, grid: { ...state.store.grid, connector: grid } }
    const planner = new SectionPlanner()
    const plan = planner.build(source, selected, visibility, chains)
    const section = plan.sections.find(({ steps }) =>
        steps.some(({ entity }) => entity === bucket[0]),
    )
    assert.ok(section?.live, 'a fixed all-chart tie order is unsafe for this section')
    const local = assertSelection(plan, 20.25, 20.75, selected, visibility, chains)
    assert.deepEqual(
        local.objects
            .filter(({ entity }) => entity.type === 'connector')
            .map(({ entity }) => entity),
        [...bucket].reverse(),
    )
    // The editor may use a wider coarse cull window than the exact art range.
    // Its first encountered bucket must still decide equal-beat painter order.
    const padded = assertSelection(plan, 20.25, 20.75, selected, visibility, chains, 19, 21)
    assert.deepEqual(
        padded.objects
            .filter(({ entity }) => entity.type === 'connector')
            .map(({ entity }) => entity),
        bucket,
    )
    assertSelection(plan, 19, 21, selected, visibility, chains)
    assertSelection(plan, 21, 21, selected, visibility, chains)
    assert.equal(planner.stats.builds, 1)
    assert.ok(
        plan.sections.some((candidate) => !candidate.live),
        'unrelated sections stay reusable',
    )
})

test('deterministic fractional pans agree with the old traversal across section widths', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    let seed = 0x71c3a94d
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 0x100000000
    }
    for (const width of [0.5, 1, 4, 7, 8, 16, 31]) {
        const planner = new SectionPlanner(width)
        const plan = planner.build(state.store, selected, visibility, chains)
        for (let index = 0; index < 80; index++) {
            const min = random() * 70 - 2
            const max = min + random() * 25
            assertSelection(plan, min, max, selected, visibility, chains)
        }
        assert.equal(planner.stats.builds, 1)
    }
})

test('selection and visibility rebuilds reuse source order until the immutable store changes', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const reads = { keys: 0, get: 0 }
    class CountingMap<K, V> extends Map<K, V> {
        override keys() {
            reads.keys++
            return super.keys()
        }
        override get(key: K) {
            reads.get++
            return super.get(key)
        }
    }
    const source: Store = {
        ...state.store,
        grid: { ...state.store.grid, note: new CountingMap(state.store.grid.note) },
    }
    const planner = new SectionPlanner()
    const emptySelection = new Set<Entity>()
    const initial = planner.build(source, emptySelection, visibility, raisedChains(emptySelection))
    assert.ok(reads.keys > 0 && reads.get > 0, 'the first build scans source buckets')
    const afterInitial = { ...reads }
    const tied = [...state.store.grid.note.get(16)!]
    const selected = new Set<Entity>([tied[1]!])
    const selectedChains = raisedChains(selected)
    const selectionPlan = planner.build(source, selected, visibility, selectedChains)
    assert.deepEqual(reads, afterInitial, 'selection must not scan source buckets again')
    assert.deepEqual(
        selectSections(selectionPlan, 0, 64).objects,
        oldVisibleSteps(state.store, 0, 64, selected, visibility, selectedChains).objects,
        'cached source order still applies the new selection tiers',
    )
    const dimmed: EntityVisibility = {
        ...visibility,
        scope: createScopeLookup({ groupId: groupA, stageId: stageA }),
        visibilities: { ...visibility.visibilities, connector: false },
    }
    const visibilityPlan = planner.build(source, selected, dimmed, selectedChains)
    assert.deepEqual(reads, afterInitial, 'visibility must not scan source buckets again')
    assert.deepEqual(
        selectSections(visibilityPlan, 0, 64).objects,
        oldVisibleSteps(state.store, 0, 64, selected, dimmed, selectedChains).objects,
        'cached source order still applies the new opacity and scope',
    )
    const returned = planner.build(source, emptySelection, visibility, raisedChains(emptySelection))
    assert.deepEqual(reads, afterInitial, 'returning to the old settings reuses source order')
    assert.deepEqual(
        selectSections(returned, 0, 64).objects,
        selectSections(initial, 0, 64).objects,
    )

    const changedNotes = new CountingMap(state.store.grid.note)
    changedNotes.set(16, new Set([...tied].reverse()))
    const changedSource: Store = {
        ...source,
        grid: { ...source.grid, note: changedNotes },
    }
    const changed = planner.build(
        changedSource,
        emptySelection,
        visibility,
        raisedChains(emptySelection),
    )
    assert.ok(
        reads.keys > afterInitial.keys && reads.get > afterInitial.get,
        'a new immutable store must scan its source buckets',
    )
    const actual = assertSelection(
        changed,
        16,
        16,
        emptySelection,
        visibility,
        raisedChains(emptySelection),
    )
    assert.deepEqual(
        actual.objects.filter(({ entity }) => entity.type === 'note').map(({ entity }) => entity),
        [...tied].reverse(),
        'a same-count source edit must not retain the cached tie order',
    )
})

test('note selection toggles preserve exact painter order and unrelated section identities', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const tied = [...state.store.grid.note.get(16)!]
    const distant = [...state.store.grid.note.get(48)!][0]!
    const planner = new SectionPlanner()
    const initial = planner.build(state.store, new Set(), visibility, raisedChains([]))
    const unrelated = new Map(
        [...initial.sections, ...initial.labelSections]
            .filter(({ steps }) => steps.every(({ entity }) => entity.type !== 'note'))
            .map((section) => [section.key, section]),
    )
    for (const members of [[], [tied[1]!], [tied[1]!, distant], [tied[0]!], []]) {
        const selected = new Set<Entity>(members)
        const chains = raisedChains(selected)
        const plan = planner.build(state.store, selected, visibility, chains)
        assert.equal(planner.stats.sourceBuckets, 0, 'selection never reads source bucket contents')
        assert.equal(planner.stats.sourceEntities, 0)
        assert.equal(planner.stats.spanningFamilies, 0)
        assert.ok(
            planner.stats.projectedEntities <= 4,
            'only the two affected note chunks are projected',
        )
        for (const [min, max] of [
            [0, 64],
            [16, 16],
            [47.9, 48.1],
        ]) {
            assert.ok(min !== undefined && max !== undefined)
            assertSelection(plan, min, max, selected, visibility, chains)
        }
        for (const section of [...plan.sections, ...plan.labelSections])
            if (unrelated.has(section.key))
                assert.equal(
                    section,
                    unrelated.get(section.key),
                    'note selection leaves other types unchanged',
                )
    }
})

test('cross-chunk immutable point moves remove old membership and preserve undo and redo', () => {
    const original = fixture()
    const visibility = visibilityOf(original)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const moved = [...original.store.grid.note.get(48)!][0]!
    for (const width of [0.5, 4, 8, 16]) {
        for (const beat of [3.75, -0.25]) {
            const planner = new SectionPlanner(width)
            const initial = planner.build(original.store, selected, visibility, chains)
            const transaction = createTransaction(original)
            const [replacement] = replaceNote(transaction, moved, { ...moved, beat })
            assert.ok(replacement)
            const edited = transaction.commit([])
            assert.equal(
                original.store.grid.note.get(48)?.has(moved),
                true,
                'history keeps its original bucket',
            )
            assert.equal(original.store.grid.note.has(Math.floor(beat)), false)
            assert.equal(edited.store.grid.note.has(48), false, 'the old point bucket is deleted')
            assert.equal(edited.store.grid.note.get(Math.floor(beat))?.has(replacement), true)
            const dirty = new Set([Math.floor(moved.beat / width), Math.floor(beat / width)])
            const unrelated = new Map(
                [...initial.sections, ...initial.labelSections]
                    .filter(({ steps }) =>
                        steps.every(
                            ({ entity }) =>
                                entity.type !== 'note' ||
                                !dirty.has(Math.floor(entity.beat / width)),
                        ),
                    )
                    .map((section) => [section.key, section]),
            )
            for (const state of [edited, original, edited]) {
                const plan = planner.build(state.store, selected, visibility, chains)
                assert.equal(
                    plan.source,
                    state.store,
                    'live traversal uses the current committed store',
                )
                for (const [min, max] of [
                    [-1, 64],
                    [beat - 0.001, beat],
                    [beat + 0.001, beat + 0.25],
                    [48, 48],
                ]) {
                    assert.ok(min !== undefined && max !== undefined)
                    assertSelection(plan, min, max, selected, visibility, chains)
                }
                const members = plan.sections.flatMap(({ steps }) =>
                    steps.map(({ entity }) => entity),
                )
                assert.equal(members.includes(moved), state === original)
                assert.equal(members.includes(replacement), state === edited)
                for (const section of [...plan.sections, ...plan.labelSections])
                    if (unrelated.has(section.key))
                        assert.equal(
                            section,
                            unrelated.get(section.key),
                            'a point move retains unrelated chunks',
                        )
            }
        }
    }
})

test('a later spanning bucket can introduce and remove live tie ambiguity after a cached build', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const planner = new SectionPlanner()
    const initial = planner.build(state.store, selected, visibility, chains)
    const bucket = [...state.store.grid.connector.get(20)!]
    assert.equal(bucket.length, 2)
    const sectionOf = (plan: SectionPlan) =>
        plan.sections.find(({ steps }) => steps.some(({ entity }) => entity === bucket[0]))!
    assert.equal(!!sectionOf(initial).live, false)
    const grid = new Map(state.store.grid.connector)
    grid.set(20, new Set([...bucket].reverse()))
    const edited: Store = { ...state.store, grid: { ...state.store.grid, connector: grid } }
    assert.equal(
        edited.grid.connector.get(0),
        state.store.grid.connector.get(0),
        'the canonical first bucket is unchanged',
    )
    let previous = initial
    for (const source of [edited, state.store, edited]) {
        const plan = planner.build(source, selected, visibility, chains)
        const changed = sectionOf(plan)
        assert.equal(!!changed.live, source === edited)
        assert.notEqual(
            changed,
            sectionOf(previous),
            'ambiguity alone changes the retained-section contract',
        )
        for (const [min, max] of [
            [0, 0],
            [19.25, 19.75],
            [20.25, 20.75],
            [21.25, 21.75],
            [33, 40],
        ]) {
            assert.ok(min !== undefined && max !== undefined)
            assertSelection(plan, min, max, selected, visibility, chains)
        }
        assertSelection(plan, 20.25, 20.75, selected, visibility, chains, 19, 21)
        for (const section of plan.sections)
            if (section.steps.every(({ entity }) => entity.type !== 'connector'))
                assert.equal(
                    section,
                    initial.sections.find(({ key }) => key === section.key),
                )
        previous = plan
    }
})

test('whole-source replacement never retains old entities even when all chunk keys and counts match', () => {
    const original = fixture()
    const replacement = fixture()
    const visibility = visibilityOf(original)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const planner = new SectionPlanner()
    const initial = planner.build(original.store, selected, visibility, chains)
    const originalSections = new Map(
        [...initial.sections, ...initial.labelSections].map((section) => [section.key, section]),
    )
    const oldEntities = new Set(
        initial.sections.flatMap(({ steps }) => steps.map(({ entity }) => entity)),
    )
    const next = planner.build(replacement.store, selected, visibility, chains)
    assert.equal(next.source, replacement.store)
    assert.equal(next.sections.length, initial.sections.length)
    assert.equal(next.labelSections.length, initial.labelSections.length)
    for (const section of [...next.sections, ...next.labelSections]) {
        assert.ok(originalSections.has(section.key))
        assert.notEqual(section, originalSections.get(section.key))
        assert.ok(section.steps.every(({ entity }) => !oldEntities.has(entity)))
    }
    assertSelection(next, 0, 64, selected, visibility, chains)
    assertSelection(next, 20.25, 20.75, selected, visibility, chains)
    const returned = planner.build(original.store, selected, visibility, chains)
    assertSelection(returned, 0, 64, selected, visibility, chains)
})

test('transaction read clones preserve every section when bucket identities and selection stay equal', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const planner = new SectionPlanner()
    const initial = planner.build(state.store, selected, visibility, chains)
    const transaction = createTransaction(state)
    assert.equal(transaction.store.grid.note.get(16), state.store.grid.note.get(16))
    assert.equal(transaction.store.grid.connector.get(20), state.store.grid.connector.get(20))
    const copied = transaction.commit([])
    assert.notEqual(copied.store.grid.note, state.store.grid.note)
    assert.notEqual(copied.store.grid.connector, state.store.grid.connector)
    for (const [key, bucket] of state.store.grid.note)
        assert.equal(copied.store.grid.note.get(key), bucket)
    const next = planner.build(copied.store, selected, visibility, chains)
    assert.equal(next.source, copied.store)
    assert.equal(next.sections.length, initial.sections.length)
    assert.equal(next.labelSections.length, initial.labelSections.length)
    for (const [index, section] of [...next.sections, ...next.labelSections].entries())
        assert.equal(section, [...initial.sections, ...initial.labelSections][index])
    assertSelection(next, 0, 64, selected, visibility, chains)
})

test('moving a point into an occupied chunk preserves destination ties through undo and redo', () => {
    const original = fixture()
    const visibility = visibilityOf(original)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const planner = new SectionPlanner()
    const initial = planner.build(original.store, selected, visibility, chains)
    const moved = [...original.store.grid.note.get(16)!][1]!
    const beforeDestination = [...original.store.grid.note.get(32)!]
    const transaction = createTransaction(original)
    const [replacement] = replaceNote(transaction, moved, { ...moved, beat: 32 })
    assert.ok(replacement)
    const edited = transaction.commit([])
    const distant = initial.sections.find(({ steps }) =>
        steps.some(({ entity }) => entity.type === 'note' && entity.beat === 48),
    )!
    for (const state of [edited, original, edited]) {
        const plan = planner.build(state.store, selected, visibility, chains)
        for (const [min, max] of [
            [0, 64],
            [15.999, 16],
            [16.001, 17],
            [31.999, 32],
            [32.001, 33],
        ]) {
            assert.ok(min !== undefined && max !== undefined)
            assertSelection(plan, min, max, selected, visibility, chains)
        }
        const atDestination = selectSections(plan, 32, 32)
            .objects.filter(({ entity }) => entity.type === 'note')
            .map(({ entity }) => entity)
        assert.deepEqual(
            atDestination,
            state === edited ? [...beforeDestination, replacement] : beforeDestination,
        )
        const notes = plan.sections.flatMap(({ steps }) =>
            steps.filter(({ entity }) => entity.type === 'note'),
        )
        assert.equal(
            notes.filter(({ entity }) => entity === replacement).length,
            state === edited ? 1 : 0,
        )
        assert.equal(
            notes.filter(({ entity }) => entity === moved).length,
            state === original ? 1 : 0,
        )
        assert.equal(
            plan.sections.find(({ key }) => key === distant.key),
            distant,
        )
        for (const [index, section] of plan.labelSections.entries())
            assert.equal(section, initial.labelSections[index])
    }
})

test('immutable connector span extensions and shortening update clipping bounds and stored ties', () => {
    const original = fixture()
    const visibility = visibilityOf(original)
    const selected = new Set<Entity>()
    const chains = raisedChains(selected)
    const planner = new SectionPlanner()
    const initial = planner.build(original.store, selected, visibility, chains)
    const connectors = [...original.store.grid.connector.get(20)!]
    const first = connectors[0]!
    assert.equal(first.tail.beat, 64)
    const editTail = (beat: number) => {
        const transaction = createTransaction(original)
        replaceNote(transaction, first.tail, { ...first.tail, beat })
        return transaction.commit([])
    }
    const extended = editTail(80)
    const shortened = editTail(24)
    for (const state of [extended, original, shortened, original, extended]) {
        const plan = planner.build(state.store, selected, visibility, chains)
        const expectedTail = state === extended ? 80 : state === shortened ? 24 : 64
        const connectorSection = plan.sections.find(({ steps }) =>
            steps.some(({ entity }) => entity.type === 'connector' && entity.head === first.head),
        )!
        assert.equal(connectorSection.minBeat, 0)
        assert.equal(connectorSection.maxBeat, Math.max(32, expectedTail))
        for (const [min, max] of [
            [20, 20],
            [24, 24],
            [24.001, 24.001],
            [32, 32],
            [63.999, 64],
            [64.001, 65],
            [79.999, 80],
            [80.001, 81],
        ]) {
            assert.ok(min !== undefined && max !== undefined)
            const actual = assertSelection(plan, min, max, selected, visibility, chains)
            const matching = actual.objects.filter(
                ({ entity }) => entity.type === 'connector' && entity.head === first.head,
            )
            assert.equal(
                matching.length,
                min <= expectedTail ? 1 : 0,
                'crossing geometry appears once through its inclusive tail',
            )
        }
        const atTwenty = selectSections(plan, 20, 20).objects.flatMap(({ entity }) =>
            entity.type === 'connector' ? [entity.head] : [],
        )
        assert.deepEqual(
            atTwenty,
            state === original
                ? connectors.map(({ head }) => head)
                : [connectors[1]!.head, first.head],
        )
        for (const [index, section] of plan.labelSections.entries())
            assert.equal(section, initial.labelSections[index])
    }
})

test('twenty-note selection and local moves bound work to affected point chunks', (context) => {
    const state = fixture(
        Array.from({ length: 1024 }, (_, index) => note(128 + index / 4, index % 8)),
    )
    const visibility = visibilityOf(state)
    let distantReads = 0
    class CountingSet extends Set<NoteEntity> {
        override [Symbol.iterator]() {
            distantReads++
            return super[Symbol.iterator]()
        }
    }
    state.store.grid.note.set(300, new CountingSet(state.store.grid.note.get(300)))
    const planner = new SectionPlanner()
    const initial = planner.build(state.store, new Set(), visibility, raisedChains([]))
    const moving = [...state.store.grid.note.values()]
        .flatMap((bucket) => [...bucket])
        .filter(({ beat }) => beat >= 192 && beat < 197)
    assert.equal(moving.length, 20)
    const selected = new Set<Entity>(moving)
    distantReads = 0
    const selectionPlan = planner.build(state.store, selected, visibility, raisedChains(selected))
    assert.equal(distantReads, 0, 'selection does not iterate an unrelated source Set')
    assert.equal(planner.stats.sourceBuckets, 0)
    assert.equal(planner.stats.sourceEntities, 0)
    assert.equal(planner.stats.spanningFamilies, 0)
    assert.ok(
        planner.stats.projectedEntities > 0 && planner.stats.projectedEntities <= 32,
        'twenty selected notes project at most their two populated 4-beat chunks',
    )
    assert.ok(planner.stats.projectedChunks <= 2)
    context.diagnostic(`twenty-note selection: ${JSON.stringify(planner.stats)}`)
    assertSelection(selectionPlan, 0, 400, selected, visibility, raisedChains(selected))

    const transaction = createTransaction(state)
    const moved = moving.flatMap((entity) =>
        replaceNote(transaction, entity, { ...entity, beat: entity.beat + 8 }),
    )
    const edited = transaction.commit(moved)
    const replacementSelection = new Set<Entity>(edited.selectedEntities)
    distantReads = 0
    const movedPlan = planner.build(
        edited.store,
        replacementSelection,
        visibility,
        raisedChains(replacementSelection),
    )
    assert.equal(distantReads, 0, 'a local edit does not iterate an unrelated source Set')
    assert.equal(
        planner.stats.spanningFamilies,
        0,
        'unrelated long connector families are not scanned',
    )
    // Ten changed integer buckets contain eight old+new entries each. Each of
    // four dirty chunks may inspect seven conservatively padded buckets, whose
    // largest post-move population is eight. Repeated reads count toward this bound.
    const sourceVisitLimit = 10 * 8 + 4 * 7 * 8
    assert.ok(
        planner.stats.sourceEntities > 0 && planner.stats.sourceEntities <= sourceVisitLimit,
        JSON.stringify(planner.stats),
    )
    assert.ok(planner.stats.sourceBuckets <= 10 * 2 + 4 * 7)
    assert.ok(planner.stats.projectedEntities > 0 && planner.stats.projectedEntities <= 64)
    assert.ok(planner.stats.projectedChunks <= 4)
    context.diagnostic(`twenty-note move: ${JSON.stringify(planner.stats)}`)
    assertSelection(
        movedPlan,
        0,
        400,
        replacementSelection,
        visibility,
        raisedChains(replacementSelection),
    )
    assert.equal(state.store.grid.note.get(192)?.size, 4, 'the edit leaves old history intact')
    const distant = initial.sections.find(({ steps }) =>
        steps.some(({ entity }) => entity.type === 'note' && entity.beat === 300),
    )!
    assert.equal(
        movedPlan.sections.find(({ key }) => key === distant.key),
        distant,
    )

    for (const [source, members] of [
        [state.store, selected],
        [edited.store, replacementSelection],
    ] as const) {
        distantReads = 0
        const plan = planner.build(source, members, visibility, raisedChains(members))
        assert.equal(distantReads, 0, 'undo and redo do not iterate an unrelated source Set')
        assert.equal(planner.stats.spanningFamilies, 0)
        assert.ok(planner.stats.sourceEntities <= sourceVisitLimit, JSON.stringify(planner.stats))
        assert.ok(planner.stats.sourceBuckets <= 10 * 2 + 4 * 7)
        assert.ok(planner.stats.projectedEntities <= 64)
        assert.ok(planner.stats.projectedChunks <= 4)
        assertSelection(plan, 0, 400, members, visibility, raisedChains(members))
    }
})

const chainFixture = () => {
    const points = [0, 16, 32].flatMap((beat) =>
        [stageA, stageB].map((stageId, index) => ({
            beat: beat + index * 8,
            stageId,
            eventEase: 'linear' as const,
        })),
    )
    return fixture(
        Array.from({ length: 1024 }, (_, index) => note(128 + index / 4, index % 8)),
        {
            cameraEvents: [0, 16, 32].map((beat) => ({
                beat,
                cameraLeft: -6,
                cameraSize: 12,
                cameraZoom: 1,
                cameraZoomTargetLane: 0,
                cameraZoomTargetY: 0,
                cameraZoomVerticalAlign: 'default',
                cameraRotation: 0,
                cameraStageTilt: 0,
                eventEase: 'linear',
            })),
            stageMaskEvents: points.map((point) => ({
                ...point,
                maskLeft: -6,
                maskSize: 12,
                isMaskNotes: false,
            })),
            stagePivotEvents: points.map((point) => ({
                ...point,
                pivotLane: 0,
                divisionSize: 1,
                divisionParity: 'even',
                yOffset: 0,
                yOffsetBeat: 0,
            })),
            stageStyleEvents: points.map((point) => ({
                ...point,
                editorLane: 0,
                laneColor: 'default',
                judgmentLineColor: 'neutral',
                judgmentLineStyle: 'default',
                leftBorderStyle: 'default',
                rightBorderStyle: 'default',
                isFullWidth: false,
                noteAlpha: 1,
                laneAlpha: 1,
                judgmentLineAlpha: 1,
                divisionLineAlpha: 1,
            })),
            stageTransformEvents: points.map((point) => ({
                ...point,
                rotation: 0,
                xTranslation: 0,
                yTranslation: 0,
                elevation: 0,
                anchor: 'default',
            })),
            timeScales: points.map(({ beat, stageId }) => ({
                beat,
                groupId: stageId === stageA ? groupA : groupB,
                editorLane: 0,
                timeScale: 1,
                skip: 0,
                timeScaleEase: 'linear',
                timeScaleTransition: 'timeScale',
                hideNotes: false,
            })),
        },
    )
}

test('every non-note selection preserves legacy painter order without reprojecting unrelated types', () => {
    const state = chainFixture()
    const visibility = visibilityOf(state)
    const planner = new SectionPlanner()
    const initial = planner.build(state.store, new Set(), visibility, raisedChains([]))
    const noteSections = initial.sections.filter(({ steps }) => steps[0]?.entity.type === 'note')
    const entities = new Set(
        Object.values(state.store.grid).flatMap((grid) =>
            [...grid.values()].flatMap((set) => [...set]),
        ),
    )
    const types = new Set<EntityType>()
    for (const entity of entities) {
        if (entity.type === 'note') continue
        types.add(entity.type)
        for (const selected of [new Set([entity]), new Set<Entity>()]) {
            const chains = raisedChains(selected)
            const plan = planner.build(state.store, selected, visibility, chains)
            assert.equal(planner.stats.sourceEntities, 0, 'selection never rereads source buckets')
            assert.equal(planner.stats.spanningFamilies, 0)
            assert.ok(planner.stats.projectedEntities > 0 && planner.stats.projectedEntities <= 5)
            for (const section of noteSections) assert.ok(plan.sections.includes(section))
            for (const [min, max] of [
                [0, 64],
                [16, 16],
                [20.25, 20.75],
                [31.999, 32],
            ]) {
                assert.ok(min !== undefined && max !== undefined)
                assertSelection(plan, min, max, selected, visibility, chains)
            }
        }
    }
    assert.deepEqual(
        [...types].sort(),
        Object.keys(state.store.grid)
            .filter((type) => type !== 'note')
            .sort(),
    )
})

test('same-chain selection swaps and partial deselection project only changed highlight chunks', () => {
    const state = chainFixture()
    const visibility = visibilityOf(state)
    for (const type of ['stagePivotEventJoint', 'timeScale'] as const) {
        const planner = new SectionPlanner()
        const [a, b, c] = [0, 16, 32].map((beat) => [...state.store.grid[type].get(beat)!][0]!)
        assert.ok(a && b && c)
        let previous = planner.build(state.store, new Set(), visibility, raisedChains([]))
        for (const [members, expectedEntities] of [
            [[a], type === 'timeScale' ? 3 : 5],
            [[b], 2],
            [[b, c], 1],
            [[c], 1],
            [[], type === 'timeScale' ? 3 : 5],
        ] as const) {
            const selected = new Set<Entity>(members)
            const chains = raisedChains(selected)
            const plan = planner.build(state.store, selected, visibility, chains)
            assert.equal(planner.stats.projectedEntities, expectedEntities)
            assert.equal(planner.stats.sourceEntities, 0)
            assertSelection(plan, 0, 64, selected, visibility, chains)
            if (expectedEntities <= 2)
                for (const section of previous.sections.filter(({ steps }) =>
                    steps.some(({ entity }) => entity.type.endsWith('Connection')),
                ))
                    assert.ok(
                        plan.sections.includes(section),
                        'unchanged raised connections stay retained',
                    )
            previous = plan
        }
    }
})

test('tool all/subset transitions project only chains whose raised status changes', () => {
    const state = chainFixture()
    const visibility = visibilityOf(state)
    const planner = new SectionPlanner()
    const selected = new Set<Entity>()
    let previous = planner.build(state.store, selected, visibility, raisedChains([]))
    for (const [key, expectedEntities] of [
        ['all', 10],
        [stageA, 5],
        ['all', 5],
        [stageB, 5],
        [999 as StageId, 5],
        [998 as StageId, 0],
    ] as const) {
        const chains = raisedChains(selected, ['stagePivotEventJoint', key])
        const plan = planner.build(state.store, selected, visibility, chains)
        assert.equal(planner.stats.projectedEntities, expectedEntities)
        assert.equal(planner.stats.sourceEntities, 0)
        for (const section of [...previous.sections, ...previous.labelSections].filter(
            ({ steps }) => steps.every(({ entity }) => !entity.type.startsWith('stagePivot')),
        ))
            assert.ok([...plan.sections, ...plan.labelSections].includes(section))
        assertSelection(plan, 0, 64, selected, visibility, chains)
        previous = plan
    }
})

test('selection changes between joints, connections and chain families retain exact ordering', () => {
    const state = chainFixture()
    const visibility = visibilityOf(state)
    const pivotA = [...state.store.grid.stagePivotEventJoint.get(0)!][0]!
    const connectionA = [...state.store.grid.stagePivotEventConnection.get(0)!][0]!
    const pivotB = [...state.store.grid.stagePivotEventJoint.get(8)!][0]!
    const maskB = [...state.store.grid.stageMaskEventJoint.get(8)!][0]!
    const timeA = [...state.store.grid.timeScale.get(0)!][0]!
    const timeB = [...state.store.grid.timeScale.get(8)!][0]!
    const planner = new SectionPlanner()
    planner.build(state.store, new Set(), visibility, raisedChains([]))
    for (const [members, expectedEntities] of [
        [[pivotA], 5],
        [[connectionA], 2],
        [[connectionA, pivotB], 5],
        [[pivotB, timeA], 8],
        [[maskB, timeB], 16],
        [[], 8],
    ] as const) {
        const selected = new Set<Entity>(members)
        const chains = raisedChains(selected)
        const plan = planner.build(state.store, selected, visibility, chains)
        assert.equal(planner.stats.projectedEntities, expectedEntities)
        assert.equal(planner.stats.sourceEntities, 0)
        assertSelection(plan, 0, 64, selected, visibility, chains)
        assertSelection(plan, 4.25, 4.75, selected, visibility, chains)
    }
})

test('same-chunk stage/group edits refresh chain membership through undo and redo', () => {
    const original = chainFixture()
    const visibility = visibilityOf(original)
    const pivot = [...original.store.grid.stagePivotEventJoint.get(16)!][0]!
    const timeScale = [...original.store.grid.timeScale.get(16)!][0]!
    const transaction = createTransaction(original)
    const [nextPivot] = replaceStagePivotEventJoint(transaction, pivot, {
        ...pivot,
        stageId: stageB,
    })
    const [nextTimeScale] = replaceTimeScale(transaction, timeScale, {
        ...timeScale,
        groupId: groupB,
    })
    assert.ok(nextPivot && nextTimeScale)
    const edited = transaction.commit([])
    const planner = new SectionPlanner()
    const selected = new Set<Entity>()
    for (const state of [original, edited, original, edited]) {
        planner.build(state.store, selected, visibility, raisedChains([]))
        for (const key of [stageA, stageB, 'all'] as const) {
            // Raise B directly from none after reassignment: stale cached A
            // membership must not accidentally invalidate this chunk anyway.
            planner.build(state.store, selected, visibility, raisedChains([]))
            const chains: RaisedChains = new Map<
                'stagePivotEventJoint' | 'timeScale',
                Set<StageId | GroupId> | 'all'
            >([
                ['stagePivotEventJoint', key === 'all' ? 'all' : new Set([key])],
                ['timeScale', key === 'all' ? 'all' : new Set([key === stageA ? groupA : groupB])],
            ])
            const plan = planner.build(state.store, selected, visibility, chains)
            assert.equal(planner.stats.sourceEntities, 0)
            const actual = assertSelection(plan, 0, 64, selected, visibility, chains)
            const moved = state === edited ? [nextPivot, nextTimeScale] : [pivot, timeScale]
            for (const entity of moved) {
                const steps = [...actual.objects, ...actual.labels].filter(
                    (step) => step.entity === entity,
                )
                assert.ok(steps.length)
                assert.ok(
                    steps.every(
                        (step) =>
                            step.raised ===
                            (key === 'all' || key === (state === edited ? stageB : stageA)),
                    ),
                )
            }
        }
    }
})

test('localized selection preserves ambiguous long-span ties in viewport-first order', () => {
    const state = fixture()
    const visibility = visibilityOf(state)
    const grid = new Map(state.store.grid.connector)
    const tied = [...grid.get(20)!]
    grid.set(20, new Set([...tied].reverse()))
    const source: Store = { ...state.store, grid: { ...state.store.grid, connector: grid } }
    const planner = new SectionPlanner()
    planner.build(source, new Set(), visibility, raisedChains([]))
    for (const members of [[tied[0]!], tied, [tied[1]!], []]) {
        const selected = new Set<Entity>(members)
        const chains = raisedChains(selected)
        const plan = planner.build(source, selected, visibility, chains)
        assert.equal(planner.stats.sourceEntities, 0)
        assert.equal(planner.stats.projectedChunks, 1)
        assert.equal(planner.stats.projectedEntities, 2)
        assertSelection(plan, 20.25, 20.75, selected, visibility, chains)
        assertSelection(plan, 20.25, 20.75, selected, visibility, chains, 19, 21)
    }
})
