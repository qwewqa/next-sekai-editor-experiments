import { test } from '@playwright/test'

/**
 * The editor's support gate (public/gate.js) refuses to start without OffscreenCanvas, and
 * Playwright's WebKit on Windows lacks it. Call this at the top of a spec that boots the editor:
 * in a WebKit build without it the file's tests skip with the reason, and everywhere else
 * (Linux, macOS, other engines) they run. The page is asked, so no platform is named.
 */
export const skipWhereTheEditorCannotStart = () => {
    test.beforeAll(async ({ browser, browserName }) => {
        if (browserName !== 'webkit') return
        const context = await browser.newContext()
        try {
            const page = await context.newPage()
            const present = await page.evaluate(() => typeof OffscreenCanvas !== 'undefined')
            test.skip(
                !present,
                "This WebKit build lacks OffscreenCanvas, so the editor's support gate refuses to start",
            )
        } finally {
            await context.close()
        }
    })
}
