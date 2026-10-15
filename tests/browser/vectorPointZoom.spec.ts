import { expect, test } from '@playwright/test'
import type { DrawStep } from '../../src/editor/canvas/ordering'
import type { DrawSection } from '../../src/editor/canvas/sections'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type { WebGLDrawContext } from '../../src/rendering/context'
import type { State } from '../../src/state'
import type { Entity } from '../../src/state/entities'

test('point sections reuse fixed artwork through first-use PPS changes in WebGL2', async ({
    page,
}, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/__point-zoom', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><canvas width="768" height="720"></canvas>',
        }),
    )
    await page.goto('/__point-zoom')
    const report = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const { VectorRanges } = await import('/src/editor/canvas/vectorRanges.ts')
        const { drawEvent } = await import('/src/editor/canvas/events.ts')
        const { createNameLayer } = await import('/src/editor/canvas/names.ts')
        const canvas = document.querySelector('canvas')!
        const root = getDrawContext(canvas)
        await root.ready
        const gl = canvas.getContext('webgl2')!
        const expectedSurface = root.createSurface(768, 720)
        const actualSurface = root.createSurface(768, 720)
        const reference = expectedSurface.getContext()
        const actual = actualSurface.getContext()
        const read = (ctx: WebGLDrawContext) => ctx.getImageData(0, 0, 768, 720).data
        const difference = (left: Uint8ClampedArray, right: Uint8ClampedArray) => {
            let pixels = 0,
                max = 0
            let alphaMax = 0,
                displayedMax = 0,
                interior = 0,
                spill = 0
            const bounds = [768, 720, -1, -1]
            for (let index = 0; index < left.length; index += 4) {
                let changed = false
                for (let channel = 0; channel < 4; channel++) {
                    const delta = Math.abs(left[index + channel]! - right[index + channel]!)
                    changed ||= delta !== 0
                    max = Math.max(max, delta)
                }
                pixels += +changed
                if (!changed) continue
                const x = (index / 4) % 768,
                    y = Math.floor(index / 3072)
                bounds[0] = Math.min(bounds[0]!, x)
                bounds[1] = Math.min(bounds[1]!, y)
                bounds[2] = Math.max(bounds[2]!, x)
                bounds[3] = Math.max(bounds[3]!, y)
                const a = left[index + 3]!,
                    b = right[index + 3]!
                alphaMax = Math.max(alphaMax, Math.abs(a - b))
                for (const background of [0, 64, 255])
                    for (let channel = 0; channel < 3; channel++)
                        displayedMax = Math.max(
                            displayedMax,
                            Math.abs(
                                (left[index + channel]! * a +
                                    background * (255 - a) -
                                    right[index + channel]! * b -
                                    background * (255 - b)) /
                                    255,
                            ),
                        )
                let flat = x > 0 && x < 767 && y > 0 && y < 719
                for (let dy = -1; dy <= 1 && flat; dy++)
                    for (let dx = -1; dx <= 1 && flat; dx++)
                        for (let channel = 0; channel < 4; channel++)
                            flat &&=
                                left[((y + dy) * 768 + x + dx) * 4 + channel] ===
                                left[index + channel]
                if (flat) {
                    if (a) interior++
                    else spill++
                }
            }
            return { pixels, max, alphaMax, displayedMax, interior, spill, bounds }
        }
        const pictures: { label: string; reference: string; candidate: string }[] = []
        const png = (pixels: Uint8ClampedArray) => {
            const target = document.createElement('canvas')
            target.width = 768
            target.height = 720
            target
                .getContext('2d')!
                .putImageData(new ImageData(new Uint8ClampedArray(pixels), 768, 720), 0, 0)
            return target.toDataURL('image/png')
        }
        const state = {
            bpms: [{ x: 0, y: 0, s: 0.5 }],
            stages: new Map([[1, { name: 'Stage' }]]),
            isDynamicStages: true,
        } as unknown as State
        const specifications = [
            {
                type: 'cameraEventJoint',
                cameraLeft: -4,
                cameraSize: 2.5,
                cameraZoomTargetLane: 0.2,
            },
            { type: 'stageMaskEventJoint', maskLeft: -3, maskSize: 4 },
            { type: 'stagePivotEventJoint', pivotLane: -1.5 },
            { type: 'stageStyleEventJoint', editorLane: 2.25 },
            { type: 'stageTransformEventJoint', xTranslation: 1.375 },
            { type: 'bpm', bpm: 150, part: 'line' },
            {
                type: 'timeScale',
                editorLane: -2.25,
                hideNotes: false,
                timeScaleTransition: 'normal',
                part: 'line',
            },
            {
                type: 'timeScale',
                editorLane: 1.75,
                hideNotes: true,
                timeScaleTransition: 'scroll',
                part: 'line',
            },
            {
                type: 'timeScale',
                editorLane: -1.25,
                hideNotes: false,
                timeScaleTransition: 'normal',
                part: 'marker',
            },
            {
                type: 'timeScale',
                editorLane: 2.25,
                hideNotes: true,
                timeScaleTransition: 'normal',
                part: 'marker',
            },
            {
                type: 'timeScale',
                editorLane: -1.75,
                hideNotes: false,
                timeScaleTransition: 'scroll',
                part: 'marker',
            },
            {
                type: 'timeScale',
                editorLane: 1.25,
                hideNotes: true,
                timeScaleTransition: 'scroll',
                part: 'marker',
            },
        ] as const
        const rows: {
            label: string
            difference: ReturnType<typeof difference>
            freshDifference: ReturnType<typeof difference>
            callbacks: number
            captures: number
            names: unknown[]
            expectedNames: unknown[]
            glError: number
        }[] = []
        const caches: InstanceType<typeof VectorRanges>[] = []
        const serializeNames = (context: EditorDrawContext) =>
            context.names!.names.map(({ owner, ...name }) => ({ ...name, beat: owner.beat }))
        const draw = (context: EditorDrawContext, step: DrawStep) => {
            if (step.entity.type === 'note' || step.entity.type === 'connector')
                throw new Error('Unexpected point fixture')
            drawEvent(context, step.entity, step.highlighted, step.opacity, step.part)
        }
        let restored = false
        try {
            for (const [label, scale, xSign, ySign, farBeat, composed] of [
                ['basic', 32, 1, 1, 0, false],
                ['composed-dpr2', 64, 1, 1, 0, true],
                ['basic-dpr3', 96, 1, 1, 0, false],
                ['reflected-far', 32, -1, -1, 2 ** 20, false],
            ] as const) {
                const cache = new VectorRanges()
                caches.push(cache)
                const sections: DrawSection[] = specifications.map((specification, index) => {
                    const { part, ...properties } = { part: undefined, ...specification }
                    const steps = [0, 0.125].map((offset) => ({
                        entity: {
                            ...properties,
                            beat: farBeat + index * 0.375 + offset,
                            stageId: 1,
                        } as Entity,
                        part,
                        highlighted: index % 2 === 0,
                        raised: false,
                        opacity: offset ? 0.375 : 0.75,
                    })) as DrawStep[]
                    return {
                        key: `${label}:${index}`,
                        steps,
                        pass: 'normal',
                        minBeat: steps[0]!.entity.beat,
                        maxBeat: steps[1]!.entity.beat,
                    }
                })
                const stages = new Map()
                const frame = (ups: number, phase: string, expectCapture: boolean) => {
                    const context = (ctx: WebGLDrawContext): EditorDrawContext => ({
                        ctx,
                        state,
                        ups,
                        scale,
                        pixelRatio: scale / 32,
                        bounds: { l: -12, r: 12, t: -20, b: 20, w: 24, h: 40 },
                        defaultGroupId: undefined,
                        showStageName: true,
                        showGroupName: false,
                        nameContrast: false,
                        recentlyActive: phase !== 'idle',
                        fontFamily: 'sans-serif',
                        fontMiddle: 0.25,
                        figureMiddle: 0.375,
                        names: createNameLayer(),
                        composed: composed
                            ? ({ stages } as EditorDrawContext['composed'])
                            : undefined,
                    })
                    const reset = (ctx: WebGLDrawContext) => {
                        ctx.clear()
                        ctx.setTransform(
                            scale * xSign,
                            0,
                            0,
                            scale * ySign,
                            384,
                            (ySign === 1 ? 640 : 80) - scale * ySign * farBeat * 0.5 * ups,
                        )
                    }
                    reset(actual)
                    reset(reference)
                    const candidate = context(actual)
                    const fresh = context(reference)
                    const before = cache.stats.captures
                    let callbacks = 0
                    cache.beginFrame(candidate, [])
                    cache.prepareSections(sections, sections)
                    for (const section of sections)
                        cache.drawSection(candidate, section, undefined, (destination, step) => {
                            callbacks++
                            draw(destination, step)
                        })
                    actual.flush()
                    cache.endFrame()
                    for (const section of sections)
                        for (const step of section.steps) draw(fresh, step)
                    const expected = read(reference),
                        displayed = read(actual)
                    if (phase === 'initial')
                        pictures.push({
                            label,
                            reference: png(expected),
                            candidate: png(displayed),
                        })
                    reset(reference)
                    const freshCache = new VectorRanges()
                    const freshContext = context(reference)
                    try {
                        freshCache.beginFrame(freshContext, [])
                        freshCache.prepareSections(sections, sections)
                        for (const section of sections)
                            freshCache.drawSection(freshContext, section, undefined, draw)
                        reference.flush()
                        freshCache.endFrame()
                    } finally {
                        freshCache.clear()
                    }
                    rows.push({
                        label: `${label}:${phase}`,
                        difference: difference(expected, displayed),
                        freshDifference: difference(read(reference), displayed),
                        callbacks,
                        captures: cache.stats.captures - before,
                        names: serializeNames(candidate),
                        expectedNames: serializeNames(fresh),
                        glError: gl.getError(),
                    })
                    if (expectCapture && callbacks !== 24)
                        throw new Error('Expected new point capture')
                    if (!expectCapture && callbacks !== 0)
                        throw new Error('PPS-only change rebuilt point geometry')
                }
                frame(-1.1, 'initial', true)
                frame(-1.13731, 'first-use-a', false)
                frame(-1.21357, 'first-use-b', false)
                frame(-0.98371, 'idle', false)
                frame(-1.25793, 'active', false)
                if (label === 'basic') {
                    const oldOwner = root.resourceOwner
                    const extension = gl.getExtension('WEBGL_lose_context')!
                    const lost = new Promise<void>((resolve) =>
                        canvas.addEventListener('webglcontextlost', () => resolve(), {
                            once: true,
                        }),
                    )
                    extension.loseContext()
                    await lost
                    await new Promise((resolve) => setTimeout(resolve, 50))
                    const ready = new Promise<void>((resolve) =>
                        canvas.addEventListener('renderingready', () => resolve(), { once: true }),
                    )
                    extension.restoreContext()
                    await ready
                    restored = root.resourceOwner !== oldOwner
                    frame(-1.25793, 'restored', true)
                    frame(-1.01973, 'restored-zoom', false)
                    cache.clear()
                    const paths = (
                        actual as unknown as { paths: { pin: (...args: never[]) => unknown } }
                    ).paths
                    const pin = paths.pin
                    try {
                        paths.pin = () => undefined
                        frame(-1.19273, 'pin-pressure', true)
                    } finally {
                        paths.pin = pin
                    }
                    frame(-1.19273, 'after-pressure', true)
                    frame(-1.03917, 'after-pressure-zoom', false)
                }
                cache.clear()
            }
            return { rows, restored, pictures }
        } finally {
            for (const cache of caches) cache.clear()
            expectedSurface.dispose()
            actualSurface.dispose()
            root.dispose()
        }
    })
    await testInfo.attach('point-zoom', {
        body: JSON.stringify({ ...report, pictures: undefined }, null, 2),
        contentType: 'application/json',
    })
    for (const picture of report.pictures)
        for (const kind of ['reference', 'candidate'] as const)
            await testInfo.attach(`${picture.label}-${kind}`, {
                body: Buffer.from(picture[kind].split(',')[1]!, 'base64'),
                contentType: 'image/png',
            })
    expect(errors).toEqual([])
    expect(report.restored).toBe(true)
    for (const row of report.rows) {
        expect(row.glError, row.label).toBe(0)
        expect(row.freshDifference.pixels, `${row.label}:fresh`).toBe(0)
        // Local point placement can change one MSAA edge sample versus drawing
        // absolute coordinates. The measured fixture allowance is deliberately
        // small; interiors, spill, and reused-versus-fresh output stay strict.
        expect(row.difference.pixels, row.label).toBeLessThanOrEqual(40)
        expect(row.difference.displayedMax, row.label).toBeLessThanOrEqual(48)
        expect(row.difference.alphaMax, row.label).toBeLessThanOrEqual(48)
        expect(row.difference.interior, row.label).toBe(0)
        expect(row.difference.spill, row.label).toBe(0)
        expect(row.names, row.label).toEqual(row.expectedNames)
    }
})
