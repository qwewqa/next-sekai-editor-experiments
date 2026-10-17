import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

// The support gate on the release build (Part 1 §1.6.10, Part 4 4.3.1): /gate.js is a staged file
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

test('a browser without a needed feature gets the plain page and its downloads, with no bundle', async ({
    page,
}) => {
    const violations: string[] = []
    const errors: string[] = []
    // A bundle that ran would throw: the page has no editor root.
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
        ({ prefix, autoSave }) => {
            // As Safari 16 has no navigator.locks.
            Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined })
            document.addEventListener('securitypolicyviolation', (event) =>
                console.error('csp ' + event.effectiveDirective),
            )
            localStorage.setItem(prefix + 'legacyRecovery', autoSave)
        },
        { prefix, autoSave },
    )
    page.on('console', (message) => {
        if (message.text().startsWith('csp ')) violations.push(message.text())
    })
    // The page is stopped, so its load never comes.
    await page.goto('/', { waitUntil: 'commit' })
    await expect(page.locator('html')).toHaveAttribute('data-gate', 'unsupported')
    await expect(page.getByText('This browser is too old for the editor.')).toBeVisible()
    const button = page.getByRole('button', { name: 'Download Your Last Auto Save' })
    await expect(button).toBeVisible()
    const download = page.waitForEvent('download')
    await button.click()
    const file = await download
    expect(file.suggestedFilename()).toBe('coconut.nsld')
    const path = await file.path()
    expect((await readFile(path)).equals(gz)).toBe(true)
    // The bundle never ran, and the page made nothing the policy blocks.
    await page.waitForTimeout(500)
    expect(errors).toEqual([])
    await expect(page.locator('script[type="module"]')).toHaveCount(0)
    expect(violations).toEqual([])
})

test('a browser with the features gets the editor, not the gate', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect(page.locator('html')).not.toHaveAttribute('data-gate', /.*/)
})
