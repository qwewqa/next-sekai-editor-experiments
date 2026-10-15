import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test(`editor restore releases retained geometry after native reset (WebGL2)`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await page.locator('canvas.editor-chart').waitFor({ state: 'visible' })
    await page.evaluate(installEditorFixture)
    const result = await page.evaluate(async () => {
        const { show, fixtures, view, settings, history, nextTick } = window.editorTest
        const { peekDrawContext } = await window.editorRenderingReady
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!
        const ctx = peekDrawContext(canvas)!
        await ctx.ready
        const settle = async () => {
            await nextTick()
            await new Promise<void>((done) =>
                requestAnimationFrame(() => requestAnimationFrame(() => done())),
            )
        }
        show(fixtures.connectors, 1)
        settings.showGroupName = false
        settings.showStageName = false
        view.lastActive = Infinity
        await settle()

        const retained = ctx as unknown as { retained: Map<object, unknown> }
        const beforeGroups = retained.retained.size
        const model = history.state.value
        const serializedView = JSON.stringify(view)
        const owner = ctx.resourceOwner
        const gl = canvas.getContext('webgl2')!
        const nativeGetError = gl.getError.bind(gl)
        const nativeErrors: { method: string; phase: string; error: number }[] = []
        const traced = gl as unknown as Record<string, unknown>
        for (const name of ['deleteBuffer', 'deleteVertexArray']) {
            const method = traced[name]
            if (typeof method !== 'function') continue
            const original = method.bind(gl) as (...args: unknown[]) => unknown
            traced[name] = (...args: unknown[]) => {
                const before = gl.isContextLost() ? 0 : nativeGetError()
                if (before && before !== gl.CONTEXT_LOST_WEBGL)
                    nativeErrors.push({ method: name, phase: 'before', error: before })
                const result = original(...args)
                const after = gl.isContextLost() ? 0 : nativeGetError()
                if (after && after !== gl.CONTEXT_LOST_WEBGL)
                    nativeErrors.push({ method: name, phase: 'after', error: after })
                return result
            }
        }
        let rawRestoreWindow = false
        let prematureReleases = 0
        const release = ctx.releaseVectors.bind(ctx)
        ctx.releaseVectors = (range) => {
            if (rawRestoreWindow) prematureReleases++
            release(range)
        }
        // This capture listener precedes Vue and Pixi's ordinary listeners.
        // Cleanup must occur in renderingready's later task, never while the
        // browser is still dispatching the native context-restored event.
        canvas.addEventListener(
            'webglcontextrestored',
            () => {
                rawRestoreWindow = true
                setTimeout(() => (rawRestoreWindow = false), 0)
            },
            { capture: true, once: true },
        )
        const extension = gl.getExtension('WEBGL_lose_context')!
        await new Promise<void>((resolve) => {
            canvas.addEventListener('webglcontextlost', () => setTimeout(resolve, 0), {
                once: true,
            })
            extension.loseContext()
        })
        await new Promise<void>((resolve) => {
            canvas.addEventListener('renderingready', () => setTimeout(resolve, 0), {
                once: true,
            })
            extension.restoreContext()
        })
        await settle()
        const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        return {
            beforeGroups,
            afterGroups: retained.retained.size,
            modelUnchanged: history.state.value === model,
            viewUnchanged: JSON.stringify(view) === serializedView,
            ownerChanged: ctx.resourceOwner !== owner,
            prematureReleases,
            nativeErrors,
            glError: nativeGetError(),
            hasPixels: bytes.some((alpha, index) => index % 4 === 3 && alpha > 0),
        }
    })
    expect(result.beforeGroups).toBeGreaterThan(0)
    expect(result.afterGroups).toBe(result.beforeGroups)
    expect(result.modelUnchanged).toBe(true)
    expect(result.viewUnchanged).toBe(true)
    expect(result.ownerChanged).toBe(true)
    expect(result.prematureReleases).toBe(0)
    expect(result.nativeErrors).toEqual([])
    expect(result.glError).toBe(0)
    expect(result.hasPixels).toBe(true)
    expect(errors).toEqual([])
})
