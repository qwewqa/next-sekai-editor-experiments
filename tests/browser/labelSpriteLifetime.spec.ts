import { expect, test } from '@playwright/test'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type { WebGLDrawContext } from '../../src/rendering/context'

const installLabelFixture = async () => {
    type GL = WebGLRenderingContext | WebGL2RenderingContext
    const uploads = new Map<WebGLTexture, { source: HTMLCanvasElement; deleted: boolean }>()
    const observed = new WeakSet<GL>()
    const targets = new WeakSet<HTMLCanvasElement>()
    const versions: number[] = []
    let creates = 0
    let deletes = 0
    const nativeGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        kind: string,
        ...args: unknown[]
    ) {
        const result = Reflect.apply(nativeGetContext, this, [
            kind,
            ...args,
        ]) as RenderingContext | null
        if (!result || !targets.has(this) || (kind !== 'webgl' && kind !== 'webgl2')) return result
        const gl = result as GL
        if (observed.has(gl)) return result
        observed.add(gl)
        versions.push(kind === 'webgl2' ? 2 : 1)
        const methods = gl as unknown as Record<string, (...args: unknown[]) => unknown>
        for (const name of ['createTexture', 'deleteTexture', 'texImage2D', 'texSubImage2D']) {
            const native = methods[name]!
            methods[name] = function (...parameters: unknown[]) {
                const value = Reflect.apply(native, gl, parameters)
                if (name === 'createTexture' && value) creates++
                if (name === 'deleteTexture' && parameters[0]) {
                    deletes++
                    const upload = uploads.get(parameters[0] as WebGLTexture)
                    if (upload) upload.deleted = true
                }
                if (name === 'texImage2D' || name === 'texSubImage2D') {
                    const source = parameters.find(
                        (parameter) => parameter instanceof HTMLCanvasElement,
                    )
                    if (source instanceof HTMLCanvasElement) {
                        const texture = gl.getParameter(
                            gl.TEXTURE_BINDING_2D,
                        ) as WebGLTexture | null
                        if (texture) uploads.set(texture, { source, deleted: false })
                    }
                }
                return value
            }
        }
        return result
    } as typeof nativeGetContext

    const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
    const { createLabelSprites } = await import('/src/editor/canvas/labelSprites.ts')
    const sprites = createLabelSprites()
    const canvases: HTMLCanvasElement[] = []
    const sources: HTMLCanvasElement[] = []
    const watched = new WeakSet<WebGLDrawContext>()
    let frame = 0
    let lastSource: HTMLCanvasElement | undefined
    const watchSource = (target: WebGLDrawContext) => {
        if (watched.has(target)) return
        watched.add(target)
        const drawNameSprite = target.drawNameSprite
        target.drawNameSprite = function (source, ...args) {
            if (source instanceof HTMLCanvasElement) {
                lastSource = source
                if (!sources.includes(source)) sources.push(source)
            }
            return Reflect.apply(drawNameSprite, this, [source, ...args])
        }
    }
    const create = async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = 120
        canvases.push(canvas)
        targets.add(canvas)
        const target = getDrawContext(canvas)
        await target.ready
        return target
    }
    const draw = (target: WebGLDrawContext, text = 'Stage A', large = false) => {
        watchSource(target)
        const scale = large ? 200 : 40
        const context = {
            ctx: target,
            scale,
            fontFamily: 'Arial',
            fontMiddle: 0.25,
        } as EditorDrawContext
        sprites.beginFrame(++frame)
        lastSource = undefined
        const drawn = sprites.draw(
            context,
            new DOMMatrix([scale, 0, 0, scale, 0, 0]),
            text,
            large ? 0.1 : 3,
            large ? 0.3 : 1,
            '#5a96cd',
        )
        if (!drawn || !lastSource) throw new Error('Expected the actual cached label-sprite path')
        return lastSource
    }
    const pixels = (target: WebGLDrawContext) => [...target.getImageData(0, 0, 320, 120).data]
    const stats = (source?: HTMLCanvasElement) => {
        const images = [...uploads.values()].filter((entry) => !source || entry.source === source)
        return {
            uploaded: images.length,
            live: images.filter(({ deleted }) => !deleted).length,
            deleted: images.filter(({ deleted }) => deleted).length,
            creates,
            deletes,
        }
    }
    const fixture = {
        create,
        draw,
        pixels,
        stats,
        sprites,
        sources,
        versions,
        dispose(target: WebGLDrawContext) {
            disposeDrawContext(target.canvas)
        },
        cleanup() {
            sprites.clear()
            for (const canvas of canvases) disposeDrawContext(canvas)
            uploads.clear()
            sources.length = 0
        },
    }
    window.labelLifetime = fixture
}

declare global {
    interface Window {
        labelLifetime: {
            create(): Promise<WebGLDrawContext>
            draw(target: WebGLDrawContext, text?: string, large?: boolean): HTMLCanvasElement
            pixels(target: WebGLDrawContext): number[]
            stats(source?: HTMLCanvasElement): {
                uploaded: number
                live: number
                deleted: number
                creates: number
                deletes: number
            }
            sprites: ReturnType<
                typeof import('../../src/editor/canvas/labelSprites').createLabelSprites
            >
            sources: HTMLCanvasElement[]
            versions: number[]
            dispose(target: WebGLDrawContext): void
            cleanup(): void
        }
    }
}

test.describe('label sprite lifetime in WebGL2', () => {
    test.beforeEach(async ({ page }) => {
        await page.route('**/__label-lifetime', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html lang="en"></html>',
            }),
        )
        await page.goto('/__label-lifetime')
        await page.evaluate(installLabelFixture)
    })

    test('clear releases an uploaded texture and a later label redraw preserves pixels', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const fixture = window.labelLifetime
            try {
                const target = await fixture.create()
                const source = fixture.draw(target)
                const beforePixels = fixture.pixels(target)
                const before = fixture.stats(source)
                fixture.sprites.clear()
                const after = fixture.stats(source)
                target.clear()
                const replacement = fixture.draw(target)
                const afterPixels = fixture.pixels(target)
                return {
                    before,
                    after,
                    shrunk: source.width === 0 && source.height === 0,
                    replaced: replacement !== source,
                    samePixels: beforePixels.every((value, index) => value === afterPixels[index]),
                    painted: beforePixels.some((value) => value !== 0),
                    versions: fixture.versions,
                }
            } finally {
                fixture.cleanup()
            }
        })
        expect(result.versions).toEqual([2])
        expect(result.before.uploaded).toBe(1)
        expect(result.before.live).toBe(1)
        expect(result.after.live).toBe(0)
        expect(result.after.deleted).toBe(1)
        expect(result.after.deletes - result.before.deletes).toBe(1)
        expect(result).toMatchObject({
            shrunk: true,
            replaced: true,
            samePixels: true,
            painted: true,
        })
    })

    test('clear flushes a pending sprite before releasing and shrinking its source', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const fixture = window.labelLifetime
            try {
                const target = await fixture.create()
                fixture.draw(target)
                const expected = fixture.pixels(target)
                fixture.sprites.clear()
                target.clear()
                const source = fixture.draw(target)
                const before = fixture.stats(source)
                // No explicit flush/readback may happen between this draw and clear.
                fixture.sprites.clear()
                const after = fixture.stats(source)
                const actual = fixture.pixels(target)
                return {
                    before,
                    after,
                    samePixels: actual.every((value, index) => value === expected[index]),
                    painted: actual.some((value) => value !== 0),
                    shrunk: source.width === 0 && source.height === 0,
                }
            } finally {
                fixture.cleanup()
            }
        })
        expect(result.before.uploaded).toBe(0)
        expect(result.after.uploaded).toBe(1)
        expect(result.after.deleted).toBe(1)
        expect(result.after.live).toBe(0)
        expect(result).toMatchObject({ samePixels: true, painted: true, shrunk: true })
    })

    test('real label-budget eviction releases the oldest texture and preserves current textures', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const fixture = window.labelLifetime
            try {
                const target = await fixture.create()
                const text = 'M'.repeat(42)
                const oldest = fixture.draw(target, `${text} 0`, true)
                target.flush()
                let newest = oldest
                let count = 1
                while (fixture.stats(oldest).live && count < 40) {
                    target.clear()
                    newest = fixture.draw(target, `${text} ${count++}`, true)
                    target.flush()
                }
                const evicted = fixture.stats(oldest)
                const current = fixture.stats(newest)
                const painted = fixture.pixels(target).some((value) => value !== 0)
                fixture.sprites.clear()
                return {
                    count,
                    evicted,
                    current,
                    painted,
                    shrunk: oldest.width === 0 && oldest.height === 0,
                    remaining: fixture.stats().live,
                }
            } finally {
                fixture.cleanup()
            }
        })
        expect(result.count).toBeGreaterThan(2)
        expect(result.count).toBeLessThan(40)
        expect(result.evicted).toMatchObject({ uploaded: 1, deleted: 1, live: 0 })
        expect(result.current).toMatchObject({ uploaded: 1, deleted: 0, live: 1 })
        expect(result).toMatchObject({ painted: true, shrunk: true, remaining: 0 })
    })

    test('shared surfaces and replacement contexts flush pending readers and release every owner', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const fixture = window.labelLifetime
            try {
                const first = await fixture.create()
                const surface = first.createSurface(320, 120)
                const shared = surface.getContext()
                const second = await fixture.create()
                // Compare the pending shared-surface draw with its own reference.
                fixture.draw(shared)
                const expectedShared = fixture.pixels(shared)
                fixture.sprites.clear()
                shared.clear()
                const source = fixture.draw(first)
                const sameSharedSource = fixture.draw(shared) === source
                // Third consumer evicts the oldest tracked context. Its shared
                // resource owner must flush both pending readers before deletion.
                const sameSecondSource = fixture.draw(second) === source
                const firstPixels = fixture.pixels(first)
                const sharedPixels = fixture.pixels(shared)
                second.flush()
                const beforeReplacement = fixture.stats(source)
                fixture.dispose(first)
                const replacement = await fixture.create()
                const sameReplacementSource = fixture.draw(replacement) === source
                replacement.flush()
                const beforeClear = fixture.stats(source)
                const unshrunk = source.width > 0 && source.height > 0
                fixture.sprites.clear()
                const afterClear = fixture.stats(source)
                const secondPixels = fixture.pixels(second)
                const replacementPixels = fixture.pixels(replacement)
                return {
                    sameSharedSource,
                    sameSecondSource,
                    sameReplacementSource,
                    beforeReplacement,
                    beforeClear,
                    afterClear,
                    unshrunk,
                    shrunk: source.width === 0 && source.height === 0,
                    painted: firstPixels.some((value) => value !== 0),
                    sharedMatches: expectedShared.every(
                        (value, index) => value === sharedPixels[index],
                    ),
                    secondMatches: firstPixels.every(
                        (value, index) => value === secondPixels[index],
                    ),
                    replacementMatches: firstPixels.every(
                        (value, index) => value === replacementPixels[index],
                    ),
                    versions: fixture.versions,
                }
            } finally {
                fixture.cleanup()
            }
        })
        expect(result.versions).toEqual(Array(3).fill(2))
        expect(result.beforeReplacement).toMatchObject({ uploaded: 2, deleted: 1, live: 1 })
        expect(result.beforeClear).toMatchObject({ uploaded: 3, deleted: 1, live: 2 })
        expect(result.afterClear).toMatchObject({ uploaded: 3, deleted: 3, live: 0 })
        expect(result).toMatchObject({
            sameSharedSource: true,
            sameSecondSource: true,
            sameReplacementSource: true,
            unshrunk: true,
            shrunk: true,
            painted: true,
            sharedMatches: true,
            secondMatches: true,
            replacementMatches: true,
        })
    })
})
