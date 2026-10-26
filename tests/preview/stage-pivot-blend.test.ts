import assert from 'node:assert/strict'
import test from 'node:test'
import { FlickDirection } from '../../src/preview/engine/layout'
import type { Quad } from '../../src/preview/engine/math'
import {
    ConnectorKind,
    NoteKind,
    type PreviewChart,
    type PreviewConnector,
    type PreviewNote,
    type PreviewStage,
} from '../../src/preview/engine/model'
import { renderPreviewFrame } from '../../src/preview/engine/render'
import { createTimescaleGroup } from '../../src/preview/engine/timescale'
import type { PreviewRenderer } from '../../src/preview/gl'
import { resolveSkin, type PreviewSkin, type Sprite } from '../../src/preview/skin'

const body: Sprite = { u0: 0, v0: 0, u1: 1, v1: 1 }
const slot: Sprite = { ...body }
const glow: Sprite = { ...body }
const connection: Sprite = { ...body }
const sprites = { body, slot, glow, connection }
const skin: PreviewSkin = {
    ...resolveSkin(() => undefined),
    normalNote: {
        body: { renderType: 'normalFallback', middle: body },
        arrow: { fallback: false, up: [], down: [], upLeft: [], downLeft: [] },
        slot,
        slotGlow: glow,
    },
    activeSlideConnector: { normal: connection },
}

const stage = (rotate: number, xLaneTranslate: number, elevation: number): PreviewStage => ({
    order: 0,
    drawStartTime: 0,
    drawEndTime: 4,
    masks: [],
    pivots: [],
    styles: [],
    hasTransforms: true,
    transforms: [
        { time: 0, rotate, xLaneTranslate, yLaneTranslate: 0, elevation, centerWeight: 0, ease: 1 },
    ],
})

const note = (targetTime: number, stageIndex: number, values: Partial<PreviewNote> = {}) => ({
    kind: NoteKind.tap,
    style: 'default' as const,
    isCritical: false,
    isFake: false,
    targetTime,
    lane: 0,
    size: 1,
    elevation: 0,
    direction: FlickDirection.upOmni,
    groupIndex: 0,
    stageIndex,
    isAttached: false,
    connectorEase: 1 as const,
    targetScaledTime: targetTime,
    ...values,
})

// The first stage has no transform; a tiny translation makes the old code take the projected path.
const chart = (firstTranslate: number): PreviewChart => {
    const head = note(1, 0)
    const tail = note(3, 1)
    const attached = note(2, 0, { isAttached: true, attachHead: head, attachTail: tail })
    const connector: PreviewConnector = {
        kind: ConnectorKind.activeNormal,
        style: 'default',
        ease: 1,
        head,
        tail,
        segmentHead: head,
        segmentTail: tail,
        segmentHeadAlpha: 1,
        segmentTailAlpha: 1,
        layer: 0,
        throughJudgeLine: false,
        fullScreen: false,
    }
    return {
        isDynamicStages: true,
        hasStageTransforms: true,
        notes: [head, attached, tail],
        connectors: [connector],
        slides: [
            {
                activeHead: head,
                activeTail: tail,
                notes: [head, attached, tail],
                kind: ConnectorKind.activeNormal,
                connectors: [connector],
            },
        ],
        simLines: [],
        chains: [],
        cameras: [],
        groups: [createTimescaleGroup([], 0)],
        stages: [stage(0, firstTranslate, 0), stage(0.3, 1, 1)],
    }
}

const capture = (source: PreviewChart, now: number) => {
    const draws = new Map<Sprite, Quad[]>()
    const renderer: PreviewRenderer = {
        maxViewportSize: { width: 1920, height: 1920 },
        setTexture() {},
        begin() {},
        draw: (sprite, quad) => {
            if (sprite) draws.set(sprite, [...(draws.get(sprite) ?? []), quad])
        },
        flush() {},
        isContextLost: () => false,
        dispose() {},
    }
    renderPreviewFrame(renderer, skin, source, now, 1600, 900, 1600, 900, 8, true)
    return draws
}

test('a stage without a transform keeps its projected pivot in blends with a rotated stage', () => {
    // Before the attached note: its body, the slide head and the connector. After it: its slot effects.
    for (const [now, names] of [
        [1.5, ['body', 'connection']],
        [2.1, ['body', 'connection', 'slot', 'glow']],
    ] as const) {
        const actual = capture(chart(0), now)
        const expected = capture(chart(1e-300), now)
        for (const name of names) {
            const quads = actual.get(sprites[name]) ?? []
            const wanted = expected.get(sprites[name]) ?? []
            assert.ok(quads.length > 0, `${name} at ${now}`)
            assert.equal(quads.length, wanted.length, `${name} at ${now}`)
            for (const [index, quad] of quads.entries()) {
                for (const corner of ['bl', 'br', 'tl', 'tr'] as const) {
                    const a = quad[corner]
                    const b = wanted[index]?.[corner]
                    assert.ok(
                        b && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9,
                        `${name} ${index} ${corner} at ${now}: ${JSON.stringify(a)} ${JSON.stringify(b)}`,
                    )
                }
            }
        }
    }
})
