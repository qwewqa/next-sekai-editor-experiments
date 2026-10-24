import { expect, test } from '@playwright/test'
import type { RenderingResources } from '../../src/rendering/resources'

test(`explicit rendering owns maintenance and leaves idle input alone (WebGL2)`, async ({
    page,
}) => {
    await page.route('**/__webgl-scheduler-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    )
    await page.goto('/__webgl-scheduler-test')
    const result = await page.evaluate(async () => {
        let requests = 0
        let callbacks = 0
        const inputListeners: string[] = []
        const originalRaf = window.requestAnimationFrame
        const originalAdd = EventTarget.prototype.addEventListener
        const originalNow = performance.now
        window.requestAnimationFrame = (callback) => {
            requests++
            return originalRaf.call(window, (now) => {
                callbacks++
                callback(now)
            })
        }
        EventTarget.prototype.addEventListener = function (
            this: EventTarget,
            type,
            callback,
            options,
        ) {
            if (/^(pointer|mouse|touch|wheel|click)/.test(type)) inputListeners.push(type)
            return originalAdd.call(this, type, callback, options)
        }
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const contexts: ReturnType<typeof getDrawContext>[] = []
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        const make = async () => {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 64
            canvas.style.touchAction = 'pan-x'
            const ctx = getDrawContext(canvas)
            contexts.push(ctx)
            await ctx.ready
            const resources = (ctx as unknown as { resources: RenderingResources }).resources
            return { ctx, canvas, resources }
        }
        try {
            const { ctx, canvas, resources } = await make()
            const renderer = resources.renderer
            const draw = () => {
                ctx.fillStyle = '#ff0000'
                ctx.fillRect(0, 0, 64, 64)
                ctx.flush()
            }
            // Pixi 8.22 keeps destroyed native targets as null entries in this
            // registered GC collection. Inspect it to ensure replacing its
            // scheduler retains collection compaction, not only GPU deletion.
            const snapshot = () => {
                const targetSystem = renderer.renderTarget as unknown as {
                    _gpuRenderTargetHash: Record<string, unknown>
                }
                const values = Object.values(targetSystem._gpuRenderTargetHash)
                return {
                    live: values.filter(Boolean).length,
                    tombstones: values.filter((value) => value === null).length,
                }
            }
            draw()
            for (let i = 0; i < 40; i++) {
                const surface = ctx.createSurface(16, 16)
                try {
                    const child = surface.getContext()
                    child.fillStyle = '#00ff00'
                    child.fillRect(0, 0, 16, 16)
                    child.flush()
                } finally {
                    surface.dispose()
                }
            }
            const churn = snapshot()
            const beforeIdle = { requests, callbacks }
            await wait(150)
            const idle = {
                requests: requests - beforeIdle.requests,
                callbacks: callbacks - beforeIdle.callbacks,
            }
            const afterIdle = snapshot()
            // Advance the clock, not timers: maintenance must await a real
            // render, then run the existing 30s / 31s GC callbacks once.
            performance.now = () => originalNow.call(performance) + 32_000
            draw()
            const resumed = snapshot()
            const red = [...ctx.getImageData(20, 20, 1, 1).data]
            const second = await make()
            const gcEnabled = renderer.gc.enabled
            const gcFrequency = (renderer.gc as unknown as { _frequency: number })._frequency
            const eventSystem = !!renderer.events
            const touchAction = canvas.style.touchAction
            const firstGlError = resources.gl.getError()
            ctx.dispose()
            second.ctx.fillStyle = '#0000ff'
            second.ctx.fillRect(0, 0, 64, 64)
            const blue = [...second.ctx.getImageData(20, 20, 1, 1).data]
            const independent = !second.resources.gl.isContextLost()
            const secondGlError = second.resources.gl.getError()
            second.ctx.dispose()
            const beforeDisposedIdle = requests
            await wait(100)
            return {
                webgl2: resources.gl instanceof WebGL2RenderingContext,
                churn,
                afterIdle,
                resumed,
                idle,
                gcEnabled,
                gcFrequency,
                eventSystem,
                touchAction,
                inputListeners,
                red,
                blue,
                independent,
                firstGlError,
                secondGlError,
                disposedIdleRequests: requests - beforeDisposedIdle,
            }
        } finally {
            for (const ctx of contexts) ctx.dispose()
            window.requestAnimationFrame = originalRaf
            EventTarget.prototype.addEventListener = originalAdd
            performance.now = originalNow
        }
    })
    expect(result.webgl2).toBe(true)
    expect(result.churn.tombstones).toBeGreaterThanOrEqual(40)
    expect(result.afterIdle).toEqual(result.churn)
    expect(result.resumed).toEqual({ live: 1, tombstones: 0 })
    expect(result.idle).toEqual({ requests: 0, callbacks: 0 })
    expect(result.gcEnabled).toBe(true)
    // Short passes keep each unload batch small; the 30 s default stalls a frame.
    expect(result.gcFrequency).toBeLessThanOrEqual(5000)
    expect(result.eventSystem).toBe(false)
    expect(result.touchAction).toBe('pan-x')
    expect(result.inputListeners).toEqual([])
    expect(result.red).toEqual([255, 0, 0, 255])
    expect(result.blue).toEqual([0, 0, 255, 255])
    expect(result.independent).toBe(true)
    expect(result.firstGlError).toBe(0)
    expect(result.secondGlError).toBe(0)
    expect(result.disposedIdleRequests).toBe(0)
})
