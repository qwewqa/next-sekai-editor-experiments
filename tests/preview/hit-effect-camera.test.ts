import assert from 'node:assert/strict'
import test from 'node:test'
import { FlickDirection, type CameraChange } from '../../src/preview/engine/layout'
import type { Quad } from '../../src/preview/engine/math'
import { NoteKind, type PreviewChart, type PreviewStage } from '../../src/preview/engine/model'
import { renderPreviewFrame } from '../../src/preview/engine/render'
import { createTimescaleGroup } from '../../src/preview/engine/timescale'
import type { PreviewRenderer } from '../../src/preview/gl'
import { resolveSkin, type PreviewSkin, type Sprite } from '../../src/preview/skin'

const body: Sprite = { u0: 0, v0: 0, u1: 1, v1: 1 }
const slot: Sprite = { ...body }
const glow: Sprite = { ...body }
const skin: PreviewSkin = {
    ...resolveSkin(() => undefined),
    normalNote: {
        body: { renderType: 'normalFallback', middle: body },
        arrow: { fallback: false, up: [], down: [], upLeft: [], downLeft: [] },
        slot,
        slotGlow: glow,
    },
}

const camera = (time: number, values: Partial<CameraChange> = {}): CameraChange => ({
    time,
    lane: 0,
    size: 6,
    zoom: 1,
    zoomTargetLane: 0,
    zoomTargetY: 0,
    zoomVerticalAlign: 0,
    rotate: 0,
    stageTilt: 1,
    ease: 1,
    ...values,
})

const stage = (elevation: number, rotate: number): PreviewStage => ({
    order: 0,
    drawStartTime: 0,
    drawEndTime: 3,
    masks: [],
    pivots: [],
    styles: [],
    hasTransforms: true,
    transforms: [
        {
            time: 0,
            rotate,
            xLaneTranslate: 1,
            yLaneTranslate: 0,
            elevation,
            centerWeight: 0,
            ease: 1,
        },
    ],
})

const chart = (cameras: CameraChange[], elevation: number, rotate: number): PreviewChart => ({
    isDynamicStages: true,
    hasStageTransforms: true,
    notes: [
        {
            kind: NoteKind.tap,
            style: 'default',
            isCritical: false,
            isFake: false,
            targetTime: 1,
            lane: 2,
            size: 1,
            elevation: 0,
            direction: FlickDirection.upOmni,
            groupIndex: 0,
            stageIndex: 0,
            isAttached: false,
            connectorEase: 1,
            targetScaledTime: 1,
        },
    ],
    connectors: [],
    slides: [],
    simLines: [],
    chains: [],
    cameras,
    groups: [createTimescaleGroup([], 0)],
    stages: [stage(elevation, rotate)],
})

const effects = (source: PreviewChart, now: number) => {
    const draws: Quad[][] = [[], []]
    const renderer: PreviewRenderer = {
        maxViewportSize: { width: 1920, height: 1920 },
        setTexture() {},
        begin() {},
        draw: (sprite, quad) => {
            if (sprite === slot) draws[0]?.push(quad)
            if (sprite === glow) draws[1]?.push(quad)
        },
        flush() {},
        isContextLost: () => false,
        dispose() {},
    }
    renderPreviewFrame(renderer, skin, source, now, 1600, 900, 1600, 900, 8, true)
    return draws
}

const assertQuadsClose = (actual: Quad[], expected: Quad[], message: string) => {
    assert.equal(actual.length, expected.length, message)
    assert.ok(actual.length > 0, message)
    for (const [index, quad] of actual.entries()) {
        for (const corner of ['bl', 'br', 'tl', 'tr'] as const) {
            const a = quad[corner]
            const b = expected[index]?.[corner]
            assert.ok(
                b && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9,
                `${message}: ${index} ${corner} ${JSON.stringify(a)} ${JSON.stringify(b)}`,
            )
        }
    }
}

test('hit slot effects stay on their raised stage while the camera moves', () => {
    const now = 1.2
    // Camera values at `now`, held from the start in the reference chart.
    const moves: [string, Partial<CameraChange>, Partial<CameraChange>][] = [
        ['rotation', { rotate: 0.6 }, { rotate: 0.6 * (now / 2) }],
        ['zoom', { zoom: 1.5 }, { zoom: 1 + 0.5 * (now / 2) }],
        ['tilt', { stageTilt: 0.5 }, { stageTilt: 1 - 0.5 * (now / 2) }],
    ]
    for (const [elevation, rotate] of [
        [2, 0],
        [1, 0.3],
    ] as const) {
        for (const [name, end, held] of moves) {
            const moving = effects(chart([camera(0), camera(2, end)], elevation, rotate), now)
            const still = effects(chart([camera(0, held)], elevation, rotate), now)
            const message = `${name} at elevation ${elevation}, stage rotation ${rotate}`
            assertQuadsClose(moving[0] ?? [], still[0] ?? [], `${message}: slots`)
            assertQuadsClose(moving[1] ?? [], still[1] ?? [], `${message}: glow`)
        }
    }
})
