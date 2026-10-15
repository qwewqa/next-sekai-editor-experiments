import { expect, test } from '@playwright/test'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type { WebGLDrawContext } from '../../src/rendering/context'
import type { NoteEntity } from '../../src/state/entities/slides/note'

test('connector bodies retain local geometry and gradients through arbitrary WebGL2 zoom', async ({
    page,
}, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/__connector-body-zoom', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><canvas></canvas>' }),
    )
    await page.goto('/__connector-body-zoom')
    const report = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const { createConnectorRenderer } = await import('/src/editor/canvas/connectors.ts')
        const { toConnectorEntity } = await import('/src/state/entities/slides/connector.ts')
        const size = 512
        const canvas = document.querySelector('canvas')!
        canvas.width = canvas.height = size
        const root = getDrawContext(canvas)
        await root.ready
        const gl = canvas.getContext('webgl2')!
        const surfaces = Array.from({ length: 3 }, () => root.createSurface(size, size))
        const [actual, legacy, fresh] = surfaces.map((surface) => surface.getContext()) as [
            WebGLDrawContext,
            WebGLDrawContext,
            WebGLDrawContext,
        ]
        // Keep the old fill route as an independent same-source pixel reference.
        legacy.fillConnectorBody = () => false
        const read = (ctx: WebGLDrawContext) => ctx.getImageData(0, 0, size, size).data
        const png = (pixels: Uint8ClampedArray) => {
            const image = document.createElement('canvas')
            image.width = image.height = size
            image
                .getContext('2d')!
                .putImageData(new ImageData(new Uint8ClampedArray(pixels), size), 0, 0)
            return image.toDataURL('image/png')
        }
        const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
            let changed = 0,
                interior = 0,
                alphaMax = 0,
                displayedMax = 0,
                spill = 0,
                coverageA = 0,
                coverageB = 0
            const bounds = [size, size, -1, -1]
            for (let y = 0; y < size; y++)
                for (let x = 0; x < size; x++) {
                    const i = (y * size + x) * 4
                    const aa = a[i + 3]!,
                        ba = b[i + 3]!
                    coverageA += aa
                    coverageB += ba
                    let delta = Math.abs(aa - ba)
                    alphaMax = Math.max(alphaMax, delta)
                    for (const background of [0, 64, 255])
                        for (let channel = 0; channel < 3; channel++)
                            delta = Math.max(
                                delta,
                                Math.abs(
                                    (a[i + channel]! * aa +
                                        background * (255 - aa) -
                                        b[i + channel]! * ba -
                                        background * (255 - ba)) /
                                        255,
                                ),
                            )
                    displayedMax = Math.max(displayedMax, delta)
                    if (!delta) continue
                    changed++
                    bounds[0] = Math.min(bounds[0]!, x)
                    bounds[1] = Math.min(bounds[1]!, y)
                    bounds[2] = Math.max(bounds[2]!, x)
                    bounds[3] = Math.max(bounds[3]!, y)
                    let flat = x > 0 && x < size - 1 && y > 0 && y < size - 1
                    let nearby = false
                    for (let dy = -1; dy <= 1; dy++)
                        for (let dx = -1; dx <= 1; dx++) {
                            if (x + dx < 0 || x + dx >= size || y + dy < 0 || y + dy >= size)
                                continue
                            const alpha = a[i + (dy * size + dx) * 4 + 3]!
                            nearby ||= alpha > 0
                            if (Math.abs(alpha - aa) > 2) flat = false
                        }
                    if (flat && delta > 2) interior++
                    if (!nearby && ba) spill++
                }
            return {
                changed,
                interior,
                alphaMax,
                displayedMax,
                spill,
                coverageChange: coverageA ? (coverageB - coverageA) / coverageA : coverageB,
                coverageA,
                bounds,
            }
        }
        const crop = (a: Uint8ClampedArray, b: Uint8ClampedArray, bounds: number[]) => {
            const x = Math.max(0, bounds[0]! - 8),
                y = Math.max(0, bounds[1]! - 8)
            const w = Math.min(size - x, bounds[2]! - x + 9),
                h = Math.min(size - y, bounds[3]! - y + 9)
            const target = document.createElement('canvas')
            target.width = w * 8
            target.height = h * 4
            const targetContext = target.getContext('2d')!
            targetContext.imageSmoothingEnabled = false
            for (const [index, pixels] of [a, b].entries()) {
                const source = document.createElement('canvas')
                source.width = source.height = size
                source
                    .getContext('2d')!
                    .putImageData(new ImageData(new Uint8ClampedArray(pixels), size), 0, 0)
                targetContext.drawImage(source, x, y, w, h, index * w * 4, 0, w * 4, h * 4)
            }
            return target.toDataURL('image/png')
        }
        const note = (beat: number, left: number, size: number, extra: Partial<NoteEntity> = {}) =>
            ({
                type: 'note',
                beat,
                left,
                size,
                connectorEase: 'linear',
                connectorType: 'active',
                connectorStyle: extra.connectorType === 'guide' ? 'blue' : 'default',
                connectorActiveIsCritical: false,
                connectorIsFake: false,
                connectorGuideAlpha: 1,
                ...extra,
            }) as NoteEntity
        const rows = []
        const pictures: { label: string; legacy: string; candidate: string; crop?: string }[] = []
        const configurations = [
            ['linear', 'linear', false, false, false],
            ['quadratic', 'inQuad', false, false, false],
            ['compound-gradient', 'inOutQuad', true, false, false],
            ['overshoot', 'outBack', false, false, false],
            ['step-gradient', 'inOutStep', true, false, false],
            ['fake', 'outQuad', false, true, false],
            ['composed-gradient', 'linear', true, false, true],
            ['composed-fake', 'linear', false, true, true],
        ] as const
        let activeCalls = 0,
            successfulCalls = 0
        const paths = new Set<unknown>()
        const api = actual.fillConnectorBody.bind(actual)
        actual.fillConnectorBody = (path, scale, origin) => {
            activeCalls++
            paths.add(path)
            const result = api(path, scale, origin)
            successfulCalls += +result
            return result
        }
        let restored = false
        try {
            for (const [label, ease, guide, fake, composed] of configurations)
                for (const [variant, scale, reflected, requestedFarBeat] of [
                    ['dpr1', 18, false, 0],
                    ['dpr3', 54, false, 0],
                    ['reflected-far', 18, true, 2 ** 20],
                ] as const) {
                    // Composed sampling intentionally removes sub-jump-tolerance
                    // strips at enormous times. Keep this short fixture visible.
                    const farBeat = composed
                        ? Math.min(requestedFarBeat, 2 ** 14)
                        : requestedFarBeat
                    const head = note(farBeat, 0.5, 1.25, {
                        connectorEase: ease,
                        connectorType: guide ? 'guide' : 'active',
                        connectorIsFake: fake,
                        connectorGuideAlpha: 0.15,
                    })
                    const tail = note(farBeat + 0.5, 5, 1.75, { connectorGuideAlpha: 0.95 })
                    const entity = toConnectorEntity(head, tail, head, tail, head, tail)
                    const stages = new Map([[head.stageId, { breakpoints: [farBeat + 0.25] }]])
                    const layout = composed
                        ? ({
                              stages,
                              connectorPosition: (
                                  _entity: unknown,
                                  beat: number,
                                  options: { rightLimit?: boolean } = {},
                              ) => ({
                                  left:
                                      0.5 +
                                      9 * (beat - farBeat) +
                                      Math.sin((beat - farBeat) * 8) * 0.3 +
                                      (beat > farBeat + 0.25 ||
                                      (beat === farBeat + 0.25 && options.rightLimit)
                                          ? 0.3
                                          : 0),
                                  size: 1.25 + beat - farBeat,
                              }),
                          } as unknown as EditorDrawContext['composed'])
                        : undefined
                    const renderer = createConnectorRenderer()
                    const oldRenderer = createConnectorRenderer()
                    const state = { bpms: [{ x: 0, y: 0, s: 0.5 }] }
                    paths.clear()
                    const render = (
                        ctx: WebGLDrawContext,
                        draw: ReturnType<typeof createConnectorRenderer>,
                        ups: number,
                    ) => {
                        ctx.clear()
                        const sign = reflected ? -1 : 1
                        ctx.setTransform(
                            scale * sign,
                            0,
                            0,
                            scale * sign,
                            reflected ? 480 : 16,
                            (reflected ? 40 : 470) - scale * sign * farBeat * 0.5 * ups,
                        )
                        const context = {
                            ctx,
                            ups,
                            scale,
                            composed: layout,
                            state,
                        } as EditorDrawContext
                        const range = ctx.captureVectors(
                            () => draw.draw(context, entity, false),
                            [0, farBeat * 0.5 * ups],
                        )!
                        if (!range || !ctx.drawVectors(range)) throw new Error('Capture declined')
                        const pixels = read(ctx)
                        ctx.releaseVectors(range)
                        return pixels
                    }
                    for (const ups of [-7.71, -8.123, -16.371]) {
                        const expected = render(legacy, oldRenderer, ups)
                        const candidate = render(actual, renderer, ups)
                        const independent = render(fresh, createConnectorRenderer(), ups)
                        const delta = difference(expected, candidate)
                        const exactFresh = candidate.every(
                            (value, index) => value === independent[index],
                        )
                        rows.push({
                            label,
                            variant,
                            ups,
                            ...delta,
                            exactFresh,
                            glError: gl.getError(),
                        })
                        if (
                            (ups === -16.371 &&
                                ['compound-gradient', 'composed-fake'].includes(label)) ||
                            (label === 'overshoot' && variant === 'reflected-far' && ups === -7.71)
                        )
                            pictures.push({
                                label: `${label}-${variant}`,
                                legacy: png(expected),
                                candidate: png(candidate),
                                crop:
                                    label === 'overshoot'
                                        ? crop(expected, candidate, delta.bounds)
                                        : undefined,
                            })
                    }
                    if (paths.size !== 1)
                        throw new Error(`Body path did not persist: ${label}/${variant}`)
                    if (label === 'linear' && variant === 'dpr1') {
                        // The domain retains CPU paths; the restored renderer must
                        // reacquire only its own generation of native resources.
                        const owner = root.resourceOwner
                        const extension = gl.getExtension('WEBGL_lose_context')!
                        const lost = new Promise<void>((resolve) =>
                            canvas.addEventListener('webglcontextlost', () => resolve(), {
                                once: true,
                            }),
                        )
                        extension.loseContext()
                        await lost
                        await new Promise((resolve) => setTimeout(resolve, 50))
                        const changed = new Promise<void>((resolve) =>
                            canvas.addEventListener('renderingready', () => resolve(), {
                                once: true,
                            }),
                        )
                        extension.restoreContext()
                        await changed
                        await root.ready
                        restored = root.resourceOwner !== owner
                        const candidate = render(actual, renderer, -9.219)
                        const expected = render(fresh, createConnectorRenderer(), -9.219)
                        if (!candidate.every((value, index) => value === expected[index]))
                            throw new Error('Restored body differed from fresh')
                        surfaces[0]!.width = size + 1
                        surfaces[0]!.width = size
                        const resized = render(actual, renderer, -10.013)
                        const resizedExpected = render(fresh, createConnectorRenderer(), -10.013)
                        if (!resized.every((value, index) => value === resizedExpected[index]))
                            throw new Error('Resized body differed from fresh')
                    }
                }
            return { rows, pictures, activeCalls, successfulCalls, restored }
        } finally {
            for (const surface of surfaces) surface.dispose()
            root.dispose()
        }
    })
    for (const picture of report.pictures)
        for (const side of ['legacy', 'candidate', 'crop'] as const)
            if (picture[side])
                await testInfo.attach(`${picture.label}-${side}`, {
                    body: Buffer.from(picture[side]!.split(',')[1]!, 'base64'),
                    contentType: 'image/png',
                })
    await testInfo.attach('connector-body-report', {
        body: JSON.stringify({ ...report, pictures: undefined }, null, 2),
        contentType: 'application/json',
    })
    expect(errors).toEqual([])
    expect(report.restored).toBe(true)
    expect(report.successfulCalls).toBe(report.activeCalls)
    expect(report.rows).toHaveLength(72)
    for (const row of report.rows) {
        expect(row.exactFresh, JSON.stringify(row)).toBe(true)
        expect(row.glError, JSON.stringify(row)).toBe(0)
        expect(row.coverageA, JSON.stringify(row)).toBeGreaterThan(0)
        expect(row.interior, JSON.stringify(row)).toBe(0)
        expect(row.spill, JSON.stringify(row)).toBe(0)
        expect(Math.abs(row.coverageChange), JSON.stringify(row)).toBeLessThanOrEqual(0.005)
        expect(row.displayedMax, JSON.stringify(row)).toBeLessThanOrEqual(64)
    }
})
