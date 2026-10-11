import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { StagePivotEventObject } from '../../src/chart/events/stage/pivot'
import type { StageTransformEventObject } from '../../src/chart/events/stage/transform'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import { eases, type Ease } from '../../src/ease'
import { attachEasedFrac, buildPreviewChart } from '../../src/preview/engine/chart'
import { effectiveNoteElevation } from '../../src/preview/engine/elevation'
import { getStageProps } from '../../src/preview/engine/stage'
import type { State } from '../../src/state'
import { sameBeatAttachmentFraction } from '../../src/state/entities/slides/attachment'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import { removeNote } from '../../src/state/mutations/slides/note'
import { flipVertical } from '../../src/state/operations/flipVertical'
import {
    getDetachedNotePositions,
    getMaterializedNotePositions,
} from '../../src/state/operations/notePositions'
import { scaleSelection } from '../../src/state/operations/scaleSelection'
import { splitHold } from '../../src/state/operations/splitHold'
import { translateSelection } from '../../src/state/operations/translateSelection'
import { createTransaction } from '../../src/state/transaction'
import { alignComputed, shiftComputed } from '../../src/utils/math'
import { chartState, note } from './chartFixture'

const stageIds = [1, 2, 3, 4] as StageId[]

const state = (slides: NoteObject[][], overrides: Partial<Chart> = {}) =>
    chartState(slides, {
        isDynamicStages: true,
        stages: new Map(
            stageIds.map((id) => [
                id,
                {
                    name: `${id}`,
                    isFromStart: true,
                    isUntilEnd: true,
                    generateSimLines: 'global' as const,
                },
            ]),
        ),
        ...overrides,
    })

// The whole-chart compile these positions used to come from.
const compiledPositions = (source: State, notes: NoteEntity[], { translation = true } = {}) => {
    const chart = buildPreviewChart(source, 10)
    const bySource = new Map(chart.notes.map((note) => [note.source, note]))
    const positions = new Map<NoteEntity, { left: number; size: number; elevation: number }>()
    for (const note of notes) {
        const compiled = bySource.get(note)
        if (!compiled?.isAttached || !compiled.attachHead || !compiled.attachTail) continue
        const props = (index: number) => {
            const stage = chart.stages[index]
            return stage
                ? getStageProps(stage, compiled.targetTime)
                : { pivotLane: 0, xLaneTranslate: 0, elevation: 0 }
        }
        const head = compiled.attachHead
        const tail = compiled.attachTail
        const headStage = props(head.stageIndex)
        const tailStage = props(tail.stageIndex)
        const stage = props(compiled.stageIndex)
        const frac = attachEasedFrac(compiled)
        const elevationFrac = sameBeatAttachmentFraction(head.source!, tail.source!, note) ?? frac
        const headLane = head.lane + headStage.pivotLane
        const tailLane = tail.lane + tailStage.pivotLane
        const translate = translation
            ? headStage.xLaneTranslate +
              (tailStage.xLaneTranslate - headStage.xLaneTranslate) * frac -
              stage.xLaneTranslate
            : 0
        const headElevation = (head.elevation ?? 0) + headStage.elevation
        const tailElevation = (tail.elevation ?? 0) + tailStage.elevation
        positions.set(note, {
            left: shiftComputed(
                alignComputed(
                    headLane + (tailLane - headLane) * frac - stage.pivotLane - compiled.size,
                ),
                translate,
            ),
            size: alignComputed(compiled.size * 2),
            elevation: alignComputed(
                headElevation + (tailElevation - headElevation) * elevationFrac - stage.elevation,
            ),
        })
    }
    return positions
}

// A small deterministic generator, so the big chart is the same on every run.
const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
}

const synthetic = (slideCount: number, seed: number, overrides: Partial<Chart> = {}) => {
    const next = random(seed)
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
    const stage = () => pick(stageIds)
    const ease = () => pick(eases) as Ease
    const value = (scale: number) => Math.round((next() - 0.5) * scale * 64) / 64
    const slides: NoteObject[][] = []
    for (let i = 0; i < slideCount; i++) {
        const start = Math.round(next() * 400 * 4) / 4
        const sameBeat = next() < 0.15
        const length = sameBeat ? 0 : 0.25 + Math.round(next() * 16) / 4
        const ticks = 1 + Math.floor(next() * 6)
        const slide = [
            note(start, value(12), {
                stageId: stage(),
                size: 0.5 + Math.round(next() * 8) / 4,
                elevation: value(6),
                connectorEase: ease(),
            }),
        ]
        for (let k = 0; k < ticks; k++) {
            // Some ticks share the head's or tail's beat.
            const at = next()
            const beat = sameBeat
                ? start
                : at < 0.1
                  ? start
                  : at < 0.2
                    ? start + length
                    : start + Math.round(next() * length * 48) / 48
            slide.push(
                note(beat, value(12), {
                    stageId: stage(),
                    size: 0.5 + Math.round(next() * 8) / 4,
                    elevation: value(6),
                    connectorEase: ease(),
                    isAttached: next() < 0.8,
                }),
            )
        }
        slide.push(
            note(start + length, value(12), {
                stageId: stage(),
                size: 0.5 + Math.round(next() * 8) / 4,
                elevation: value(6),
                connectorEase: ease(),
            }),
        )
        slides.push(slide)
    }
    const stagePivotEvents: StagePivotEventObject[] = stageIds.flatMap((stageId) =>
        Array.from({ length: 60 }, (_, j) => ({
            stageId,
            // Some events share a beat, so their stored order decides the jump.
            beat: Math.round(j * 7 + next() * 4) / 2,
            pivotLane: value(10),
            divisionSize: 1 + Math.floor(next() * 4),
            divisionParity: next() < 0.5 ? ('odd' as const) : ('even' as const),
            yOffset: 0,
            yOffsetBeat: 0,
            eventEase: ease(),
        })),
    )
    const stageTransformEvents: StageTransformEventObject[] = stageIds.flatMap((stageId) =>
        Array.from({ length: 40 }, (_, j) => ({
            stageId,
            beat: Math.round(j * 10 + next() * 6) / 2,
            rotation: 0,
            xTranslation: value(8),
            yTranslation: 0,
            elevation: value(4),
            anchor: 'default' as const,
            eventEase: ease(),
        })),
    )
    return state(slides, {
        bpms: [
            { beat: 0, bpm: 160 },
            { beat: 37.5, bpm: 97 },
            { beat: 120, bpm: 211 },
        ],
        stagePivotEvents,
        stageTransformEvents,
        ...overrides,
    })
}

const all = (source: State) => [...source.store.slides.note.values()].flat()

const assertSame = (
    actual: Map<NoteEntity, { left: number; size: number; elevation: number }>,
    expected: Map<NoteEntity, { left: number; size: number; elevation: number }>,
) => {
    assert.equal(actual.size, expected.size)
    for (const [note, position] of expected) {
        const own = actual.get(note)
        assert.ok(own, `missing ${note.beat}`)
        for (const key of ['left', 'size', 'elevation'] as const)
            assert.ok(
                Object.is(own[key], position[key]),
                `${key} at ${note.beat}: ${own[key]} ${position[key]}`,
            )
    }
}

test('tick places match the whole-chart compile bit for bit', () => {
    for (const [seed, overrides] of [
        [1, {}],
        [2, {}],
        [3, { isDynamicStages: false }],
        [4, { stageTransformEvents: [] }],
    ] satisfies [number, Partial<Chart>][]) {
        const source = synthetic(400, seed, overrides)
        const notes = all(source)
        const expected = compiledPositions(source, notes)
        assert.ok(expected.size > 500)
        assertSame(getMaterializedNotePositions(source, notes), expected)
        // A compiled chart's stages give the same places.
        assertSame(
            getMaterializedNotePositions(source, notes, buildPreviewChart(source, 10)),
            expected,
        )
        assertSame(
            getMaterializedNotePositions(source, notes, undefined, { translation: false }),
            compiledPositions(source, notes, { translation: false }),
        )
    }
})

test('tick places on an 11k-note chart match the whole-chart compile', () => {
    const source = synthetic(2600, 11)
    const notes = all(source)
    assert.ok(notes.length > 11000)
    assertSame(getMaterializedNotePositions(source, notes), compiledPositions(source, notes))
})

test('a placed elevation is aligned like the lane and size', () => {
    // 0.3 a third of the way is 0.09999999999999999 before alignment.
    const source = state(
        [
            [
                note(0, 0, { elevation: 0 }),
                note(1, 0, { isAttached: true }),
                note(3, 0, { elevation: 0.3 }),
            ],
        ],
        { isDynamicStages: false },
    )
    const tick = all(source).find((entity) => entity.isAttached)!
    assert.equal(getMaterializedNotePositions(source, [tick]).get(tick)!.elevation, 0.1)
})

test('a detached same-beat tick keeps its stored elevation within its ends', () => {
    const slide = (elevation: number) =>
        state(
            [
                [
                    note(2, -4, { elevation: 0 }),
                    note(2, 0, { isAttached: true, elevation }),
                    note(2, 2, { elevation: 2 }),
                ],
            ],
            { isDynamicStages: false },
        )
    for (const [elevation, kept] of [
        [3, 2],
        [-1, 0],
        [1.5, 1.5],
    ]) {
        const source = slide(elevation!)
        const tick = all(source).find((entity) => entity.isAttached)!
        assert.equal(getDetachedNotePositions(source, [tick]).get(tick)!.elevation, kept)
    }
})

// One cross-stage slide: stage 1 slides its pivot and X, stage 2 sits apart.
const crossStage = () =>
    state(
        [
            [
                note(2, -4, { elevation: 1 }),
                note(4, 0, { isAttached: true }),
                note(6, -4, { stageId: stageIds[1]!, size: 3, elevation: 3 }),
            ],
        ],
        {
            stagePivotEvents: [
                {
                    stageId: stageIds[0]!,
                    beat: 0,
                    pivotLane: 0,
                    divisionSize: 1,
                    divisionParity: 'even',
                    yOffset: 0,
                    yOffsetBeat: 0,
                    eventEase: 'linear',
                },
                {
                    stageId: stageIds[0]!,
                    beat: 8,
                    pivotLane: 4,
                    divisionSize: 1,
                    divisionParity: 'even',
                    yOffset: 0,
                    yOffsetBeat: 0,
                    eventEase: 'linear',
                },
                {
                    stageId: stageIds[1]!,
                    beat: 0,
                    pivotLane: 4.5,
                    divisionSize: 1,
                    divisionParity: 'odd',
                    yOffset: 0,
                    yOffsetBeat: 0,
                    eventEase: 'linear',
                },
            ],
            stageTransformEvents: [
                {
                    stageId: stageIds[0]!,
                    beat: 0,
                    rotation: 0,
                    xTranslation: 0,
                    yTranslation: 0,
                    elevation: 0,
                    anchor: 'default',
                    eventEase: 'linear',
                },
                {
                    stageId: stageIds[0]!,
                    beat: 8,
                    rotation: 0,
                    xTranslation: 4,
                    yTranslation: 0,
                    elevation: 2,
                    anchor: 'default',
                    eventEase: 'linear',
                },
                {
                    stageId: stageIds[1]!,
                    beat: 0,
                    rotation: 0,
                    xTranslation: -3,
                    yTranslation: 0,
                    elevation: 1,
                    anchor: 'default',
                    eventEase: 'linear',
                },
            ],
        },
    )

const brief = (source: State) =>
    all(source)
        .map(({ beat, left, size, elevation, isAttached, stageId }) => ({
            beat,
            left,
            size,
            elevation,
            isAttached,
            stageId,
        }))
        .sort((a, b) => a.beat - b.beat)

// The tick's gameplay place: stored on stage 1 at left -5.25, size 2.5, elevation 2.
const kept = { left: -5.25, size: 2.5, elevation: 2, isAttached: true, stageId: stageIds[0] }

test('Scale Selection taking a tick past its head keeps the tick at its gameplay place', () => {
    const source = crossStage()
    const [, tick, tail] = all(source)
    // Anchored at the tail, tripling takes the tick from 4 to 0 and leaves the tail.
    const moved = brief(scaleSelection(source, [tick!, tail!], 'beat', 3, 6))
    assert.deepEqual(moved[0], { beat: 0, ...kept })
    assert.deepEqual(
        moved.slice(1),
        brief(source).filter((entity) => entity.beat !== 4),
    )
})

test('Scale Selection translating a tick past its tail keeps the tick at its gameplay place', () => {
    const source = crossStage()
    const [, tick] = all(source)
    const moved = brief(translateSelection(source, [tick!], 'beat', 3))
    assert.deepEqual(
        moved.slice(0, 2),
        brief(source).filter((entity) => entity.beat !== 4),
    )
    assert.deepEqual(moved[2], { beat: 7, ...kept })
})

test('Scale Selection keeping a tick inside its slide leaves it attached on the path', () => {
    const source = crossStage()
    const [, tick] = all(source)
    const moved = brief(translateSelection(source, [tick!], 'beat', 1))
    assert.deepEqual(moved[1], { ...moved[1], beat: 5, size: 2.75, elevation: 0, isAttached: true })
})

test('Flip Vertical taking a tick past its tail keeps the tick at its gameplay place', () => {
    const source = crossStage()
    const [, tick, tail] = all(source)
    // Tick and tail swap beats, so the tick ends the slide.
    const flipped = brief(flipVertical(source, [tick!, tail!]))
    assert.deepEqual(flipped[1], { ...brief(source)[2], beat: 4 })
    assert.deepEqual(flipped[2], { beat: 6, ...kept })
})

test('Flip Vertical of a whole slide leaves its tick attached on the path', () => {
    const source = crossStage()
    const flipped = brief(flipVertical(source, all(source)))
    assert.deepEqual(flipped[1], { ...brief(source)[1], beat: 4 })
})

test('the cross-stage fixture places its tick as the whole-chart compile does', () => {
    const source = crossStage()
    const notes = all(source)
    const expected = compiledPositions(source, notes)
    assert.equal(expected.size, 1)
    assertSame(getMaterializedNotePositions(source, notes), expected)
    assert.deepEqual([...expected.values()], [{ left: -5.25, size: 2.5, elevation: 2 }])
})

// Where gameplay plays a note's height: the compiled chart's effective elevation at its time.
const playedHeight = (source: State, entity: NoteEntity) => {
    const chart = buildPreviewChart(source, 10)
    const compiled = chart.notes.find((note) => note.source === entity)!
    return effectiveNoteElevation(compiled, (index) => {
        const stage = chart.stages[index]
        return stage && getStageProps(stage, compiled.targetTime)
    })
}

// Head, tick and tail at beat 2 on stages raised 0.5, 1 and 2.
const sameBeatAcrossStages = (head: number, tick: number, tail: number, isDynamicStages = true) =>
    state(
        [
            [
                note(2, -4, { elevation: head }),
                note(2, 0, { stageId: stageIds[1]!, isAttached: true, elevation: tick }),
                note(2, 2, { stageId: stageIds[2]!, elevation: tail }),
            ],
        ],
        {
            isDynamicStages,
            stageTransformEvents: [0.5, 1, 2].map((elevation, index) => ({
                stageId: stageIds[index]!,
                beat: 0,
                rotation: 0,
                xTranslation: 0,
                yTranslation: 0,
                elevation,
                anchor: 'default',
                eventEase: 'linear',
            })),
        },
    )

const sameBeatCases = [
    [0, 1, 4],
    [0, 6, 4],
    [0, -3, 4],
    [2, 1, 2],
    [3, 1.2345678901, 1],
]

// The tick as an end of its slide in the result, after Split Slide at it or deleting its head.
const detachedTicks = (source: State) => {
    const tick = all(source).find((entity) => entity.isAttached)!
    const transaction = createTransaction(source)
    removeNote(transaction, all(source)[0]!)
    return [splitHold(source, [tick]), transaction.commit([])].map((result) => {
        const note = all(result).find((entity) => entity.stageId === stageIds[1])!
        const notes = result.store.slides.note.get(note.slideId)!
        assert.ok(note === notes[0] || note === notes.at(-1))
        return { result, note }
    })
}

test('a detached same-beat tick keeps the height it played at, across stage elevations', () => {
    for (const isDynamicStages of [true, false]) {
        for (const [head, elevation, tail] of sameBeatCases) {
            const source = sameBeatAcrossStages(head!, elevation!, tail!, isDynamicStages)
            const tick = all(source).find((entity) => entity.isAttached)!
            const played = playedHeight(source, tick)
            for (const { result, note } of detachedTicks(source))
                assert.ok(Math.abs(playedHeight(result, note) - played) < 1e-9)
        }
    }
})

test('a detached same-beat tick keeps its exact stored elevation where its stages add the same height', () => {
    for (const [head, elevation, tail] of sameBeatCases) {
        const source = sameBeatAcrossStages(head!, elevation!, tail!, false)
        const tick = all(source).find((entity) => entity.isAttached)!
        const kept = Math.min(Math.max(elevation!, Math.min(head!, tail!)), Math.max(head!, tail!))
        assert.equal(getDetachedNotePositions(source, [tick]).get(tick)!.elevation, kept)
        for (const { note } of detachedTicks(source)) assert.equal(note.elevation, kept)
    }
})
