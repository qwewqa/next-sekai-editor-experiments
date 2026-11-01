import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PreviewFrameContext } from '../../src/preview/engine/context'
import {
    StageRotationCenter,
    approachAtTilt,
    createLayout,
    createViewport,
    getCameraInfo,
    stageTransformToAffine,
    transformedVecAt,
    type CameraChange,
    type StageScreenTransform,
} from '../../src/preview/engine/layout'
import { EaseType, applyAffine, vec, type Vec } from '../../src/preview/engine/math'
import type {
    PreviewChart,
    PreviewStage,
    StageTransformEvent,
} from '../../src/preview/engine/model'
import { renderPreviewFrame } from '../../src/preview/engine/render'
import { getStageProps, stagePropsTransform } from '../../src/preview/engine/stage'
import { createTimescaleGroup } from '../../src/preview/engine/timescale'
import type { PreviewRenderer } from '../../src/preview/gl'
import { markerSegments } from '../../src/preview/outlineRenderer'
import { resolveSkin } from '../../src/preview/skin'

// The X at the rotation center of each stage with a selected transform event: where the frame
// puts it and how it turns, and its arms on the overlay.

const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) <= 1e-9, `${label}: ${actual} != ${expected}`)

/** The arms of each X as [x0, y0, x1, y1], the ends in a fixed order. */
const arms = (segments: number[]) => {
    const result: number[][] = []
    for (let i = 0; i < segments.length; i += 4) {
        const [x0, y0, x1, y1] = segments.slice(i, i + 4) as [number, number, number, number]
        const first = Math.abs(x0 - x1) > 1e-9 ? x0 < x1 : y0 < y1
        result.push(first ? [x0, y0, x1, y1] : [x1, y1, x0, y0])
    }
    return result.sort((a, b) => a[1]! - b[1]!)
}

test('an X at angle 0 is the screen-aligned diagonals, 12 px across', () => {
    // The center of a 200 x 100 preview, and a point up and to the right of it.
    assert.deepEqual(arms(markerSegments([{ point: vec(0, 0), angle: 0 }], 200, 100)), [
        [94, 44, 106, 56],
        [94, 56, 106, 44],
    ])
    assert.deepEqual(arms(markerSegments([{ point: vec(0.5, 0.5), angle: 0 }], 200, 100)), [
        [119, 19, 131, 31],
        [119, 31, 131, 19],
    ])
})

test('an X at 45 degrees has axis-aligned arms, and a positive angle turns it counterclockwise', () => {
    const half = 6 * Math.SQRT2
    const turned = arms(markerSegments([{ point: vec(0, 0), angle: Math.PI / 4 }], 200, 100))
    for (const [index, expected] of [
        [100, 50 - half, 100, 50 + half],
        [100 - half, 50, 100 + half, 50],
    ].entries())
        for (const [i, value] of expected.entries())
            close(turned[index]![i]!, value, `arm ${index}`)
    // Turning by 0.3 rad (y up) turns each arm's direction by 0.3 rad the other way on the canvas.
    const angle = 0.3
    const directions = markerSegments([{ point: vec(0, 0), angle }], 200, 100)
    const found: number[] = []
    for (let i = 0; i < directions.length; i += 4) {
        const dx = directions[i + 2]! - directions[i]!
        const dy = directions[i + 3]! - directions[i + 1]!
        close(Math.hypot(dx, dy), 2 * half, 'length')
        found.push(((Math.atan2(-dy, dx) % Math.PI) + Math.PI) % Math.PI)
    }
    const expected = [Math.PI / 4 + angle, (3 * Math.PI) / 4 + angle].map((a) => a % Math.PI)
    found.sort((a, b) => a - b)
    expected.sort((a, b) => a - b)
    for (const [i, value] of expected.entries()) close(found[i]!, value, `direction ${i}`)
})

const viewport = createViewport(1600, 900)
const camera: CameraChange = {
    time: 0,
    lane: 1,
    size: 6,
    zoom: 1.2,
    zoomTargetLane: 0,
    zoomTargetY: 0,
    zoomVerticalAlign: 0,
    rotate: 0.3,
    stageTilt: 0.6,
    ease: EaseType.linear,
}

const transform = (overrides: Partial<StageTransformEvent>): StageTransformEvent => ({
    time: 0,
    rotate: 0,
    xLaneTranslate: 0,
    yLaneTranslate: 0,
    centerWeight: 0,
    rotationCenter: StageRotationCenter.maskCenter,
    rotationCenterXOffset: 0,
    rotationCenterYOffset: 0,
    elevation: 0,
    ease: EaseType.linear,
    ...overrides,
})

const stage = (event: StageTransformEvent, drawEndTime = 1e8): PreviewStage => ({
    order: 0,
    drawStartTime: -1e8,
    drawEndTime,
    masks: [{ time: 0, lane: 2, size: 2, maskNotes: false, ease: EaseType.linear }],
    pivots: [],
    styles: [],
    transforms: [event],
    hasTransforms: true,
})

const renderer: PreviewRenderer = {
    maxViewportSize: { width: 1600, height: 900 },
    setTexture() {},
    reserveTexture() {},
    setTextureRegion() {},
    readPixels: () => new Uint8Array(),
    begin() {},
    draw() {},
    flush() {},
    isContextLost: () => false,
    dispose() {},
}

/** The screen image of the stage point that two rotations of one transform map to one place. */
const fixedImage = (first: StageScreenTransform, second: StageScreenTransform) => {
    const a = vec(first.a00 - second.a00, first.a10 - second.a10)
    const b = vec(first.a01 - second.a01, first.a11 - second.a11)
    const c = vec(second.a02 - first.a02, second.a12 - first.a12)
    const det = a.x * b.y - a.y * b.x
    return applyAffine(first, vec((c.x * b.y - c.y * b.x) / det, (a.x * c.y - a.y * c.x) / det))
}

test('a frame marks each drawn stage with a selected transform event where it turns, turned with it', () => {
    const now = 1
    const events = [
        transform({
            rotate: 0.4,
            elevation: 1.5,
            xLaneTranslate: 1,
            rotationCenterXOffset: 0.5,
            rotationCenterYOffset: -0.25,
        }),
        transform({
            rotate: -0.7,
            centerWeight: 1,
            yLaneTranslate: 0.5,
            rotationCenter: StageRotationCenter.screenCenter,
        }),
        transform({ rotate: 0.2, rotationCenter: StageRotationCenter.stageCenter }),
        transform({ rotate: 0.2 }),
    ]
    // The third stage ends before the frame, and the fourth has no selected transform event.
    const stages = events.map((event, index) => stage(event, index === 2 ? 0.5 : 1e8))
    const chart: PreviewChart = {
        isDynamicStages: true,
        notes: [],
        connectors: [],
        slides: [],
        simLines: [],
        chains: [],
        cameras: [camera],
        groups: [createTimescaleGroup([], 0)],
        stages,
        hasStageTransforms: true,
    }
    const markers: { point: Vec; angle: number }[] = []
    renderPreviewFrame(
        renderer,
        resolveSkin(() => undefined),
        chart,
        now,
        1600,
        900,
        1600,
        900,
        8,
        false,
        undefined,
        {
            objects: new Set(),
            stages: new Set([0, 1, 2, 3]),
            centers: new Set([0, 1, 2]),
            outline() {},
            marker: (point, angle) => markers.push({ point, angle }),
        },
    )
    assert.equal(markers.length, 2)
    const context: PreviewFrameContext = {
        now,
        layout: createLayout(viewport, getCameraInfo(viewport, [camera], now), true),
    }
    const affine = (event: StageTransformEvent) =>
        stageTransformToAffine(stagePropsTransform(context, getStageProps(stage(event), now)))
    const travel = approachAtTilt(1, camera.stageTilt)
    for (const [index, { point, angle }] of markers.entries()) {
        const event = events[index]!
        const expected = fixedImage(
            affine({ ...event, rotate: 0.9 }),
            affine({ ...event, rotate: -1.3 }),
        )
        close(point.x, expected.x, `${index} x`)
        close(point.y, expected.y, `${index} y`)
        // The judgment line's direction through the drawn stage.
        const drawn = affine(event)
        const a = applyAffine(drawn, transformedVecAt(context.layout, -2, travel))
        const b = applyAffine(drawn, transformedVecAt(context.layout, 2, travel))
        close(angle, Math.atan2(b.y - a.y, b.x - a.x), `${index} angle`)
    }
})
