import assert from 'node:assert/strict'
import test from 'node:test'
import type { StageId } from '../../src/chart/stages'
import { createState, type State } from '../../src/state'
import { cleanBeat, GLOBAL_GRID, nearGridsBeat } from '../../src/state/integrals/grid'
import { flipVertical } from '../../src/state/operations/flipVertical'
import { groupId, note } from './chartFixture'

const stageId = 1 as StageId

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

test('a vertical flip lands triplets exactly while the grid is in quarters', () => {
    const quarters = (beat: number, offset: number) => cleanBeat([GLOBAL_GRID], beat + offset, 4)
    // Placed at 1/3 steps: 0 + (1 - 2/3) carries an ulp of noise the quarter grid can't see.
    assert.notEqual(0 + (1 - 2 / 3), 1 / 3)
    const source = selectedNotes([0, 2 / 3, 1])
    assert.deepEqual(beats(flipVertical(source, source.selectedEntities)), [0, 1 - 2 / 3, 1])
    assert.deepEqual(beats(flipVertical(source, source.selectedEntities, quarters)), [0, 1 / 3, 1])
    for (const division of [3, 6, 12]) {
        for (let min = 0; min < 2 * division; min++) {
            for (let max = min + 2; max < min + 3 * division; max++) {
                for (let k = min + 1; k < max; k++) {
                    const flipped = selectedNotes([min / division, k / division, max / division])
                    assert.deepEqual(
                        beats(flipVertical(flipped, flipped.selectedEntities, quarters)),
                        [min / division, (min + max - k) / division, max / division],
                        `${min} ${k} ${max}/${division}`,
                    )
                }
            }
        }
    }
})
