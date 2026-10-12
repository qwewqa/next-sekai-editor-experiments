import type { LevelDataEntity } from '@sonolus/core'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import { ImportRefusal } from '../../src/chart/refusal'
import { serializeToLevelDataEntities } from '../../src/levelData/entities/serialize'
import {
    LATEST_REVISION,
    getLevelDataRevision,
    getRevisionWarning,
} from '../../src/levelData/revision'
import { chartState, note, stageA } from './chartFixture'

const initialization = (data: LevelDataEntity['data']): LevelDataEntity[] => [
    { archetype: 'Initialization', data: [{ name: 'initialLife', value: 1000 }, ...data] },
]

const chart = (overrides: Partial<Chart> = {}): Chart => ({
    initialLife: 1000,
    isDynamicStages: true,
    bpms: [{ beat: 0, bpm: 60 }],
    groups: new Map(),
    stages: new Map(),
    cameraEvents: [],
    stageMaskEvents: [],
    stagePivotEvents: [],
    stageStyleEvents: [],
    stageTransformEvents: [],
    timeScales: [],
    slides: [[note(0)]],
    ...overrides,
})

const noteElevation = chart({ slides: [[note(0), note(1, 0, { elevation: -0.5 })]] })
const stageElevation = chart({
    stageTransformEvents: [
        {
            stageId: stageA,
            beat: 0,
            rotation: 0,
            xTranslation: 0,
            yTranslation: 0,
            elevation: 2,
            anchor: 'default',
            eventEase: 'linear',
        },
    ],
})
const flat = chart({
    slides: [[note(0, 0, { elevation: 0 })]],
    stageTransformEvents: [{ ...stageElevation.stageTransformEvents[0]!, elevation: 0 }],
})

test('the latest revision is the last revision step', () => {
    assert.equal(LATEST_REVISION, 2)
})

test('level data revision reads the Initialization value, and missing is revision 1', () => {
    assert.equal(getLevelDataRevision([]), 1)
    assert.equal(getLevelDataRevision(initialization([])), 1)
    for (const revision of [0, 1, 2, 3, 2.5]) {
        assert.equal(
            getLevelDataRevision(initialization([{ name: 'revision', value: revision }])),
            revision,
        )
    }
    // Only the first entity is the Initialization, as the parser reads it.
    assert.equal(
        getLevelDataRevision([
            { archetype: 'Stage', data: [] },
            ...initialization([{ name: 'revision', value: 2 }]),
        ]),
        1,
    )
    // A ref is not a value.
    assert.equal(getLevelDataRevision(initialization([{ name: 'revision', ref: 'x' }])), 1)
    assert.throws(
        () => getLevelDataRevision(initialization([{ name: 'revision', value: 'two' as never }])),
        (error) => error instanceof ImportRefusal && error.reason === 'invalidValue',
    )
})

test('an older revision warns only when a later revision step affects the chart', () => {
    for (const revision of [0, 1, 1.5]) {
        assert.equal(getRevisionWarning(revision, noteElevation), 'older')
        assert.equal(getRevisionWarning(revision, stageElevation), 'older')
        assert.equal(getRevisionWarning(revision, flat), undefined)
        assert.equal(getRevisionWarning(revision, chart()), undefined)
    }
    assert.equal(getRevisionWarning(2, noteElevation), undefined)
    assert.equal(getRevisionWarning(2, stageElevation), undefined)
})

test('a newer revision always warns', () => {
    for (const revision of [2.5, 3, 100]) {
        assert.equal(getRevisionWarning(revision, flat), 'newer')
        assert.equal(getRevisionWarning(revision, noteElevation), 'newer')
    }
})

test('serialized level data is the latest revision and reads back without a warning', () => {
    const state = chartState([[note(0), note(1, 0, { elevation: 3 })]])
    const entities = serializeToLevelDataEntities(
        1000,
        state.isDynamicStages,
        state.store,
        state.groups,
        state.stages,
    )
    assert.deepEqual(entities[0], {
        archetype: 'Initialization',
        data: [
            { name: 'initialLife', value: 1000 },
            { name: 'revision', value: LATEST_REVISION },
        ],
    })
    assert.equal(getLevelDataRevision(entities), LATEST_REVISION)
    assert.equal(getRevisionWarning(getLevelDataRevision(entities), noteElevation), undefined)
})
