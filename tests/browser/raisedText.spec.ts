import { expect, test, type Page } from '@playwright/test'
import type { WebGLDrawContext } from '../../src/rendering/context'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Text goes above every object: BPM, time scale and grid labels draw after an 'over' slide
// that crosses them, and Elevation Editor axis labels after over connections and selected rows.
// The cursor line stays below notes and slides.

declare global {
    interface Window {
        canvasOps: Record<'chart' | 'elevation', string[]>
        vectorOps: Record<
            'chart' | 'elevation',
            { captured: number; replayed: number; unknown: number }
        >
    }
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    // Observe submission order, including warm retained groups. Recording only the drawing
    // calls inside captureVectors would omit their later replays and count cold captures twice.
    await page.evaluate(async () => {
        const { WebGLDrawContext, RenderSurface } = await window.editorTest.appImport<
            typeof import('../../src/rendering/context')
        >('/src/rendering/context.ts')
        const { DrawPath } =
            await window.editorTest.appImport<typeof import('../../src/rendering/path')>(
                '/src/rendering/path.ts',
            )
        const colorProbe = document.createElement('canvas').getContext('2d')!
        window.canvasOps = { chart: [], elevation: [] }
        window.vectorOps = {
            chart: { captured: 0, replayed: 0, unknown: 0 },
            elevation: { captured: 0, replayed: 0, unknown: 0 },
        }
        const canvasOf = (ctx: WebGLDrawContext) => {
            const { classList } = ctx.canvas as HTMLCanvasElement
            if (!classList) return
            if (classList.contains('editor-chart')) return 'chart'
            if (classList.contains('elevation-canvas')) return 'elevation'
        }
        const capturing = new WeakMap<WebGLDrawContext, string[]>()
        const opsOf = (ctx: WebGLDrawContext) => {
            const canvas = canvasOf(ctx)
            return capturing.get(ctx) ?? (canvas && window.canvasOps[canvas])
        }
        const points = new WeakMap<WebGLDrawContext, number[]>()
        const proto = WebGLDrawContext.prototype
        type Vectors = NonNullable<ReturnType<WebGLDrawContext['captureVectors']>>
        const capturedOps = new WeakMap<Vectors, string[]>()
        const capture = proto.captureVectors
        proto.captureVectors = function (draw, origin) {
            if (!opsOf(this)) return capture.call(this, draw, origin)
            const previous = capturing.get(this)
            const ops: string[] = []
            capturing.set(this, ops)
            try {
                const range = capture.call(this, draw, origin)
                if (range) {
                    capturedOps.set(range, ops)
                    const canvas = canvasOf(this)
                    if (canvas) window.vectorOps[canvas].captured++
                }
                return range
            } finally {
                if (previous) capturing.set(this, previous)
                else capturing.delete(this)
            }
        }
        const replay = proto.drawVectors
        proto.drawVectors = function (range) {
            const drawn = replay.call(this, range)
            const ops = opsOf(this)
            if (drawn && ops) {
                const recorded = capturedOps.get(range)
                if (recorded) ops.push(...recorded)
                const canvas = canvasOf(this)
                if (canvas && !capturing.has(this)) {
                    window.vectorOps[canvas].replayed++
                    if (!recorded) window.vectorOps[canvas].unknown++
                }
            }
            return drawn
        }
        const clear = proto.clear
        proto.clear = function () {
            const canvas = canvasOf(this)
            if (canvas) {
                window.canvasOps[canvas] = []
                window.vectorOps[canvas] = { captured: 0, replayed: 0, unknown: 0 }
            }
            return clear.call(this)
        }
        const recordingCall = new WeakSet<WebGLDrawContext>()
        const wrap = <
            K extends
                | 'beginPath'
                | 'moveTo'
                | 'lineTo'
                | 'fill'
                | 'fillCircle'
                | 'stroke'
                | 'strokeLine'
                | 'drawImage'
                | 'drawNameSprite'
                | 'fillText'
                | 'drawEditorLabel'
                | 'drawGridLabel'
                | 'drawPreparedEditorLabel',
        >(
            name: K,
            record: (ctx: WebGLDrawContext, args: unknown[], ops: string[]) => void,
        ) => {
            const original = proto[name] as (...args: unknown[]) => unknown
            ;(proto[name] as unknown) = function (this: WebGLDrawContext, ...args: unknown[]) {
                const ops = opsOf(this)
                if (!ops || recordingCall.has(this)) return original.apply(this, args)
                record(this, args, ops)
                // A public text operation may upload its raster through drawImage. That
                // nested image is the same text, not a later note or connection.
                recordingCall.add(this)
                try {
                    return original.apply(this, args)
                } finally {
                    recordingCall.delete(this)
                }
            }
        }
        wrap('beginPath', (ctx) => points.set(ctx, []))
        wrap('moveTo', (ctx, args) => points.get(ctx)?.push(args[1] as number))
        wrap('lineTo', (ctx, args) => points.get(ctx)?.push(args[1] as number))
        wrap('fill', (_, args, ops) => ops.push(args[0] instanceof DrawPath ? 'slide' : 'fill'))
        wrap('fillCircle', (_, __, ops) => ops.push('fill'))
        wrap('stroke', (ctx, args, ops) => {
            const ys = points.get(ctx)
            if (args.length || ys?.length !== 2 || ys[0] !== ys[1]) return
            colorProbe.fillStyle = String(ctx.strokeStyle)
            ops.push(`line:${colorProbe.fillStyle}:${ys[0]}`)
        })
        wrap('strokeLine', (ctx, args, ops) => {
            if (args[1] !== args[3]) return
            colorProbe.fillStyle = String(ctx.strokeStyle)
            ops.push(`line:${colorProbe.fillStyle}:${String(args[1])}`)
        })
        wrap('drawImage', (_, args, ops) => {
            // The composed stage surface is a background, not an editor object. Notes use
            // ordinary atlas surfaces; they must still draw after the cursor.
            if (args[0] instanceof RenderSurface && args[0].stageCache) return
            ops.push('image')
        })
        wrap('drawNameSprite', (_, __, ops) => ops.push('name'))
        wrap('fillText', (_, args, ops) => ops.push(`text:${String(args[0])}`))
        wrap('drawEditorLabel', (_, args, ops) => ops.push(`text:${String(args[0])}`))
        wrap('drawGridLabel', (_, args, ops) => ops.push(`text:${String(args[0])}`))
        wrap('drawPreparedEditorLabel', (_, args, ops) => {
            const label = args[0] as Parameters<WebGLDrawContext['drawPreparedEditorLabel']>[0]
            ops.push(`text:${label.text}`)
        })
    })
})

// One redrawn frame's ops: nudging the cursor redraws the chart, new visibilities the Elevation Editor.
const frameOps = (page: Page, canvas: 'chart' | 'elevation') =>
    page.evaluate(async (canvas) => {
        const { view } = window.editorTest
        window.canvasOps[canvas] = []
        window.vectorOps[canvas] = { captured: 0, replayed: 0, unknown: 0 }
        if (canvas === 'chart') view.cursorTime = view.cursorTime === 3 ? 3.25 : 3
        else view.visibilities = { ...view.visibilities }
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        return {
            ops: window.canvasOps[canvas],
            vectors: window.vectorOps[canvas],
            cursorTime: view.cursorTime,
        }
    }, canvas)

const texts = (ops: string[]) =>
    ops.flatMap((op, index) => (op.startsWith('text:') ? [{ text: op.slice(5), index }] : []))

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: labels draw above an over slide, the cursor line below it`, async ({
        page,
    }) => {
        await page.evaluate((layout) => {
            const { fixtures, show, view } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const slide = { ...base, left: -6, size: 12, connectorLayer: 'over' as const }
            show(
                {
                    ...fixtures.events,
                    bpms: [
                        { beat: 0, bpm: 120 },
                        { beat: 4, bpm: 90 },
                    ],
                    timeScales: [
                        { ...fixtures.events.timeScales[0]!, beat: 4, editorLane: 0, timeScale: 2 },
                    ],
                    slides: [
                        [
                            { ...slide, beat: 2 },
                            { ...slide, beat: 6 },
                        ],
                    ],
                },
                4,
            )
            view.layout = layout
            view.cursorTime = 3
        }, layout)
        await expect
            .poll(async () => {
                const { ops, vectors, cursorTime } = await frameOps(page, 'chart')
                const lastSlide = ops.lastIndexOf('slide')
                const lines = ops.flatMap((op, index) => {
                    const [kind, color, y] = op.split(':')
                    return kind === 'line' ? [{ color, y: Number(y), index }] : []
                })
                // The BPM change is 2 s in, so its line gives the units per second.
                const bpmLine = lines.find(({ color, y }) => color === '#ff00ff' && y !== 0)
                const ups = (bpmLine?.y ?? NaN) / 2
                const cursor = lines.find(
                    ({ color, y }) => color === '#ffffff' && Math.abs(y - cursorTime * ups) < 1e-6,
                )
                const drawn = texts(ops)
                // Slides, notes, connections and BPM and time scale lines.
                const firstObject = ops.findIndex(
                    (op) =>
                        op === 'slide' ||
                        op === 'fill' ||
                        op === 'image' ||
                        op.startsWith('line:#ff00ff:') ||
                        op.startsWith('line:#ffff00:'),
                )
                return {
                    retained:
                        vectors.captured === 0 && vectors.replayed > 0 && vectors.unknown === 0,
                    slides: lastSlide >= 0,
                    labels: ['90', '2x', '00:02'].filter((text) =>
                        drawn.some((label) => label.text === text),
                    ),
                    below: drawn.filter(({ index }) => index < lastSlide).map(({ text }) => text),
                    // Before the first object, the time scale line.
                    cursorFirst: !!cursor && firstObject >= 0 && cursor.index < firstObject,
                }
            })
            .toEqual({
                retained: true,
                slides: true,
                labels: ['90', '2x', '00:02'],
                below: [],
                cursorFirst: true,
            })
    })
}

test('Elevation Editor axis labels draw above over connections and selected rows', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { fixtures, show, settings, history, appImport } = window.editorTest
        const base = {
            ...fixtures.interaction.slides[0]![0]!,
            beat: 3,
            left: -2,
            size: 4,
            noteType: 'forceNonTick' as const,
            connectorLayer: 'over' as const,
        }
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [
                        { ...base, elevation: 0 },
                        { ...base, elevation: 2 },
                        { ...base, elevation: 4 },
                    ],
                ],
            },
            3,
        )
        settings.showPreview = false
        settings.showSidebar = false
        settings.elevationEditorSideBySide = 'disallow'
        const middle = [...history.state.value.store.slides.note.values()]
            .flat()
            .find((note) => note.elevation === 2)!
        history.replaceState({ ...history.state.value, selectedEntities: [middle] })
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
    })
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await expect
        .poll(async () => {
            const { ops } = await frameOps(page, 'elevation')
            const axis = texts(ops).filter(({ text }) => /^-?\d+$/.test(text))
            const lastObject = Math.max(ops.lastIndexOf('image'), ops.lastIndexOf('fill'))
            return {
                drawn: axis.length > 0 && lastObject >= 0,
                below: axis.filter(({ index }) => index < lastObject).map(({ text }) => text),
            }
        })
        .toEqual({ drawn: true, below: [] })
})
