import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Text goes above every object: BPM, time scale and grid labels draw after an 'over' slide
// that crosses them. The cursor line stays below notes and slides.

declare global {
    interface Window {
        canvasOps: Record<'chart' | 'elevation', string[]>
    }
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    // What the chart and Elevation Editor draw, in order: Path2D fills (slide bodies), plain
    // fills (connections), images (notes), single-segment lines (with their colour and y) and texts.
    await page.addInitScript(() => {
        window.canvasOps = { chart: [], elevation: [] }
        const opsOf = (ctx: CanvasRenderingContext2D) => {
            const { classList } = ctx.canvas as HTMLCanvasElement
            if (!classList) return
            if (classList.contains('editor-chart')) return window.canvasOps.chart
            if (classList.contains('elevation-canvas')) return window.canvasOps.elevation
        }
        const points = new WeakMap<CanvasRenderingContext2D, number[]>()
        const proto = CanvasRenderingContext2D.prototype
        const wrap = <
            K extends
                'beginPath' | 'moveTo' | 'lineTo' | 'fill' | 'stroke' | 'drawImage' | 'fillText',
        >(
            name: K,
            record: (ctx: CanvasRenderingContext2D, args: unknown[], ops: string[]) => void,
        ) => {
            const original = proto[name] as (...args: unknown[]) => unknown
            ;(proto[name] as unknown) = function (
                this: CanvasRenderingContext2D,
                ...args: unknown[]
            ) {
                const ops = opsOf(this)
                if (ops) record(this, args, ops)
                return original.apply(this, args)
            }
        }
        wrap('beginPath', (ctx) => points.set(ctx, []))
        wrap('moveTo', (ctx, args) => points.get(ctx)?.push(args[1] as number))
        wrap('lineTo', (ctx, args) => points.get(ctx)?.push(args[1] as number))
        wrap('fill', (_, args, ops) => ops.push(args[0] instanceof Path2D ? 'slide' : 'fill'))
        wrap('stroke', (ctx, args, ops) => {
            const ys = points.get(ctx)
            if (args.length || ys?.length !== 2 || ys[0] !== ys[1]) return
            ops.push(`line:${String(ctx.strokeStyle)}:${ys[0]}`)
        })
        wrap('drawImage', (_, __, ops) => ops.push('image'))
        wrap('fillText', (_, args, ops) => ops.push(`text:${String(args[0])}`))
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// One redrawn frame's ops: nudging the cursor redraws the chart, new visibilities the Elevation Editor.
const frameOps = (page: Page, canvas: 'chart' | 'elevation') =>
    page.evaluate(async (canvas) => {
        const { view } = window.editorTest
        window.canvasOps[canvas] = []
        if (canvas === 'chart') view.cursorTime = view.cursorTime === 3 ? 3.25 : 3
        else view.visibilities = { ...view.visibilities }
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        return { ops: window.canvasOps[canvas], cursorTime: view.cursorTime }
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
                const { ops, cursorTime } = await frameOps(page, 'chart')
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
                return {
                    slides: lastSlide >= 0,
                    labels: ['90', '2x', '00:02'].filter((text) =>
                        drawn.some((label) => label.text === text),
                    ),
                    below: drawn.filter(({ index }) => index < lastSlide).map(({ text }) => text),
                    // Before the first object: the BPM line, the lowest.
                    cursorFirst: !!cursor && !!bpmLine && cursor.index < bpmLine.index,
                }
            })
            .toEqual({ slides: true, labels: ['90', '2x', '00:02'], below: [], cursorFirst: true })
    })
}
