import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { GroupId } from '../../src/chart/groups'
import type { StageId } from '../../src/chart/stages'
import type { TimeScaleObject } from '../../src/chart/timeScale'
import { EventAnnotations } from '../../src/editor/canvas/eventAnnotations'
import { drawEvent, drawEventInfinities, type EventPart } from '../../src/editor/canvas/events'
import { coveredLabelYs, drawGrid, timeScaleEdgeLabelYs } from '../../src/editor/canvas/grid'
import { createNameLayer, placeNames } from '../../src/editor/canvas/names'
import { raisedChains } from '../../src/editor/canvas/ordering'
import { clearTextWidths, drawText } from '../../src/editor/canvas/text'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { createComposedLayout } from '../../src/editor/composed'
import { createEventPath, createRangeEventPaths } from '../../src/editor/entities/events/path'
import { createScopeLookup, fullScope, type ScopeLookup } from '../../src/editor/scopeRules'
import type { WebGLDrawContext } from '../../src/rendering/context'
import { DrawPath } from '../../src/rendering/path'
import { createState } from '../../src/state'
import type { Entity, EntityType } from '../../src/state/entities'
import type { StageMaskEventJointEntity } from '../../src/state/entities/events/joints/stage/mask'
import type { StagePivotEventJointEntity } from '../../src/state/entities/events/joints/stage/pivot'
import type { StageTransformEventJointEntity } from '../../src/state/entities/events/joints/stage/transform'
import type { TimeScaleEntity } from '../../src/state/entities/timeScale'
import { calculateBpms } from '../../src/state/integrals/bpms'
import { recordEditorLabel } from './recordedLabel'

type RecordedPreparedLabel = Parameters<WebGLDrawContext['prepareEditorLabel']>
type RecordedPreparedGlyph = { path: DrawPath; color: string; width: number; released: boolean }

const prepareAnnotationsRecorder = (canvas: RecordingCanvas) => {
    const calls = { labels: 0, glyphs: 0, releases: 0, order: [] as string[], decline: false }
    Object.assign(canvas, {
        canvas: { width: 800, height: 600 },
        resourceOwner: {},
        getTransform: () => {
            const [a, d, e, f] = canvas.transform
            return { a, b: 0, c: 0, d, e, f }
        },
        prepareEditorLabel: (...label: RecordedPreparedLabel) => {
            calls.labels++
            return label
        },
        drawPreparedEditorLabel: (
            [
                text,
                color,
                fontFamily,
                scale,
                size,
                align,
                middle,
                alignToPixels,
            ]: RecordedPreparedLabel,
            x: number,
            y: number,
            opacity: number,
        ) => {
            canvas.save()
            canvas.globalAlpha *= opacity
            canvas.drawEditorLabel(
                text,
                x,
                y,
                color,
                fontFamily,
                scale,
                size,
                align,
                middle,
                alignToPixels,
            )
            canvas.restore()
        },
        prepareEaseGlyph: (path: DrawPath, color: string, width: number) => {
            calls.glyphs++
            calls.order.push('prepare')
            return calls.decline ? undefined : { path, color, width, released: false }
        },
        drawPreparedEaseGlyph: (
            glyph: RecordedPreparedGlyph,
            x: number,
            y: number,
            opacity: number,
        ) => {
            if (glyph.released) return false
            canvas.save()
            canvas.globalAlpha *= opacity
            canvas.strokeStyle = glyph.color
            canvas.lineWidth = glyph.width
            canvas.lineCap = 'round'
            canvas.lineJoin = 'round'
            canvas.setLineDash([])
            canvas.translate(x, y)
            canvas.stroke(glyph.path)
            canvas.restore()
            return true
        },
        releasePreparedEaseGlyph: (glyph: RecordedPreparedGlyph) => {
            assert.equal(glyph.released, false, 'each geometry lease releases once')
            glyph.released = true
            calls.releases++
            calls.order.push('release')
        },
    })
    return calls
}

class RecordingCanvas {
    globalAlpha = 1
    lineWidth = 1
    lineCap = 'butt'
    lineJoin = 'miter'
    strokeStyle = '#000'
    fillStyle = '#000'
    font = ''
    textAlign = 'start'
    textBaseline = 'alphabetic'
    fontKerning = 'auto'
    transform: [number, number, number, number] = [1, 1, 0, 0]
    lineDashOffset = 0
    dash: number[] = []
    currentPath: unknown[] = []
    retainedPaths: DrawPath[] = []
    strokes: { alpha: number; color: string; width: number; dash: number[]; path: unknown }[] = []
    labels: { text: string; x: number; y: number; align: string; alpha: number }[] = []
    gridLabels: Parameters<WebGLDrawContext['drawGridLabel']>[] = []
    editorLabels: Parameters<WebGLDrawContext['drawEditorLabel']>[] = []
    saved: (() => void)[] = []
    drawEditorLabel(...args: Parameters<WebGLDrawContext['drawEditorLabel']>) {
        this.editorLabels.push(args)
        recordEditorLabel.call(this, ...args)
    }

    drawGridLabel(...args: Parameters<WebGLDrawContext['drawGridLabel']>) {
        this.gridLabels.push(args)
        const [text, x, y, fontFamily, scale, align, middle] = args
        // Domain assertions use exact scene positions. The renderer's browser
        // oracle separately verifies the grid-only device-pixel anchor policy.
        recordEditorLabel.call(this, text, x, y, 'white', fontFamily, scale, 0.4, align, middle)
    }

    save() {
        const properties = {
            globalAlpha: this.globalAlpha,
            lineWidth: this.lineWidth,
            lineCap: this.lineCap,
            lineJoin: this.lineJoin,
            strokeStyle: this.strokeStyle,
            fillStyle: this.fillStyle,
            font: this.font,
            textAlign: this.textAlign,
            textBaseline: this.textBaseline,
            fontKerning: this.fontKerning,
            transform: this.transform,
            lineDashOffset: this.lineDashOffset,
            dash: this.dash,
        }
        this.saved.push(() => Object.assign(this, properties))
    }

    restore() {
        this.saved.pop()?.()
    }

    setLineDash(dash: number[]) {
        this.dash = dash
    }

    translate(x: number, y: number) {
        const [sx, sy, tx, ty] = this.transform
        this.transform = [sx, sy, tx + sx * x, ty + sy * y]
    }

    scale(x: number, y: number) {
        const [sx, sy, tx, ty] = this.transform
        this.transform = [sx * x, sy * y, tx, ty]
    }

    beginPath() {
        this.currentPath = []
    }

    moveTo(x: number, y: number) {
        this.currentPath.push(['M', x, y])
    }

    lineTo(x: number, y: number) {
        this.currentPath.push(['L', x, y])
    }

    closePath() {
        this.currentPath.push(['Z'])
    }

    arc(x: number, y: number, radius: number) {
        this.currentPath.push(['arc', x, y, radius])
    }

    fill() {}

    fillCircle(x: number, y: number, radius: number) {
        this.beginPath()
        this.arc(x, y, radius)
        this.fill()
    }

    strokeCircle(x: number, y: number, radius: number) {
        this.beginPath()
        this.arc(x, y, radius)
        this.stroke()
    }

    strokeLine(x1: number, y1: number, x2: number, y2: number) {
        this.beginPath()
        this.moveTo(x1, y1)
        this.lineTo(x2, y2)
        this.stroke()
    }

    stroke(path?: unknown) {
        if (path instanceof DrawPath) this.retainedPaths.push(path)
        // Record retained glyphs after the current transform, as Canvas draws them.
        if (path instanceof DrawPath && path.commands[0]?.[0] !== 'svg')
            path = path.commands.map((command) => {
                const [sx, sy, tx, ty] = this.transform
                if (command[0] === 'moveTo' || command[0] === 'lineTo')
                    return [
                        command[0] === 'moveTo' ? 'M' : 'L',
                        command[1] * sx + tx,
                        command[2] * sy + ty,
                    ]
                return [...command]
            })
        this.strokes.push({
            alpha: this.globalAlpha,
            color: this.strokeStyle,
            width: this.lineWidth,
            dash: this.dash,
            path: path ?? this.currentPath,
        })
    }

    // Every glyph is 0.6 em wide.
    measureText(text: string) {
        return { width: text.length * 0.6 * parseFloat(this.font) }
    }

    fillText(text: string, x: number, y: number) {
        const [sx, sy, tx, ty] = this.transform
        this.labels.push({
            text,
            x: tx + x * sx,
            y: ty + y * sy,
            align: this.textAlign,
            alpha: this.globalAlpha,
        })
    }
}

type DrawnEvent = Parameters<typeof drawEvent>[1]

const groupId = 1 as GroupId
const stageId = 1 as StageId

const makeContext = (overrides: Partial<Chart> = {}) => {
    const chart: Chart = {
        initialLife: 1000,
        isDynamicStages: true,
        bpms: [{ beat: 0, bpm: 120 }],
        groups: new Map(),
        stages: new Map([
            [
                stageId,
                {
                    name: 'Stage A',
                    isFromStart: true,
                    isUntilEnd: false,
                    generateSimLines: 'global',
                },
            ],
        ]),
        cameraEvents: [],
        stageMaskEvents: [],
        stagePivotEvents: [],
        stageStyleEvents: [],
        stageTransformEvents: [],
        timeScales: [],
        slides: [],
        ...overrides,
    }
    const canvas = new RecordingCanvas()
    const context: EditorDrawContext = {
        ctx: canvas as unknown as WebGLDrawContext,
        scale: 10,
        pixelRatio: 2,
        bounds: { l: -10, r: 10, t: -100, b: 0, w: 20, h: 100 },
        ups: -10,
        state: createState(chart, 0),
        defaultGroupId: groupId,
        showStageName: true,
        showGroupName: true,
        nameContrast: false,
        recentlyActive: false,
        fontFamily: 'sans-serif',
        fontMiddle: 0.25,
        figureMiddle: 0.375,
    }
    return { canvas, context }
}

test('Composed grid keeps faint outer references and extends every horizontal guide to the pane', () => {
    const inspect = (composed: boolean) => {
        const { canvas, context } = makeContext()
        context.scale = 40
        if (composed) context.composed = createComposedLayout(context.state)
        drawGrid(context, { min: 0, max: 4 }, { min: 0, max: 0 }, 4, 4)
        return canvas.strokes.flatMap(({ path, alpha, width }) => {
            const points = path as [string, number, number][]
            return Array.from({ length: points.length / 2 }, (_, i) => ({
                alpha,
                width,
                from: points[i * 2]!.slice(1),
                to: points[i * 2 + 1]!.slice(1),
            }))
        })
    }
    const composed = inspect(true)
    const vertical = composed.filter(({ from, to }) => from[0] === to[0])
    assert.deepEqual(
        vertical.map(({ from, alpha }) => [from[0], alpha]),
        [
            [-6, 0.12],
            [6, 0.12],
        ],
    )
    const horizontal = composed.filter(({ from, to }) => from[1] === to[1])
    assert.ok(horizontal.length > 0)
    assert.ok(horizontal.every(({ from, to }) => from[0] === -10 && to[0] === 10))
    assert.ok(
        horizontal.some(({ alpha, width }) => alpha === 0.4 && width === 2 / 40),
        'Composed measures are thinner and less emphasized than the preview line',
    )
    const basic = inspect(false)
    assert.ok(basic.some(({ alpha, width }) => alpha === 0.7 && width === 3 / 40))
    assert.equal(basic.filter(({ from, to }) => from[0] === to[0]).length, 49)
    assert.ok(
        basic
            .filter(({ from, to }) => from[1] === to[1])
            .every(({ from, to }) => from[0] === -6 && to[0] === 6),
    )
})

const mask = (beat: number): StageMaskEventJointEntity => ({
    type: 'stageMaskEventJoint',
    stageId,
    beat,
    maskLeft: -4,
    maskSize: 8,
    isMaskNotes: true,
    eventEase: 'inOutQuad',
})

const visibilities = {
    cameraEventConnection: true,
    stageMaskEventConnection: true,
    stagePivotEventConnection: true,
    stageStyleEventConnection: true,
    stageTransformEventConnection: true,
} as Record<EntityType, boolean>

test('event connections reuse geometry while scrolling but invalidate for BPM edits and zoom', () => {
    const { context, canvas } = makeContext()
    const entity = {
        type: 'stageMaskEventConnection' as const,
        beat: 2,
        min: mask(2),
        max: { ...mask(4), maskLeft: -2, maskSize: 4 },
    }
    drawEvent(context, entity, false, 0.25)
    assert.equal(canvas.strokes.length, 2)
    assert.deepEqual(
        canvas.retainedPaths.map((path) => path.commands),
        [
            [
                ['moveTo', -4, -10],
                ['quadraticCurveTo', -4, -12.5, -3, -15],
                ['quadraticCurveTo', -2, -17.5, -2, -20],
            ],
            [
                ['moveTo', 4, -10],
                ['quadraticCurveTo', 4, -12.5, 3, -15],
                ['quadraticCurveTo', 2, -17.5, 2, -20],
            ],
        ],
    )
    assert.equal(canvas.strokes[0]?.alpha, 0.125)
    assert.equal(canvas.strokes[0]?.width, 0.2)
    assert.equal(canvas.globalAlpha, 1)

    context.bounds = { ...context.bounds, t: -120, b: -20 }
    drawEvent(context, entity, false)
    assert.equal(canvas.retainedPaths[2], canvas.retainedPaths[0])

    context.ups = -20
    drawEvent(context, entity, false)
    assert.notEqual(canvas.retainedPaths[4], canvas.retainedPaths[0])
    assert.deepEqual(canvas.retainedPaths[4]?.commands[0], ['moveTo', -4, -20])

    context.state = { ...context.state, bpms: calculateBpms([{ x: 0, y: 0, s: 1 }]) }
    drawEvent(context, entity, false)
    assert.notEqual(canvas.retainedPaths[6], canvas.retainedPaths[4])
    assert.deepEqual(canvas.retainedPaths[6]?.commands[0], ['moveTo', -4, -40])
})

test('mask infinities preserve stage lifetime flags and hidden-stage behavior', () => {
    const { context, canvas } = makeContext()
    context.state.store.stageEventRanges.stageMaskEventJoint.set(stageId, {
        min: mask(2),
        max: mask(4),
    })
    drawEventInfinities(context, visibilities, fullScope, false)
    assert.deepEqual(
        canvas.strokes.map(({ path }) => path),
        [
            [
                ['M', -4, 0],
                ['L', -4, -10],
            ],
            [
                ['M', 4, 0],
                ['L', 4, -10],
            ],
        ],
    )

    canvas.strokes = []
    drawEventInfinities(
        context,
        visibilities,
        createScopeLookup({ stageId: 2 as StageId, showOtherStages: false }),
        false,
    )
    assert.equal(canvas.strokes.length, 0)
    drawEventInfinities(
        context,
        visibilities,
        createScopeLookup({ stageId: 2 as StageId, showOtherStages: true }),
        false,
    )
    assert.equal(canvas.strokes.length, 2)
    assert.equal(canvas.strokes[0]?.alpha, 0.125)

    const savedVisibility = new Map([[stageId, 'hidden' as const]])
    for (const showOtherStages of [false, true]) {
        canvas.strokes = []
        drawEventInfinities(
            context,
            visibilities,
            createScopeLookup({ stageId, stageVisibility: savedVisibility, showOtherStages }),
            false,
        )
        assert.equal(
            canvas.strokes.length,
            2,
            'a selected stage draws its infinity lines even with its saved eye hidden',
        )
        assert.equal(canvas.strokes[0]?.alpha, 0.5)
        canvas.strokes = []
        drawEventInfinities(
            context,
            visibilities,
            createScopeLookup({ stageVisibility: savedVisibility, showOtherStages }),
            false,
        )
        assert.equal(canvas.strokes.length, 0, 'All restores the saved hidden stage')
    }

    context.state.stages.set(stageId, {
        name: 'Stage A',
        isFromStart: false,
        isUntilEnd: true,
        generateSimLines: 'global',
    })
    canvas.strokes = []
    drawEventInfinities(context, visibilities, createScopeLookup({ stageId }), false)
    assert.deepEqual(canvas.strokes[0]?.path, [
        ['M', -4, -20],
        ['L', -4, -100],
    ])
})

test('event visibility orders faint infinity layers before visible layers', () => {
    const { context, canvas } = makeContext()
    context.state.store.stageEventRanges.stageMaskEventJoint.set(stageId, {
        min: mask(2),
        max: mask(4),
    })
    context.state.store.stageEventRanges.stagePivotEventJoint.set(stageId, {
        min: {
            ...mask(2),
            type: 'stagePivotEventJoint',
            pivotLane: 0,
            divisionSize: 2,
            divisionParity: 'even',
            yOffset: 0,
            yOffsetBeat: 0,
        },
        max: {
            ...mask(4),
            type: 'stagePivotEventJoint',
            pivotLane: 1,
            divisionSize: 2,
            divisionParity: 'even',
            yOffset: 0,
            yOffsetBeat: 0,
        },
    })
    drawEventInfinities(
        context,
        { ...visibilities, stagePivotEventConnection: false },
        fullScope,
        true,
    )
    assert.deepEqual(
        canvas.strokes.map(({ color, alpha }) => [color, alpha]),
        [
            ['#00f', 0.125],
            ['#00f', 0.125],
            ['#0f0', 0.5],
            ['#0f0', 0.5],
        ],
    )
})

// Infinities read only these fields.
const transform = (beat: number, xTranslation: number) =>
    ({
        type: 'stageTransformEventJoint',
        stageId,
        beat,
        xTranslation,
    }) as StageTransformEventJointEntity

test('a raised chain raises both its extensions into the raised pass, drawing each once', () => {
    const { context, canvas } = makeContext()
    const ranges = context.state.store.stageEventRanges.stageTransformEventJoint
    // The base and raised passes' strokes.
    const both = (selected: Entity[], shown = visibilities, scope: ScopeLookup = fullScope) => {
        const chains = raisedChains(new Set(selected))
        const paths = (isRaisedPass: boolean) => {
            canvas.strokes = []
            drawEventInfinities(context, shown, scope, true, chains, isRaisedPass)
            return canvas.strokes.map(({ path }) => path)
        }
        return { base: paths(false), raised: paths(true) }
    }
    const start = [
        ['M', 1, 0],
        ['L', 1, -10],
    ]
    const end = [
        ['M', 3, -20],
        ['L', 3, -100],
    ]
    const down = { base: [start, end], raised: [] }
    const up = { base: [], raised: [start, end] }

    const min = transform(2, 1)
    const middle = transform(3, 2)
    const max = transform(4, 3)
    ranges.set(stageId, { min, max })
    assert.deepEqual(both([]), down)
    assert.deepEqual(both([min]), up)
    assert.deepEqual(both([middle]), up)
    assert.deepEqual(both([max]), up)

    // Another stage's chain, or another type's, leaves it down.
    assert.deepEqual(both([{ ...middle, stageId: 2 as StageId }]), down)
    assert.deepEqual(
        both([{ type: 'stagePivotEventJoint', stageId, beat: 3 } as StagePivotEventJointEntity]),
        down,
    )

    // One joint raises both.
    const only = transform(2, 1)
    ranges.set(stageId, { min: only, max: only })
    assert.deepEqual(both([only]), {
        base: [],
        raised: [
            start,
            [
                ['M', 1, -10],
                ['L', 1, -100],
            ],
        ],
    })

    // A chain whose joints are all below the pane still raises its extensions.
    context.bounds = { ...context.bounds, t: -100, b: -50, h: 50 }
    ranges.set(stageId, { min, max })
    assert.deepEqual(both([middle]), up)

    // Faint chains stay in the base pass.
    const hidden = {
        ...visibilities,
        stageTransformEventJoint: false,
        stageTransformEventConnection: false,
    }
    assert.deepEqual(both([middle], hidden), down)
    assert.deepEqual(
        both(
            [middle],
            visibilities,
            createScopeLookup({ stageId: 2 as StageId, showOtherStages: true }),
        ),
        down,
    )
})

test('the raised pass keeps a mask stage that is not from the start without its start extension', () => {
    const { context, canvas } = makeContext()
    const min = mask(2)
    context.state.store.stageEventRanges.stageMaskEventJoint.set(stageId, { min, max: mask(4) })
    context.state.stages.set(stageId, {
        name: 'Stage A',
        isFromStart: false,
        isUntilEnd: true,
        generateSimLines: 'global',
    })
    const chains = raisedChains(new Set([min]))
    drawEventInfinities(context, visibilities, fullScope, false, chains)
    assert.equal(canvas.strokes.length, 0)
    drawEventInfinities(context, visibilities, fullScope, false, chains, true)
    assert.deepEqual(
        canvas.strokes.map(({ path }) => path),
        [
            [
                ['M', -4, -20],
                ['L', -4, -100],
            ],
            [
                ['M', 4, -20],
                ['L', 4, -100],
            ],
        ],
    )
})

test('time-scale dashes stay in CSS pixels and stage labels respond to highlighting', () => {
    const { context, canvas } = makeContext()
    drawEvent(
        context,
        {
            type: 'timeScale',
            groupId,
            beat: 2,
            editorLane: -7,
            timeScale: 2,
            skip: 1,
            timeScaleEase: 'linear',
            timeScaleTransition: 'timeScale',
            hideNotes: true,
        },
        false,
    )
    assert.deepEqual(canvas.strokes[0]?.dash, [0.2, 0.2])
    // The dotted line stops at the hollow marker.
    assert.deepEqual(canvas.strokes[0]?.path, [
        ['M', -6.9, -10],
        ['L', 6, -10],
    ])
    assert.deepEqual(canvas.strokes[1]?.path, [['arc', -7, -10, 0.1]])
    assert.equal(canvas.strokes[1]?.color, '#ff0')
    assert.deepEqual(canvas.labels, [
        { text: '2x+1', x: -7.23 - 0.36, y: -9.8125, align: 'end', alpha: 1 },
    ])
    assert.deepEqual(canvas.dash, [])

    canvas.labels = []
    drawEvent(context, mask(2), false)
    assert.equal(canvas.labels.length, 0)
    drawEvent(context, mask(2), true)
    assert.deepEqual(canvas.labels, [{ text: 'Stage A', x: 0, y: -9.9, align: 'center', alpha: 1 }])
})

test('a BPM label rounds as Properties shows it', () => {
    const { context, canvas } = makeContext()
    drawEvent(context, { type: 'bpm', beat: 2, bpm: 150.123456789, meter: 4 }, false)
    drawEvent(context, { type: 'bpm', beat: 2, bpm: 150.5, meter: 4 }, false)
    assert.deepEqual(
        canvas.labels.map(({ text }) => text),
        ['150.1235', '150.5'],
    )
})

test('number labels centre on their figures and names on the x-height', () => {
    const { context, canvas } = makeContext()
    context.showStageName = false
    context.state.groups.set(2 as GroupId, { name: 'Group B' })
    drawEvent(context, { type: 'bpm', beat: 2, bpm: 180, meter: 4 }, false)
    drawEvent(
        context,
        {
            type: 'timeScale',
            groupId: 2 as GroupId,
            beat: 2,
            editorLane: 7,
            timeScale: 1.5,
            skip: 0,
            timeScaleEase: 'linear',
            timeScaleTransition: 'timeScale',
            hideNotes: false,
        },
        true,
    )
    // Baselines sit size × middle below the line at y = -10.
    assert.deepEqual(
        canvas.labels.map(({ text, y }) => [text, y]),
        [
            ['180', -10 + 0.5 * 0.375],
            ['1.5x', -10 + 0.5 * 0.375],
            ['Group B', -10 + 0.4 * 0.25],
        ],
    )
})

test('time-scale markers show the transition and whether notes are shown', () => {
    const { context, canvas } = makeContext()
    const draw = (timeScaleTransition: 'timeScale' | 'scroll', hideNotes: boolean) => {
        canvas.strokes = []
        drawEvent(
            context,
            {
                type: 'timeScale',
                groupId,
                beat: 2,
                editorLane: 0,
                timeScale: 1,
                skip: 0,
                timeScaleEase: 'inStep',
                timeScaleTransition,
                hideNotes,
            },
            false,
        )
        // Lines and marker; the ease glyph follows.
        return canvas.strokes.slice(0, -1).map(({ path, color }) => ({ path, color }))
    }

    assert.deepEqual(draw('timeScale', false).slice(-1), [
        { path: [['arc', 0, -10, 0.1]], color: '#fff' },
    ])
    const diamond = [
        ['M', 0, -10.135],
        ['L', 0.135, -10],
        ['L', 0, -9.865],
        ['L', -0.135, -10],
        ['Z'],
    ]
    assert.deepEqual(draw('scroll', false), [
        {
            path: [
                ['M', -6, -10],
                ['L', 0, -10],
            ],
            color: '#ff0',
        },
        {
            path: [
                ['M', 0, -10],
                ['L', 6, -10],
            ],
            color: '#ff0',
        },
        { path: diamond, color: '#fff' },
    ])
    assert.deepEqual(draw('scroll', true), [
        {
            path: [
                ['M', -6, -10],
                ['L', -0.135, -10],
            ],
            color: '#ff0',
        },
        {
            path: [
                ['M', 0.135, -10],
                ['L', 6, -10],
            ],
            color: '#ff0',
        },
        { path: diamond, color: '#ff0' },
    ])
})

test('time-scale eases show their curve toward the next change in the group', () => {
    const { context, canvas } = makeContext()
    const timeScale = (
        beat: number,
        value: number,
        timeScaleEase: TimeScaleEntity['timeScaleEase'],
        group = groupId,
    ): TimeScaleObject => ({
        groupId: group,
        beat,
        editorLane: 7,
        timeScale: value,
        skip: 0,
        timeScaleEase,
        timeScaleTransition: 'timeScale',
        hideNotes: false,
    })
    context.state = createState(
        {
            ...context.state,
            bpms: [{ beat: 0, bpm: 120 }],
            groups: new Map(),
            stages: new Map(),
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            slides: [],
            timeScales: [
                timeScale(1, 1, 'linear'),
                timeScale(2, 3, 'outStep'),
                timeScale(3, 9, 'linear', 2 as GroupId),
                timeScale(4, 0.5, 'inQuad'),
                timeScale(5, 0.5, 'inStep'),
            ],
        },
        0,
    )
    const entities = [...context.state.store.grid.timeScale.values()]
        .flatMap((set) => [...set])
        .sort((a, b) => a.beat - b.beat)
    const glyph = (index: number) => {
        canvas.strokes = []
        canvas.labels = []
        drawEvent(context, entities[index]!, false)
        return { glyph: canvas.strokes[2], label: canvas.labels[0] }
    }
    const rounded = (path: unknown) =>
        (path as [string, number, number][]).map(([command, x, y]) => [
            command,
            +x.toFixed(9),
            +y.toFixed(9),
        ])

    // Rising to the next change in the same group, past the other group's change.
    const rising = glyph(0)
    assert.equal(rising.glyph?.alpha, 1)
    assert.equal(rising.glyph?.width, 0.1)
    assert.deepEqual(rounded(rising.glyph?.path), [
        ['M', 7.23, -4.83],
        ['L', 7.53, -5.17],
    ])
    assert.equal(rising.label?.text, '1x')
    assert.ok(Math.abs(rising.label!.x - 7.59) < 1e-9)

    // Falling mirrors the curve.
    const falling = glyph(1)
    assert.deepEqual(rounded(falling.glyph?.path), [
        ['M', 7.53, -9.83],
        ['L', 7.23, -9.83],
        ['L', 7.23, -10.17],
    ])

    // Without a later change in its group, or toward the same value, show a padded equals sign.
    const lastInGroup = glyph(2)
    const sameValue = glyph(3)
    assert.equal(lastInGroup.glyph?.alpha, 0.7)
    assert.equal(sameValue.glyph?.alpha, 0.7)
    assert.deepEqual(rounded(lastInGroup.glyph?.path), [
        ['M', 7.28, -15.085],
        ['L', 7.48, -15.085],
        ['M', 7.28, -14.915],
        ['L', 7.48, -14.915],
    ])
    assert.deepEqual(rounded(sameValue.glyph?.path), [
        ['M', 7.28, -20.085],
        ['L', 7.48, -20.085],
        ['M', 7.28, -19.915],
        ['L', 7.48, -19.915],
    ])

    // Previews outside the chart have no known next change.
    canvas.strokes = []
    drawEvent(context, { ...entities[3]!, beat: 10 }, false)
    assert.equal(canvas.strokes[2]?.alpha, 1)

    // The final held step also shows equals, and its value keeps the same column.
    const step = glyph(4)
    assert.equal(step.glyph?.alpha, 0.7)
    assert.deepEqual(rounded(step.glyph?.path), [
        ['M', 7.28, -25.085],
        ['L', 7.48, -25.085],
        ['M', 7.28, -24.915],
        ['L', 7.48, -24.915],
    ])
    assert.ok(Math.abs(step.label!.x - 7.59) < 1e-9)
    canvas.strokes = []
    drawEvent(context, { ...entities[4]!, beat: 10 }, false)
    assert.equal(canvas.strokes[2]?.alpha, 0.7)

    // None draws and fades as the in step it equals, even toward a different value.
    const drawn = (timeScaleEase: TimeScaleEntity['timeScaleEase']) => {
        canvas.strokes = []
        drawEvent(context, { ...entities[1]!, timeScaleEase } as TimeScaleEntity, false)
        return canvas.strokes[2]
    }
    assert.equal(drawn('none')?.alpha, 0.7)
    assert.deepEqual(drawn('none'), drawn('inStep'))
})

test('time-scale glyphs share relative paths while positions and edited eases stay current', () => {
    const timeScales: TimeScaleObject[] = [1, 2, 3].map((value, index) => ({
        groupId,
        beat: index + 1,
        editorLane: 7,
        timeScale: value,
        skip: 0,
        timeScaleEase: 'linear',
        timeScaleTransition: 'timeScale',
        hideNotes: false,
    }))
    const { context, canvas } = makeContext({ timeScales })
    const entities = [...context.state.store.grid.timeScale.values()]
        .flatMap((set) => [...set])
        .sort((a, b) => a.beat - b.beat)
    const first = entities[0]!
    const second = entities[1]!
    const last = entities[2]!
    const draw = (entity: TimeScaleEntity) => {
        canvas.retainedPaths = []
        canvas.strokes = []
        drawEvent(context, entity, false, 1, 'label')
        assert.equal(canvas.retainedPaths.length, 1)
        assert.deepEqual(canvas.transform, [1, 1, 0, 0])
        return { source: canvas.retainedPaths[0]!, stroke: canvas.strokes[0]! }
    }
    const a = draw(first)
    const b = draw(second)
    assert.equal(a.source, b.source)
    assert.notDeepEqual(a.stroke.path, b.stroke.path)

    const moved = draw({ ...first, beat: first.beat + 4, editorLane: -7 })
    assert.equal(moved.source, a.source)
    assert.notDeepEqual(moved.stroke.path, a.stroke.path)
    assert.equal(moved.stroke.alpha, a.stroke.alpha)
    assert.equal(moved.stroke.width, a.stroke.width)

    const edited = draw({ ...first, timeScaleEase: 'inQuad' })
    assert.notEqual(edited.source, a.source)
    assert.notDeepEqual(edited.stroke.path, a.stroke.path)
    assert.equal(draw(first).source, a.source)

    const constant = draw(last)
    assert.notEqual(constant.source, a.source)
    assert.equal(constant.stroke.alpha, 0.7)
})

test('event paths draw steps as held values and sample other curves', () => {
    for (const eventEase of ['inStep', 'none'] as const)
        assert.deepEqual(createEventPath(0, 2, 0, -4, eventEase).commands, [
            ['moveTo', 0, 0],
            ['lineTo', 0, -4],
        ])
    assert.deepEqual(createEventPath(0, 2, 0, -4, 'outStep').commands, [
        ['moveTo', 2, 0],
        ['lineTo', 2, -4],
    ])
    assert.deepEqual(createEventPath(0, 2, 0, -4, 'inOutStep').commands, [
        ['moveTo', 0, 0],
        ['lineTo', 0, -2],
        ['moveTo', 2, -2],
        ['lineTo', 2, -4],
    ])
    assert.deepEqual(createEventPath(0, 2, 0, -4, 'outInStep').commands, [
        ['moveTo', 1, 0],
        ['lineTo', 1, -4],
    ])
    const sampled = createEventPath(0, 2, 0, -4, 'inBack').commands
    assert.equal(sampled[0]?.[0], 'moveTo')
    const xs = sampled.map((command) => {
        assert.ok(command[0] === 'moveTo' || command[0] === 'lineTo')
        return command[1]
    })
    assert.ok(Math.min(...xs) < -0.15)
    assert.ok(Math.abs(xs.at(-1)! - 2) < 1e-12)
})

test('overshooting mask connections keep the engine minimum width instead of crossing', () => {
    const { context, canvas } = makeContext()
    // Closing to its center with OUT_BACK, the mask width would overshoot below 0.
    drawEvent(
        context,
        {
            type: 'stageMaskEventConnection' as const,
            beat: 2,
            min: { ...mask(2), eventEase: 'outBack' },
            max: { ...mask(4), maskLeft: 0, maskSize: 0 },
        },
        false,
    )
    const [left, right] = canvas.retainedPaths.map((path) =>
        path.commands.map((command) => {
            assert.ok(command[0] === 'moveTo' || command[0] === 'lineTo')
            return command[1]
        }),
    )
    assert.equal(left!.length, right!.length)
    for (const [index, x] of left!.entries()) assert.ok(x <= right![index]! + 1e-12)
    assert.ok(left!.some((x, index) => x === right![index]))
    // Ranges that cannot reach the minimum keep their exact paths.
    assert.deepEqual(
        createRangeEventPaths([-3, 3], [-1, 1], 0, -4, 'inBack', 0.02).map((path) => path.commands),
        [
            createEventPath(-3, -1, 0, -4, 'inBack').commands,
            createEventPath(3, 1, 0, -4, 'inBack').commands,
        ],
    )
})

test('each change of a same-beat pair draws its own label, and same-beat joints no count', () => {
    const timeScale = (value: number): TimeScaleObject => ({
        groupId,
        beat: 2,
        editorLane: 7,
        timeScale: value,
        skip: 0,
        timeScaleEase: 'inStep',
        timeScaleTransition: 'timeScale',
        hideNotes: false,
    })
    const camera = (zoom: number) => ({
        beat: 3,
        cameraLeft: -6,
        cameraSize: 12,
        cameraZoom: zoom,
        cameraZoomTargetLane: 0,
        cameraZoomTargetY: 0,
        cameraZoomVerticalAlign: 'default' as const,
        cameraRotation: 0,
        cameraStageTilt: 1,
        eventEase: 'linear' as const,
    })
    const { context, canvas } = makeContext({
        timeScales: [timeScale(1), timeScale(2)],
        cameraEvents: [camera(1), camera(2)],
    })
    const { grid } = context.state.store
    for (const type of ['timeScale', 'cameraEventJoint'] as const)
        for (const entities of grid[type].values())
            for (const entity of entities) drawEvent(context, entity, false)
    assert.deepEqual(
        canvas.labels.map(({ text }) => text),
        ['1x', '2x'],
    )
})

test('a same-beat pair rounds the value in each label', () => {
    const timeScale = (value: number): TimeScaleObject => ({
        groupId,
        beat: 2,
        editorLane: 7,
        timeScale: value,
        skip: 1.23456789,
        timeScaleEase: 'inStep',
        timeScaleTransition: 'timeScale',
        hideNotes: false,
    })
    const { context, canvas } = makeContext({
        timeScales: [timeScale(1.123456789), timeScale(0.333333333)],
    })
    for (const entities of context.state.store.grid.timeScale.values())
        for (const entity of entities) drawEvent(context, entity, false)
    assert.deepEqual(
        canvas.labels.map(({ text }) => text),
        ['1.1235x+1.2346', '0.3333x+1.2346'],
    )
})

test('time-scale labels turn inward only inside the stage, where outward would leave the view', () => {
    const timeScale = (beat: number, editorLane: number, value: number): TimeScaleObject => ({
        groupId: 2 as GroupId,
        beat,
        editorLane,
        timeScale: value,
        skip: 0,
        timeScaleEase: 'inStep',
        timeScaleTransition: 'timeScale',
        hideNotes: false,
    })
    const { context, canvas } = makeContext({
        groups: new Map([[2 as GroupId, { name: 'B' }]]),
        timeScales: [
            timeScale(2, -8, 1),
            timeScale(2, -8, 0.25),
            timeScale(3, -6, 2),
            timeScale(4, 9.5, 4),
        ],
    })
    for (const entities of context.state.store.grid.timeScale.values())
        for (const entity of entities) drawEvent(context, entity, true)
    // Marker gap and ease take 0.59 lanes, and each test glyph 0.3.
    assert.deepEqual(
        canvas.labels.map(({ text, x, align }) => [text, Math.round(x * 100) / 100, align]),
        [
            // At or past the stage's edge, labels stay outward even without room.
            ['1x', -8.59, 'end'],
            ['B', -7.8, 'start'],
            ['0.25x', -8.59, 'end'],
            ['B', -7.8, 'start'],
            ['2x', -6.59, 'end'],
            ['B', -5.8, 'start'],
            ['4x', 10.09, 'start'],
            ['B', 9.3, 'end'],
        ],
    )
    // Inside it, a label without room outside turns inward, its group name after its text.
    const inner = makeContext({
        groups: new Map([[2 as GroupId, { name: 'B' }]]),
        timeScales: [timeScale(5, 5.5, 4)],
    })
    inner.context.bounds = { ...inner.context.bounds, r: 6.5 }
    for (const entities of inner.context.state.store.grid.timeScale.values())
        for (const entity of entities) drawEvent(inner.context, entity, true)
    assert.deepEqual(
        inner.canvas.labels.map(({ text, x, align }) => [text, Math.round(x * 100) / 100, align]),
        [
            ['4x', 4.91, 'end'],
            ['B', 4.11, 'end'],
        ],
    )
})

test('a BPM label takes the place of beat labels near enough to overlap', () => {
    const { context, canvas } = makeContext({
        bpms: [
            { beat: 0, bpm: 120 },
            { beat: 9.25, bpm: 60 },
        ],
    })
    const draw = (ups: number) => {
        canvas.labels = []
        canvas.gridLabels = []
        drawGrid({ ...context, ups }, { min: 8, max: 11 }, { min: 0, max: 0 }, 1, 1, 'beat', true)
        assert.deepEqual(
            canvas.gridLabels.map(([text]) => text),
            canvas.labels.map(({ text }) => text),
            'each visible beat label uses the explicit grid-label operation once',
        )
        return canvas.labels.map(({ text }) => text)
    }
    // Beat 9 is 0.125 s before the change, beat 10 0.75 s after.
    assert.deepEqual(draw(-1), ['9', '11', '12'])
    assert.deepEqual(draw(-10), ['9', '10', '11', '12'])
})

test('beat labels closer than 2px are skipped, so a huge BPM draws a bounded number', () => {
    const { context, canvas } = makeContext({
        bpms: [
            { beat: 0, bpm: 120 },
            { beat: 4, bpm: 100000 },
        ],
    })
    // 2 s at 120 BPM, then 8 s at 0.06px per beat: about 13,000 beats in 800px.
    drawGrid(context, { min: 0, max: 13337 }, { min: 0, max: 0 }, 1, 1, 'beat')
    const texts = canvas.labels.map(({ text }) => text)
    assert.deepEqual(texts.slice(0, 4), ['2', '3', '4', '5'])
    assert.ok(texts.length > 300 && texts.length <= 404, `${texts.length}`)
})

const edgeTimeScale = (beat: number, editorLane: number): TimeScaleObject => ({
    groupId,
    beat,
    editorLane,
    timeScale: 15,
    skip: 0,
    timeScaleEase: 'inStep',
    timeScaleTransition: 'timeScale',
    hideNotes: false,
})

/** The time and beat labels the grid draws beside these time scales, at 120 BPM. */
const gridLabelsBeside = (timeScales: TimeScaleObject[], bounds?: { l: number; r: number }) => {
    const { context, canvas } = makeContext({ timeScales })
    if (bounds) context.bounds = { ...context.bounds, ...bounds }
    const entities = new Set(
        [...context.state.store.grid.timeScale.values()].flatMap((bucket) => [...bucket]),
    )
    const steps = [...entities].flatMap((entity) => [
        { entity, part: 'line' as const },
        { entity, part: 'marker' as const },
        { entity, part: 'label' as const },
    ])
    const edges = timeScaleEdgeLabelYs(context, steps)
    drawGrid(context, { min: 1, max: 13 }, { min: 1, max: 7 }, 1, 1, 'beat', false, edges)
    return { edges, texts: canvas.labels.map(({ text }) => text) }
}

test('edge time scale labels take the place of the time and beat labels they reach', () => {
    // Beat b is b/2 s, shown as beat b + 1. Each label reaches 1.49 lanes past its marker.
    const { edges, texts } = gridLabelsBeside([
        edgeTimeScale(4, -6),
        edgeTimeScale(6, 6),
        edgeTimeScale(8, 3),
        edgeTimeScale(10, -5),
        edgeTimeScale(12, 5),
    ])
    assert.deepEqual(edges, { left: [-20, -50], right: [-30, -60] })
    // Lanes ±6 and ±5 reach the columns; lane 3 doesn't.
    for (const hidden of ['00:02', '00:05', '7', '13']) assert.ok(!texts.includes(hidden), hidden)
    for (const shown of ['00:03', '00:04', '9', '11']) assert.ok(texts.includes(shown), shown)
})

test('edge labels stay outward over the columns; inner ones turned inward leave them alone', () => {
    // No room outside: the edge labels still take the columns, not the notes.
    const edge = gridLabelsBeside([edgeTimeScale(4, -6), edgeTimeScale(6, 6)], { l: -7, r: 7 })
    assert.deepEqual(edge.edges, { left: [-20], right: [-30] })
    assert.ok(!edge.texts.includes('00:02') && !edge.texts.includes('7'))
    // Inside the stage, a label without room outside turns inward, away from the columns.
    const turned = gridLabelsBeside([edgeTimeScale(4, 5.5)], { l: -7, r: 6.5 })
    assert.deepEqual(turned.edges, { left: [], right: [] })
    assert.ok(turned.texts.includes('5'))
    // Mid-stage, a label stays clear of the columns.
    const mid = gridLabelsBeside([edgeTimeScale(4, 0)])
    assert.deepEqual(mid.edges, { left: [], right: [] })
    assert.ok(mid.texts.includes('00:02'))
    // Each change of a same-beat pair makes its own room.
    const pair = gridLabelsBeside([edgeTimeScale(4, 0), edgeTimeScale(4, -7)])
    assert.deepEqual(pair.edges, { left: [-20], right: [] })
    assert.ok(!pair.texts.includes('00:02'))
})

test('time and beat labels under the labels over the chart are left out', () => {
    const { context, canvas } = makeContext()
    // 1 s, beat 2 (shown as 3), lies 900px down the pane; its time label spans
    // 27-39px across and its beat label 161-163.4px.
    const row = (left: number, right: number) => ({ left, right, top: 890, bottom: 914 })
    const covered = (left: number, right: number) =>
        coveredLabelYs(context, { min: 1, max: 5 }, { min: 1, max: 2 }, 'beat', {
            left: [row(0, left)],
            right: [row(right, 200)],
        })
    assert.deepEqual(covered(30, 160), { left: [-10], right: [-10] })
    // Clear of the labels, by their width.
    assert.deepEqual(covered(20, 170), { left: [], right: [] })
    drawGrid(context, { min: 1, max: 5 }, { min: 1, max: 2 }, 1, 1, 'beat', false, covered(30, 160))
    const texts = canvas.labels.map(({ text }) => text)
    for (const hidden of ['00:01', '3']) assert.ok(!texts.includes(hidden), hidden)
    for (const shown of ['00:02', '2', '4']) assert.ok(texts.includes(shown), shown)
})

test('only grid labels in a covering band are measured', () => {
    const { context, canvas } = makeContext()
    const measured: string[] = []
    const measure = canvas.measureText.bind(canvas)
    canvas.measureText = (text) => {
        measured.push(text)
        return measure(text)
    }
    const row = { left: 0, right: 200, top: 890, bottom: 914 }
    coveredLabelYs(context, { min: 1, max: 5 }, { min: 1, max: 2 }, 'beat', {
        left: [row],
        right: [row],
    })
    assert.deepEqual(measured, ['00:01', '3'])
})

test('time scale labels are measured once per font and zoom, and again after a font loads', () => {
    const { context, canvas } = makeContext({ timeScales: [edgeTimeScale(4, 3)] })
    const measured: string[] = []
    const measure = canvas.measureText.bind(canvas)
    canvas.measureText = (text) => {
        measured.push(text)
        return measure(text)
    }
    const steps = [...context.state.store.grid.timeScale.values()].flatMap((bucket) =>
        [...bucket].map((entity) => ({ entity, part: 'label' as const })),
    )
    // The edge label pass and the drawing pass of each frame share a width.
    const frame = (scale = 10) => {
        const at = { ...context, scale }
        timeScaleEdgeLabelYs(at, steps)
        for (const { entity } of steps) drawEvent(at, entity, false)
    }
    clearTextWidths()
    frame()
    frame()
    assert.deepEqual(measured, ['15x'])
    frame(20)
    assert.deepEqual(measured, ['15x', '15x'])
    clearTextWidths()
    frame(20)
    assert.deepEqual(measured, ['15x', '15x', '15x'])
})

test('a BPM label stays drawn where a time scale label reaches the beat column', () => {
    const { context, canvas } = makeContext({
        bpms: [
            { beat: 0, bpm: 120 },
            { beat: 6, bpm: 90 },
            { beat: 8, bpm: 60 },
        ],
        timeScales: [edgeTimeScale(6, 5), edgeTimeScale(8, 3)],
    })
    const steps = [...context.state.store.grid.timeScale.values()].flatMap((bucket) =>
        [...bucket].map((entity) => ({ entity, part: 'label' as const })),
    )
    // The overlap stays visible, so the time scale can be moved clear of it.
    assert.ok(timeScaleEdgeLabelYs(context, steps).right.length > 0)
    drawEvent(context, { type: 'bpm', beat: 6, bpm: 90, meter: 4 }, false)
    drawEvent(context, { type: 'bpm', beat: 8, bpm: 60, meter: 4 }, false)
    assert.deepEqual(
        canvas.labels.map(({ text }) => text),
        ['90', '60'],
    )
})

test('each change of a same-beat jump draws its own marker and line', () => {
    const timeScale = (
        editorLane: number,
        timeScaleTransition: 'timeScale' | 'scroll',
        hideNotes: boolean,
    ): TimeScaleObject => ({
        groupId,
        beat: 2,
        editorLane,
        timeScale: 1,
        skip: 0,
        timeScaleEase: 'inStep',
        timeScaleTransition,
        hideNotes,
    })
    const { context, canvas } = makeContext({
        timeScales: [timeScale(0, 'timeScale', true), timeScale(0, 'scroll', false)],
    })
    for (const entities of context.state.store.grid.timeScale.values())
        for (const entity of entities) drawEvent(context, entity, false)
    const markers = canvas.strokes.filter(({ path }) =>
        (path as unknown[][]).some(([command]) => command === 'Z' || command === 'arc'),
    )
    // A hollow circle on dashed lines, then a filled diamond on solid ones.
    assert.deepEqual(
        markers.map(({ path, color }) => [(path as unknown[][]).length, color]),
        [
            [1, '#ff0'],
            [5, '#fff'],
        ],
    )
    const lines = canvas.strokes.filter(({ path }) =>
        (path as unknown[][]).every(([command]) => command === 'M' || command === 'L'),
    )
    assert.deepEqual(
        lines.slice(0, 2).map(({ dash }) => dash.length > 0),
        [true, true],
    )
    assert.ok(lines.slice(2).every(({ dash }) => !dash.length))
})

test('a time scale draws its line, marker and label as separate parts', () => {
    const { context, canvas } = makeContext()
    const entity: TimeScaleEntity = {
        type: 'timeScale',
        groupId,
        beat: 2,
        editorLane: 7,
        timeScale: 2,
        skip: 0,
        timeScaleEase: 'inStep',
        timeScaleTransition: 'timeScale',
        hideNotes: false,
    }
    const draw = (part?: EventPart) => {
        canvas.strokes = []
        canvas.labels = []
        drawEvent(context, entity, false, 1, part)
        return {
            lines: canvas.strokes.filter(({ path }) =>
                (path as unknown[][]).every(([command]) => command === 'M' || command === 'L'),
            ).length,
            markers: canvas.strokes.filter(({ path }) =>
                (path as unknown[][]).some(([command]) => command === 'arc'),
            ).length,
            labels: canvas.labels.map(({ text }) => text),
        }
    }
    // Lines span the stage to the marker, and the ease glyph is a line too.
    assert.deepEqual(draw('line'), { lines: 1, markers: 0, labels: [] })
    assert.deepEqual(draw('marker'), { lines: 0, markers: 1, labels: [] })
    assert.deepEqual(draw('label'), { lines: 1, markers: 0, labels: ['2x'] })
    assert.deepEqual(draw(), { lines: 2, markers: 1, labels: ['2x'] })
})

test('of a same-beat pair, only the highlighted change shows its group name', () => {
    const timeScale = (value: number): TimeScaleObject => ({
        groupId: 2 as GroupId,
        beat: 2,
        editorLane: -6,
        timeScale: value,
        skip: 0,
        timeScaleEase: 'inStep',
        timeScaleTransition: 'timeScale',
        hideNotes: false,
    })
    const { context, canvas } = makeContext({
        groups: new Map([[2 as GroupId, { name: 'B' }]]),
        timeScales: [timeScale(1), timeScale(2)],
    })
    const [first, second] = [...context.state.store.grid.timeScale.values()].flatMap((entities) => [
        ...entities,
    ])
    drawEvent(context, first!, false)
    drawEvent(context, second!, true)
    assert.deepEqual(
        canvas.labels.map(({ text }) => text),
        ['1x', '2x', 'B'],
    )
})

test('a floored range draws a step as held values with a gap at the jump', () => {
    // From 0 to 0.01 lanes wide, under the 0.02 floor: each side holds its value.
    assert.deepEqual(
        createRangeEventPaths([-1, 1], [4, 4.01], 0, -4, 'inOutStep', 0.02).map(
            (path) => path.commands,
        ),
        [
            [
                ['moveTo', -1, 0],
                ['lineTo', -1, -2],
                ['moveTo', 3.995, -2],
                ['lineTo', 3.995, -4],
            ],
            [
                ['moveTo', 1, 0],
                ['lineTo', 1, -2],
                ['moveTo', 4.015, -2],
                ['lineTo', 4.015, -4],
            ],
        ],
    )
    assert.deepEqual(
        createRangeEventPaths([2, 2], [-1, 1], 0, -4, 'inStep', 0.02).map((path) => path.commands),
        [
            [
                ['moveTo', 1.99, 0],
                ['lineTo', 1.99, -4],
            ],
            [
                ['moveTo', 2.01, 0],
                ['lineTo', 2.01, -4],
            ],
        ],
    )
    assert.deepEqual(
        createRangeEventPaths([2, 2], [-1, 1], 0, -4, 'none', 0.02).map((path) => path.commands),
        createRangeEventPaths([2, 2], [-1, 1], 0, -4, 'inStep', 0.02).map((path) => path.commands),
    )
})

test('names all draw after every object, selected and hovered ones last', () => {
    const pivot = (beat: number, pivotLane: number) =>
        ({ type: 'stagePivotEventJoint', stageId, beat, pivotLane }) as StagePivotEventJointEntity
    const place = (draws: [DrawnEvent, boolean][]) => {
        const { context, canvas } = makeContext()
        // Recently active, unhighlighted objects show their names too.
        context.recentlyActive = true
        context.names = createNameLayer()
        for (const [entity, highlighted] of draws) drawEvent(context, entity, highlighted)
        // Nothing is drawn until the frame places its names.
        assert.equal(canvas.labels.length, 0)
        placeNames(context, context.names)
        return canvas.labels.map(({ text, x, y }) => [text, x, y])
    }
    // 'Stage A' is 1.68 lanes wide, so these two names overlap; both draw.
    const a = pivot(2, 0)
    const b = pivot(2.02, 1.2)
    assert.deepEqual(
        place([
            [a, true],
            [b, true],
        ]),
        [
            ['Stage A', 0, -9.9],
            ['Stage A', 1.2, -10],
        ],
    )
    // A highlighted name suppresses an overlapping plain one.
    assert.deepEqual(
        place([
            [a, true],
            [b, false],
        ]),
        [['Stage A', 0, -9.9]],
    )
    // Nonoverlapping plain names remain, and highlighted names paint last.
    assert.deepEqual(
        place([
            [a, true],
            [pivot(2.02, 4), false],
        ]),
        [
            ['Stage A', 4, -10],
            ['Stage A', 0, -9.9],
        ],
    )
    // A mask's name between its ends still draws over a pivot's dot.
    assert.deepEqual(
        place([
            [mask(6), true],
            [pivot(6, 0.5), true],
        ]),
        [
            ['Stage A', 0, -29.9],
            ['Stage A', 0.5, -29.9],
        ],
    )
})

const annotationFixture = () => {
    const fixture = makeContext({
        groups: new Map([[2 as GroupId, { name: 'Group B' }]]),
        timeScales: [
            { ...edgeTimeScale(4, 2), groupId: 2 as GroupId, timeScaleEase: 'inOutQuad' },
            { ...edgeTimeScale(8, 3), groupId: 2 as GroupId, timeScale: 3 },
        ],
    })
    const timeScales = [...fixture.context.state.store.grid.timeScale.values()].flatMap((row) => [
        ...row,
    ])
    const bpm = [...fixture.context.state.store.grid.bpm.values()].flatMap((row) => [...row])[0]!
    return { ...fixture, labels: [bpm, ...timeScales].map((entity) => ({ entity })) }
}

test('prepared event annotations preserve label/glyph placement, opacity and deferred name order', () => {
    for (const bounds of [
        { l: -10, r: 10 },
        { l: -4.1, r: 4.1 },
    ]) {
        const { context, canvas, labels } = annotationFixture()
        prepareAnnotationsRecorder(canvas)
        context.bounds = { ...context.bounds, ...bounds }
        context.names = createNameLayer()
        canvas.transform = [1.25, 1.25, 17.125, 23.375]
        canvas.globalAlpha = 0.6
        for (const { entity } of labels) drawEvent(context, entity, true, 0.25, 'label')
        const expected = {
            strokes: canvas.strokes,
            labels: canvas.labels,
            names: context.names.names,
        }
        canvas.strokes = []
        canvas.labels = []
        context.names = createNameLayer()
        const annotations = new EventAnnotations()
        annotations.beginFrame(context, labels)
        for (const { entity } of labels) assert.ok(annotations.draw(context, entity, true, 0.25))
        annotations.endFrame()
        assert.deepEqual(
            { strokes: canvas.strokes, labels: canvas.labels, names: context.names.names },
            expected,
        )
        assert.equal(canvas.globalAlpha, 0.6)
        annotations.clear()
    }
})

test('numeric events opt into integer baselines in prepared and live preview paths only', () => {
    const { context, canvas, labels } = annotationFixture()
    prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    annotations.beginFrame(context, labels)
    for (const { entity } of labels) {
        assert.ok(annotations.draw(context, entity, false))
        assert.equal(canvas.editorLabels.at(-1)?.[9], true)
    }
    const prepared = canvas.editorLabels
    canvas.editorLabels = []
    const preview = { ...context, state: { ...context.state } }
    for (const { entity } of labels) {
        assert.equal(annotations.draw(preview, entity, false), false)
        drawEvent(preview, entity, false, 1, 'label')
    }
    assert.deepEqual(canvas.editorLabels, prepared)
    drawText(context, 'Ordinary name', 0, 0, '#fff')
    assert.equal(canvas.editorLabels.at(-1)?.[9], undefined)
    annotations.endFrame()
    annotations.clear()
})

test('fractional panning reuses annotation layout while names and highlighting stay live', () => {
    const { context, canvas, labels } = annotationFixture()
    const calls = prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    const draw = (highlighted: boolean) => {
        context.names = createNameLayer()
        annotations.beginFrame(context, labels)
        for (const { entity } of labels) assert.ok(annotations.draw(context, entity, highlighted))
        annotations.endFrame()
    }
    draw(false)
    assert.equal(context.names?.names.length, 0)
    const prepared = { labels: calls.labels, glyphs: calls.glyphs }
    canvas.transform = [1, 1, 0.25, -31.375]
    context.bounds = { ...context.bounds, t: -120, b: -20 }
    context.state.groups.set(2 as GroupId, { name: 'Renamed' })
    draw(true)
    assert.deepEqual({ labels: calls.labels, glyphs: calls.glyphs }, prepared)
    assert.deepEqual(
        context.names?.names.map(({ text }) => text),
        ['Renamed', 'Renamed'],
    )
    draw(false)
    assert.equal(context.names?.names.length, 0)
    annotations.clear()
    assert.equal(calls.releases, calls.glyphs)
})

test('PPS-only zoom retains annotation handles while matching live labels, glyphs and names', () => {
    const { context, canvas, labels } = annotationFixture()
    labels.push({ entity: { type: 'bpm', beat: 3.25, bpm: 137, meter: 4 } })
    const calls = prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    canvas.globalAlpha = 0.6
    let ups = -10
    for (const [index, factor] of [
        1,
        1.1,
        1.1,
        1.1,
        1.1,
        1 / 1.1,
        1 / 1.1,
        1 / 1.1,
        1 / 1.1,
    ].entries()) {
        ups *= factor
        context.ups = ups
        canvas.transform = [1.25, 1.25, 17.125, 23.375 + index * 0.37]
        context.names = createNameLayer()
        canvas.strokes = []
        canvas.labels = []
        for (const { entity } of labels) drawEvent(context, entity, true, 0.25, 'label')
        const expected = {
            strokes: canvas.strokes,
            labels: canvas.labels,
            names: context.names.names,
        }
        context.names = createNameLayer()
        canvas.strokes = []
        canvas.labels = []
        annotations.beginFrame(context, labels)
        for (const { entity } of labels) assert.ok(annotations.draw(context, entity, true, 0.25))
        annotations.endFrame()
        assert.deepEqual(
            { strokes: canvas.strokes, labels: canvas.labels, names: context.names.names },
            expected,
            `all placements and alpha stay exact at ups=${ups}`,
        )
        assert.equal(calls.labels, labels.length, 'first-visit PPS values reuse the same labels')
        assert.equal(calls.glyphs, 2, 'first-visit PPS values reuse the same glyph leases')
        assert.equal(calls.releases, 0)
        assert.equal(canvas.globalAlpha, 0.6)
    }
    annotations.clear()
    assert.equal(calls.releases, 2)
})

test('PPS reuse preserves scale, matrix, store, baseline and surface invalidation', () => {
    const { context, canvas, labels } = annotationFixture()
    const calls = prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    const step = labels[1]!
    const draw = () => {
        annotations.beginFrame(context, [step])
        assert.ok(annotations.draw(context, step.entity, false))
        annotations.endFrame()
    }
    draw()
    context.ups *= 1.1
    draw()
    assert.equal(calls.glyphs, 1)
    const mutations = [
        () => {
            context.scale *= 1.1
        },
        () => {
            canvas.transform = [2, 2, 0, 0]
        },
        () => {
            context.state.store.grid.timeScale = new Map(context.state.store.grid.timeScale)
        },
        () => {
            context.figureMiddle += 0.125
        },
        () => {
            context.ctx.canvas.width += 1
        },
    ]
    for (const [index, mutate] of mutations.entries()) {
        mutate()
        draw()
        assert.equal(calls.glyphs, index + 2)
        assert.equal(calls.labels, index + 2)
        assert.equal(calls.releases, index + 1, 'obsolete glyph ownership still releases once')
    }
    annotations.clear()
    assert.equal(calls.releases, calls.glyphs)
})

test('PPS-retained annotations still release departed and undrawn glyph leases', () => {
    const { context, canvas, labels } = annotationFixture()
    const calls = prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    const first = labels[1]!
    const second = labels[2]!
    annotations.beginFrame(context, [first])
    assert.ok(annotations.draw(context, first.entity, false))
    annotations.endFrame()
    context.ups *= 1.1
    annotations.beginFrame(context, [first])
    assert.ok(annotations.draw(context, first.entity, false))
    annotations.endFrame()
    assert.equal(calls.glyphs, 1)
    calls.order = []
    context.ups *= 1.1
    annotations.beginFrame(context, [second])
    assert.deepEqual(calls.order, ['release'])
    assert.ok(annotations.draw(context, second.entity, false))
    annotations.endFrame()
    assert.deepEqual(calls.order, ['release', 'prepare'])
    context.ups *= 1.1
    annotations.beginFrame(context, [second])
    annotations.endFrame()
    assert.equal(calls.releases, 2, 'visible but undrawn handles still expire')
    annotations.clear()
    annotations.clear()
    assert.equal(calls.releases, calls.glyphs)
})

test('annotations turn inward when the pane changes and release departed geometry before a jump', () => {
    const { context, canvas, labels } = annotationFixture()
    const calls = prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    const first = labels[1]!
    annotations.beginFrame(context, [first])
    assert.ok(annotations.draw(context, first.entity, false))
    annotations.endFrame()
    assert.equal(canvas.labels.at(-1)?.align, 'start')
    context.bounds = { ...context.bounds, r: 2.1 }
    annotations.beginFrame(context, [first])
    assert.ok(annotations.draw(context, first.entity, false))
    annotations.endFrame()
    assert.equal(canvas.labels.at(-1)?.align, 'end')
    assert.equal(calls.releases, 1)
    calls.order = []
    const second = labels[2]!
    annotations.beginFrame(context, [second])
    assert.deepEqual(calls.order, ['release'])
    assert.ok(annotations.draw(context, second.entity, false))
    assert.deepEqual(calls.order, ['release', 'prepare'])
    annotations.endFrame()
    annotations.clear()
    assert.equal(calls.releases, calls.glyphs)
})

test('annotation leases reset after renderer/font/tempo changes and declining capture draws nothing', () => {
    const { context, canvas, labels } = annotationFixture()
    const calls = prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    const step = labels[1]!
    const draw = () => {
        annotations.beginFrame(context, [step])
        const drawn = annotations.draw(context, step.entity, false)
        annotations.endFrame()
        return drawn
    }
    assert.ok(draw())
    Object.assign(canvas, { resourceOwner: {} })
    assert.ok(draw())
    context.fontFamily = 'serif'
    assert.ok(draw())
    context.state = { ...context.state, bpms: calculateBpms([{ x: 0, y: 0, s: 1 }]) }
    assert.ok(draw())
    assert.equal(calls.releases, 3)
    assert.equal(canvas.labels.at(-1)?.y, -39.8125)
    annotations.clear()
    calls.decline = true
    canvas.labels = []
    canvas.strokes = []
    assert.equal(draw(), false)
    assert.equal(canvas.labels.length, 0)
    assert.equal(canvas.strokes.length, 0)
    annotations.clear()
})

test('annotation cache declines a different preview state without changing queued output', () => {
    const { context, canvas, labels } = annotationFixture()
    const calls = prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    annotations.beginFrame(context, labels)
    const preview = { ...context, state: { ...context.state } }
    assert.equal(annotations.draw(preview, labels[1]!.entity, true), false)
    assert.equal(calls.glyphs, 0)
    assert.equal(canvas.labels.length, 0)
    annotations.endFrame()
    annotations.clear()
})

test('a dense annotation working set stays bounded and a jump immediately makes room', () => {
    const { context, canvas } = makeContext()
    const calls = prepareAnnotationsRecorder(canvas)
    const annotations = new EventAnnotations()
    const labels = Array.from({ length: 4097 }, (_, beat) => ({
        entity: { type: 'bpm' as const, beat, bpm: 120, meter: 4 },
    }))
    annotations.beginFrame(context, labels)
    let retained = 0
    for (const { entity } of labels) {
        if (annotations.draw(context, entity, false)) retained++
        else drawEvent(context, entity, false, 1, 'label')
    }
    annotations.endFrame()
    assert.equal(retained, 4096)
    assert.equal(calls.labels, 4096)
    assert.equal(canvas.editorLabels.length, 4097)
    assert.ok(canvas.editorLabels.every((label) => label[9] === true))
    const next = labels.at(-1)!
    annotations.beginFrame(context, [next])
    assert.ok(annotations.draw(context, next.entity, false))
    assert.equal(calls.labels, 4097)
    annotations.endFrame()
    annotations.clear()
})
