import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { EventEase } from '../../src/chart/events'
import type { StagePivotEventObject } from '../../src/chart/events/stage/pivot'
import type { StageTransformEventObject } from '../../src/chart/events/stage/transform'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import { createComposedLayout } from '../../src/editor/composed'
import type { State } from '../../src/state'
import { combineNotes } from '../../src/state/operations/combineNotes'
import { makeVertical } from '../../src/state/operations/makeVertical'
import { getMaterializedNotePositions } from '../../src/state/operations/notePositions'
import { splitHold } from '../../src/state/operations/splitHold'
import { chartState, note, stageA, stageB } from './chartFixture'

// Gameplay draws an attached note at the blend of its ends' pivot plus X translation;
// a materialized note sits at its own stage's pivot plus X translation.
const pivot = (
    stageId: StageId,
    beat: number,
    pivotLane: number,
    eventEase: EventEase = 'linear',
): StagePivotEventObject => ({
    stageId,
    beat,
    pivotLane,
    divisionSize: 1,
    divisionParity: 'even',
    yOffset: 0,
    yOffsetBeat: 0,
    eventEase,
})

const translate = (
    stageId: StageId,
    beat: number,
    xTranslation: number,
    eventEase: EventEase = 'linear',
): StageTransformEventObject => ({
    stageId,
    beat,
    rotation: 0,
    xTranslation,
    yTranslation: 0,
    elevation: 0,
    anchor: 'default',
    eventEase,
})

const state = (slides: NoteObject[][], overrides: Partial<Chart> = {}) =>
    chartState(slides, { isDynamicStages: true, ...overrides })

// The audit's fixture: A translates 0 to 8 over beats 0 to 8; B sits at pivot 4.5.
const audit = () =>
    state([[note(2, -4), note(4, 0, { isAttached: true }), note(6, -4, { stageId: stageB })]], {
        stagePivotEvents: [pivot(stageA, 0, 0), pivot(stageB, 0, 4.5)],
        stageTransformEvents: [translate(stageA, 0, 0), translate(stageA, 8, 8)],
    })

const notes = (source: State) => [...source.store.slides.note.values()].flat()
const tick = (source: State) => notes(source).find((entity) => entity.isAttached)!

// Where Composed draws a note: gameplay's lane at the note's time.
const drawn = (source: State, entity = tick(source)) => {
    const { left, size } = createComposedLayout(source).notePosition(entity)
    return left + size / 2
}

test('materialized ticks keep their drawn lane across translated stages', () => {
    const source = audit()
    const attached = tick(source)
    const position = getMaterializedNotePositions(source, [attached]).get(attached)!
    assert.deepEqual([position.left, position.size], [-3.75, 2])
    // Stage A is translated by 4 at beat 4.
    assert.equal(position.left + position.size / 2 + 4, drawn(source))
    // Lane limits read the slide's authored lanes without translation.
    const authored = getMaterializedNotePositions(source, [attached], undefined, {
        translation: false,
    }).get(attached)!
    assert.deepEqual([authored.left, authored.size], [-1.75, 2])
})

test('Split Slide, Combine Notes and Make Vertical place the tick where it was drawn', () => {
    const source = audit()
    const attached = tick(source)
    const before = drawn(source)
    const split = splitHold(source, [attached])
    const replacement = split.selectedEntities.find(
        (entity) => entity.type === 'note' && entity.beat === 4,
    )
    assert.ok(replacement?.type === 'note')
    assert.equal(replacement.left, -3.75)
    assert.equal(replacement.isAttached, false)
    assert.equal(drawn(split, replacement), before)

    const other = state(
        [
            [note(2, -4), note(4, 0, { isAttached: true }), note(6, -4, { stageId: stageB })],
            [note(5, 1, { stageId: stageB })],
        ],
        {
            stagePivotEvents: [pivot(stageA, 0, 0), pivot(stageB, 0, 4.5)],
            stageTransformEvents: [translate(stageA, 0, 0), translate(stageA, 8, 8)],
        },
    )
    const combined = combineNotes(other, notes(other))
    const combinedTick = notes(combined).find((entity) => entity.beat === 4)!
    assert.equal(combinedTick.left, -3.75)
    assert.equal(combinedTick.isAttached, false)

    const vertical = makeVertical(source, [attached, notes(source)[0]!])
    const verticalTick = notes(vertical).find((entity) => entity.elevation === 2)!
    assert.deepEqual([verticalTick.left, verticalTick.size], [-3.75, 2])
    assert.equal(verticalTick.isAttached, false)
})

test('materialized ticks match the drawn lane on moving stages and steps', () => {
    for (const ease of ['linear', 'inQuad', 'outInCubic'] as const) {
        for (const step of ['linear', 'none', 'inStep', 'outStep'] as const) {
            const source = state(
                [
                    [
                        note(1, -3, { connectorEase: ease }),
                        note(3, 1, { stageId: stageB, isAttached: true }),
                        note(3.5, -1, { isAttached: true }),
                        note(5, 2, { stageId: stageB, size: 3 }),
                    ],
                ],
                {
                    bpms: [
                        { beat: 0, bpm: 120 },
                        { beat: 2, bpm: 75 },
                    ],
                    stagePivotEvents: [
                        pivot(stageA, 0, -2),
                        pivot(stageA, 6, 5),
                        pivot(stageB, 0, 3, step),
                        pivot(stageB, 3, 1),
                    ],
                    stageTransformEvents: [
                        translate(stageA, 0, 1, step),
                        translate(stageA, 3.5, 6),
                        translate(stageB, 0, -2),
                        translate(stageB, 3, 7, step),
                        translate(stageB, 6, -3),
                    ],
                },
            )
            const attached = notes(source).filter((entity) => entity.isAttached)
            const positions = getMaterializedNotePositions(source, attached)
            const split = splitHold(source, attached)
            for (const entity of attached) {
                const position = positions.get(entity)!
                const replacement = notes(split).find((other) => other.beat === entity.beat)!
                assert.deepEqual(
                    [replacement.left, replacement.size],
                    [position.left, position.size],
                )
                assert.ok(
                    Math.abs(drawn(split, replacement) - drawn(source, entity)) < 1e-9,
                    `${ease} ${step} ${entity.beat}: ${drawn(split, replacement)} ${drawn(source, entity)}`,
                )
            }
        }
    }
})

test('ticks whose stages share their X translation materialize exactly as before', () => {
    const slides = [
        [
            note(1, -3, { connectorEase: 'inQuad' }),
            note(2.3, 0, { isAttached: true }),
            note(3.7, 0, { stageId: stageB, isAttached: true }),
            note(5, 2, { stageId: stageB, size: 3 }),
        ],
    ]
    const stagePivotEvents = [pivot(stageA, 0, -2), pivot(stageA, 6, 5), pivot(stageB, 0, 3)]
    const shared = (events: StageTransformEventObject[]) =>
        events.flatMap((event) => [event, { ...event, stageId: stageB }])
    const without = state(slides, { stagePivotEvents })
    for (const stageTransformEvents of [
        shared([translate(stageA, 0, 1.3), translate(stageA, 6, -4.9)]),
        shared([translate(stageA, 0, 2.7, 'inStep'), translate(stageA, 3, 0.1)]),
    ]) {
        const source = state(slides, { stagePivotEvents, stageTransformEvents })
        const expected = getMaterializedNotePositions(
            without,
            notes(without).filter((entity) => entity.isAttached),
        )
        const actual = getMaterializedNotePositions(
            source,
            notes(source).filter((entity) => entity.isAttached),
        )
        assert.deepEqual(
            [...actual.values()].map(({ left }) => left),
            [...expected.values()].map(({ left }) => left),
        )
        for (const [index, { left }] of [...actual.values()].entries())
            assert.ok(Object.is(left, [...expected.values()][index]!.left))
    }
})
