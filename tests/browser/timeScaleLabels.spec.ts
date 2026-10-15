import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

type Ink = { left: number; right: number; top: number; bottom: number; alpha: number }

test('retained ease glyphs match fresh drawing after chart and viewport changes', async ({
    page,
}) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    const results = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { drawEvent } = await appImport<typeof import('../../src/editor/canvas/events')>(
            '/src/editor/canvas/events.ts',
        )
        const { measureFigureMiddle, measureTextMiddle } = await appImport<
            typeof import('../../src/editor/canvas/text')
        >('/src/editor/canvas/text.ts')
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const { toTimeScaleEntity } = await appImport<
            typeof import('../../src/state/entities/timeScale')
        >('/src/state/entities/timeScale.ts')
        const group = 1 as import('../../src/chart/groups').GroupId
        const base: import('../../src/chart/timeScale').TimeScaleObject = {
            groupId: group,
            beat: 4,
            editorLane: 2,
            timeScale: 1,
            skip: 0,
            timeScaleEase: 'inQuad',
            timeScaleTransition: 'timeScale',
            hideNotes: false,
        }
        const retained = toTimeScaleEntity(base)
        const owner = window.editorRendering.getDrawContext(
            document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!,
        )
        const surface = owner.createSurface(400, 600)
        const ctx = surface.getContext()
        const fontFamily = 'ui-sans-serif, system-ui, sans-serif'
        type Scenario = {
            name: string
            next?: number
            nextGroup?: number
            bpm?: number
            scale?: number
            ups?: number
            scroll?: number
            direction?: -1
            preview?: boolean
        }
        const scenarios: Scenario[] = [
            { name: 'rising', next: 2 },
            { name: 'same geometry while scrolling', next: 2, scroll: 17.35 },
            { name: 'replacement neighbor falls', next: 0.5 },
            { name: 'replacement neighbor holds', next: 1 },
            { name: 'neighbor moves to another group', next: 2, nextGroup: 2 },
            { name: 'last change' },
            { name: 'BPM edit changes world position', next: 2, bpm: 180 },
            { name: 'vertical zoom changes world position', next: 2, ups: -4 },
            { name: 'zoom changes stroke minimum', next: 2, scale: 12 },
            { name: 'label points inward', next: 2, direction: -1 },
            { name: 'preview outside chart', preview: true },
            { name: 'restored chart membership', next: 2 },
        ]
        const render = (
            scenario: Scenario,
            entity: import('../../src/state/entities/timeScale').TimeScaleEntity,
        ) => {
            const state = createState(
                {
                    ...window.editorTest.fixtures.interaction,
                    bpms: [{ beat: 0, bpm: scenario.bpm ?? 120 }],
                    slides: [],
                    timeScales: [
                        base,
                        // An intervening change in another group must never be the neighbor.
                        { ...base, beat: 6, groupId: 3 as typeof group, timeScale: 10 },
                        ...(scenario.next === undefined
                            ? []
                            : [
                                  {
                                      ...base,
                                      beat: 8,
                                      groupId: (scenario.nextGroup ?? group) as typeof group,
                                      timeScale: scenario.next,
                                  },
                              ]),
                    ],
                },
                0,
            )
            // An unrelated edit can retain the first entity while replacing its
            // grid and neighbor. A fresh equivalent is the uncached raster oracle.
            for (const entities of state.store.grid.timeScale.values()) {
                for (const generated of entities) {
                    if (generated.beat !== base.beat || generated.groupId !== group) continue
                    entities.delete(generated)
                    if (!scenario.preview) entities.add(entity)
                    break
                }
            }
            const scale = scenario.scale ?? 50
            const ups = scenario.ups ?? -2
            ctx.clear()
            // Keep a fixed viewport so BPM and vertical zoom really move the glyph.
            ctx.setTransform(scale * 1.25, 0, 0, scale * 1.25, 100, 550 + (scenario.scroll ?? 0))
            drawEvent(
                {
                    ctx,
                    state,
                    scale,
                    ups,
                    pixelRatio: 1.25,
                    bounds: {
                        l: -8,
                        r: scenario.direction === -1 ? 2.4 : 8,
                        t: -20,
                        b: 0,
                        w: 16,
                        h: 20,
                    },
                    defaultGroupId: group,
                    showStageName: false,
                    showGroupName: false,
                    nameContrast: false,
                    recentlyActive: false,
                    fontFamily,
                    fontMiddle: measureTextMiddle(fontFamily, document.body),
                    figureMiddle: measureFigureMiddle(fontFamily),
                },
                entity,
                false,
                1,
                'label',
            )
            return ctx.getImageData(0, 0, surface.width, surface.height).data
        }
        try {
            return scenarios.map((scenario) => {
                const actual = render(scenario, retained)
                const expected = render(scenario, toTimeScaleEntity(base))
                let different = 0
                let alpha = 0
                for (let i = 0; i < actual.length; i++) {
                    if (actual[i] !== expected[i]) different++
                    if (i % 4 === 3) alpha += actual[i]!
                }
                return { name: scenario.name, different, alpha }
            })
        } finally {
            surface.dispose()
        }
    })
    for (const result of results) {
        expect(result.different, result.name).toBe(0)
        expect(result.alpha, result.name).toBeGreaterThan(0)
    }
})

for (const pixelRatio of [1, 1.25, 2]) {
    test(`time-scale curves and constant indicators match at pixel ratio ${pixelRatio}`, async ({
        page,
    }) => {
        await page.goto('/')
        await page.evaluate(() => document.fonts.ready)
        const results = await page.evaluate(async (pixelRatio) => {
            const { disposeDrawContext, getDrawContext } = await import('/src/rendering/context.ts')
            const paths = {
                events: '/src/editor/canvas/events.ts',
                text: '/src/editor/canvas/text.ts',
                glyph: '/src/easeGlyph.ts',
                state: '/src/state/index.ts',
                bpms: '/src/state/integrals/bpms.ts',
            }
            const { drawEvent } = (await import(
                paths.events
            )) as typeof import('../../src/editor/canvas/events')
            const { measureFigureMiddle, measureTextMiddle } = (await import(
                paths.text
            )) as typeof import('../../src/editor/canvas/text')
            const { easeGlyphPathD } = (await import(
                paths.glyph
            )) as typeof import('../../src/easeGlyph')
            const { createState } = (await import(paths.state)) as typeof import('../../src/state')
            const { beatToTime } = (await import(
                paths.bpms
            )) as typeof import('../../src/state/integrals/bpms')

            const group = 1 as import('../../src/chart/groups').GroupId
            const timeScale = (
                beat: number,
                value: number,
                timeScaleEase: import('../../src/ease').TimeScaleEase,
            ) => ({
                groupId: group,
                beat,
                editorLane: 7,
                timeScale: value,
                skip: 0,
                timeScaleEase,
                timeScaleTransition: 'timeScale' as const,
                hideNotes: false,
            })
            const state = createState(
                {
                    initialLife: 1000,
                    isDynamicStages: false,
                    bpms: [{ beat: 0, bpm: 120 }],
                    groups: new Map([[group, { name: 'Default' }]]),
                    stages: new Map(),
                    cameraEvents: [],
                    stageMaskEvents: [],
                    stagePivotEvents: [],
                    stageStyleEvents: [],
                    stageTransformEvents: [],
                    timeScales: [
                        timeScale(0, 1, 'inQuad'),
                        timeScale(4, 2, 'outQuad'),
                        timeScale(8, 0.5, 'inStep'),
                        timeScale(12, 0.5, 'linear'),
                    ],
                    slides: [],
                },
                0,
            )
            const entities = [...state.store.grid.timeScale.values()]
                .flatMap((set) => [...set])
                .sort((a, b) => a.beat - b.beat)

            const scale = 50
            const ups = -2
            const width = 240
            const height = 80
            const anchor = { x: 40, y: 40 }
            const fontFamily = 'ui-sans-serif, system-ui, sans-serif'
            const glyphBox = { left: 0.23, top: -0.17, width: 0.3, height: 0.34 }

            const measureInk = (
                ctx: Pick<CanvasRenderingContext2D, 'getImageData'> & {
                    canvas: { width: number; height: number }
                },
                [x0, y0, x1, y1]: [number, number, number, number],
            ): Ink => {
                const pixels = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data
                const ink = { left: Infinity, right: -1, top: Infinity, bottom: -1, alpha: 0 }
                for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
                    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
                        const value = pixels[(y * ctx.canvas.width + x) * 4 + 3]!
                        ink.alpha += value
                        if (value < 64) continue
                        ink.left = Math.min(ink.left, x)
                        ink.right = Math.max(ink.right, x)
                        ink.top = Math.min(ink.top, y)
                        ink.bottom = Math.max(ink.bottom, y)
                    }
                }
                return ink
            }

            const results = []
            for (const entity of entities) {
                const canvas = document.createElement('canvas')
                canvas.width = width * pixelRatio
                canvas.height = height * pixelRatio
                document.body.append(canvas)
                const ctx = getDrawContext(canvas)
                await ctx.ready
                const y = beatToTime(state.bpms, entity.beat) * ups
                const s = scale * pixelRatio
                // Puts the marker at the anchor.
                ctx.setTransform(
                    s,
                    0,
                    0,
                    s,
                    (anchor.x - 7 * scale) * pixelRatio,
                    (anchor.y - y * scale) * pixelRatio,
                )
                drawEvent(
                    {
                        ctx,
                        scale,
                        pixelRatio,
                        // The lanes the canvas shows, so labels keep their side.
                        bounds: {
                            l: 7 - anchor.x / scale,
                            r: 7 + (width - anchor.x) / scale,
                            t: 0,
                            b: 0,
                            w: width / scale,
                            h: 0,
                        },
                        ups,
                        state,
                        defaultGroupId: group,
                        showStageName: false,
                        showGroupName: false,
                        nameContrast: false,
                        recentlyActive: false,
                        fontFamily,
                        fontMiddle: measureTextMiddle(fontFamily, document.body),
                        figureMiddle: measureFigureMiddle(fontFamily),
                    },
                    entity,
                    false,
                )
                canvas.remove()

                // Device pixels of the glyph box, with room for the stroke.
                const box = {
                    left: (anchor.x + glyphBox.left * scale) * pixelRatio,
                    top: (anchor.y + glyphBox.top * scale) * pixelRatio,
                    width: glyphBox.width * scale * pixelRatio,
                    height: glyphBox.height * scale * pixelRatio,
                }
                const pad = 0.05 * scale * pixelRatio
                const quadrant = (right: boolean, bottom: boolean) =>
                    measureInk(ctx, [
                        box.left + (right ? box.width * 0.7 : -pad),
                        box.top + (bottom ? box.height * 0.7 : -pad),
                        box.left + (right ? box.width + pad : box.width * 0.3),
                        box.top + (bottom ? box.height + pad : box.height * 0.3),
                    ]).alpha
                const glyph = measureInk(ctx, [
                    box.left - pad,
                    box.top - pad,
                    box.left + box.width + pad,
                    box.top + box.height + pad,
                ])
                const label = measureInk(ctx, [
                    box.left + box.width + pad,
                    0,
                    canvas.width,
                    canvas.height,
                ])

                // Independently rasterize curves and the padded equals sign as SVG.
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
                svg.setAttribute('width', String(canvas.width))
                svg.setAttribute('height', String(canvas.height))
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
                const next = entities[entities.indexOf(entity) + 1]
                const constant = !next || next.timeScale === entity.timeScale
                path.setAttribute(
                    'd',
                    constant
                        ? [0.25, 0.75]
                              .map(
                                  (fraction) =>
                                      `M ${box.left + 0.05 * scale * pixelRatio} ${box.top + fraction * box.height} L ${box.left + box.width - 0.05 * scale * pixelRatio} ${box.top + fraction * box.height}`,
                              )
                              .join(' ')
                        : easeGlyphPathD(
                              entity.timeScaleEase,
                              !!next && next.timeScale < entity.timeScale,
                              box.left,
                              box.top,
                              box.width,
                              box.height,
                          ),
                )
                path.setAttribute('fill', 'none')
                path.setAttribute('stroke', '#ff0')
                path.setAttribute('stroke-width', String(0.05 * scale * pixelRatio))
                path.setAttribute('stroke-linecap', 'round')
                path.setAttribute('stroke-linejoin', 'round')
                if (constant) path.setAttribute('stroke-opacity', '0.7')
                svg.append(path)
                const url = URL.createObjectURL(
                    new Blob([new XMLSerializer().serializeToString(svg)], {
                        type: 'image/svg+xml',
                    }),
                )
                const image = new Image()
                image.src = url
                await image.decode()
                const reference = document.createElement('canvas')
                reference.width = canvas.width
                reference.height = canvas.height
                const referenceContext = reference.getContext('2d')!
                referenceContext.drawImage(image, 0, 0)
                URL.revokeObjectURL(url)

                results.push({
                    ease: entity.timeScaleEase,
                    quadrants: {
                        topLeft: quadrant(false, false),
                        topRight: quadrant(true, false),
                        bottomLeft: quadrant(false, true),
                        bottomRight: quadrant(true, true),
                    },
                    glyph,
                    reference: measureInk(referenceContext, [
                        box.left - pad,
                        box.top - pad,
                        box.left + box.width + pad,
                        box.top + box.height + pad,
                    ]),
                    label,
                    text: measureInk(ctx, [box.left - pad, 0, canvas.width, canvas.height]),
                    glyphRight: box.left + box.width,
                })
                disposeDrawContext(canvas)
            }
            return results
        }, pixelRatio)

        const [rising, falling, sameValue, last] = results
        // Rising in-quad: holds at the start, then sweeps right toward the next value.
        expect(rising!.quadrants.bottomLeft).toBeGreaterThan(0)
        expect(rising!.quadrants.topRight).toBeGreaterThan(0)
        expect(rising!.quadrants.bottomRight).toBe(0)
        expect(rising!.quadrants.topLeft).toBe(0)
        // Falling out-quad: leaves the start sideways, toward the left.
        expect(falling!.quadrants.bottomRight).toBeGreaterThan(0)
        expect(falling!.quadrants.topLeft).toBeGreaterThan(0)
        expect(falling!.quadrants.bottomLeft).toBe(0)
        expect(falling!.quadrants.topRight).toBe(0)
        // Equal values and the final change both have a visible, padded equals sign.
        for (const result of [sameValue!, last!]) {
            expect(result.glyph.alpha).toBeGreaterThan(0)
            expect(result.glyph.right).toBeLessThan(result.glyphRight)
        }

        for (const result of results) {
            for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
                expect(
                    Math.abs(result.glyph[edge] - result.reference[edge]),
                    `${result.ease}: ${edge} glyph edge`,
                ).toBeLessThanOrEqual(1)
            }
            // The value follows the glyph without touching it.
            expect(result.label.left).toBeGreaterThan(result.glyph.right + 1)
        }
    })
}

test('a BPM label stays drawn on the chart where a time scale label reaches the beat column', async ({
    page,
}) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    const drawn = await page.evaluate(async () => {
        const { show, fixtures } = window.editorTest
        const texts: string[] = []
        const { WebGLDrawContext } = await window.editorTest.appImport<
            typeof import('../../src/rendering/context')
        >('/src/rendering/context.ts')
        const record = (ctx: InstanceType<typeof WebGLDrawContext>, text: string) => {
            if (
                ctx.canvas instanceof HTMLCanvasElement &&
                ctx.canvas.classList.contains('editor-chart')
            )
                texts.push(text)
        }
        const drawEditorLabel = WebGLDrawContext.prototype.drawEditorLabel
        WebGLDrawContext.prototype.drawEditorLabel = function (text, ...args) {
            record(this, text)
            return drawEditorLabel.call(this, text, ...args)
        }
        const drawPreparedEditorLabel = WebGLDrawContext.prototype.drawPreparedEditorLabel
        WebGLDrawContext.prototype.drawPreparedEditorLabel = function (label, ...args) {
            record(this, label.text)
            return drawPreparedEditorLabel.call(this, label, ...args)
        }
        // At lane 5, the 15x label runs past lane 6.1 into the beat column, beside the BPM change.
        show(
            {
                ...fixtures.interaction,
                bpms: [
                    { beat: 0, bpm: 120 },
                    { beat: 6, bpm: 90 },
                ],
                timeScales: [
                    {
                        groupId: 1 as never,
                        beat: 6,
                        editorLane: 5,
                        timeScale: 15,
                        skip: 0,
                        timeScaleEase: 'inStep',
                        timeScaleTransition: 'timeScale',
                        hideNotes: false,
                    },
                ],
            },
            3,
        )
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        WebGLDrawContext.prototype.drawEditorLabel = drawEditorLabel
        WebGLDrawContext.prototype.drawPreparedEditorLabel = drawPreparedEditorLabel
        return texts
    })
    expect(drawn).toContain('15x')
    expect(drawn).toContain('90')
})
