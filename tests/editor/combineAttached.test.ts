import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { GroupId } from '../../src/chart/groups'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import { createState, type State } from '../../src/state'
import { combineNotes } from '../../src/state/operations/combineNotes'
import { getMaterializedNotePositions } from '../../src/state/operations/notePositions'

const groupId = 1 as GroupId
const stageA = 1 as StageId
const stageB = 2 as StageId

const note = (beat: number, left: number, extra: Partial<NoteObject> = {}): NoteObject => ({
    groupId,
    stageId: stageA,
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
const tick = (beat: number, extra: Partial<NoteObject> = {}) =>
    note(beat, 0, { isAttached: true, ...extra })

const state = (slides: NoteObject[][], overrides: Partial<Chart> = {}) =>
    createState(
        {
            initialLife: 1000,
            isDynamicStages: false,
            bpms: [{ beat: 0, bpm: 60 }],
            groups: new Map([[groupId, { name: 'Default' }]]),
            stages: new Map([
                [
                    stageA,
                    { name: 'A', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
                ],
                [
                    stageB,
                    { name: 'B', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
                ],
            ]),
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

const notes = (source: State) => [...source.store.slides.note.values()].flat()
const combineAll = (source: State) => {
    const combined = combineNotes(source, notes(source))
    assert.equal(combined.store.slides.note.size, 1)
    return combined
}

// Where each note plays: gameplay's place for an attached tick, else its own fields.
const played = (source: State) => {
    const all = notes(source)
    const positions = getMaterializedNotePositions(source, all)
    return all.map((entity) => {
        const { left, size, elevation } = positions.get(entity) ?? entity
        return { beat: entity.beat, left, size, elevation, attached: entity.isAttached }
    })
}
const byBeat = (values: ReturnType<typeof played>) =>
    [...values].sort((a, b) => a.beat - b.beat || a.left - b.left || a.elevation - b.elevation)
const place = ({ beat, left, size, elevation }: ReturnType<typeof played>[number]) => ({
    beat,
    left: Math.round(left * 1e9) / 1e9,
    size: Math.round(size * 1e9) / 1e9,
    elevation: Math.round(elevation * 1e9) / 1e9,
})
const assertSamePlaces = (before: State, after: State) =>
    assert.deepEqual(byBeat(played(after)).map(place), byBeat(played(before)).map(place))
const attachedBeats = (source: State) =>
    notes(source)
        .filter((entity) => entity.isAttached)
        .map((entity) => entity.beat)

test('joining slides end to end keeps every tick attached where it plays', () => {
    const source = state(
        [
            [
                note(4, 2, { connectorEase: 'outCubic' }),
                tick(5),
                tick(5.5),
                note(6, -2, { size: 4 }),
            ],
            [note(0, -4, { connectorEase: 'inQuad' }), tick(1), tick(2.5), note(3, 4, { size: 1 })],
        ],
        {
            bpms: [
                { beat: 0, bpm: 60 },
                { beat: 2, bpm: 150 },
            ],
        },
    )
    const combined = combineAll(source)
    assert.deepEqual(attachedBeats(combined), [1, 2.5, 5, 5.5])
    assertSamePlaces(source, combined)
    const slide = [...combined.store.slides.note.values()][0]!
    const selected = combined.selectedEntities.filter((entity) => entity.type === 'note')
    assert.equal(selected.length, slide.length)
    assert.ok(selected.every((entity) => slide.includes(entity)))
})

test('joining slides that touch at a shared beat keeps every tick attached', () => {
    // The later slide is listed first, so store order alone would start it before the other ends.
    const source = state([
        [note(2, 3, { connectorEase: 'inOutQuad' }), tick(3), note(4, -3)],
        [note(0, -4, { connectorEase: 'inQuad' }), tick(1), tick(1.5), note(2, 1)],
    ])
    const combined = combineAll(source)
    assert.deepEqual(attachedBeats(combined), [1, 1.5, 3])
    assertSamePlaces(source, combined)
    const slide = [...combined.store.slides.note.values()][0]!
    assert.deepEqual(
        slide.filter((entity) => entity.beat === 2).map((entity) => entity.left),
        [1, 3],
    )
})

test('interleaved slides detach only the ticks whose anchors change, at their played places', () => {
    const source = state([
        [
            note(0, -4, { connectorEase: 'inQuad' }),
            tick(1),
            tick(2),
            note(4, 2, { connectorEase: 'outQuad' }),
            tick(5),
            note(6, -2, { size: 4 }),
        ],
        [note(3, 5), note(7, 0)],
    ])
    const ticks = notes(source).filter((entity) => entity.isAttached)
    const before = getMaterializedNotePositions(source, ticks)
    const combined = combineAll(source)
    assert.deepEqual(attachedBeats(combined), [5])
    assertSamePlaces(source, combined)
    for (const original of ticks.slice(0, 2)) {
        const detached = notes(combined).find((entity) => entity.beat === original.beat)!
        const { left, size, elevation } = before.get(original)!
        assert.deepEqual(
            { left: detached.left, size: detached.size, elevation: detached.elevation },
            { left, size, elevation },
        )
    }
})

test('a cross-stage slide on dynamic stages keeps its ticks attached at exact positions', () => {
    const pivot = (stageId: StageId, beat: number, pivotLane: number) => ({
        stageId,
        beat,
        pivotLane,
        divisionSize: 1,
        divisionParity: 'even' as const,
        yOffset: 0,
        yOffsetBeat: 0,
        eventEase: 'linear' as const,
    })
    const transform = (stageId: StageId, beat: number, xTranslation: number, elevation = 0) => ({
        stageId,
        beat,
        rotation: 0,
        xTranslation,
        yTranslation: 0,
        elevation,
        anchor: 'default' as const,
        eventEase: 'linear' as const,
    })
    const source = state(
        [
            [
                note(0, -3, { connectorEase: 'inQuad', elevation: 1 }),
                tick(1, { stageId: stageB, elevation: 7 }),
                tick(2.5, { elevation: 2 }),
                note(3, 2, { stageId: stageB, size: 3, elevation: 4 }),
            ],
            [
                note(3, 0, { connectorEase: 'outInCubic', stageId: stageB, elevation: 4 }),
                tick(4, { elevation: 9 }),
                note(5, 4, { size: 1, elevation: -2 }),
            ],
        ],
        {
            isDynamicStages: true,
            bpms: [
                { beat: 0, bpm: 120 },
                { beat: 2, bpm: 75 },
            ],
            stagePivotEvents: [
                pivot(stageA, 0, -2),
                pivot(stageA, 6, 5),
                pivot(stageB, 0, 3),
                pivot(stageB, 4, 1),
            ],
            stageTransformEvents: [
                transform(stageA, 0, 1, 2),
                transform(stageA, 5, 6, -1),
                transform(stageB, 0, -2, 3),
                transform(stageB, 5, 4, 1),
            ],
        },
    )
    const combined = combineAll(source)
    assert.deepEqual(attachedBeats(combined), [1, 2.5, 4])
    assertSamePlaces(source, combined)
})

test('ticks between same-beat anchors keep their stored elevation and place', () => {
    const source = state([
        [
            note(2, 0, { elevation: 0, connectorEase: 'inQuad' }),
            tick(2, { elevation: 1 }),
            note(2, 4, { elevation: 4 }),
        ],
        [note(2, -2, { elevation: 6 }), note(3, 1)],
    ])
    const combined = combineAll(source)
    assert.deepEqual(
        notes(combined).map((entity) => [entity.elevation, entity.isAttached]),
        [
            [0, false],
            [1, true],
            [4, false],
            [6, false],
            [0, false],
        ],
    )
    assertSamePlaces(source, combined)
})

test('a slide at a tick’s anchor beat keeps the tick attached only when ordered outside its anchors', () => {
    const slides = (elevation: number) => [
        [note(2, 0, { connectorEase: 'inQuad' }), tick(2, { elevation: 1 }), tick(3), note(4, 4)],
        [note(2, -3, { elevation }), note(6, 1)],
    ]
    // Lower, the other slide's note comes before the anchor at that beat.
    const below = state(slides(-1))
    const kept = combineAll(below)
    assert.deepEqual(attachedBeats(kept), [2, 3])
    assertSamePlaces(below, kept)
    // Higher, it comes between the anchor and the ticks, so they detach where they play.
    const above = state(slides(2))
    const detached = combineAll(above)
    assert.deepEqual(attachedBeats(detached), [])
    assertSamePlaces(above, detached)
})

test('a touching join stays end to start when the later head is lower than the earlier tail', () => {
    const source = state([
        [note(2, 3, { elevation: 1, connectorEase: 'inOutQuad' }), tick(3), note(4, -3)],
        [
            note(0, -4, { connectorEase: 'inQuad' }),
            tick(1),
            tick(1.5),
            note(2, 1, { elevation: 3 }),
        ],
    ])
    const combined = combineAll(source)
    assert.deepEqual(attachedBeats(combined), [1, 1.5, 3])
    assertSamePlaces(source, combined)
    const slide = [...combined.store.slides.note.values()][0]!
    assert.deepEqual(
        slide.filter((entity) => entity.beat === 2).map((entity) => entity.elevation),
        [3, 1],
    )
})

test('a chain of slides joins end to start at each shared beat, through a slide wholly at one', () => {
    const source = state([
        [note(4, 0, { elevation: 0 }), tick(5), note(6, 2)],
        [note(2, 1, { elevation: 2 }), note(2, 1, { elevation: 1 })],
        [
            note(2, -1, { elevation: 0, connectorEase: 'outQuad' }),
            tick(3),
            note(4, 3, { elevation: 6 }),
        ],
        [note(0, -4, { connectorEase: 'inQuad' }), tick(1), note(2, 4, { elevation: 4 })],
    ])
    const combined = combineAll(source)
    assert.deepEqual(attachedBeats(combined), [1, 3, 5])
    assertSamePlaces(source, combined)
    const slide = [...combined.store.slides.note.values()][0]!
    assert.deepEqual(
        slide.map((entity) => [entity.beat, entity.elevation]),
        [
            [0, 0],
            [1, 0],
            [2, 4],
            [2, 2],
            [2, 1],
            [2, 0],
            [3, 0],
            [4, 6],
            [4, 0],
            [5, 0],
            [6, 0],
        ],
    )
})

test('a slide passing through a shared beat keeps its elevation place among joining slides', () => {
    const source = state([
        [note(2, 0, { elevation: 2 }), note(4, 0)],
        [note(0, 2), note(2, 2, { elevation: 3 }), note(4, 2)],
        [note(0, -2), note(2, -2, { elevation: 5 })],
    ])
    const combined = combineAll(source)
    const slide = [...combined.store.slides.note.values()][0]!
    // By elevation: start (2), passing (3), end (5); the end and start swap places.
    assert.deepEqual(
        slide.filter((entity) => entity.beat === 2).map((entity) => entity.elevation),
        [5, 3, 2],
    )
})
