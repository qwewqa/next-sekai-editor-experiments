import assert from 'node:assert/strict'
import test from 'node:test'
import { addToFolders } from '../../../src/chart/folders'
import { addToStages } from '../../../src/chart/stages'
import { serializeEditorMetadata } from '../../../src/levelData/editorMetadata'
import { serializeToLevelData } from '../../../src/levelData/serialize'
import { extractChart } from '../../../src/local/records/extract'
import { levelDataMatchesState } from '../../../src/local/records/normalised'
import {
    chartToRecords,
    fromRecords,
    stateFromRecords,
    toRecords,
} from '../../../src/local/records/records'
import type { State } from '../../../src/state'
import { createSlideId } from '../../../src/state/entities/slides'
import { addCameraEventJoint } from '../../../src/state/mutations/events/camera'
import { addStageMaskEventJoint } from '../../../src/state/mutations/events/stage/mask'
import { addNote, replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction, type Transaction } from '../../../src/state/transaction'
import {
    camera,
    edgeChart,
    goldenChart,
    mask,
    mediaHash,
    note,
    recordsText,
    stateOf,
} from './charts'
import { samplePaths, sampleState } from './samples'

/** A state's level data and editor metadata, as Export and the auto save write them. */
const levelData = (state: State) => {
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

const assertRoundTrip = (state: State, name: string, { checkLevelData = true } = {}) => {
    const records = toRecords(state)
    const rebuilt = stateFromRecords(records)
    assert.equal(recordsText(toRecords(rebuilt)), recordsText(records), name)
    // One order: the extractor's chart sorts to the same records.
    assert.equal(
        recordsText(chartToRecords(extractChart(state), headerExtras(state))),
        recordsText(records),
        name,
    )
    if (checkLevelData) {
        // Level data is a function of the record set, editor metadata included.
        const before = levelData(state)
        const after = levelData(rebuilt)
        assert.equal(JSON.stringify(after.data), JSON.stringify(before.data), name)
        assert.deepEqual(after.metadata, before.metadata, name)
        // The state's own level.json matches it, and the rebuilt state.
        for (const target of [state, rebuilt])
            assert.ok(
                levelDataMatchesState(
                    before.data.entities,
                    before.data.bgmOffset,
                    before.metadata.defaultGuideColors,
                    target,
                ),
                name,
            )
    }
    // Ids are kept, so a restored state's chunks hash as before.
    assert.deepEqual([...rebuilt.groups.keys()], [...state.groups.keys()], name)
    assert.deepEqual([...rebuilt.stages.keys()], [...state.stages.keys()], name)
    assert.deepEqual(rebuilt.levelInfo, state.levelInfo, name)
    assert.deepEqual(rebuilt.bgm.meta, state.bgm.meta, name)
    return rebuilt
}

const headerExtras = (state: State) => ({
    bgmOffset: state.bgm.offset,
    levelInfo: state.levelInfo,
    ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
})

const edit = (state: State, change: (transaction: Transaction) => void) => {
    const transaction = createTransaction(state)
    change(transaction)
    return transaction.commit([])
}

/** The track's events in chain order, as the serializer and playback walk them. */
const maskChains = (state: State) =>
    [...state.store.stageEventRanges.stageMaskEventJoint].map(([stageId, range]) => {
        const next = new Map(
            [...state.store.grid.stageMaskEventConnection.values()]
                .flatMap((bucket) => [...bucket])
                .map(({ min, max }) => [min, max]),
        )
        const chain: string[] = []
        for (let joint: typeof range.min | undefined = range.min; joint; joint = next.get(joint))
            chain.push(`${joint.beat}:${joint.maskLeft}:${joint.maskSize}`)
        return [stageId, chain]
    })

test('records round-trip every sample level', () => {
    for (const path of samplePaths) assertRoundTrip(sampleState(path), path)
})

test('records round-trip the golden and edge charts, and fromRecords returns the golden chart', () => {
    const golden = goldenChart()
    assertRoundTrip(stateOf(golden), 'golden')
    const content = fromRecords(toRecords(stateOf(golden)))
    assert.deepEqual(content.chart, golden.chart)
    assert.equal(content.offset, golden.offset)
    assert.deepEqual(content.levelInfo, golden.extras.levelInfo)
    assert.deepEqual(content.bgm, golden.extras.bgm)

    const edge = stateOf(edgeChart())
    // The edge chart holds values level data refuses, so only its records are checked.
    const rebuilt = assertRoundTrip(edge, 'edge', { checkLevelData: false })
    // Same-beat events keep their chain order, which byte order would reverse.
    assert.deepEqual(maskChains(rebuilt), maskChains(edge))
    assert.deepEqual(maskChains(edge)[0]?.[1], ['129:-6:12', '129:-2:4'])
})

test('records round-trip after scripted edits', () => {
    let state = stateOf(goldenChart())
    const steps: [string, (state: State) => State][] = [
        [
            'notes at lane divisions 3, 5, 6, 10 and 12',
            (s) =>
                edit(s, (t) => {
                    for (const [i, n] of [3, 5, 6, 10, 12].entries()) {
                        const slideId = createSlideId()
                        addNote(t, slideId, note(20 + i, { left: 1 / n, size: 2 / n }))
                        addNote(t, slideId, note(20.5 + i, { left: 7 / n, size: 3 / n }))
                    }
                }),
        ],
        [
            'camera and mask events at lane divisions',
            (s) =>
                edit(s, (t) => {
                    for (const [i, n] of [3, 5, 6, 10, 12].entries()) {
                        addCameraEventJoint(
                            t,
                            camera(30 + i, { cameraLeft: 1 / n, cameraSize: 6 + 5 / n }),
                        )
                        addStageMaskEventJoint(
                            t,
                            mask(30 + i, { maskLeft: -1 / n, maskSize: 11 / n }),
                        )
                    }
                }),
        ],
        [
            'an attached tick and a default-coloured guide',
            (s) =>
                edit(s, (t) => {
                    const slideId = createSlideId()
                    addNote(t, slideId, note(40, { connectorType: 'guide' }))
                    addNote(t, slideId, note(41, { isAttached: true, connectorType: 'guide' }))
                    addNote(t, slideId, note(42, { connectorType: 'guide' }))
                }),
        ],
        [
            'an edit that moves a slide in insertion order',
            (s) =>
                edit(s, (t) => {
                    const first = [...s.store.slides.note.values()][0]?.[0]
                    assert.ok(first)
                    replaceNote(t, first, { ...first, size: 3, elevation: 0.75 })
                }),
        ],
        [
            'folders, stages and dynamic stages',
            (s) => {
                const stages = new Map(s.stages)
                addToStages(stages, 'Added')
                const stageFolders = new Map(s.stageFolders)
                addToFolders(stageFolders, s.groupFolders, 'Stage folder')
                return { ...s, stages, stageFolders, isDynamicStages: !s.isDynamicStages }
            },
        ],
        [
            'level info and the BGM',
            (s) => ({
                ...s,
                levelInfo: (({ cover: _, ...info }) => ({
                    ...info,
                    title: 'Edited',
                    rating: 0,
                    tags: [],
                }))(s.levelInfo),
                bgm: {
                    ...s.bgm,
                    meta: { hash: mediaHash('other'), filename: 'other.wav', size: 9, type: '' },
                },
            }),
        ],
    ]
    for (const [name, step] of steps) {
        const before = recordsText(toRecords(state))
        state = step(state)
        assert.notEqual(recordsText(toRecords(state)), before, name)
        assertRoundTrip(state, name)
    }
})
