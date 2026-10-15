import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createNameLayer, drawName, placeNames } from '../../src/editor/canvas/names'
import { createNoteRenderer } from '../../src/editor/canvas/notes'
import { clearTextWidths } from '../../src/editor/canvas/text'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type { WebGLDrawContext } from '../../src/rendering/context'
import { DrawPath } from '../../src/rendering/path'
import type { Entity } from '../../src/state/entities'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import { recordEditorLabel } from './recordedLabel'
import { pathName } from './recordedPath'

// Records each complete label with its original colour, opacity and inherited clips.
const recordingContext = (nameContrast = true) => {
    const texts: { text: string; color: string; clips: string[]; alpha: number }[] = []
    const stack: { clips: string[]; alpha: unknown }[] = []
    let clips: string[] = []
    const target: Record<string, unknown> = {
        globalAlpha: 1,
        font: '10px sans-serif',
        resourceOwner: {},
        isContextLost: () => false,
    }
    const ctx = new Proxy(target, {
        get(target, property) {
            if (property in target) return Reflect.get(target, property)
            switch (property) {
                case 'drawEditorLabel':
                    return recordEditorLabel
                case 'createSurface':
                    return (width: number, height: number) => {
                        const surface = {
                            width,
                            height,
                            getContext: () => ctx,
                            dispose() {
                                surface.width = surface.height = 0
                            },
                        }
                        return surface
                    }
                case 'save':
                    return () => stack.push({ clips: [...clips], alpha: target.globalAlpha })
                case 'restore':
                    return () => {
                        const saved = stack.pop()
                        clips = saved?.clips ?? []
                        if (saved) target.globalAlpha = saved.alpha
                    }
                case 'clip':
                    return (path?: DrawPath, rule?: string) => {
                        if (path)
                            clips.push(`${rule === 'evenodd' ? 'out' : 'in'}:${pathName(path)}`)
                    }
                // Every glyph is 0.5 em wide.
                case 'measureText':
                    return (text: string) => ({
                        width: text.length * 0.5 * parseFloat(target.font as string),
                    })
                case 'fillText':
                    return (text: string) =>
                        texts.push({
                            text,
                            color: target.fillStyle as string,
                            clips: [...clips],
                            alpha: Number(target.globalAlpha),
                        })
                default:
                    return () => {}
            }
        },
    }) as unknown as WebGLDrawContext
    const context = {
        ctx,
        scale: 10,
        pixelRatio: 1,
        bounds: { l: -50, r: 50, t: -50, b: 50, w: 100, h: 100 },
        fontFamily: 'sans-serif',
        fontMiddle: 0.25,
        nameContrast,
    } as unknown as EditorDrawContext
    return { context, texts }
}

test('whole names retain their role colours, inherited clips and opacity, with highlighted names last', () => {
    const { context, texts } = recordingContext()
    const clip = new DrawPath()
    clip.rect(-40, -40, 80, 80)
    context.ctx.clip(clip)
    context.ctx.globalAlpha = 0.8
    const layer = createNameLayer()
    const name = { size: 0.4, align: 'center' as const, x: 0, owner: {} as Entity }
    layer.names.push(
        { ...name, highlighted: false, text: 'Group', y: 0, color: '#0aa', alpha: 0.35 },
        { ...name, highlighted: true, text: 'Stage', y: 10, color: '#f6f', alpha: 0.6 },
        { ...name, highlighted: false, text: 'Far', y: 5, color: '#f6f', alpha: 1 },
    )
    placeNames(context, layer)
    assert.deepEqual(texts, [
        { text: 'Group', color: '#0aa', clips: [`in:${pathName(clip)}`], alpha: 0.35 },
        { text: 'Far', color: '#f6f', clips: [`in:${pathName(clip)}`], alpha: 1 },
        { text: 'Stage', color: '#f6f', clips: [`in:${pathName(clip)}`], alpha: 0.6 },
    ])
    assert.equal(context.ctx.globalAlpha, 0.8)
})

const noteScene = (t: TestContext, nameContrast = true) => {
    const { context, texts } = recordingContext(nameContrast)
    Object.assign(context, {
        ups: -2,
        recentlyActive: false,
        showStageName: true,
        showGroupName: false,
        state: {
            bpms: [{ x: 0, y: 0, s: 0.5 }],
            store: { slides: { info: new Map() } },
            isDynamicStages: true,
            stages: new Map([[2, { name: 'Side stage' }]]),
        },
    })
    const note = (properties: Partial<NoteEntity>) =>
        ({
            type: 'note',
            beat: 0,
            noteType: 'default',
            connectorType: 'active',
            isConnectorSeparator: false,
            size: 2,
            left: 1,
            noteStyle: 'default',
            flickDirection: 'none',
            isCritical: false,
            isFake: false,
            stageId: 2,
            ...properties,
        }) as NoteEntity
    const renderer = createNoteRenderer()
    t.after(() => renderer.clear())
    return { context, texts, note, renderer }
}

test('different note bodies queue one complete name with the note opacity', (t) => {
    const { context, note, renderer } = noteScene(t)
    for (const noteType of ['default', 'trace', 'damage', 'anchor'] as const) {
        const names = createNameLayer()
        const entity = note({ noteType })
        renderer.draw({ ...context, names }, entity, true, 0.5)
        assert.equal(names.names.length, 1, noteType)
        assert.equal(names.names[0]?.owner, entity)
        assert.equal(names.names[0]?.text, 'Side stage')
        assert.equal(names.names[0]?.color, '#f6f')
        assert.equal(names.names[0]?.alpha, 0.5)
        assert.equal(names.names[0]?.highlighted, true)
    }
    const inactive = createNameLayer()
    renderer.draw({ ...context, names: inactive }, note({}), false, 1)
    assert.deepEqual(inactive.names, [])
})

for (const enabled of [false, true]) {
    test(`stage names use their role colour without body-dependent repainting (contrast ${enabled})`, (t) => {
        const { context, texts, note, renderer } = noteScene(t, enabled)
        const names = createNameLayer()
        renderer.draw({ ...context, names }, note({ noteType: 'trace' }), true, 0.5)
        placeNames(context, names)
        // Paste ghosts and other immediate names follow the same colour rule.
        renderer.draw(context, note({ noteType: 'damage', beat: 4 }), true, 1)
        assert.deepEqual(texts, [
            { text: 'Side stage', color: enabled ? '#f6f' : '#a0a', clips: [], alpha: 0.5 },
            { text: 'Side stage', color: enabled ? '#f6f' : '#a0a', clips: [], alpha: 1 },
        ])
    })
}

test('fully transparent names do not suppress visible names at the same position', () => {
    const { context, texts } = recordingContext(false)
    const layer = createNameLayer()
    const name = {
        x: 0,
        y: 0,
        size: 0.4,
        align: 'center' as const,
        color: '#f6f',
    }
    layer.names.push(
        {
            ...name,
            owner: {} as Entity,
            text: 'Transparent ordinary',
            alpha: 0,
            highlighted: false,
        },
        { ...name, owner: {} as Entity, text: 'Transparent selected', alpha: 0, highlighted: true },
        { ...name, owner: {} as Entity, text: 'Visible', alpha: 1, highlighted: false },
    )
    placeNames(context, layer)
    assert.deepEqual(
        texts.map(({ text }) => text),
        ['Visible'],
    )
})

test('names are measured once per font and zoom, and again after a font loads', () => {
    const { context } = recordingContext()
    let measured = 0
    const measureText = context.ctx.measureText.bind(context.ctx)
    Object.defineProperty(context.ctx, 'measureText', {
        value: (text: string) => {
            measured++
            return measureText(text)
        },
    })
    const owner = { type: 'note' } as Entity
    const frame = (scale: number, nameContrast = true) => {
        const layer = createNameLayer()
        for (const [index, text] of ['Stage', 'Group', 'Stage'].entries())
            layer.names.push({
                owner,
                highlighted: false,
                text,
                x: index * 10,
                y: 0,
                color: '#f6f',
                size: 0.4,
                align: 'center',
                alpha: 1,
            })
        placeNames({ ...context, scale, nameContrast }, layer)
    }
    clearTextWidths()
    frame(10)
    frame(10)
    assert.equal(measured, 2)
    frame(20)
    assert.equal(measured, 4)
    clearTextWidths()
    frame(20)
    assert.equal(measured, 6)
    // Without contrast, names are still measured to fit the pane.
    frame(30, false)
    assert.equal(measured, 8)
    frame(30, false)
    assert.equal(measured, 8)
})

test('canvases at different fonts and zooms keep their measured names', () => {
    const { context } = recordingContext()
    let measured = 0
    const measureText = context.ctx.measureText.bind(context.ctx)
    Object.defineProperty(context.ctx, 'measureText', {
        value: (text: string) => {
            measured++
            return measureText(text)
        },
    })
    const owner = { type: 'note' } as Entity
    const frame = (fontFamily: string, scale: number) => {
        const layer = createNameLayer()
        layer.names.push({
            owner,
            highlighted: false,
            text: 'Stage',
            x: 0,
            y: 0,
            color: '#f6f',
            size: 0.4,
            align: 'center',
            alpha: 1,
        })
        placeNames({ ...context, fontFamily, scale }, layer)
    }
    clearTextWidths()
    // The chart and the elevation editor drawing in turn.
    for (let index = 0; index < 3; index++) {
        frame('system-ui', 37.5)
        frame('sans-serif', 50)
    }
    assert.equal(measured, 2)
    // A zoom keeps the other canvas's widths, while old zooms are dropped.
    for (const scale of [38, 39, 40, 41, 42]) {
        frame('system-ui', scale)
        frame('sans-serif', 50)
    }
    assert.equal(measured, 7)
    frame('system-ui', 37.5)
    assert.equal(measured, 8)
    // A font alone measures anew.
    clearTextWidths()
    frame('system-ui', 40)
    frame('serif', 40)
    assert.equal(measured, 10)
})

test('a name that would run past the pane edge is cut with an ellipsis at that edge', () => {
    const owner = { type: 'note' } as Entity
    // Each glyph is 0.1 lane wide; the pane spans -50 to 50.
    const frame = (text: string, x: number, align: CanvasTextAlign, nameContrast: boolean) => {
        const { context, texts } = recordingContext(nameContrast)
        const layer = createNameLayer()
        layer.names.push({
            owner,
            highlighted: true,
            text,
            x,
            y: 0,
            color: '#0aa',
            size: 0.4,
            align,
            alpha: 1,
        })
        placeNames(context, layer)
        return texts.map(({ text }) => text)
    }
    for (const nameContrast of [false, true]) {
        assert.deepEqual(frame('Long group name', 49, 'start', nameContrast), ['Long…'])
        assert.deepEqual(frame('Long stage name', -49, 'end', nameContrast), ['…name'])
        assert.deepEqual(frame('Long group name', 50, 'center', nameContrast), ['Long g…'])
        // No room even for the ellipsis: nothing.
        assert.deepEqual(frame('Long group name', 49.95, 'start', nameContrast), [])
        assert.deepEqual(frame('Short', 0, 'center', nameContrast), ['Short'])
    }
})

const clippedName = (
    text: string,
    room = 1,
    side: 'left' | 'right' = 'left',
    scale = 10,
    fontFamily = 'sans-serif',
) => {
    const { context, texts } = recordingContext(false)
    context.bounds = { l: -room, r: room, t: -1, b: 1, w: room * 2, h: 2 }
    context.scale = scale
    context.fontFamily = fontFamily
    drawName(context, { type: 'note' } as Entity, false, text, 0, 0, '#0aa', 0.4, side)
    return texts.map(({ text }) => text)
}

test('clipped names preserve whole Unicode graphemes on either edge', () => {
    clearTextWidths()
    for (const [grapheme, room] of [
        ['e\u0301', 0.7],
        ['👩🏽‍💻', 1.7],
        ['👨‍👩‍👧‍👦', 2.5],
        ['🇺🇸', 1.1],
        ['✈️', 0.7],
        ['漢', 0.5],
    ] as const) {
        for (const scale of [10, 25]) {
            assert.deepEqual(clippedName(`${grapheme}ABCDEFG`, room, 'left', scale), [
                `${grapheme}…`,
            ])
            assert.deepEqual(clippedName(`ABCDEFG${grapheme}`, room, 'right', scale), [
                `…${grapheme}`,
            ])
        }
    }
    assert.deepEqual(clippedName(' \t👩🏽‍💻\nABCDEFG\r ', 1.7), ['👩🏽‍💻…'])
    assert.deepEqual(clippedName('   ', 1), [])
    assert.deepEqual(clippedName('No ellipsis fits', 0.1), [])
})

const countNameSegmentation = (t: TestContext) => {
    const counts = new Map<string, number>()
    const original = Intl.Segmenter.prototype.segment
    t.mock.method(
        Intl.Segmenter.prototype,
        'segment',
        function (this: Intl.Segmenter, text: string) {
            counts.set(text, (counts.get(text) ?? 0) + 1)
            return original.call(this, text)
        },
    )
    return counts
}

test('clipped names reuse normalized graphemes across fonts, zoom and pane changes', (t) => {
    const counts = countNameSegmentation(t)
    const normalized = 'Segmentation cache 🧪 sample'
    clippedName(` \t${normalized}\r\n `)
    clippedName(normalized, 2, 'right', 25, 'serif')
    clearTextWidths()
    clippedName(normalized, 0.7, 'left', 40, 'monospace')
    assert.equal(counts.get(normalized), 1)
    const nonbreaking = normalized.replace(' ', '\u00a0')
    clippedName(nonbreaking)
    assert.equal(counts.get(nonbreaking), 1)
    // Long raw whitespace does not change the normalized cache key.
    clippedName(' '.repeat(2048) + normalized)
    assert.equal(counts.get(normalized), 1)
})

test('clipped-name segmentation bounds retained entries and text, and bypasses long names', (t) => {
    const counts = countNameSegmentation(t)
    const entry = (index: number) => `Entry capacity check ${index}`
    for (let index = 0; index < 129; index++) clippedName(entry(index))
    clippedName(entry(128))
    assert.equal(counts.get(entry(128)), 1)
    clippedName(entry(0))
    assert.equal(counts.get(entry(0)), 2)

    const units = (index: number) => `Unit capacity ${index}:` + 'x'.repeat(1000)
    for (let index = 0; index < 17; index++) clippedName(units(index))
    clippedName(units(16))
    assert.equal(counts.get(units(16)), 1)
    clippedName(units(0))
    assert.equal(counts.get(units(0)), 2)

    const oversized = 'Oversized segmentation ' + '👩🏽‍💻'.repeat(160)
    const first = clippedName(oversized, 2)
    assert.deepEqual(clippedName(oversized, 2), first)
    assert.equal(counts.get(oversized), 2)
})
