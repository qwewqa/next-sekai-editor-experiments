import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const installCoverProbe = () => {
    type GL = WebGLRenderingContext | WebGL2RenderingContext
    const contexts: GL[] = []
    const textures = new Set<WebGLTexture>()
    const programs = new Set<WebGLProgram>()
    const extensions = new WeakSet<object>()
    const totals = {
        contextRequests: 0,
        textureCreates: 0,
        textureDeletes: 0,
        programCreates: 0,
        programDeletes: 0,
        loseCalls: 0,
    }
    let holding: false | 'invocation' | 'callback' = false
    let failNextEncode = false
    let textureLimit: number | undefined
    const encodes: (() => void)[] = []
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...args: unknown[]
    ) {
        const tracked = !this.isConnected && (type === 'webgl2' || type === 'webgl')
        if (tracked) totals.contextRequests++

        const context = Reflect.apply(getContext, this, [type, ...args]) as RenderingContext | null
        if (tracked && context && !contexts.includes(context as GL)) contexts.push(context as GL)
        return context
    } as typeof getContext
    for (const prototype of [
        WebGLRenderingContext.prototype,
        ...(typeof WebGL2RenderingContext === 'undefined'
            ? []
            : [WebGL2RenderingContext.prototype]),
    ]) {
        const wrap = (
            name: string,
            observe: (gl: GL, args: unknown[], result: unknown) => unknown,
        ) => {
            if (!Object.hasOwn(prototype, name)) return
            const methods = prototype as unknown as Record<string, (...args: unknown[]) => unknown>
            const original = methods[name]!
            methods[name] = function (this: GL, ...args) {
                const result = Reflect.apply(original, this, args)
                const override = contexts.includes(this) ? observe(this, args, result) : undefined
                return override === undefined ? result : override
            }
        }
        wrap('getParameter', (gl, [parameter], result) =>
            parameter === gl.MAX_TEXTURE_SIZE && textureLimit !== undefined
                ? Math.min(Number(result), textureLimit)
                : undefined,
        )
        wrap('createTexture', (_gl, _args, texture) => {
            if (!texture) return
            totals.textureCreates++
            textures.add(texture as WebGLTexture)
        })
        wrap('deleteTexture', (_gl, [texture]) => {
            if (!texture) return
            totals.textureDeletes++
            textures.delete(texture as WebGLTexture)
        })
        wrap('createProgram', (_gl, _args, program) => {
            if (!program) return
            totals.programCreates++
            programs.add(program as WebGLProgram)
        })
        wrap('deleteProgram', (_gl, [program]) => {
            if (!program) return
            totals.programDeletes++
            programs.delete(program as WebGLProgram)
        })
        wrap('getExtension', (_gl, [name], extension) => {
            if (name !== 'WEBGL_lose_context' || !extension || extensions.has(extension as object))
                return
            extensions.add(extension as object)
            const lose = extension as WEBGL_lose_context
            const original = lose.loseContext
            lose.loseContext = () => {
                totals.loseCalls++
                original.call(lose)
            }
        })
    }
    const toBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        // Cancellation delays completion after native encoding has already started.
        // Invoking native toBlob only after losing its context is not a real export.
        if (holding === 'callback') {
            toBlob.call(this, (blob) => encodes.push(() => callback(blob)), ...args)
            return
        }
        const encode = () => {
            if (failNextEncode) {
                failNextEncode = false
                callback(null)
            } else toBlob.call(this, callback, ...args)
        }
        if (holding === 'invocation') encodes.push(encode)
        else encode()
    }
    const probe = {
        limit: (size: number) => {
            textureLimit = size
        },
        snapshot: () => ({
            ...totals,
            contexts: contexts.length,
            liveContexts: contexts.filter((gl) => !gl.isContextLost()).length,
            liveTextures: textures.size,
            livePrograms: programs.size,
            dimensions: contexts
                .filter((gl) => !gl.isContextLost())
                .map((gl) => [
                    gl.canvas.width,
                    gl.canvas.height,
                    gl.drawingBufferWidth,
                    gl.drawingBufferHeight,
                ]),
            versions: contexts.map((gl) =>
                typeof WebGL2RenderingContext !== 'undefined' &&
                gl instanceof WebGL2RenderingContext
                    ? 2
                    : 1,
            ),
        }),
        hold: (mode: 'invocation' | 'callback' = 'invocation') => {
            holding = mode
        },
        pending: () => encodes.length,
        release: (index = 0) => {
            const [encode] = encodes.splice(index, 1)
            if (!encode) throw new Error('No held cover encoder')
            encode()
        },
        resume: () => {
            holding = false
            for (const encode of encodes.splice(0)) encode()
        },
        failEncode: () => {
            failNextEncode = true
        },
        loseIdle: async () => {
            const gl = [...contexts].reverse().find((context) => !context.isContextLost())
            if (!gl) throw new Error('No live cover context')
            const lost = new Promise<void>((resolve) =>
                gl.canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }),
            )
            const extension = gl.getExtension('WEBGL_lose_context')
            if (!extension) throw new Error('Context loss extension unavailable')
            extension.loseContext()
            await lost
        },
        waitForEncodes: async (count: number) => {
            const deadline = performance.now() + 5000
            while (encodes.length < count) {
                if (performance.now() > deadline) throw new Error('Cover encoding did not start')
                await new Promise((resolve) => setTimeout(resolve, 0))
            }
        },
        image: async (seed: number, width: number, height: number, alpha = false) => {
            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const context = canvas.getContext('2d')!
            const image = context.createImageData(width, height)
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    image.data.set(
                        [
                            (x * 13 + seed * 37) % 256,
                            (y * 17 + seed * 71) % 256,
                            (x * 3 + y * 5 + seed * 29) % 256,
                            alpha ? [0, 64, 128, 255][((x >> 3) + (y >> 3)) % 4]! : 255,
                        ],
                        (y * width + x) * 4,
                    )
                }
            }
            context.putImageData(image, 0, 0)
            const decoded = new Image()
            decoded.src = canvas.toDataURL()
            await decoded.decode()
            return decoded
        },
        pixels: async (blob: Blob) => {
            const bitmap = await createImageBitmap(blob)
            const canvas = document.createElement('canvas')
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            const context = canvas.getContext('2d')!
            context.drawImage(bitmap, 0, 0)
            bitmap.close()
            return {
                width: canvas.width,
                height: canvas.height,
                bytes: context.getImageData(0, 0, canvas.width, canvas.height).data,
            }
        },
    }
    window.coverReuseProbe = probe
    return probe
}

declare global {
    interface Window {
        coverReuseProbe: ReturnType<typeof installCoverProbe>
    }
}

test.beforeEach(async ({ page }) => {
    await page.route('**/__cover-reuse-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__cover-reuse-test')
})

test.describe('cover sampler reuse in WebGL2', () => {
    test.beforeEach(async ({ page }) => {
        await page.evaluate(installCoverProbe)
    })

    test('changed sources and sizes exactly match fresh exports with one bounded idle sampler', async ({
        page,
        browserName,
    }) => {
        const result = await page.evaluate(async () => {
            const { CoverExporter, createCoverBlob } = await import('/src/rendering/coverExport.ts')
            const probe = window.coverReuseProbe
            probe.limit(128)
            const cases = [
                { image: await probe.image(1, 128, 64), size: 64 },
                { image: await probe.image(2, 64, 128, true), size: 16 },
                { image: await probe.image(3, 192, 96, true), size: 192 },
                { image: await probe.image(4, 64, 64), size: 96 },
            ]
            const references = []
            for (const { image, size } of cases)
                references.push(
                    await probe.pixels(
                        await createCoverBlob(image, size, new AbortController().signal),
                    ),
                )
            const nativeCanvas = document.createElement('canvas')
            nativeCanvas.width = nativeCanvas.height = 64
            const native = nativeCanvas.getContext('2d')!
            native.drawImage(cases[0]!.image, 32, 0, 64, 64, 0, 0, 64, 64)
            const nativePixels = native.getImageData(0, 0, 64, 64).data
            const nativeDifferences = Array.from(references[0]!.bytes).flatMap((value, offset) =>
                value === nativePixels[offset]
                    ? []
                    : [
                          {
                              offset,
                              actual: value,
                              expected: nativePixels[offset],
                              delta: value - nativePixels[offset]!,
                          },
                      ],
            )
            const before = probe.snapshot()
            const exporter = new CoverExporter()
            const comparisons = []
            const idle = []
            for (let run = 0; run < 24; run++) {
                const index = run % cases.length
                const { image, size } = cases[index]!
                const actual = await probe.pixels(
                    await exporter.createBlob(image, size, new AbortController().signal),
                )
                const expected = references[index]!
                comparisons.push({
                    width: actual.width,
                    height: actual.height,
                    size,
                    mismatches: actual.bytes.reduce(
                        (count, value, offset) => count + +(value !== expected.bytes[offset]),
                        0,
                    ),
                })
                idle.push(probe.snapshot())
            }
            exporter.dispose()
            return { before, comparisons, idle, nativeDifferences, disposed: probe.snapshot() }
        })
        // WebKit's fresh opaque PNG differs from native Canvas by +1 red in
        // 15/16,384 channels. Alpha remains exact; reuse must remain byte exact.
        for (const { offset, delta } of result.nativeDifferences)
            expect(Math.abs(delta)).toBeLessThanOrEqual(
                browserName === 'webkit' && offset % 4 !== 3 ? 1 : 0,
            )
        for (const { width, height, size, mismatches } of result.comparisons) {
            expect([width, height]).toEqual([size, size])
            expect(mismatches).toBe(0)
        }
        const first = result.idle[0]!
        expect(first.contexts - result.before.contexts).toBe(1)
        expect(first.programCreates - result.before.programCreates).toBeGreaterThan(0)
        for (const idle of result.idle) {
            expect(idle.contexts).toBe(first.contexts)
            expect(idle.contextRequests).toBe(first.contextRequests)
            expect(idle.programCreates).toBe(first.programCreates)
            expect(idle.liveContexts).toBe(1)
            expect(idle.liveTextures).toBe(0)
            expect(idle.textureDeletes).toBe(idle.textureCreates)
            expect(idle.dimensions).toEqual([[1, 1, 1, 1]])
            expect(idle.versions.every((version) => version === 2)).toBe(true)
        }
        expect(result.disposed.liveContexts).toBe(0)
        expect(result.disposed.livePrograms).toBe(0)
        expect(result.disposed.programDeletes).toBe(result.disposed.programCreates)
        expect(result.disposed.loseCalls - first.loseCalls).toBe(1)
    })

    test('overlapping delayed encodes keep independent pixels and retain at most one idle sampler', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const { CoverExporter, createCoverBlob } = await import('/src/rendering/coverExport.ts')
            const probe = window.coverReuseProbe
            const a = await probe.image(5, 128, 64)
            const b = await probe.image(6, 96, 160)
            const referenceA = await probe.pixels(
                await createCoverBlob(a, 32, new AbortController().signal),
            )
            const referenceB = await probe.pixels(
                await createCoverBlob(b, 48, new AbortController().signal),
            )
            const before = probe.snapshot()
            const exporter = new CoverExporter()
            probe.hold()
            const first = exporter.createBlob(a, 32, new AbortController().signal)
            await probe.waitForEncodes(1)
            const second = exporter.createBlob(b, 48, new AbortController().signal)
            await probe.waitForEncodes(2)
            const during = probe.snapshot()
            probe.release(1)
            const actualB = await probe.pixels(await second)
            const afterSecond = probe.snapshot()
            probe.release()
            const actualA = await probe.pixels(await first)
            probe.resume()
            const afterBoth = probe.snapshot()
            exporter.dispose()
            return {
                before,
                during,
                afterSecond,
                afterBoth,
                disposed: probe.snapshot(),
                mismatchesA: actualA.bytes.reduce(
                    (count, value, index) => count + +(value !== referenceA.bytes[index]),
                    0,
                ),
                mismatchesB: actualB.bytes.reduce(
                    (count, value, index) => count + +(value !== referenceB.bytes[index]),
                    0,
                ),
                sizes: [
                    [actualA.width, actualA.height],
                    [actualB.width, actualB.height],
                ],
            }
        })
        expect(result.mismatchesA).toBe(0)
        expect(result.mismatchesB).toBe(0)
        expect(result.sizes).toEqual([
            [32, 32],
            [48, 48],
        ])
        expect(result.during.contexts - result.before.contexts).toBe(2)
        expect(result.during.liveContexts).toBe(2)
        expect(result.during.dimensions).toEqual([
            [32, 32, 32, 32],
            [48, 48, 48, 48],
        ])
        expect(result.afterSecond.liveContexts).toBe(2)
        expect(result.afterBoth.liveContexts).toBe(1)
        expect(result.afterBoth.liveTextures).toBe(0)
        expect(result.afterBoth.dimensions).toEqual([[1, 1, 1, 1]])
        expect(result.disposed.liveContexts).toBe(0)
        expect(result.disposed.liveTextures).toBe(0)
        expect(result.disposed.livePrograms).toBe(0)
    })

    test('pre-abort allocates nothing and cancellation or encode failure permits a clean retry', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const { CoverExporter } = await import('/src/rendering/coverExport.ts')
            const probe = window.coverReuseProbe
            const image = await probe.image(7, 64, 64)
            const exporter = new CoverExporter()
            const errorName = (error: unknown) =>
                error instanceof DOMException || error instanceof Error ? error.name : String(error)
            const already = new AbortController()
            already.abort()
            const preAbort = await exporter
                .createBlob(image, 32, already.signal)
                .then(() => 'resolved', errorName)
            const afterPreAbort = probe.snapshot()
            probe.hold('callback')
            const controller = new AbortController()
            const cancelled = exporter
                .createBlob(image, 32, controller.signal)
                .then(() => 'resolved', errorName)
            await probe.waitForEncodes(1)
            controller.abort()
            const afterCancel = probe.snapshot()
            const earlyRetry = exporter.createBlob(image, 64, new AbortController().signal)
            await probe.waitForEncodes(2)
            probe.release(1)
            await earlyRetry
            const beforeLateCancel = probe.snapshot()
            probe.release()
            const cancellation = await cancelled
            const afterLateCancel = probe.snapshot()
            probe.resume()
            probe.failEncode()
            const failure = await exporter
                .createBlob(image, 48, new AbortController().signal)
                .then(() => 'resolved', errorName)
            const afterError = probe.snapshot()
            const output = await probe.pixels(
                await exporter.createBlob(image, 64, new AbortController().signal),
            )
            const afterRetry = probe.snapshot()
            exporter.dispose()
            return {
                preAbort,
                afterPreAbort,
                cancellation,
                afterCancel,
                beforeLateCancel,
                afterLateCancel,
                failure,
                afterError,
                afterRetry,
                dimensions: [output.width, output.height],
                disposed: probe.snapshot(),
            }
        })
        expect(result.preAbort).toBe('AbortError')
        expect(result.afterPreAbort.contextRequests).toBe(0)
        expect(result.afterPreAbort.programCreates).toBe(0)
        expect(result.cancellation).toBe('AbortError')
        expect(result.beforeLateCancel.liveContexts).toBe(1)
        expect(result.afterLateCancel.liveContexts).toBe(1)
        expect(result.afterLateCancel.programDeletes).toBe(result.beforeLateCancel.programDeletes)
        expect(result.afterLateCancel.dimensions).toEqual([[1, 1, 1, 1]])
        expect(result.failure).not.toBe('resolved')
        for (const disposed of [result.afterCancel, result.afterError, result.disposed]) {
            expect(disposed.liveContexts).toBe(0)
            expect(disposed.liveTextures).toBe(0)
            expect(disposed.livePrograms).toBe(0)
        }
        expect(result.dimensions).toEqual([64, 64])
        expect(result.afterRetry.liveContexts).toBe(1)
        expect(result.afterRetry.liveTextures).toBe(0)
        expect(result.afterRetry.dimensions).toEqual([[1, 1, 1, 1]])
    })

    test('an idle context loss disposes resources and the next export creates a working sampler', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const { CoverExporter } = await import('/src/rendering/coverExport.ts')
            const probe = window.coverReuseProbe
            const exporter = new CoverExporter()
            const image = await probe.image(8, 64, 64)
            const first = await probe.pixels(
                await exporter.createBlob(image, 32, new AbortController().signal),
            )
            const beforeLoss = probe.snapshot()
            await probe.loseIdle()
            const afterLoss = probe.snapshot()
            const second = await probe.pixels(
                await exporter.createBlob(image, 32, new AbortController().signal),
            )
            const afterRetry = probe.snapshot()
            exporter.dispose()
            return {
                beforeLoss,
                afterLoss,
                afterRetry,
                disposed: probe.snapshot(),
                mismatches: first.bytes.reduce(
                    (count, value, index) => count + +(value !== second.bytes[index]),
                    0,
                ),
            }
        })
        expect(result.afterLoss.liveContexts).toBe(0)
        expect(result.afterLoss.liveTextures).toBe(0)
        expect(result.afterLoss.livePrograms).toBe(0)
        expect(result.afterRetry.contexts - result.beforeLoss.contexts).toBe(1)
        expect(result.afterRetry.liveContexts).toBe(1)
        expect(result.afterRetry.dimensions).toEqual([[1, 1, 1, 1]])
        expect(result.mismatches).toBe(0)
        expect(result.disposed.livePrograms).toBe(0)
    })

    test('teardown rejects every active export, releases active and idle samplers, and leaves new owners usable', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const { CoverExporter } = await import('/src/rendering/coverExport.ts')
            const probe = window.coverReuseProbe
            const image = await probe.image(9, 64, 64)
            const exporter = new CoverExporter()
            await exporter.createBlob(image, 32, new AbortController().signal)
            probe.hold('callback')
            const errorName = (error: unknown) =>
                error instanceof DOMException || error instanceof Error ? error.name : String(error)
            const first = exporter
                .createBlob(image, 48, new AbortController().signal)
                .then(() => 'resolved', errorName)
            await probe.waitForEncodes(1)
            const second = exporter
                .createBlob(image, 64, new AbortController().signal)
                .then(() => 'resolved', errorName)
            await probe.waitForEncodes(2)
            const completed = exporter.createBlob(image, 24, new AbortController().signal)
            await probe.waitForEncodes(3)
            probe.release(2)
            await completed
            const beforeDispose = probe.snapshot()
            exporter.dispose()
            exporter.dispose()
            const afterDispose = probe.snapshot()
            const closed = await exporter
                .createBlob(image, 32, new AbortController().signal)
                .then(() => 'resolved', errorName)
            const afterClosed = probe.snapshot()
            probe.resume()
            const failures = await Promise.all([first, second])
            const replacement = new CoverExporter()
            const blob = await replacement.createBlob(image, 32, new AbortController().signal)
            const pixels = await probe.pixels(blob)
            replacement.dispose()
            return {
                failures,
                closed,
                beforeDispose,
                afterDispose,
                afterClosed,
                replacementSize: [pixels.width, pixels.height],
                final: probe.snapshot(),
            }
        })
        expect(result.beforeDispose.liveContexts).toBe(3)
        expect(
            result.beforeDispose.dimensions.filter(
                ([width, height]) => width === 1 && height === 1,
            ),
        ).toHaveLength(1)
        expect(result.failures).toEqual(['AbortError', 'AbortError'])
        expect(result.closed).toBe('AbortError')
        expect(result.afterClosed.contexts).toBe(result.afterDispose.contexts)
        expect(result.replacementSize).toEqual([32, 32])
        for (const disposed of [result.afterDispose, result.final]) {
            expect(disposed.liveContexts).toBe(0)
            expect(disposed.liveTextures).toBe(0)
            expect(disposed.livePrograms).toBe(0)
            expect(disposed.programDeletes).toBe(disposed.programCreates)
        }
    })
})

test('cover modal reuses its sampler across exports and releases it on close and reopen', async ({
    page,
}) => {
    test.skip(
        await page.evaluate(() => typeof AudioContext === 'undefined'),
        'The full editor requires Web Audio, absent in Windows Playwright WebKit; direct cover tests still run.',
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(installCoverProbe, false)

    const open = async () => {
        await page.evaluate(async () => {
            const { appImport } = window.editorTest
            const { showModal } =
                await appImport<typeof import('../../src/modals')>('/src/modals/index.ts')
            const { default: component } = await appImport<
                typeof import('../../src/editor/utilities/coverEditor/CoverEditorModal.vue')
            >('/src/editor/utilities/coverEditor/CoverEditorModal.vue')
            void showModal(component, {})
        })
        await expect(page.getByRole('dialog')).toHaveCount(1)
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('dialog').locator('input[type="button"]').click()
        await (
            await chooser
        ).setFiles({
            name: 'cover.svg',
            mimeType: 'image/svg+xml',
            buffer: Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>',
            ),
        })
        await expect(page.getByRole('dialog').first().locator('input[type="button"]')).toHaveValue(
            '64×64',
        )
        await expect(page.getByRole('dialog')).toHaveCount(1)
        await page.getByRole('spinbutton', { name: 'Size' }).fill('32')
        await page.keyboard.press('Tab')
    }
    const generate = async () => {
        const download = page.waitForEvent('download')
        await page.getByRole('button', { name: 'Generate', exact: true }).click()
        expect((await download).suggestedFilename()).toBe('cover.png')
        await expect(page.getByRole('dialog')).toHaveCount(1)
        return page.evaluate(() => window.coverReuseProbe.snapshot())
    }
    const close = async () => {
        await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        const disposed = await page.evaluate(() => window.coverReuseProbe.snapshot())
        expect(disposed.liveContexts).toBe(0)
        expect(disposed.liveTextures).toBe(0)
        expect(disposed.livePrograms).toBe(0)
    }
    await open()
    const first = await generate()
    const second = await generate()
    expect(first.contexts).toBe(1)
    expect(second.contexts).toBe(first.contexts)
    expect(second.programCreates).toBe(first.programCreates)
    expect(second.liveTextures).toBe(0)
    expect(second.dimensions).toEqual([[1, 1, 1, 1]])
    await close()
    await open()
    const reopened = await generate()
    expect(reopened.contexts).toBe(2)
    expect(reopened.liveContexts).toBe(1)
    expect(reopened.liveTextures).toBe(0)
    expect(reopened.dimensions).toEqual([[1, 1, 1, 1]])
    await close()
})
