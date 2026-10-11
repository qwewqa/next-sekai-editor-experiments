import assert from 'node:assert/strict'
import test from 'node:test'
import type { GroupId } from '../../src/chart/groups'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import { createState, type State } from '../../src/state'
import { GLOBAL_GRID, nearGridsBeat } from '../../src/state/integrals/grid'
import { flipVertical } from '../../src/state/operations/flipVertical'

const groupId = 1 as GroupId
const stageId = 1 as StageId

const note = (beat: number): NoteObject => ({
    groupId,
    stageId,
    beat,
    noteType: 'default',
    isAttached: false,
    left: 0,
    size: 2,
    isCritical: false,
    flickDirection: 'none',
    isFake: false,
    noteStyle: 'default',
    connectorStyle: 'default',
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

// Single-note slides at these beats, all selected.
const selectedNotes = (beats: number[]): State => {
    const source = createState(
        {
            initialLife: 1000,
            isDynamicStages: false,
            bpms: [{ beat: 0, bpm: 120 }],
            groups: new Map([[groupId, { name: 'Default' }]]),
            stages: new Map([
                [
                    stageId,
                    {
                        name: '1',
                        isFromStart: true,
                        isUntilEnd: true,
                        generateSimLines: 'global' as const,
                    },
                ],
            ]),
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
            slides: beats.map((beat) => [note(beat)]),
        },
        0,
    )
    return { ...source, selectedEntities: [...source.store.slides.note.values()].flat() }
}

const beats = (state: State) =>
    [...state.store.slides.note.values()]
        .flat()
        .map((note) => note.beat)
        .sort((a, b) => a - b)

test('a vertical flip lands on the grid through the given cleaning, which only removes float noise', () => {
    const thirds = (beat: number, offset: number) => nearGridsBeat([GLOBAL_GRID], beat + offset, 3)
    // 1 - 1/3 carries an ulp of noise.
    assert.notEqual(1 - 1 / 3, 2 / 3)
    const source = selectedNotes([0, 1 / 3, 1])
    assert.deepEqual(beats(flipVertical(source, source.selectedEntities)), [0, 1 - 1 / 3, 1])
    assert.deepEqual(beats(flipVertical(source, source.selectedEntities, thirds)), [0, 2 / 3, 1])
    // Off the grid, a flipped beat keeps its value; the ends swap exactly.
    const off = selectedNotes([0.1, 0.37, 1.3])
    assert.deepEqual(beats(flipVertical(off, off.selectedEntities, thirds)), [
        0.1,
        0.1 + (1.3 - 0.37),
        1.3,
    ])
})
