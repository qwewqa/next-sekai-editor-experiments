import { expect, test, type Page } from '@playwright/test'
import { inlineScripts, webPolicy } from '../../scripts/csp.mjs'
import { testTitlePrefix } from '../../scripts/site.mjs'
import { analyticsOf } from './analytics'

// The landing pages in the release build: /privacy/ and /terms/ until the native apps ship.

const hosted = Boolean(process.env.PRODUCTION_TEST_URL)

const load = async (page: Page, path: string) => {
    const errors: string[] = []
    const origins = new Set<string>()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
    })
    page.on('request', (request) => origins.add(new URL(request.url()).origin))
    await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) =>
            console.error(`Blocked by the policy: ${event.blockedURI}`),
        )
    })
    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
    await page.waitForLoadState('networkidle')
    return { errors, origins }
}

const PAGES = [
    { path: '/privacy/', title: 'Privacy Notice', other: '/terms/', otherName: 'Terms of Service' },
    { path: '/terms/', title: 'Terms of Service', other: '/privacy/', otherName: 'Privacy Notice' },
] as const

for (const { path, title, other, otherName } of PAGES) {
    test(`${path} loads with one h1, no errors and no request to another origin`, async ({
        page,
        baseURL,
    }) => {
        const { errors, origins } = await load(page, path)
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
        await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible()
        expect(errors).toEqual([])
        expect([...origins]).toEqual([new URL(baseURL ?? '').origin])
        // The build filled every placeholder, and the page shows the product name.
        const html = await page.content()
        expect(html).not.toMatch(/%[A-Z_]+%/)
        // A test-site build prefixes every title (scripts/site.mjs); its manifest says which site it is.
        const { site } = (await (await page.request.get('/release-manifest.json')).json()) as {
            site: string
        }
        await expect(page).toHaveTitle(
            `${site === 'test' ? testTitlePrefix : ''}${title} – Next SEKAI Editor`,
        )
        await expect(page.locator('header')).toContainText('Next SEKAI Editor')
    })

    test(`${path} carries the web policy hashing its one inline script`, async ({ page }) => {
        await load(page, path)
        const { meta, scripts, first } = await page.evaluate(() => ({
            meta: document
                .querySelector('meta[http-equiv="Content-Security-Policy"]')
                ?.getAttribute('content'),
            scripts: [...document.scripts]
                .filter((script) => !script.src)
                .map((s) => s.textContent),
            first: document.head.firstElementChild?.getAttribute('http-equiv'),
        }))
        expect(first).toBe('Content-Security-Policy')
        expect(scripts).toHaveLength(1)
        const analytics = await analyticsOf(page)
        expect(meta).toBe(
            webPolicy(inlineScripts(`<script>${scripts[0]}</script>`), analytics?.origin),
        )
    })

    test(`${path} uses the app icon, not the editor's favicon`, async ({ page }) => {
        await load(page, path)
        const icon = await page.locator('link[rel="icon"]').getAttribute('href')
        expect(icon).toMatch(/^(?:\/assets\/app-icon-32-[\w-]+\.png|data:image\/png;base64,)/)
        const header = page.locator('header img')
        await expect(header).toBeVisible()
        expect(await header.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(32)
        expect(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toMatch(
            /^\/assets\/app-icon-180-[\w-]+\.png$/,
        )
    })

    test(`${path} links reach the site's files, the other page and the contact address`, async ({
        page,
    }) => {
        await load(page, path)
        await expect(page.locator('a[href="mailto:nse@qwewqa.dev"]').first()).toBeVisible()
        for (const href of ['/', '/LICENSE.txt', '/THIRD_PARTY_NOTICES.txt', other])
            expect((await page.request.get(href)).ok(), href).toBe(true)
        await page.locator('footer').getByRole('link', { name: otherName }).click()
        await expect(page).toHaveURL(new RegExp(`${other}$`))
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(otherName)
    })

    for (const [name, setting, system] of [
        ['the stored light', 'light', 'dark'],
        ['the stored dark', 'dark', 'light'],
        ["the system's dark", undefined, 'dark'],
        ["the system's light", undefined, 'light'],
    ] as const) {
        test(`${path} follows ${name} theme before any style loads`, async ({ page }) => {
            await page.emulateMedia({ colorScheme: system })
            if (setting)
                await page.addInitScript(
                    (theme) =>
                        localStorage.setItem(
                            'sonolus-next-sekai-editor.theme',
                            JSON.stringify(theme),
                        ),
                    setting,
                )
            await load(page, path)
            const expected = setting ?? system
            expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(expected)
            // The surface takes the theme's colour: modal is 46 48 72 in dark, 233 235 239 in light.
            const surface = await page
                .locator('main')
                .evaluate(
                    (main) => getComputedStyle(main.parentElement as HTMLElement).backgroundColor,
                )
            expect(surface).toBe(expected === 'dark' ? 'rgb(46, 48, 72)' : 'rgb(233, 235, 239)')
        })
    }

    test(`${path} fits a 360 px phone without scrolling sideways`, async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 780 })
        await load(page, path)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360)
    })

    test(`${path.slice(0, -1)} redirects to ${path}`, async ({ page }) => {
        test.skip(!hosted, "The redirect is Pages' behaviour")
        await page.goto(path.slice(0, -1))
        expect(new URL(page.url()).pathname).toBe(path)
    })
}
