import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { editorReady } from './fixtures'

// The support gate on the release build: /gate.js is a staged file
// the page loads ahead of the bundle, and it works under the exact policy.

const prefix = 'sonolus-next-sekai-editor.'

const levelData = { bgmOffset: 0, entities: [{ archetype: 'Initialization', data: [] }] }
const gz = gzipSync(JSON.stringify(levelData))
const autoSave = JSON.stringify({
    version: 1,
    filename: 'coconut',
    levelData: gz.toString('base64'),
})

test('/gate.js is in the release, as the manifest and the page say', async ({ page }) => {
    const response = await page.request.get('/gate.js')
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toMatch(/javascript/)
    const body = await response.body()
    expect(body.equals(await readFile('public/gate.js'))).toBe(true)
    const manifest = (await (await page.request.get('/release-manifest.json')).json()) as {
        files: Record<string, string>
    }
    expect(manifest.files['gate.js']).toBe(createHash('sha256').update(body).digest('hex'))
    const html = await (await page.request.get('/')).text()
    const gate = html.indexOf('<script src="/gate.js"></script>')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(html.indexOf('type="module"'))
})

// Each way a browser can lack what the editor needs, as an older browser would.
const missing = {
    // Safari 16 has no navigator.locks.
    'navigator.locks': () =>
        Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined }),
    // Very old browsers have no CSS object.
    CSS: () => Object.defineProperty(window, 'CSS', { value: undefined }),
    // Chrome before 111 and Firefox before 113 cannot mix colours.
    'color-mix': () => {
        const supports = CSS.supports.bind(CSS)
        CSS.supports = (...args: [string, string?]) =>
            !String(args[1] ?? args[0]).includes('color-mix') &&
            supports(...(args as [string, string]))
    },
    // Firefox before 128 cannot register custom properties.
    'CSS.registerProperty': () =>
        Object.defineProperty(CSS, 'registerProperty', { value: undefined }),
}

for (const [feature, remove] of Object.entries(missing))
    test(`a browser without ${feature} gets the plain page and its downloads, with no bundle`, async ({
        page,
    }) => {
        const violations: string[] = []
        const errors: string[] = []
        // The bundle's entry stops at once; one that ran on would throw something else.
        page.on('pageerror', (error) => errors.push(error.message))
        await page.addInitScript(remove)
        await page.addInitScript(
            ({ prefix, autoSave }) => {
                document.addEventListener('securitypolicyviolation', (event) =>
                    console.error('csp ' + event.effectiveDirective),
                )
                localStorage.setItem(prefix + 'autoSave.levelData', autoSave)
            },
            { prefix, autoSave },
        )
        page.on('console', (message) => {
            if (message.text().startsWith('csp ')) violations.push(message.text())
        })
        await page.goto('/')
        await expect(page.locator('html')).toHaveAttribute('data-gate', 'unsupported')
        await expect(
            page.getByText(
                'This browser does not support the features required by the editor. Update it, or open the editor in another browser.',
            ),
        ).toBeVisible()
        // Readable: the text contrasts with the page at 4.5:1 or more, whatever the theme.
        const contrast = await page.evaluate(() => {
            const style = getComputedStyle(document.body)
            const luminance = (colour: string) => {
                const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => {
                    const c = Number(value) / 255
                    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
                })
                return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
            }
            const [a, b] = [luminance(style.color), luminance(style.backgroundColor)]
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        })
        expect(contrast).toBeGreaterThanOrEqual(4.5)
        const button = page.getByRole('button', { name: 'Download Last Auto Save' })
        await expect(button).toBeVisible()
        for (const input of ['pointer', 'keyboard']) {
            const download = page.waitForEvent('download')
            if (input === 'pointer') await button.click()
            else await button.press('Enter')
            const file = await download
            expect(file.suggestedFilename()).toBe('coconut.nsld')
            const path = await file.path()
            expect((await readFile(path)).equals(gz)).toBe(true)
        }
        // The bundle never mounted, and the page made nothing the policy blocks.
        await page.waitForTimeout(500)
        expect(errors).toEqual(['This browser is not supported.'])
        await expect(page.locator('#app')).toBeEmpty()
        expect(violations).toEqual([])
    })

test('a browser with the features gets the editor, not the gate', async ({ page }) => {
    await page.goto('/')
    await editorReady(page)
    await expect(page.locator('html')).not.toHaveAttribute('data-gate', /.*/)
})
