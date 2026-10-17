import { expect, test } from '@playwright/test'
import { openAssets, useBuiltinServerSkin } from './serverFlow'

// The post-deploy smoke test of our own static server (Part 2, 2.5.7, 2.11): the live site's
// /builtin-server/ is connected to, its skin is listed and used, and the choice survives a
// reload. It runs against the deployed site and is skipped otherwise:
//   PRODUCTION_TEST_URL=https://nse.qwewqa.dev npm run test:production -- builtinServer
const hosted = process.env.PRODUCTION_TEST_URL

test.describe('the live /builtin-server/', () => {
    test.skip(!hosted, 'Set PRODUCTION_TEST_URL to run it against the deployed site')

    test('sends CORS headers, and serves what its list names', async ({ request }) => {
        const info = await request.get('/builtin-server/sonolus/info')
        expect(info.ok()).toBe(true)
        // Pages sends this; without it no web page could use the server.
        expect(info.headers()['access-control-allow-origin']).toBe('*')
        const list = (await (await request.get('/builtin-server/sonolus/skins/list')).json()) as {
            items: { name: string; texture: { url: string } }[]
        }
        expect(list.items.map((item) => item.name)).toEqual(['nse-builtin'])
        const texture = await request.get(`/builtin-server${list.items[0]!.texture.url}`)
        expect(texture.ok()).toBe(true)
        expect(texture.headers()['access-control-allow-origin']).toBe('*')
    })

    test('connects, lists the skin, uses it, and has it chosen after a reload', async ({
        page,
        baseURL,
    }) => {
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.addInitScript(() => {
            const seen: string[] = []
            ;(window as unknown as { seen: string[] }).seen = seen
            document.addEventListener('securitypolicyviolation', (event) =>
                seen.push(`${event.effectiveDirective} ${event.blockedURI}`),
            )
        })
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await openAssets(page)
        await useBuiltinServerSkin(page, new URL('/builtin-server/', baseURL).href)
        const violations = await page.evaluate(() => (window as unknown as { seen: string[] }).seen)
        await page.keyboard.press('Escape')

        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await openAssets(page)
        const dialog = page.locator('dialog[open]')
        await dialog.getByRole('tab', { name: 'Skin' }).click()
        await expect(dialog.locator('[data-asset-row^="server:"] input')).toBeChecked()
        await expect(dialog.locator('[data-asset-note]')).toHaveCount(0)

        expect(violations).toEqual([])
        expect(errors).toEqual([])
    })
})
