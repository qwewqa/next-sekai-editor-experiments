import assert from 'node:assert/strict'
import test from 'node:test'
import { createGeometryContext } from '../../src/preview/engine/hitbox'
import {
    createLayout,
    createViewport,
    getCameraInfo,
    type CameraChange,
} from '../../src/preview/engine/layout'
import type { Quad } from '../../src/preview/engine/math'
import type { PreviewChart } from '../../src/preview/engine/model'
import { previewBackgroundQuad } from '../../src/preview/engine/render'
import { drawTestAspectOverlay } from '../../src/preview/engine/stage'
import type { ZKey } from '../../src/preview/gl'
import type { PreviewSkin, Sprite } from '../../src/preview/skin'

const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} != ${expected}`)

// Reference: engine bfe6144 in watch mode with Test Aspect Ratio on and the stage aspect locked.
// sekai.lib.layout.refresh_layout gives DynamicLayout (t, w_scale, h_scale, x_translate,
// scaled_note_h), which camera_layout_transform_at_time also gives at the frame's time. Cameras:
// lane, size, zoom, zoom target lane, zoom target y, rotate, stage tilt.
type Camera = [number, number, number, number, number, number, number]
const layouts: [aspect: number, camera: Camera, expected: number[]][] = [
    [
        16 / 9,
        [0, 6, 1, 0, 0, 0, 1],
        [0.5463105867346939, 0.11659757653061224, -0.837531887755102, 0, -0.0369499362244898],
    ],
    [
        16 / 9,
        [1.5, 4, 1.3, -0.75, 0.35, 0.4, 0.6],
        [
            0.30808145093579586, 0.22736527423469388, -1.0887914540816326, -0.0928993388791922,
            -0.061855573162857405,
        ],
    ],
    [
        21 / 9,
        [0, 6, 1, 0, 0, 0, 1],
        [0.5463105867346939, 0.11659757653061224, -0.837531887755102, 0, -0.0369499362244898],
    ],
    [
        21 / 9,
        [1.5, 4, 1.3, -0.75, 0.35, 0.4, 0.6],
        [
            0.30808145093579586, 0.22736527423469388, -1.0887914540816326, -0.0928993388791922,
            -0.061855573162857405,
        ],
    ],
    [
        4 / 3,
        [0, 6, 1, 0, 0, 0, 1],
        [0.4097329400510204, 0.08744818239795918, -0.6281489158163265, 0, -0.027712452168367346],
    ],
    [
        4 / 3,
        [1.5, 4, 1.3, -0.75, 0.35, 0.4, 0.6],
        [
            0.2310610882018469, 0.1705239556760204, -0.8165935905612245, -0.06967450415939416,
            -0.04639167987214306,
        ],
    ],
]

test('the half-size layout matches the engine at each aspect ratio and camera', () => {
    for (const [
        aspect,
        [lane, size, zoom, targetLane, targetY, rotate, tilt],
        expected,
    ] of layouts) {
        const viewport = createViewport(900 * aspect, 900, true)
        const cameras: CameraChange[] = [
            {
                time: 0,
                lane,
                size,
                zoom,
                zoomTargetLane: targetLane,
                zoomTargetY: targetY,
                zoomVerticalAlign: 0,
                rotate,
                stageTilt: tilt,
                ease: 0,
            },
        ]
        const layout = createLayout(viewport, getCameraInfo(viewport, cameras, 1), true)
        const actual = [
            layout.t,
            layout.wScale,
            layout.hScale,
            layout.xTranslate,
            layout.scaledNoteH,
        ]
        for (const [i, value] of actual.entries()) close(value, expected[i]!, `${aspect} ${i}`)
        assert.equal(layout.rotate, rotate)

        // Hitboxes sample the layout at their own times, as camera_layout_transform_at_time does.
        const chart = { isDynamicStages: true, cameras } as unknown as PreviewChart
        const sampled = createGeometryContext(chart, viewport, 1).layout
        const terms = [sampled.t, sampled.wScale, sampled.hScale, sampled.xTranslate]
        for (const [i, value] of terms.entries()) close(value, expected[i]!, `${aspect} at ${i}`)
    }
})

// Reference: engine bfe6144, sekai.lib.stage.draw_test_aspect_overlay: guide sprite (1 red,
// 2 green, 3 blue), then the quad's left, bottom, right and top, and its z order on layer 24.
const boxes16x9 = [
    [1, -1.1706666666666667, 0.496, 1.1706666666666667, 0.504, 1000],
    [1, -1.1706666666666667, -0.504, 1.1706666666666667, -0.496, 1001],
    [1, -1.1706666666666667, -0.5, -1.1626666666666667, 0.5, 1002],
    [1, 1.1626666666666667, -0.5, 1.1706666666666667, 0.5, 1003],
    [3, -0.8928888888888888, 0.6626666666666666, 0.8928888888888888, 0.6706666666666666, 1004],
    [3, -0.8928888888888888, -0.6706666666666666, 0.8928888888888888, -0.6626666666666666, 1005],
    [3, -0.8928888888888888, -0.6666666666666666, -0.8848888888888888, 0.6666666666666666, 1006],
    [3, 0.8848888888888888, -0.6666666666666666, 0.8928888888888888, 0.6666666666666666, 1007],
    [2, -0.8928888888888888, 0.496, 0.8928888888888888, 0.504, 1008],
    [2, -0.8928888888888888, -0.504, 0.8928888888888888, -0.496, 1009],
    [2, -0.8928888888888888, -0.5, -0.8848888888888888, 0.5, 1010],
    [2, 0.8848888888888888, -0.5, 0.8928888888888888, 0.5, 1011],
]
const overlays: [aspect: number, boxes: number[][]][] = [
    [16 / 9, boxes16x9],
    [21 / 9, boxes16x9],
    [
        4 / 3,
        [
            [1, -0.879, 0.371, 0.879, 0.379, 1000],
            [1, -0.879, -0.379, 0.879, -0.371, 1001],
            [1, -0.879, -0.375, -0.871, 0.375, 1002],
            [1, 0.871, -0.375, 0.879, 0.375, 1003],
            [3, -0.6706666666666666, 0.496, 0.6706666666666666, 0.504, 1004],
            [3, -0.6706666666666666, -0.504, 0.6706666666666666, -0.496, 1005],
            [3, -0.6706666666666666, -0.5, -0.6626666666666666, 0.5, 1006],
            [3, 0.6626666666666666, -0.5, 0.6706666666666666, 0.5, 1007],
            [2, -0.6706666666666666, 0.371, 0.6706666666666666, 0.379, 1008],
            [2, -0.6706666666666666, -0.379, 0.6706666666666666, -0.371, 1009],
            [2, -0.6706666666666666, -0.375, -0.6626666666666666, 0.375, 1010],
            [2, 0.6626666666666666, -0.375, 0.6706666666666666, 0.375, 1011],
        ],
    ],
]

test('the outlines match the engine at each aspect ratio', () => {
    const guides = [0, 1, 2, 3].map((index) => ({ index }) as unknown as Sprite)
    const skin = { guides } as unknown as PreviewSkin
    for (const [aspect, expected] of overlays) {
        const drawn: number[][] = []
        const draw = (sprite: Sprite | undefined, quad: Quad, z: ZKey, alpha: number) => {
            assert.equal(alpha, 1)
            const [layer, , order] = z
            assert.equal(layer, 24)
            drawn.push([
                guides.indexOf(sprite!),
                quad.bl.x,
                quad.bl.y,
                quad.tr.x,
                quad.tr.y,
                order!,
            ])
        }
        drawTestAspectOverlay(createViewport(900 * aspect, 900, false), draw, skin)
        assert.equal(drawn.length, 0)
        drawTestAspectOverlay(createViewport(900 * aspect, 900, true), draw, skin)
        assert.equal(drawn.length, expected.length)
        for (const [i, row] of drawn.entries())
            for (const [j, value] of row.entries())
                close(value, expected[i]![j]!, `${aspect} ${i} ${j}`)
    }
})

test('the background is at half size about the screen center', () => {
    const off = previewBackgroundQuad([], 0, 1600, 900, false, { aspectRatio: 1.5, fit: 'cover' })
    const on = previewBackgroundQuad(
        [],
        0,
        1600,
        900,
        false,
        { aspectRatio: 1.5, fit: 'cover' },
        true,
    )
    for (const corner of ['bl', 'br', 'tl', 'tr'] as const) {
        close(on[corner].x, off[corner].x / 2, corner)
        close(on[corner].y, off[corner].y / 2, corner)
    }
})
