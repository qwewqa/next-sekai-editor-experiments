import { expect, test } from '@playwright/test'
import { analyticsOf } from './analytics'
import { editorReady } from './fixtures'

// Usage statistics in the release build. An automated browser sends nothing, whatever the build's
// target, and a build without one has no client to load.

test('an automated visit loads no client and sends nothing, after input and a hide', async ({
    page,
    context,
    baseURL,
}) => {
    const analytics = await analyticsOf(page)
    const appOrigin = new URL(baseURL!).origin
    const sent: string[] = []
    await context.route(
        (url) => url.origin !== appOrigin,
        (route) => {
            sent.push(route.request().url())
            return route.abort()
        },
    )
    const scripts: string[] = []
    page.on('request', (request) => {
        if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname)
    })
    await page.goto('/')
    await editorReady(page)
    await page.keyboard.press('Shift')
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        delete (document as { visibilityState?: unknown }).visibilityState
    })
    // The idle callback that would load the client has run by the time the page answers this.
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestIdleCallback(() => resolve(), { timeout: 10_000 })
            }),
    )
    expect(scripts.filter((path) => /\/client-[\w-]+\.js$/.test(path))).toEqual([])
    expect(sent.filter((url) => analytics && url.startsWith(analytics.origin))).toEqual([])
})
