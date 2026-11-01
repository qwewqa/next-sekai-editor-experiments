import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PreviewFrameContext } from '../../src/preview/engine/context'
import {
    FIELD_B_FACTOR,
    FIELD_T_FACTOR,
    STAGE_WIDTH_MID,
    StageRotationCenter,
    approachAtTilt,
    computeStageTransform,
    createLayout,
    createViewport,
    currentLayoutTransform,
    elevationProjection,
    getCameraInfo,
    stageTransformToAffine,
    widthFactorAtTilt,
    type LayoutTransform,
    type StageScreenTransform,
} from '../../src/preview/engine/layout'
import {
    EaseType,
    applyAffine,
    lerp,
    rotateVec,
    vec,
    type Vec,
} from '../../src/preview/engine/math'
import type { PreviewStage, StageTransformEvent } from '../../src/preview/engine/model'
import {
    getStageProps,
    stagePropsRotationFrame,
    stagePropsTransform,
} from '../../src/preview/engine/stage'

// The rotation center checked against geometry derived without the rotation center code: the
// center is the point whose screen image does not depend on the stage's rotation.

const { maskCenter, stageCenter, screenCenter, vanishingPoint } = StageRotationCenter
const modes = [maskCenter, stageCenter, screenCenter, vanishingPoint]
// The screen center's depth with the default camera, from the field factors alone.
const SCREEN_DEPTH = FIELD_T_FACTOR / (FIELD_T_FACTOR - FIELD_B_FACTOR)
const viewport = createViewport(1600, 900)

/** Frame contexts under the cameras the preview builds: tilts, a pan, a zoom and a rotation. */
const contexts = function* (): Generator<PreviewFrameContext> {
    for (const stageTilt of [1, 0.4, 0.1, 0])
        for (const rotate of [0, 0.5])
            for (const [lane, size, zoom] of [
                [0, 6, 1],
                [2, 4, 1.5],
            ] as const) {
                const camera = getCameraInfo(
                    viewport,
                    [
                        {
                            time: 0,
                            lane,
                            size,
                            zoom,
                            zoomTargetLane: 1,
                            zoomTargetY: 0.25,
                            zoomVerticalAlign: 0,
                            rotate,
                            stageTilt,
                            ease: EaseType.linear,
                        },
                    ],
                    0,
                )
                yield { now: 0, layout: createLayout(viewport, camera, true) }
            }
}

/** A stage-space point through the camera alone, written out from the layout's definition. */
const screenPoint = (camera: LayoutTransform, lane: number, depth: number): Vec => {
    const width = camera.stageTilt * depth + (1 - camera.stageTilt) * STAGE_WIDTH_MID
    return cameraFrame(
        camera,
        lane * width * camera.wScale + camera.xTranslate,
        depth * camera.hScale + camera.t,
    )
}

/** A vector in the camera's rotated frame. */
const cameraFrame = (camera: LayoutTransform, x: number, y: number): Vec => {
    const c = Math.cos(camera.rotate)
    const s = Math.sin(camera.rotate)
    return vec(x * c + y * s, -x * s + y * c)
}

const add = (...vs: Vec[]) => vs.reduce((a, b) => vec(a.x + b.x, a.y + b.y))
const lerpVec = (a: Vec, b: Vec, p: number) => vec(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p)

const intersect = (a1: Vec, a2: Vec, b1: Vec, b2: Vec) => {
    const d1 = vec(a2.x - a1.x, a2.y - a1.y)
    const d2 = vec(b2.x - b1.x, b2.y - b1.y)
    const u = ((b1.x - a1.x) * d2.y - (b1.y - a1.y) * d2.x) / (d1.x * d2.y - d1.y * d2.x)
    return vec(a1.x + d1.x * u, a1.y + d1.y * u)
}

/** Where two drawn lane edges meet, with the tilt held at the stage extension's minimum. */
const vanishing = (camera: LayoutTransform) => {
    const held = { ...camera, stageTilt: Math.max(camera.stageTilt, 0.2) }
    return intersect(
        screenPoint(held, -6, 1),
        screenPoint(held, -6, 0.5),
        screenPoint(held, 6, 1),
        screenPoint(held, 6, 0.5),
    )
}

/** Where the Center anchor puts lane 0's judge point at rotation 0, without elevation. */
const screenOrigin = (camera: LayoutTransform) =>
    applyAffine(
        stageTransformToAffine(computeStageTransform(viewport, camera, 0, 0, 0, 0, 1)),
        screenPoint(camera, 0, 1),
    )

/** The anchor's downward shift, in the camera's frame. */
const anchorShift = (camera: LayoutTransform, weight: number) =>
    cameraFrame(camera, 0, -weight * camera.hScale * (1 - SCREEN_DEPTH))

/** A mode's center before the stage's translation. Screen Center undoes the anchor's shift. */
const expectedCenter = (
    camera: LayoutTransform,
    mode: number,
    maskLane: number,
    elevation: number,
    weight: number,
): Vec => {
    if (mode === maskCenter)
        return applyAffine(elevationProjection(camera, elevation), screenPoint(camera, maskLane, 1))
    if (mode === stageCenter) return screenPoint(camera, 0, 1)
    if (mode === screenCenter) {
        const shift = anchorShift(camera, weight)
        return vec(screenOrigin(camera).x - shift.x, screenOrigin(camera).y - shift.y)
    }
    return vanishing(camera)
}

/** The stage's translation: X and Y translation and the anchor's shift. */
const expectedOffset = (camera: LayoutTransform, x: number, y: number, weight: number) =>
    add(cameraFrame(camera, x * camera.wScale, y * camera.wScale), anchorShift(camera, weight))

/** The screen image of the stage point that two rotations of one transform map to one place. */
const fixedImage = (first: StageScreenTransform, second: StageScreenTransform) => {
    const a = vec(first.a00 - second.a00, first.a10 - second.a10)
    const b = vec(first.a01 - second.a01, first.a11 - second.a11)
    const c = vec(second.a02 - first.a02, second.a12 - first.a12)
    const det = a.x * b.y - a.y * b.x
    return applyAffine(first, vec((c.x * b.y - c.y * b.x) / det, (a.x * c.y - a.y * c.x) / det))
}

const event = (overrides: Partial<StageTransformEvent>): StageTransformEvent => ({
    time: 0,
    rotate: 0,
    xLaneTranslate: 0,
    yLaneTranslate: 0,
    centerWeight: 0,
    rotationCenter: maskCenter,
    rotationCenterXOffset: 0,
    rotationCenterYOffset: 0,
    elevation: 0,
    ease: EaseType.linear,
    ...overrides,
})

/** A stage with a mask at `maskLane` and these transform events. */
const stage = (maskLane: number, transforms: StageTransformEvent[]): PreviewStage => ({
    order: 0,
    drawStartTime: -1e8,
    drawEndTime: 1e8,
    masks: [{ time: 0, lane: maskLane, size: 2, maskNotes: false, ease: EaseType.linear }],
    pivots: [],
    styles: [],
    transforms,
    hasTransforms: true,
})

/** The fixed image of a stage's transform at `t`, from two rotations of its events. */
const turnsAbout = (
    context: PreviewFrameContext,
    maskLane: number,
    events: Partial<StageTransformEvent>[],
    t = 0,
) => {
    const at = (rotate: number) =>
        stageTransformToAffine(
            stagePropsTransform(
                context,
                getStageProps(
                    stage(
                        maskLane,
                        events.map((overrides) => event({ ...overrides, rotate })),
                    ),
                    t,
                ),
            ),
        )
    return fixedImage(at(0.4), at(-1.1))
}

const close = (actual: Vec, expected: Vec, label: string) =>
    assert.ok(
        Math.abs(actual.x - expected.x) <= 1e-9 && Math.abs(actual.y - expected.y) <= 1e-9,
        `${label}: (${actual.x}, ${actual.y}) != (${expected.x}, ${expected.y})`,
    )

test('each center is the point the stage turns about, with elevation, anchors and translations', () => {
    for (const context of contexts()) {
        const camera = currentLayoutTransform(context.layout)
        for (const mode of modes)
            for (const elevation of [0, 1.5])
                for (const weight of [0, 1]) {
                    const label = `mode ${mode}, ${JSON.stringify(camera)}, elevation ${elevation}, anchor ${weight}`
                    const props = {
                        xLaneTranslate: 1.3,
                        yLaneTranslate: -0.6,
                        centerWeight: weight,
                        elevation,
                        rotationCenter: mode,
                    }
                    const expected = add(
                        expectedCenter(camera, mode, 2.5, elevation, weight),
                        expectedOffset(camera, 1.3, -0.6, weight),
                    )
                    close(turnsAbout(context, 2.5, [props]), expected, label)
                    // stagePropsRotationFrame gives that point too.
                    const frame = stagePropsRotationFrame(
                        context,
                        getStageProps(stage(2.5, [event(props)]), 0),
                    )
                    close(add(frame.center, frame.offset), expected, `${label}, frame`)
                }
    }
})

test('Screen Center turns about the screen center, carried by the translation alone', () => {
    for (const context of contexts()) {
        const camera = currentLayoutTransform(context.layout)
        for (const weight of [0, 1]) {
            const turned = turnsAbout(context, 0, [
                {
                    xLaneTranslate: 1.5,
                    yLaneTranslate: 2,
                    centerWeight: weight,
                    elevation: 0.6,
                    rotationCenter: screenCenter,
                },
            ])
            close(
                turned,
                add(
                    screenOrigin(camera),
                    cameraFrame(camera, 1.5 * camera.wScale, 2 * camera.wScale),
                ),
                `${JSON.stringify(camera)}, anchor ${weight}`,
            )
        }
    }
    // With the default camera, that is the screen's origin.
    const context = { now: 0, layout: createLayout(viewport, getCameraInfo(viewport, [], 0), true) }
    close(
        turnsAbout(context, 0, [{ rotationCenter: screenCenter, centerWeight: 1 }]),
        vec(0, 0),
        'default camera',
    )
})

test('the offsets move the center in the camera frame, in translation units', () => {
    for (const context of contexts()) {
        const camera = currentLayoutTransform(context.layout)
        for (const mode of modes) {
            const props = {
                elevation: 0.8,
                rotationCenter: mode,
                rotationCenterXOffset: 2,
                rotationCenterYOffset: -0.75,
            }
            close(
                turnsAbout(context, -1.5, [props]),
                add(
                    expectedCenter(camera, mode, -1.5, 0.8, 0),
                    cameraFrame(camera, 2 * camera.wScale, -0.75 * camera.wScale),
                ),
                `mode ${mode}, ${JSON.stringify(camera)}`,
            )
        }
    }
    // At full tilt, Stage Center with an X offset of 3 is Mask Center with a mask at lane 3.
    const context = [...contexts()][2]!
    close(
        turnsAbout(context, 0, [{ rotationCenter: stageCenter, rotationCenterXOffset: 3 }]),
        turnsAbout(context, 3, [{ rotationCenter: maskCenter }]),
        'stage center offset',
    )
})

test('only Mask Center follows the mask and rises with elevation', () => {
    for (const context of contexts())
        for (const mode of modes.slice(1)) {
            const label = `mode ${mode}, ${JSON.stringify(currentLayoutTransform(context.layout))}`
            const at = (maskLane: number, elevation: number) =>
                turnsAbout(context, maskLane, [{ rotationCenter: mode, elevation }])
            close(at(4, 0), at(0, 0), `${label}, mask`)
            close(at(0, 2), at(0, 0), `${label}, elevation`)
        }
})

test('the centers of a segment are lerped by its eased progress, offsets included', () => {
    const context = [...contexts()][3]!
    const camera = currentLayoutTransform(context.layout)
    for (const start of modes)
        for (const end of modes)
            for (const ease of [EaseType.linear, EaseType.outBack]) {
                const events = [
                    {
                        time: 0,
                        centerWeight: 0,
                        elevation: 0.7,
                        rotationCenter: start,
                        rotationCenterXOffset: 0.5,
                        ease,
                    },
                    {
                        time: 2,
                        xLaneTranslate: -0.8,
                        yLaneTranslate: 1.1,
                        centerWeight: 1,
                        elevation: 0.7,
                        rotationCenter: end,
                        rotationCenterYOffset: -0.25,
                    },
                ]
                for (const t of [0, 0.6, 1.7, 2]) {
                    const p = getStageProps(stage(2, events.map(event)), t).rotationCenter.progress
                    const weight = p
                    const expected = add(
                        lerpVec(
                            expectedCenter(camera, start, 2, 0.7, weight),
                            expectedCenter(camera, end, 2, 0.7, weight),
                            p,
                        ),
                        cameraFrame(
                            camera,
                            0.5 * (1 - p) * camera.wScale,
                            -0.25 * p * camera.wScale,
                        ),
                        expectedOffset(camera, -0.8 * p, 1.1 * p, weight),
                    )
                    close(
                        turnsAbout(context, 2, events, t),
                        expected,
                        `${start} to ${end}, ${ease} at ${t}`,
                    )
                }
            }
})

test('an unknown rotation center code reads as Mask Center', () => {
    const context = [...contexts()][5]!
    for (const code of [4, 1.5, -1, Number.NaN])
        for (const other of modes) {
            const at = (start: number, end: number) =>
                turnsAbout(
                    context,
                    2.5,
                    [
                        { rotationCenter: start, elevation: 0.7 },
                        { time: 2, rotationCenter: end, elevation: 0.7 },
                    ],
                    0.8,
                )
            close(at(code, other), at(maskCenter, other), `${code} to ${other}`)
            close(at(other, code), at(other, maskCenter), `${other} to ${code}`)
        }
})

/** The transform before rotation centers were configurable, copied from that version. */
const preChangeTransform = (
    camera: LayoutTransform,
    stageRotate: number,
    xLaneTranslate: number,
    yLaneTranslate: number,
    maskLane: number,
    centerWeight: number,
    elevation: number,
) => {
    const travel = approachAtTilt(1, camera.stageTilt)
    const width = widthFactorAtTilt(travel, camera.stageTilt)
    const projection = elevationProjection(camera, elevation)
    const judgeCenter = applyAffine(
        projection,
        rotateVec(
            vec(
                maskLane * width * camera.wScale + camera.xTranslate,
                travel * camera.hScale + camera.t,
            ),
            -camera.rotate,
        ),
    )
    const baseT = viewport.fieldH * FIELD_T_FACTOR
    const baseH = viewport.fieldH * FIELD_B_FACTOR - baseT
    const centerJudgeY = camera.hScale * (travel + baseT / baseH)
    const offset = rotateVec(
        vec(
            xLaneTranslate * camera.wScale,
            yLaneTranslate * camera.wScale - centerWeight * centerJudgeY,
        ),
        -camera.rotate,
    )
    const pivot = applyAffine(
        projection,
        rotateVec(
            vec(camera.xTranslate, lerp(travel, 0, camera.stageTilt) * camera.hScale + camera.t),
            -camera.rotate,
        ),
    )
    const cs = Math.cos(stageRotate)
    const sn = Math.sin(stageRotate)
    const dx = judgeCenter.x - pivot.x
    const dy = judgeCenter.y - pivot.y
    return {
        sr: stageRotate,
        px: pivot.x,
        py: pivot.y,
        tx: offset.x + (1 - cs) * dx - sn * dy,
        ty: offset.y + (1 - cs) * dy + sn * dx,
        projection,
    }
}

test('Mask Center gives exactly the transform from before rotation centers', () => {
    for (const context of contexts()) {
        const camera = currentLayoutTransform(context.layout)
        for (const [rotate, elevation, weight] of [
            [0, 0, 0],
            [0.7, 1, 1],
            [-2.1, 40, 0.5],
        ] as const) {
            const before = preChangeTransform(camera, rotate, 1.2, -0.7, -3, weight, elevation)
            assert.deepEqual(
                computeStageTransform(viewport, camera, rotate, 1.2, -0.7, -3, weight, elevation),
                before,
            )
            // With both ends Mask Center there is no blend, whatever the progress.
            for (const progress of [0.35, -0.4, 1.6])
                assert.deepEqual(
                    computeStageTransform(
                        viewport,
                        camera,
                        rotate,
                        1.2,
                        -0.7,
                        -3,
                        weight,
                        elevation,
                        maskCenter,
                        maskCenter,
                        progress,
                        0,
                        0,
                    ),
                    before,
                )
        }
    }
})
