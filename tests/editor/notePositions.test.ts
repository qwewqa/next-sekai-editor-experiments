import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { StagePivotEventObject } from '../../src/chart/events/stage/pivot'
import type { StageTransformEventObject } from '../../src/chart/events/stage/transform'
import type { GroupId } from '../../src/chart/groups'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import { eases, type Ease } from '../../src/ease'
import { attachEasedFrac, buildPreviewChart } from '../../src/preview/engine/chart'
import { getStageProps } from '../../src/preview/engine/stage'
import { createState, type State } from '../../src/state'
import { sameBeatAttachmentFraction } from '../../src/state/entities/slides/attachment'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import {
    getDetachedNotePositions,
    getMaterializedNotePositions,
} from '../../src/state/operations/notePositions'
import { alignComputed, shiftComputed } from '../../src/utils/math'

const groupId = 1 as GroupId
const stageIds = [1, 2, 3, 4] as StageId[]

const note = (beat: number, left: number, extra: Partial<NoteObject> = {}): NoteObject => ({
    groupId,
    stageId: stageIds[0]!,
    beat,
    noteType: 'default',
    isAttached: false,
    left,
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
    ...extra,
})

const state = (slides: NoteObject[][], overrides: Partial<Chart> = {}) =>
    createState(
        {
            initialLife: 1000,
            isDynamicStages: true,
            bpms: [{ beat: 0, bpm: 60 }],
            groups: new Map([[groupId, { name: 'Default' }]]),
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
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
            slides,
            ...overrides,
        },
        0,
    )

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
