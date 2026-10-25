import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

declare global {
    interface Window {
        webglLifecycle: {
            restore?: () => void
            /** Draws of the selection outline, each of which clears first. */
            overlayDraws: number
            outlines: WeakMap<HTMLCanvasElement, WebGL2RenderingContext>

            captured?: { data: Uint8ClampedArray; width: number; height: number }
            comparison?: {
                changedPixels: number
                maxChannel: number
                maxPremultiplied: number
                flatChanged: number
                changedSupport: number
            }
        }
    }
}

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        const { peekDrawContext } = await window.editorRenderingReady
        await Promise.all(
            [...document.querySelectorAll('canvas')].map(async (canvas) => {
                const ctx = peekDrawContext(canvas)
                if (ctx && 'ready' in ctx) await ctx.ready
            }),
        )
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

const pixels = (page: Page, selector: string, capture = false) =>
    page.evaluate(
        async ({ selector, capture }) => {
            const canvas = document.querySelector<HTMLCanvasElement>(selector)
            if (!canvas) return { alpha: 0, digest: '', image: '' }
            const { peekDrawContext } = await window.editorRenderingReady
            const ctx = peekDrawContext(canvas)
            const outline = window.webglLifecycle.outlines.get(canvas)
            let pixels: ImageData
            if (ctx) {
                if ('ready' in ctx) await ctx.ready
                pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
            } else if (outline) {
                // The outline's own context, premultiplied, rows from the top.
                const { width, height } = canvas
                const raw = new Uint8Array(width * height * 4)
                outline.readPixels(0, 0, width, height, outline.RGBA, outline.UNSIGNED_BYTE, raw)
                pixels = new ImageData(width, height)
                for (let y = 0; y < height; y++)
                    pixels.data.set(
                        raw.subarray((height - 1 - y) * width * 4, (height - y) * width * 4),
                        y * width * 4,
                    )
            } else return { alpha: 0, digest: '', image: '' }
            const data = pixels.data
            const digest = await crypto.subtle.digest('SHA-256', data)
            let image = ''
            if (capture) {
                const previous = window.webglLifecycle.captured
                if (previous) {
                    if (previous.width !== canvas.width || previous.height !== canvas.height)
                        throw new Error('Restoration changed the canvas dimensions')
                    let changedPixels = 0,
                        maxChannel = 0,
                        maxPremultiplied = 0,
                        flatChanged = 0,
                        changedSupport = 0
                    for (let i = 0; i < data.length; i += 4) {
                        if (data.subarray(i, i + 4).every((v, c) => v === previous.data[i + c]))
                            continue
                        changedPixels++
                        if (data[i + 3]! > 0 !== previous.data[i + 3]! > 0) changedSupport++
                        for (let c = 0; c < 4; c++) {
                            maxChannel = Math.max(
                                maxChannel,
                                Math.abs(data[i + c]! - previous.data[i + c]!),
                            )
                            if (c < 3)
                                maxPremultiplied = Math.max(
                                    maxPremultiplied,
                                    Math.abs(
                                        data[i + c]! * data[i + 3]! -
                                            previous.data[i + c]! * previous.data[i + 3]!,
                                    ) / 255,
                                )
                        }
                        const x = (i / 4) % canvas.width,
                            y = Math.floor(i / 4 / canvas.width)
                        if (x > 0 && x < canvas.width - 1 && y > 0 && y < canvas.height - 1) {
                            let flat = true
                            for (let dy = -1; dy <= 1; dy++)
                                for (let dx = -1; dx <= 1; dx++)
                                    for (let c = 0; c < 4; c++) {
                                        const j = i + 4 * (dy * canvas.width + dx) + c
                                        if (
                                            data[j] !== data[i + c] ||
                                            previous.data[j] !== previous.data[i + c]
                                        )
                                            flat = false
                                    }
                            if (flat) flatChanged++
                        }
                    }
                    window.webglLifecycle.comparison = {
                        changedPixels,
                        maxChannel,
                        maxPremultiplied,
                        flatChanged,
                        changedSupport,
                    }
                }
                window.webglLifecycle.captured = {
                    data: data.slice(),
                    width: canvas.width,
                    height: canvas.height,
                }
                // PNG attachments aid visual review; assertions compare raw readbacks
                // because a putImageData/PNG roundtrip can round translucent colors.
                const reference = document.createElement('canvas')
                reference.width = canvas.width
                reference.height = canvas.height
                reference.getContext('2d')!.putImageData(pixels, 0, 0)
                image = reference.toDataURL().split(',')[1]!
            }
            return {
                alpha: data.filter((value, i) => i % 4 === 3 && value > 0).length,
                digest: [...new Uint8Array(digest)]
                    .map((v) => v.toString(16).padStart(2, '0'))
                    .join(''),
                image,
            }
        },
        { selector, capture },
    )

const loseContext = async (page: Page, selector: string) => {
    expect(
        await page.evaluate(async (selector) => {
            const canvas = document.querySelector<HTMLCanvasElement>(selector)!
            const gl = canvas.getContext('webgl2')
            if (!gl) throw new Error('Expected an existing WebGL context')
            const extension = gl.getExtension('WEBGL_lose_context')
            if (!extension) throw new Error('The browser cannot simulate WebGL context loss')
            const lost = new Promise<boolean>((resolve) => {
                canvas.addEventListener(
                    'webglcontextlost',
                    (event) => queueMicrotask(() => resolve(event.defaultPrevented)),
                    { once: true },
                )
            })
            window.webglLifecycle.restore = () => extension.restoreContext()
            extension.loseContext()
            return lost
        }, selector),
        'context loss opts in to restoration',
    ).toBe(true)
}

const restoreContext = async (page: Page, selector: string) => {
    await page.evaluate(async (selector) => {
        const canvas = document.querySelector<HTMLCanvasElement>(selector)!
        const restored = new Promise<void>((resolve) =>
            canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true }),
        )
        window.webglLifecycle.restore!()
        await restored
    }, selector)
    await settle(page)
}

const errors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        window.webglLifecycle = { overlayDraws: 0, outlines: new WeakMap() }
        const getContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            ...args: [string, ...unknown[]]
        ) {
            const context = Reflect.apply(getContext, this, args) as RenderingContext | null
            if (context instanceof WebGL2RenderingContext && this.matches('.preview-selection'))
                window.webglLifecycle.outlines.set(this, context)
            return context
        } as typeof getContext
        const clear = WebGL2RenderingContext.prototype.clear
        WebGL2RenderingContext.prototype.clear = function (...args) {
            if (
                this.canvas instanceof HTMLCanvasElement &&
                this.canvas.matches('.preview-selection')
            )
                window.webglLifecycle.overlayDraws++
            return clear.apply(this, args)
        }
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show, view } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [
                        { ...base, beat: 6, left: -3, elevation: 0 },
                        { ...base, beat: 6, left: 1, elevation: 3 },
                    ],
                ],
            },
            3,
        )
        view.cursorTime = 3
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
    })
    await settle(page)
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page), 'uncaught browser errors').toEqual([])
})

test('elevation restores its GPU scene and releases the context when its pane closes', async ({
    page,
}, testInfo) => {
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await page.evaluate(() => {
        const { history, view } = window.editorTest
        // Hovered arrows composite through a child GPU surface at reduced opacity.
        view.entities = {
            hovered: [...history.state.value.store.slides.note.values()].flat(),
            creating: [],
        }
        window.editorTest.settings.elevationConnectorArrows = true
    })
    await settle(page)
    const { image: beforeImage, ...before } = await pixels(page, '.elevation-canvas', true)
    expect(before.alpha).toBeGreaterThan(0)
    await testInfo.attach('elevation-before-context-loss', {
        body: Buffer.from(beforeImage, 'base64'),
        contentType: 'image/png',
    })
    await loseContext(page, '.elevation-canvas')
    // Invalidations while lost must not touch deleted GPU resources.
    await page.evaluate(() => {
        window.editorTest.settings.elevationConnectorArrows = false
    })
    await settle(page)
    await page.evaluate(() => {
        window.editorTest.settings.elevationConnectorArrows = true
    })
    await restoreContext(page, '.elevation-canvas')
    const { image: afterImage, ...after } = await pixels(page, '.elevation-canvas', true)
    await testInfo.attach('elevation-after-context-restore', {
        body: Buffer.from(afterImage, 'base64'),
        contentType: 'image/png',
    })
    expect(after.alpha).toBe(before.alpha)
    const comparison = await page.evaluate(() => window.webglLifecycle.comparison!)
    // Recreating this fixture's targets can round eight sparse pixels by one
    // byte on hardware GL. Keep support and interiors exact and
    // bound raw/displayed differences; a digest alone rejects invisible rounding.
    expect(comparison.changedPixels).toBeLessThanOrEqual(16)
    expect(comparison.maxChannel).toBeLessThanOrEqual(1)
    expect(comparison.maxPremultiplied).toBeLessThanOrEqual(1.5)
    expect(comparison.flatChanged).toBe(0)
    expect(comparison.changedSupport).toBe(0)
    const released = await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
        const { peekDrawContext } = await window.editorRenderingReady
        const { closeElevationEditor } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        closeElevationEditor()
        await window.editorTest.nextTick()
        return peekDrawContext(canvas) === undefined
    })
    expect(released).toBe(true)
})

test('preview allocates no selection renderer for empty frames and clears only when needed', async ({
    page,
}) => {
    await page.evaluate(() => {
        window.editorTest.settings.showPreview = true
    })
    await expect(
        page.locator('.preview-controls').getByText('Note Speed', { exact: true }),
    ).toBeVisible()
    await settle(page)
    await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) {
            window.editorTest.view.cursorTime = 3 + i / 100
            await window.editorTest.nextTick()
            await new Promise(requestAnimationFrame)
        }
    })
    expect(
        await page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('.preview-selection')!
            return {
                allocated: window.webglLifecycle.outlines.has(canvas),
                draws: window.webglLifecycle.overlayDraws,
            }
        }),
    ).toEqual({ allocated: false, draws: 0 })
    await page.evaluate(() => {
        const { history, view } = window.editorTest
        view.cursorTime = 3
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
        })
    })
    await expect
        .poll(async () => (await pixels(page, '.preview-selection')).alpha)
        .toBeGreaterThan(0)
    const selectedDraws = await page.evaluate(() => window.webglLifecycle.overlayDraws)
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    await settle(page)
    expect(await page.evaluate(() => window.webglLifecycle.overlayDraws)).toBe(selectedDraws + 1)
    expect((await pixels(page, '.preview-selection')).alpha).toBe(0)
    const clearedDraws = await page.evaluate(() => window.webglLifecycle.overlayDraws)
    await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) {
            window.editorTest.view.cursorTime = 3 + i / 100
            await window.editorTest.nextTick()
            await new Promise(requestAnimationFrame)
        }
    })
    expect(await page.evaluate(() => window.webglLifecycle.overlayDraws)).toBe(clearedDraws)
    await page.setViewportSize({ width: 1450, height: 900 })
    await settle(page)
    expect((await pixels(page, '.preview-selection')).alpha).toBe(0)
    const resizedDraws = await page.evaluate(() => window.webglLifecycle.overlayDraws)
    await loseContext(page, '.preview-selection')
    await restoreContext(page, '.preview-selection')
    // A restored buffer is transparent, so an empty outline draws nothing.
    expect(await page.evaluate(() => window.webglLifecycle.overlayDraws)).toBe(resizedDraws)
    expect((await pixels(page, '.preview-selection')).alpha).toBe(0)
})

test('preview selection restores identically and respects deselection during context loss', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { settings, history } = window.editorTest
        settings.showPreview = true
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
        })
    })
    await expect
        .poll(async () => (await pixels(page, '.preview-selection')).alpha)
        .toBeGreaterThan(0)
    await settle(page)
    const before = await pixels(page, '.preview-selection')
    await loseContext(page, '.preview-selection')
    await restoreContext(page, '.preview-selection')
    expect(await pixels(page, '.preview-selection')).toEqual(before)
    await loseContext(page, '.preview-selection')
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    await settle(page)
    await restoreContext(page, '.preview-selection')
    expect((await pixels(page, '.preview-selection')).alpha).toBe(0)
    expect(
        await page.evaluate(async () => {
            const canvas = document.querySelector<HTMLCanvasElement>('.preview-selection')!
            window.editorTest.settings.showPreview = false
            await window.editorTest.nextTick()
            return window.webglLifecycle.outlines.get(canvas)!.isContextLost()
        }),
    ).toBe(true)
})
