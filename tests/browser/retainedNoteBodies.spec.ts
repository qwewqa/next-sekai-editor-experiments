import { expect, test } from '@playwright/test'
import type { NoteBody, WebGLDrawContext } from '../../src/rendering/context'

test(`retained note bodies preserve pixels and lifetime in WebGL 2`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))

    await page.route('**/__retained_note_bodies', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><canvas id="probe" width="128" height="128"></canvas>',
        }),
    )
    await page.goto('/__retained_note_bodies')
    const report = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const { createNoteAtlas } = await import('/src/editor/canvas/noteAtlas.ts')
        const canvas = document.querySelector<HTMLCanvasElement>('#probe')!
        const root = getDrawContext(canvas)
        await root.ready
        const gl = canvas.getContext('webgl2')!
        const referenceSurface = root.createSurface(128, 128)
        const candidateSurface = root.createSurface(128, 128)
        const reference = referenceSurface.getContext()
        const candidate = candidateSurface.getContext()
        const owned = new Set([referenceSurface, candidateSurface])
        const surface = (width = 16, height = 16) => {
            const result = root.createSurface(width, height)
            owned.add(result)
            return result
        }
        const paint = (target: ReturnType<typeof surface>, color: string) => {
            const ctx = target.getContext()
            ctx.clear()
            ctx.fillStyle = color
            ctx.fillRect(0, 0, target.width, target.height)
        }
        const pixels = (ctx: WebGLDrawContext) => ctx.getImageData(0, 0, 128, 128).data
        const at = (data: Uint8ClampedArray, x: number, y: number) => [
            ...data.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4),
        ]
        const difference = (expected: Uint8ClampedArray, actual: Uint8ClampedArray) => {
            let changed = 0,
                max = 0
            const samples: { x: number; y: number; expected: number[]; actual: number[] }[] = []
            for (let i = 0; i < expected.length; i += 4) {
                if (expected.subarray(i, i + 4).every((v, c) => v === actual[i + c])) continue
                changed++
                for (let c = 0; c < 4; c++)
                    max = Math.max(max, Math.abs(expected[i + c]! - actual[i + c]!))
                if (samples.length < 4)
                    samples.push({
                        x: (i / 4) % 128,
                        y: Math.floor(i / 512),
                        expected: [...expected.subarray(i, i + 4)],
                        actual: [...actual.subarray(i, i + 4)],
                    })
            }
            return { changed, max, samples }
        }
        const reset = (ctx: WebGLDrawContext) => {
            ctx.resetTransform()
            ctx.globalAlpha = 1
            ctx.globalCompositeOperation = 'source-over'
            ctx.imageSmoothingEnabled = true
            ctx.clear()
        }
        const immediate = (ctx: WebGLDrawContext, bodies: readonly NoteBody[]) => {
            const alpha = ctx.globalAlpha
            for (const body of bodies) {
                ctx.globalAlpha = alpha * body.alpha
                ctx.drawNoteAtlasRegion(body.region, body.x, body.y, body.width, body.height)
            }
            ctx.globalAlpha = alpha
        }
        const source = surface(32, 32)
        paint(source, '#f64a20')
        const src = source.getContext()
        src.fillStyle = '#2196e8'
        src.fillRect(4.25, 3.5, 20.5, 23.25)
        src.globalAlpha = 0.375
        src.fillStyle = '#fff'
        src.fillRect(8, 1, 5, 29)
        src.globalAlpha = 1
        const region = src.createNoteAtlasRegion(2.25, 1.5, 27, 29)!
        const follower = surface(9, 9)
        paint(follower, '#a72cdd')
        const cases = []
        const positionUpdates: {
            name: string
            delta: number
            smoothing: boolean
            alpha: number
            updated: boolean
            drawn: boolean
            queuedDeclined: boolean
            identities: boolean
            difference: ReturnType<typeof difference>
        }[] = []
        for (const smoothing of [false, true])
            for (const alpha of [1, 0.375])
                for (const [name, matrix, originY] of [
                    ['axis', [1.25, 0, 0, 0.875, 3.25, 4.125], 0],
                    ['reflect-x', [-1.25, 0, 0, 0.875, 122.25, 4.125], 0],
                    ['reflect-y', [1.25, 0, 0, -0.875, 3.25, 123.125], 0],
                    ['far-y', [1.25, 0, 0, 1, 3.25, -65531.875], 65536],
                ] as const) {
                    const bodies: NoteBody[] = [
                        {
                            region,
                            x: 8.25,
                            y: originY + 6.5,
                            width: 40.5,
                            height: 36.25,
                            alpha: 0.625,
                        },
                        {
                            region,
                            x: 25.25,
                            y: originY + 21.75,
                            width: 43.5,
                            height: 39.25,
                            alpha: 0.75,
                        },
                    ]
                    let replayed = false,
                        duplicateDeclined = false,
                        repeated = false
                    const render = (ctx: WebGLDrawContext, retained: boolean) => {
                        reset(ctx)
                        ctx.fillStyle = '#26364a'
                        ctx.fillRect(2, 3, 17, 22)
                        ctx.setTransform(
                            matrix[0],
                            matrix[1],
                            matrix[2],
                            matrix[3],
                            matrix[4],
                            matrix[5],
                        )
                        ctx.globalAlpha = alpha
                        ctx.imageSmoothingEnabled = smoothing
                        const run = retained ? ctx.createNoteBodies(bodies, originY) : undefined
                        if (retained) {
                            if (!run) throw new Error(`Valid run rejected: ${name}`)
                            replayed = ctx.drawNoteBodies(run)
                            duplicateDeclined = !ctx.drawNoteBodies(run)
                        } else immediate(ctx, bodies)
                        ctx.resetTransform()
                        ctx.globalAlpha = 1
                        ctx.drawImage(follower, 38.5, 31.25, 19, 17)
                        ctx.fillStyle = '#3fe96a'
                        ctx.fillRect(59.25, 48.5, 9.5, 17.25)
                        const result = pixels(ctx)
                        if (run) {
                            // A flushed group is detached, reusable, and not pooled as ordinary Sprites.
                            reset(ctx)
                            ctx.setTransform(
                                matrix[0],
                                matrix[1],
                                matrix[2],
                                matrix[3],
                                matrix[4],
                                matrix[5],
                            )
                            ctx.globalAlpha = alpha
                            ctx.imageSmoothingEnabled = smoothing
                            repeated = ctx.drawNoteBodies(run)
                            pixels(ctx)
                            const identities = [...run.group.children]
                            for (const delta of [0.13731, 1.91357, -0.62719]) {
                                const changed = bodies.map((body, index) => ({
                                    ...body,
                                    y: body.y + delta * (index + 1),
                                }))
                                const changedOrigin = originY + delta * 0.75
                                for (const target of [reference, ctx]) {
                                    reset(target)
                                    target.setTransform(
                                        matrix[0],
                                        matrix[1],
                                        matrix[2],
                                        matrix[3],
                                        matrix[4],
                                        matrix[5],
                                    )
                                    target.globalAlpha = alpha
                                    target.imageSmoothingEnabled = smoothing
                                }
                                const fresh = reference.createNoteBodies(changed, changedOrigin)!
                                if (!fresh || !reference.drawNoteBodies(fresh))
                                    throw new Error('Fresh position reference declined')
                                const updated = ctx.updateNoteBodyPositions(
                                    run,
                                    changed.map(({ y }) => y),
                                    changedOrigin,
                                )
                                const drawn = ctx.drawNoteBodies(run)
                                // A queued update must not rewrite already submitted paint.
                                const queuedDeclined = !ctx.updateNoteBodyPositions(
                                    run,
                                    changed.map(({ y }) => y + 50),
                                    changedOrigin,
                                )
                                positionUpdates.push({
                                    name,
                                    delta,
                                    smoothing,
                                    alpha,
                                    updated,
                                    drawn,
                                    queuedDeclined,
                                    identities: identities.every(
                                        (node, index) => run.group.children[index] === node,
                                    ),
                                    difference: difference(pixels(reference), pixels(ctx)),
                                })
                                reference.releaseNoteBodies(fresh)
                            }
                            ctx.releaseNoteBodies(run)
                            if (!run.released || !run.group.destroyed)
                                throw new Error('Released run retained its nodes')
                        }
                        return result
                    }
                    const expected = render(reference, false)
                    const actual = render(candidate, true)
                    cases.push({
                        name,
                        smoothing,
                        alpha,
                        replayed,
                        duplicateDeclined,
                        repeated,
                        difference: difference(expected, actual),
                    })
                }

        const invalid = []
        const body: NoteBody = { region, x: 5, y: 6, width: 30, height: 28, alpha: 0.75 }
        for (const mode of [
            'clip',
            'skew',
            'layer',
            'blend',
            'alpha',
            'sampling',
            'linear',
        ] as const) {
            let declinedCreate = false,
                declinedReplay = false
            const render = (ctx: WebGLDrawContext, retained: boolean) => {
                reset(ctx)
                const run = retained ? ctx.createNoteBodies([body], 0)! : undefined
                ctx.save()
                if (mode === 'clip') {
                    ctx.beginPath()
                    ctx.rect(12, 10, 31, 25)
                    ctx.clip()
                }
                if (mode === 'skew') ctx.setTransform(1, 0.2, 0.3, 1, 0, 0)
                if (mode === 'layer') ctx.saveLayer(1, 0, 0, 128, 128)
                if (mode === 'blend') ctx.globalCompositeOperation = 'destination-over'
                if (mode === 'alpha') ctx.globalAlpha = 0.5
                if (mode === 'sampling') ctx.imageSmoothingEnabled = false
                if (mode === 'linear') ctx.scale(1.25, 1)
                if (run) {
                    declinedReplay = !ctx.drawNoteBodies(run)
                    if (['clip', 'skew', 'layer', 'blend'].includes(mode))
                        declinedCreate = !ctx.createNoteBodies([body], 0)
                    else declinedCreate = true // These states are valid for a newly prepared run.
                }
                // Exactly one fallback paint: a declined retained replay must queue nothing.
                immediate(ctx, [body])
                if (mode === 'layer') ctx.restore()
                ctx.restore()
                const result = pixels(ctx)
                if (run) ctx.releaseNoteBodies(run)
                return result
            }
            const expected = render(reference, false),
                actual = render(candidate, true)
            invalid.push({
                mode,
                declinedCreate,
                declinedReplay,
                difference: difference(expected, actual),
            })
        }
        reset(candidate)
        const invalidInputs = [
            [],
            [body, { ...body, width: -1 }],
            [body, { ...body, x: NaN }],
            [body, { ...body, alpha: 1.1 }],
            [body, { ...body, height: 0 }],
        ].map((bodies) => candidate.createNoteBodies(bodies, 0) === undefined)
        const invalidInputPaint = pixels(candidate).some((v) => v !== 0)

        const lifetime = []
        for (const action of ['mutate', 'release', 'resize', 'dispose'] as const) {
            const page = surface()
            paint(page, '#ff0000')
            const crop = page.getContext().createNoteAtlasRegion(2, 2, 10, 10)!
            reset(candidate)
            const run = candidate.createNoteBodies(
                [{ ...body, region: crop, x: 4, y: 4, width: 20, height: 20, alpha: 1 }],
                0,
            )!
            if (!candidate.drawNoteBodies(run)) throw new Error('Initial lifecycle replay declined')
            if (action === 'mutate') paint(page, '#0000ff')
            if (action === 'release') crop.release()
            if (action === 'resize') page.width = 17
            if (action === 'dispose') page.dispose()
            const repositioned = candidate.updateNoteBodyPositions(run, [4], 0)
            candidate.translate(32, 0)
            const replayed = candidate.drawNoteBodies(run)
            const data = pixels(candidate)
            lifetime.push({
                action,
                repositioned,
                replayed,
                left: at(data, 12, 12),
                right: at(data, 44, 12),
            })
            candidate.releaseNoteBodies(run)
            crop.release()
        }

        // Changing B's sampler flushes earlier B readers; A must still be registered afterward.
        const a = surface(),
            b = surface()
        paint(a, '#ff0000')
        paint(b, '#0000ff')
        const ar = a.getContext().createNoteAtlasRegion(0, 0, 16, 16)!
        const br = b.getContext().createNoteAtlasRegion(0, 0, 16, 16)!
        reset(candidate)
        candidate.imageSmoothingEnabled = false
        candidate.drawNoteAtlasRegion(br, 4, 4, 16, 16)
        candidate.imageSmoothingEnabled = true
        const mixed = candidate.createNoteBodies(
            [
                { ...body, region: ar, x: 28, y: 4, width: 16, height: 16, alpha: 1 },
                { ...body, region: br, x: 52, y: 4, width: 16, height: 16, alpha: 1 },
            ],
            0,
        )!
        const mixedDrawn = candidate.drawNoteBodies(mixed)
        paint(a, '#00ff00')
        paint(b, '#ffff00')
        const mixedData = pixels(candidate)
        const mixedReaders = {
            drawn: mixedDrawn,
            previous: at(mixedData, 12, 12),
            a: at(mixedData, 36, 12),
            b: at(mixedData, 60, 12),
        }
        candidate.releaseNoteBodies(mixed)

        const atlas = createNoteAtlas()
        const first = atlas.allocate(root, 12, 12)!,
            kept = atlas.allocate(root, 12, 12)!
        const fillSlot = (slot: typeof first, color: string) => {
            const ctx = slot.surface.getContext()
            ctx.fillStyle = color
            ctx.fillRect(slot.x, slot.y, slot.width, slot.height)
        }
        fillSlot(first, '#ff0000')
        reset(candidate)
        const stale = candidate.createNoteBodies(
            [{ ...body, region: first.region!, x: 4, y: 4, width: 20, height: 20, alpha: 1 }],
            0,
        )!
        candidate.drawNoteBodies(stale)
        first.release()
        const reused = atlas.allocate(root, 12, 12)!
        fillSlot(reused, '#0000ff')
        candidate.translate(32, 0)
        const staleDeclined = !candidate.drawNoteBodies(stale)
        const fresh = candidate.createNoteBodies(
            [{ ...body, region: reused.region!, x: 4, y: 4, width: 20, height: 20, alpha: 1 }],
            0,
        )!
        const freshDrawn = candidate.drawNoteBodies(fresh)
        const reusedData = pixels(candidate)
        const reuse = {
            sameSlot: first.x === reused.x && first.y === reused.y,
            staleDeclined,
            freshDrawn,
            left: at(reusedData, 12, 12),
            right: at(reusedData, 44, 12),
        }
        candidate.releaseNoteBodies(stale)
        candidate.releaseNoteBodies(fresh)
        kept.release()
        atlas.clear()

        // Reset and disposal release detached runs too, and cannot leave pooled sprites borrowed.
        reset(candidate)
        const beforeReset = candidate.createNoteBodies([body], 0)!
        candidateSurface.width = 129
        const resetReleased =
            beforeReset.released &&
            beforeReset.group.destroyed &&
            !candidate.drawNoteBodies(beforeReset)
        candidateSurface.width = 128
        reset(candidate)
        const wrongOwner = candidate.createNoteBodies([body], 0)!
        const crossContextDeclined = !reference.drawNoteBodies(wrongOwner)
        candidate.releaseNoteBodies(wrongOwner)
        const disposable = surface(128, 128)
        const disposableContext = disposable.getContext()
        const beforeDispose = disposableContext.createNoteBodies([body], 0)!
        disposable.dispose()
        const disposeReleased =
            beforeDispose.released &&
            beforeDispose.group.destroyed &&
            !disposableContext.drawNoteBodies(beforeDispose)

        reset(candidate)
        const beforeLoss = candidate.createNoteBodies([body], 0)!
        const oldOwner = root.resourceOwner
        const extension = gl.getExtension('WEBGL_lose_context')!
        const lost = new Promise<void>((resolve) =>
            canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }),
        )
        extension.loseContext()
        await lost
        const lostDeclined = !candidate.drawNoteBodies(beforeLoss)
        const lostUpdateDeclined = !candidate.updateNoteBodyPositions(beforeLoss, [7], 0)
        await new Promise((resolve) => setTimeout(resolve, 50))
        const restored = new Promise<void>((resolve) =>
            canvas.addEventListener('renderingready', () => resolve(), { once: true }),
        )
        extension.restoreContext()
        await restored
        const restoreReleased =
            beforeLoss.released && beforeLoss.group.destroyed && root.resourceOwner !== oldOwner
        reset(candidate)
        const oldDeclined = !candidate.drawNoteBodies(beforeLoss)
        const oldUpdateDeclined = !candidate.updateNoteBodyPositions(beforeLoss, [7], 0)
        paint(source, '#00ff00')
        const restoredRegion = src.createNoteAtlasRegion(0, 0, 16, 16)!
        const afterRestore = candidate.createNoteBodies(
            [{ ...body, region: restoredRegion, x: 4, y: 4, width: 20, height: 20, alpha: 1 }],
            0,
        )!
        const restoredDrawn = candidate.drawNoteBodies(afterRestore)
        const restoredColor = at(pixels(candidate), 12, 12)
        candidate.releaseNoteBodies(afterRestore)
        restoredRegion.release()
        region.release()
        ar.release()
        br.release()
        const glError = gl.getError()
        const actualVersion = gl instanceof WebGL2RenderingContext ? 2 : 1
        for (const target of owned) target.dispose()
        root.dispose()
        return {
            actualVersion,
            cases,
            positionUpdates,
            invalid,
            invalidInputs,
            invalidInputPaint,
            lifetime,
            mixedReaders,
            reuse,
            resetReleased,
            disposeReleased,
            crossContextDeclined,
            lostDeclined,
            lostUpdateDeclined,
            restoreReleased,
            oldDeclined,
            oldUpdateDeclined,
            restoredDrawn,
            restoredColor,
            glError,
        }
    })
    await testInfo.attach('retained-note-bodies', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
    })
    expect(errors).toEqual([])
    expect(report.actualVersion).toBe(2)
    expect(report.glError).toBe(0)
    for (const entry of report.cases) {
        expect(entry, JSON.stringify(entry)).toMatchObject({
            replayed: true,
            duplicateDeclined: true,
            repeated: true,
            difference: { changed: 0, max: 0 },
        })
    }
    for (const entry of report.invalid)
        expect(entry, JSON.stringify(entry)).toMatchObject({
            declinedCreate: true,
            declinedReplay: true,
            difference: { changed: 0, max: 0 },
        })
    expect(report.positionUpdates).toHaveLength(48)
    for (const entry of report.positionUpdates)
        expect(entry, JSON.stringify(entry)).toMatchObject({
            updated: true,
            drawn: true,
            queuedDeclined: true,
            identities: true,
            difference: { changed: 0, max: 0 },
        })
    expect(report.invalidInputs.every(Boolean)).toBe(true)
    expect(report.invalidInputPaint).toBe(false)
    for (const entry of report.lifetime) {
        expect(entry.left, entry.action).toEqual([255, 0, 0, 255])
        expect(entry.replayed, entry.action).toBe(entry.action === 'mutate')
        expect(entry.repositioned, entry.action).toBe(entry.action === 'mutate')
        expect(entry.right, entry.action).toEqual(
            entry.action === 'mutate' ? [0, 0, 255, 255] : [0, 0, 0, 0],
        )
    }
    expect(report.mixedReaders).toEqual({
        drawn: true,
        previous: [0, 0, 255, 255],
        a: [255, 0, 0, 255],
        b: [0, 0, 255, 255],
    })
    expect(report.reuse).toEqual({
        sameSlot: true,
        staleDeclined: true,
        freshDrawn: true,
        left: [255, 0, 0, 255],
        right: [0, 0, 255, 255],
    })
    for (const key of [
        'resetReleased',
        'disposeReleased',
        'crossContextDeclined',
        'lostDeclined',
        'lostUpdateDeclined',
        'restoreReleased',
        'oldDeclined',
        'oldUpdateDeclined',
        'restoredDrawn',
    ] as const)
        expect(report[key], key).toBe(true)
    expect(report.restoredColor).toEqual([0, 255, 0, 255])
})
