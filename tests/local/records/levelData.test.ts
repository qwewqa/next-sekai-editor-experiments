import type { LevelDataEntity } from '@sonolus/core'
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLevelDataChart } from '../../../src/chart/parse/levelData'
import { serializeEditorMetadata } from '../../../src/levelData/editorMetadata'
import { serializeToLevelDataEntities } from '../../../src/levelData/entities/serialize'
import { serializeToLevelData } from '../../../src/levelData/serialize'
import { levelDataMatchesState } from '../../../src/local/records/normalised'
import { createState, type State } from '../../../src/state'
import { createSlideId } from '../../../src/state/entities/slides'
import { addNote } from '../../../src/state/mutations/slides/note'
import { createStore } from '../../../src/state/store/creates'
import { createTransaction } from '../../../src/state/transaction'
import { goldenChart, note, readLevelData, samplePaths, stateOf } from './charts'

const serialize = (state: State) => {
    const data = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )
    return { data, metadata: serializeEditorMetadata(data.entities, state.store) }
}

test('a sample level.json matches the state opened from it, or once saved by the editor', () => {
    for (const path of samplePaths) {
        const { bgmOffset, entities } = readLevelData(path)
        const state = createState(parseLevelDataChart(entities), bgmOffset)
        const { data, metadata } = serialize(state)
        assert.ok(
            levelDataMatchesState(data.entities, bgmOffset, metadata.defaultGuideColors, state),
            path,
        )
        // The generated chart's attached ticks hold lanes the editor recomputes on open, so only
        // its saved form matches; the others match as they are.
        assert.equal(
            levelDataMatchesState(entities, bgmOffset, undefined, state),
            !path.includes('generated-large'),
            path,
        )
    }
})

test('a level.json changed outside the editor does not match', () => {
    const state = stateOf(goldenChart())
    const { data, metadata } = serialize(state)
    const changed = structuredClone(data.entities) as LevelDataEntity[]
    const lane = changed
        .find((entity) => entity.data.some(({ name }) => name === 'segmentKind'))
        ?.data.find(({ name }) => name === 'lane')
    assert.ok(lane && 'value' in lane)
    lane.value += 1
    assert.equal(
        levelDataMatchesState(changed, data.bgmOffset, metadata.defaultGuideColors, state),
        false,
    )
    // Without the editor metadata, a default-coloured guide reads as green.
    assert.equal(levelDataMatchesState(data.entities, data.bgmOffset, undefined, state), false)
})

/** Two guides: the default-coloured one created second and earlier in beat. */
const twoGuides = () => {
    const fixture = goldenChart()
    fixture.chart.slides = []
    let state = stateOf(fixture)
    for (const [beat, connectorStyle] of [
        [8, 'red'],
        [6, 'default'],
    ] as const) {
        const transaction = createTransaction(state)
        const slideId = createSlideId()
        addNote(transaction, slideId, note(beat, { connectorType: 'guide', connectorStyle }))
        addNote(transaction, slideId, note(beat + 1, { connectorType: 'guide', connectorStyle }))
        state = transaction.commit([])
    }
    return state
}

const guideStyles = (slides: { beat: number; connectorStyle: string }[][]) =>
    slides.map((slide) => `${slide[0]?.beat}:${slide[0]?.connectorStyle}`).sort()

test('default guides keep their colours through level data, in the sorted order', () => {
    const state = twoGuides()
    // Created first, the red guide comes first in insertion order; level data sorts by beat.
    assert.deepEqual(
        [...state.store.slides.note.values()].map((notes) => notes[0]?.beat),
        [8, 6],
    )
    const { data, metadata } = serialize(state)
    assert.equal(metadata.defaultGuideColors?.length, 2)
    const parsed = parseLevelDataChart(data.entities, metadata.defaultGuideColors)
    assert.deepEqual(guideStyles(parsed.slides), ['6:default', '8:red'])
    assert.ok(
        levelDataMatchesState(data.entities, data.bgmOffset, metadata.defaultGuideColors, state),
    )
})

test('default guides keep their colours through copy and paste', () => {
    const state = twoGuides()
    // As Copy and Cut build the clipboard: a store of the copied slides, serialized without folders.
    const copiedStore = createStore(
        {
            initialLife: state.initialLife,
            isDynamicStages: state.isDynamicStages,
            bpms: [],
            timeScales: [],
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            groups: state.groups,
            stages: state.stages,
            slides: [...state.store.slides.note.values()].map((notes) => [...notes]),
        },
        state.bpms,
    )
    const entities = serializeToLevelDataEntities(
        state.initialLife,
        state.isDynamicStages,
        copiedStore,
        state.groups,
        state.stages,
    )
    const { defaultGuideColors } = serializeEditorMetadata(entities, copiedStore)
    // As paste reads it (`src/clipboard`).
    const pasted = parseLevelDataChart(entities, defaultGuideColors)
    assert.deepEqual(guideStyles(pasted.slides), ['6:default', '8:red'])
})
