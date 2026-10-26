import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createState } from '../../src/state'
import type { EntityOfType, EntityType } from '../../src/state/entities'
import type { SlideId } from '../../src/state/entities/slides'
import type { SlideInfos } from '../../src/state/entities/slides/hiddenTicks'
import { calculateBpms, toBpmIntegral } from '../../src/state/integrals/bpms'
import {
    cleanBeat,
    GLOBAL_GRID,
    nearGridsBeat,
    snapBeat,
    toBeatGrid,
} from '../../src/state/integrals/grid'
import type { EditableEntity } from '../../src/state/operations/editable'
import {
    canScaleSelection,
    getScaleBounds,
    getScaledSelectionValues,
    getScaleEntities,
    getScalePivot,
    getScaleProperties,
    getTranslatedSelectionValues,
} from '../../src/state/operations/scaleValues'

const source = <T extends EntityType>(type: T, beat: number, elevation = 0) =>
    Object.freeze({ type, beat, elevation }) as EntityOfType<T>

const emptyState = () =>
    createState(
        {
            initialLife: 1000,
            isDynamicStages: false,
            bpms: [{ beat: 0, bpm: 120 }],
            groups: new Map(),
            stages: new Map(),
            slides: [],
            timeScales: [],
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
        },
        0,
    )

test('width scaling uses outer edges, preserves point events and scales sizes together', () => {
    const first = { ...source('note', 3), left: 2, size: 2 }
    const last = { ...source('note', 5), left: 6, size: 4 }
    const pivot = { ...source('stagePivotEventJoint', 4), pivotLane: 5 }
    const selection = [first, last, pivot]
    assert.equal(canScaleSelection([first], 'width'), true)
    assert.deepEqual(getScaleBounds(last, 'width'), { min: 6, max: 10 })
    const values = getScaledSelectionValues(selection, 'width', 0.5, undefined, 10)!
    assert.deepEqual([...values.values()], [6, 8, 7.5])
    assert.deepEqual(getScaleProperties(first, 'width', values.get(first)!, 0.5), {
        left: 6,
        size: 1,
    })
    assert.deepEqual(getScaleProperties(last, 'width', values.get(last)!, 0.5), {
        left: 8,
        size: 2,
    })
    assert.deepEqual(getScaleProperties(pivot, 'width', values.get(pivot)!, 0.5), {
        pivotLane: 7.5,
    })
    const translated = getTranslatedSelectionValues(selection, 'width', -3)!
    assert.deepEqual(getScaleProperties(last, 'width', translated.get(last)!), { left: 3, size: 4 })
    assert.deepEqual([first.left, first.size, last.left, last.size], [2, 2, 6, 4])
})

test('width scaling supports each horizontal event field and rejects invalid spans', () => {
    const entities = [
        { ...source('cameraEventJoint', 0), cameraLeft: 0, cameraSize: 12 },
        { ...source('stageMaskEventJoint', 0), maskLeft: 2, maskSize: 4 },
        { ...source('stageTransformEventJoint', 0), xTranslation: 3 },
        { ...source('timeScale', 0), editorLane: 4 },
        { ...source('stageStyleEventJoint', 0), editorLane: 5 },
    ] as EditableEntity[]
    const values = getScaledSelectionValues(entities, 'width', 0.5)!
    assert.deepEqual([...values.values()], [0, 1, 1.5, 2, 2.5])
    assert.deepEqual(getScaleProperties(entities[0]!, 'width', 0, 0.5), {
        cameraLeft: 0,
        cameraSize: 6,
    })
    assert.deepEqual(getScaleProperties(entities[1]!, 'width', 1, 0.5), {
        maskLeft: 1,
        maskSize: 2,
    })
    assert.equal(getScaledSelectionValues(entities, 'width', 0.4), undefined)
    assert.equal(getScaledSelectionValues(entities, 'width', 3), undefined)
    assert.equal(canScaleSelection([source('bpm', 0)], 'width'), false)
    assert.equal(canScaleSelection([{ ...source('note', 0), left: 0, size: 0 }], 'width'), false)
    assert.equal(canScaleSelection([{ ...source('note', 0), left: 0, size: -1 }], 'width'), false)
    assert.equal(
        canScaleSelection([{ ...source('note', 0), left: Infinity, size: 1 }], 'width'),
        false,
    )
    assert.equal(
        getScaledSelectionValues(
            [{ ...source('note', 0), left: 1, size: 2 }],
            'width',
            Number.MIN_VALUE,
        ),
        undefined,
    )
    assert.equal(
        getTranslatedSelectionValues([{ ...source('note', 0), left: 0, size: 2 }], 'width', 1e308),
        undefined,
    )
})

test('width results drop float noise near the lane grid and keep finer values', () => {
    // 0.1 * 3 and 0.2 + 0.1 are both 0.30000000000000004.
    const first = { ...source('note', 0), left: 0, size: 0.1 }
    const second = { ...source('note', 1), left: 0.1, size: 0.1 }
    const scaled = getScaledSelectionValues([first, second], 'width', 3)!
    assert.deepEqual([...scaled.values()], [0, 0.3])
    assert.deepEqual(getScaleProperties(second, 'width', scaled.get(second)!, 3), {
        left: 0.3,
        size: 0.3,
    })
    const near = { ...source('note', 0), left: 0.2, size: 1 }
    assert.deepEqual([...getTranslatedSelectionValues([near], 'width', 0.1)!.values()], [0.3])
    // Off the grid, results are the plain arithmetic; an unscaled size stays as it is.
    const fine = { ...source('note', 0), left: 0.123456789, size: 0.123456789 }
    assert.deepEqual(
        [...getTranslatedSelectionValues([fine], 'width', 0.1)!.values()],
        [0.123456789 + 0.1],
    )
    assert.deepEqual(getScaleProperties(fine, 'width', 1), { left: 1, size: 0.123456789 })
    assert.deepEqual(getScaleProperties(fine, 'width', 1, 3), {
        left: 1,
        size: 0.123456789 * 3,
    })
})

test('width checks run on the plain results, so float noise never refuses them', () => {
    // A flip of 0.1 + 0.2 beside a clean -0.3: distinct lanes that snap to one.
    const noisy = { ...source('note', 0), left: -(0.1 + 0.2), size: 0.2 }
    const clean = { ...source('note', 1), left: -0.3, size: 0.2 }
    const translated = getTranslatedSelectionValues([noisy, clean], 'width', 0.5)
    assert.deepEqual([...translated!.values()], [0.2, 0.2])
    const scaled = getScaledSelectionValues([noisy, clean], 'width', 2)
    // The pivot is unmoved, so it stays exact.
    assert.deepEqual([...scaled!.values()], [-(0.1 + 0.2), -0.3])
    // A positive size never snaps to 0.
    const thin = { ...source('note', 0), left: 0, size: 5e-11 }
    const thinScaled = getScaledSelectionValues([thin], 'width', 2)
    assert.deepEqual(getScaleProperties(thin, 'width', thinScaled!.get(thin)!, 2), {
        left: 0,
        size: 1e-10,
    })
})

test('width lanes one float step apart may meet when scaled or moved', () => {
    const pivot = { ...source('note', 0), left: -7.1, size: 1 }
    const lower = { ...source('note', 1), left: -1, size: 1 }
    const upper = { ...source('note', 2), left: -0.9999999999999999, size: 1 }
    for (const [factor, lane] of [
        [0.75, -2.525],
        [0.5, -4.05],
        [2, 5.1],
    ] as const) {
        const values = getScaledSelectionValues([pivot, lower, upper], 'width', factor)
        assert.deepEqual([values?.get(lower), values?.get(upper)], [lane, lane])
    }
    const noisy = { ...source('note', 0), left: 0.1 + 0.2, size: 1 }
    const clean = { ...source('note', 1), left: 0.3, size: 1 }
    const translated = getTranslatedSelectionValues([noisy, clean], 'width', 0.25)
    assert.deepEqual([...translated!.values()], [0.55, 0.55])
})

test('scaling can anchor either endpoint while preserving ties', () => {
    const first = source('note', 3, 1)
    const middle = source('note', 5, 3)
    const last = source('note', 8, 5)
    const tied = source('note', 8, 5)
    const selected = [first, middle, last, tied]
    assert.deepEqual(
        [...getScaledSelectionValues(selected, 'beat', 0.5, undefined, 8)!.values()],
        [5.5, 6.5, 8, 8],
    )
    assert.deepEqual(
        [...getScaledSelectionValues(selected, 'elevation', 2, undefined, 5)!.values()],
        [-3, 1, 5, 5],
    )
    assert.equal(getScaledSelectionValues(selected, 'beat', 2, undefined, 8), undefined)
    assert.equal(getScaledSelectionValues(selected, 'beat', 2, undefined, NaN), undefined)
})

test('translation moves all eligible values equally and retains negative authored timing', () => {
    const first = source('note', 3, 1)
    const middle = source('note', 5, 3)
    const last = source('note', 8, 5)
    const bpm = source('bpm', -2)
    const stage = source('stageTransformEventJoint', 6, 2)
    const selected = [first, middle, last, bpm, stage, first]
    assert.deepEqual(
        [...getTranslatedSelectionValues(selected, 'beat', -1)!.values()],
        [2, 4, 7, -3, 5],
    )
    assert.deepEqual(
        [...getTranslatedSelectionValues(selected, 'elevation', -2)!.values()],
        [-1, 1, 3, 0],
    )
    assert.equal(getTranslatedSelectionValues(selected, 'beat', -4), undefined)
    assert.equal(getTranslatedSelectionValues(selected, 'beat', Infinity), undefined)
    assert.equal(getTranslatedSelectionValues(selected, 'elevation', NaN), undefined)
    assert.equal(getTranslatedSelectionValues(selected, 'beat', 0), undefined)
    assert.deepEqual(
        selected.map((entity) => entity.beat),
        [3, 5, 8, -2, 6, 3],
    )
})

test('a beat translation lands on the grid through the given cleaning, which only removes float noise', () => {
    const thirds = (beat: number, offset: number) => nearGridsBeat([GLOBAL_GRID], beat + offset, 3)
    const notes = [source('note', 4 / 3), source('note', 7 / 3)]
    // Plain sums carry an ulp of noise.
    assert.notEqual(4 / 3 + 1 / 3, 5 / 3)
    assert.notEqual(7 / 3 + 1 / 3, 8 / 3)
    assert.deepEqual(
        [...getTranslatedSelectionValues(notes, 'beat', 1 / 3, undefined, thirds)!.values()],
        [5 / 3, 8 / 3],
    )
    // Off the grid, a translation keeps its value.
    assert.deepEqual(
        [...getTranslatedSelectionValues(notes, 'beat', 0.37, undefined, thirds)!.values()],
        [4 / 3 + 0.37, 7 / 3 + 0.37],
    )
    // On a bar grid, onto its lines.
    const bars = toBeatGrid(
        calculateBpms(
            [
                { beat: 0, bpm: 120 },
                { beat: 2.3, bpm: 150 },
            ].map(toBpmIntegral),
        ),
    )
    const line = snapBeat(bars, 2.3 + 1 / 3 + 1e-9, 3)
    const next = snapBeat(bars, line + 1 + 1e-9, 3)
    assert.notEqual(line + 1, next)
    const onBars = (beat: number, offset: number) => nearGridsBeat([bars], beat + offset, 3)
    assert.deepEqual(
        [
            ...getTranslatedSelectionValues(
                [source('note', line)],
                'beat',
                1,
                undefined,
                onBars,
            )!.values(),
        ],
        [next],
    )
    // Other axes are not beats.
    const elevated = [source('note', 1, 1 / 3)]
    assert.deepEqual(
        [
            ...getTranslatedSelectionValues(
                elevated,
                'elevation',
                1 / 3,
                undefined,
                () => 0,
            )!.values(),
        ],
        [1 / 3 + 1 / 3],
    )
})

test('a beat scaling lands on the grid through the given cleaning, the grabbed end on its line', () => {
    const onGrid = (division: number) => (beat: number, offset: number) =>
        cleanBeat([GLOBAL_GRID], beat + offset, division)
    const notes = [source('note', 0), source('note', 11)]
    // Dragged from 11 to the line at 15 about 0, a plain product lands an ulp short.
    assert.deepEqual(
        [...getScaledSelectionValues(notes, 'beat', 15 / 11, undefined, 0)!.values()],
        [0, 14.999999999999998],
    )
    assert.deepEqual(
        [...getScaledSelectionValues(notes, 'beat', 15 / 11, undefined, 0, onGrid(1))!.values()],
        [0, 15],
    )
    for (const division of [1, 2, 3, 4, 6, 8, 12, 16]) {
        const clean = onGrid(division)
        for (let p = 0; p < 10; p++) {
            for (let v = p + 1; v < p + 20; v++) {
                for (let t = p + 1; t < p + 30; t++) {
                    if (t === v) continue
                    const [pivot, value, target] = [p / division, v / division, t / division]
                    const scaled = getScaledSelectionValues(
                        [source('note', pivot), source('note', value)],
                        'beat',
                        (target - pivot) / (value - pivot),
                        undefined,
                        pivot,
                        clean,
                    )!
                    assert.deepEqual(
                        [...scaled.values()],
                        [pivot, target],
                        `${p} ${v} ${t}/${division}`,
                    )
                }
            }
        }
    }
    // Onto a bar grid's line; off the grid, a scaled beat keeps its value.
    const bars = toBeatGrid(
        calculateBpms(
            [
                { beat: 0, bpm: 120 },
                { beat: 2.3, bpm: 150 },
            ].map(toBpmIntegral),
        ),
    )
    const line = snapBeat(bars, 2.3 + 1 / 3 + 1e-9, 3)
    const target = snapBeat(bars, 2.3 + 7 / 3 + 1e-9, 3)
    const onBars = (beat: number, offset: number) => cleanBeat([bars], beat + offset, 3)
    assert.deepEqual(
        [
            ...getScaledSelectionValues(
                [source('note', 2.3), source('note', line)],
                'beat',
                (target - 2.3) / (line - 2.3),
                undefined,
                2.3,
                onBars,
            )!.values(),
        ],
        [2.3, target],
    )
    assert.deepEqual(
        [
            ...getScaledSelectionValues(
                [source('note', 1), source('note', 2.37)],
                'beat',
                1.5,
                undefined,
                1,
                onGrid(4),
            )!.values(),
        ],
        [1, 1 + 1.37 * 1.5],
    )
})

test('beat scaling includes every editable event family and anchors the earliest eligible beat', () => {
    const selected = [
        source('note', 8),
        source('bpm', 4),
        source('timeScale', 6),
        source('cameraEventJoint', 2),
        source('stageMaskEventJoint', 3),
        source('stagePivotEventJoint', 5),
        source('stageStyleEventJoint', 7),
        source('stageTransformEventJoint', 9),
    ]
    const connector = source('connector', -100)
    const connection = source('stageTransformEventConnection', -200)
    const selection = [connector, ...selected, connection, selected[0]!]
    assert.deepEqual(getScaleEntities(selection, 'beat'), selected)
    assert.equal(getScalePivot(selection, 'beat'), 2)
    const result = getScaledSelectionValues(selection, 'beat', 1.5)
    assert.ok(result)
    assert.deepEqual([...result.keys()], selected)
    assert.deepEqual([...result.values()], [11, 5, 8, 2, 3.5, 6.5, 9.5, 12.5])
    assert.deepEqual(
        selected.map((entity) => entity.beat),
        [8, 4, 6, 2, 3, 5, 7, 9],
    )
})

test('elevation scaling shares the lowest stored elevation across notes and stage transforms', () => {
    const note = source('note', 1, 3)
    const stage = source('stageTransformEventJoint', 100, -1)
    const ignored = [
        source('cameraEventJoint', -100, -200),
        source('stagePivotEventJoint', 0, -300),
    ]
    const selection = [note, ...ignored, stage]
    assert.deepEqual(getScaleEntities(selection, 'elevation'), [note, stage])
    assert.equal(getScalePivot(selection, 'elevation'), -1)
    assert.equal(canScaleSelection(selection, 'elevation'), true)
    const result = getScaledSelectionValues(selection, 'elevation', 0.5)
    assert.ok(result)
    assert.deepEqual(
        [...result],
        [
            [note, 1],
            [stage, -1],
        ],
    )
    assert.equal(note.beat, 1)
    assert.equal(note.elevation, 3)
    assert.equal(stage.beat, 100)
    assert.equal(stage.elevation, -1)
})

test('fractional scaling preserves the anchor and equal-value ties without quantizing', () => {
    const first = source('note', 1 / 3, 0)
    const tied = source('note', 1 / 3, 0)
    const last = source('note', 2 / 3, 4)
    const beat = getScaledSelectionValues([last, first, tied], 'beat', 0.125)
    assert.ok(beat)
    assert.equal(beat.get(first), 1 / 3)
    assert.equal(beat.get(tied), beat.get(first))
    assert.ok(Math.abs(beat.get(last)! - 0.375) < 1e-12)
    const elevation = getScaledSelectionValues([last, first, tied], 'elevation', 0.25)
    assert.ok(elevation)
    assert.deepEqual([...elevation.values()], [1, 0, 0])
})

test('scaling requires two unique eligible entities with a nonzero span', () => {
    const note = source('note', 4, 2)
    const same = source('note', 4, 2)
    const distinct = source('note', 5, 3)
    const connection = source('cameraEventConnection', 1, -20)
    for (const axis of ['beat', 'elevation'] as const) {
        for (const selected of [[], [note], [note, note], [note, connection], [note, same]]) {
            assert.equal(canScaleSelection(selected, axis), false)
            assert.equal(getScaledSelectionValues(selected, axis, 2), undefined)
        }
        assert.equal(canScaleSelection([note, same, distinct], axis), true)
        assert.equal(canScaleSelection([note, distinct, connection], axis), true)
    }
})

test('invalid selected coordinates reject scaling while ignored connections do not affect it', () => {
    const first = source('note', 0, 0)
    const second = source('note', 2, 2)
    for (const value of [Number.NaN, Infinity, -Infinity]) {
        for (const axis of ['beat', 'elevation'] as const) {
            const invalid = source(
                'note',
                axis === 'beat' ? value : 1,
                axis === 'elevation' ? value : 1,
            )
            assert.equal(canScaleSelection([first, second, invalid], axis), false)
            assert.equal(getScaledSelectionValues([first, second, invalid], axis, 2), undefined)
            const ignored = source('connector', value, value)
            assert.equal(canScaleSelection([first, second, ignored], axis), true)
            assert.deepEqual(
                [...getScaledSelectionValues([first, second, ignored], axis, 2)!.values()],
                [0, 4],
            )
        }
    }
})

test('invalid and unchanged scale factors produce no replacement values', () => {
    const selected = [source('note', 0, -1), source('note', 8, 3)]
    for (const factor of [0, -1, Number.NaN, Infinity, -Infinity, 1]) {
        assert.equal(getScaledSelectionValues(selected, 'beat', factor), undefined)
        assert.equal(getScaledSelectionValues(selected, 'elevation', factor), undefined)
    }
    assert.deepEqual(
        selected.map(({ beat, elevation }) => [beat, elevation]),
        [
            [0, -1],
            [8, 3],
        ],
    )
})

test('overflow and numerical collapse are rejected before any entity is changed', () => {
    const first = source('note', 1e308, 1e308)
    const second = source('note', 1.5e308, 1.5e308)
    for (const axis of ['beat', 'elevation'] as const) {
        assert.equal(getScaledSelectionValues([first, second], axis, 10), undefined)
        assert.equal(getScaledSelectionValues([first, second], axis, Number.MIN_VALUE), undefined)
    }
    assert.equal(first.beat, 1e308)
    assert.equal(second.elevation, 1.5e308)
    const smallest = getScaledSelectionValues(
        [source('note', 0), source('note', 1)],
        'beat',
        Number.MIN_VALUE,
    )
    assert.ok(smallest)
    assert.deepEqual([...smallest.values()], [0, Number.MIN_VALUE])
})

test('attached slide interiors are read-only in elevation while endpoints and beats remain eligible', () => {
    const state = emptyState()
    const slideId = 1 as SlideId
    const head = { ...source('note', 0, 1), slideId, isAttached: true }
    const interior = { ...source('note', 2, 9), slideId, isAttached: true }
    const tail = { ...source('note', 4, 3), slideId, isAttached: true }
    state.store.slides.note.set(slideId, [head, interior, tail])
    assert.deepEqual(getScaleEntities([tail, interior, head], 'elevation', state), [tail, head])
    assert.deepEqual(getScaleEntities([tail, interior, head], 'beat', state), [
        tail,
        interior,
        head,
    ])
    assert.equal(getScalePivot([interior, tail, head], 'elevation', state), 1)
    assert.deepEqual(
        [...getScaledSelectionValues([tail, interior, head], 'elevation', 2, state)!.values()],
        [5, 1],
    )
    assert.equal(interior.elevation, 9)
    assert.deepEqual(
        [...getTranslatedSelectionValues([tail, interior, head], 'elevation', 1, state)!.values()],
        [4, 2],
    )
    assert.equal(interior.elevation, 9)
})

test('elevation eligibility indexes each slide once and follows replaced info arrays', () => {
    const state = emptyState()
    const slideId = 1 as SlideId
    const notes = Array.from({ length: 1001 }, (_, elevation) => ({
        ...source('note', 0, elevation),
        slideId,
        isAttached: true,
    }))
    const head = notes[0]!
    const tail = notes.at(-1)!
    const originals: SlideInfos = notes.map((note) => ({
        note,
        attachHead: head,
        attachTail: tail,
        segmentHead: head,
        segmentTail: tail,
        activeHead: head,
        activeTail: tail,
        guideHead: undefined,
        guideTail: undefined,
        damageHead: undefined,
        damageTail: undefined,
    }))
    let visits = 0
    const infos = new Proxy(originals, {
        get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) visits++
            return Reflect.get(target, key, receiver)
        },
    })
    state.store.slides.note.set(slideId, notes)
    state.store.slides.info.set(slideId, infos)
    // A vertical slide's interior attachments retain their authored elevations.
    assert.deepEqual(getScaleEntities(notes, 'elevation', state), notes)
    assert.equal(visits, notes.length)
    assert.equal(canScaleSelection(notes, 'elevation', state), true)
    assert.equal(getScaledSelectionValues(notes, 'elevation', 2, state)?.size, notes.length)
    assert.equal(visits, notes.length)

    const updated = {
        ...state,
        store: {
            ...state.store,
            slides: {
                ...state.store.slides,
                info: new Map([
                    [
                        slideId,
                        originals.map((info) => ({ ...info, attachTail: { ...tail, beat: 1 } })),
                    ],
                ]),
            },
        },
    }
    // With different endpoint beats, interiors derive their elevation again.
    const reversed = [...notes].reverse()
    assert.deepEqual(getScaleEntities(reversed, 'elevation', updated), [tail, head])
    assert.deepEqual(getScaleEntities([...notes, head], 'elevation', state), notes)
    assert.equal(visits, notes.length)
})

test('width scaling and translation refuse a lane or a size past the limits', () => {
    const notes = [
        { ...source('note', 3), left: 2, size: 2 },
        { ...source('note', 5), left: 6, size: 4 },
    ]
    assert.ok(getScaledSelectionValues(notes, 'width', 100))
    assert.equal(getScaledSelectionValues(notes, 'width', 1e4), undefined)
    assert.equal(getScaledSelectionValues(notes, 'width', 1e9), undefined)
    assert.ok(getTranslatedSelectionValues(notes, 'width', 4000))
    assert.equal(getTranslatedSelectionValues(notes, 'width', 1e9), undefined)
    assert.equal(getTranslatedSelectionValues(notes, 'width', -1e9), undefined)
})

test('scaled beats stay within the largest beat, for connected notes and for points', () => {
    const state = emptyState()
    const slideId = 1 as SlideId
    const head = { ...source('note', 0), slideId }
    const tail = { ...source('note', 4), slideId }
    state.store.slides.note.set(slideId, [head, tail])
    const boundary = getScaledSelectionValues([head, tail], 'beat', 24999, state)
    assert.ok(boundary)
    assert.deepEqual([...boundary.values()], [0, 99996])
    assert.equal(getScaledSelectionValues([head, tail], 'beat', 25001, state), undefined)
    assert.equal(getScaledSelectionValues([head, tail], 'beat', 1e12, state), undefined)
    const points = [source('bpm', 0), source('bpm', 4)]
    const largePoint = getScaledSelectionValues(points, 'beat', 1e4, state)
    assert.ok(largePoint)
    assert.deepEqual([...largePoint.values()], [0, 4e4])
    assert.equal(getScaledSelectionValues(points, 'beat', 1e12, state), undefined)
    assert.deepEqual(
        [...getScaledSelectionValues([head, tail], 'beat', 0.5, state)!.values()],
        [0, 2],
    )
})

test('beats one float step apart may meet when moved or scaled; distinct beats still may not', () => {
    const quarters = (beat: number, offset: number) => cleanBeat([GLOBAL_GRID], beat + offset, 4)
    // Stored as in a real chart: two anchors of different slides 3e-14 apart, plus notes around them.
    const lower = source('note', 157.08333333333331)
    const upper = source('note', 157.08333333333334)
    const notes = [source('note', 150), lower, upper, source('note', 160)]
    for (const moveBeat of [quarters, undefined]) {
        const translated = getTranslatedSelectionValues(notes, 'beat', 1, undefined, moveBeat)
        assert.ok(translated)
        if (moveBeat) assert.equal(translated.get(lower), translated.get(upper))
        for (const factor of [2, 1.5, 0.5]) {
            const scaled = getScaledSelectionValues(
                notes,
                'beat',
                factor,
                undefined,
                undefined,
                moveBeat,
            )
            assert.ok(scaled, `${factor}`)
            assert.ok(scaled.get(lower)! <= scaled.get(upper)!)
        }
    }
    // Beats within the grid's tolerance of one line clean onto it, as moves land them.
    const close = [source('note', 48), source('note', 48.000000025), source('note', 48.0000001)]
    assert.deepEqual(
        [...getTranslatedSelectionValues(close, 'beat', 1, undefined, quarters)!.values()],
        [49, 49, 49],
    )
    // A down-scale that collapses beats further apart than noise is refused.
    const spread = [source('note', 0), source('note', 1e-5), source('note', 1)]
    assert.equal(getScaledSelectionValues(spread, 'beat', 1e-3, undefined, 0, quarters), undefined)
    assert.ok(getScaledSelectionValues(spread, 'beat', 0.5, undefined, 0, quarters))
    // Elevations stay strict.
    const elevations = [source('note', 0, 0), source('note', 1, 1), source('note', 2, 1 + 1e-15)]
    assert.equal(getTranslatedSelectionValues(elevations, 'elevation', 1e10), undefined)
})

test('beats may meet only if the cleaning at the division could merge them', () => {
    const onGrid = (division: number) => (beat: number, offset: number) =>
        cleanBeat([GLOBAL_GRID], beat + offset, division)
    const scaled = (beats: number[], factor: number, division: number) =>
        getScaledSelectionValues(
            beats.map((beat) => source('note', beat)),
            'beat',
            factor,
            undefined,
            0,
            onGrid(division),
            division,
        )
    // A chain of beats each noise apart still spans distinct beats, which may not meet.
    const chain = [...Array.from({ length: 67 }, (_, i) => i * 1.5e-6), 1]
    assert.equal(scaled(chain, 1e-3, 1), undefined)
    // 1.9e-6 apart may merge at division 1, not at 4.
    assert.ok(scaled([0, 1.9e-6, 1], 0.1, 1))
    assert.equal(scaled([0, 1.9e-6, 1], 0.1, 4), undefined)
    assert.equal(scaled([0, 1e-6, 1], 0.1, 4), undefined)
    // Overlapping pairs noise apart move as Select lands them.
    const overlapping = [4 - 2.4e-6, 4 - 0.9e-6, 4 + 0.9e-6].map((beat) => source('note', beat))
    assert.deepEqual(
        [
            ...getTranslatedSelectionValues(
                overlapping,
                'beat',
                1,
                undefined,
                onGrid(1),
                1,
            )!.values(),
        ],
        [4 - 2.4e-6 + 1, 5, 5],
    )
})

test('non-finite and huge beats are cleaned as they are, and a huge scale factor is refused, promptly', () => {
    // Run apart, so a hang fails the test instead of stalling the run.
    const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
    const script = `
        import { calculateBpms, toBpmIntegral } from ${url('../../src/state/integrals/bpms.ts')}
        import { cleanBeat, GLOBAL_GRID, toBeatGrid } from ${url('../../src/state/integrals/grid.ts')}
        import { getScaledSelectionValues } from ${url('../../src/state/operations/scaleValues.ts')}
        import { alignFraction } from ${url('../../src/utils/math.ts')}
        const bars = toBeatGrid(
            calculateBpms([{ beat: 0, bpm: 120 }, { beat: 2.3, bpm: 150 }, { beat: 7.1, bpm: 90 }].map(toBpmIntegral)),
        )
        const huge = [Infinity, -Infinity, NaN, 1e306, 1e308, 2 ** 60, 2 ** 53 - 1, 2 ** 51 + 0.5]
        const unchanged = []
        for (const beat of huge) {
            unchanged.push(Object.is(alignFraction(beat), beat))
            for (const division of [1, 4, 1000])
                unchanged.push(Object.is(cleanBeat([bars, GLOBAL_GRID], beat, division), beat))
        }
        const refused = []
        for (const grids of [[GLOBAL_GRID], [bars, GLOBAL_GRID]]) {
            const moveBeat = (beat, offset) => cleanBeat(grids, beat + offset, 4)
            const notes = [{ type: 'note', beat: 0 }, { type: 'note', beat: 1000 }]
            for (const factor of [1e306, 1e308, 1e15])
                refused.push(getScaledSelectionValues(notes, 'beat', factor, undefined, undefined, moveBeat) === undefined)
        }
        console.log(JSON.stringify({ unchanged, refused }))
    `
    const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        { encoding: 'utf8', timeout: 20_000 },
    )
    assert.equal(run.signal, null, 'timed out')
    assert.equal(run.status, 0, run.stderr)
    const { unchanged, refused } = JSON.parse(run.stdout) as Record<string, boolean[]>
    assert.ok(unchanged!.length === 32 && unchanged!.every(Boolean), run.stdout)
    assert.ok(refused!.length === 6 && refused!.every(Boolean), run.stdout)
})
