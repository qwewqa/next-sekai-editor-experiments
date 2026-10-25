import { expect, test, type Page } from '@playwright/test'
import { inlineScripts, webPolicy } from '../../scripts/csp.mjs'
import { instrumentRendering, previewInWorker, previewPixels } from './fixtures'

// The release build under its exact policy.

type Violation = { directive: string; blocked: string }
type Watch = { violations: Violation[]; hooked: Violation[]; wasm: string[] }
declare global {
    interface Window {
        csp: Watch
    }
}

// Records violations and WebAssembly outcomes before any page script runs.
const watch = async (page: Page) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
    })
    await page.addInitScript(() => {
        window.csp = { violations: [], hooked: [], wasm: [] }
        document.addEventListener(
            'securitypolicyviolation',
            (event) =>
                window.csp.violations.push({
                    directive: event.effectiveDirective,
                    blocked: event.blockedURI,
                }),
            true,
        )
        // The app's own listener (src/csp.ts) reports here.
        Object.defineProperty(window, 'nseCspViolationHook', {
            value: (violation: Violation) => window.csp.hooked.push(violation),
        })
        // A blocked instantiate fails without any other sign, so record what happened to each.
        for (const name of ['instantiate', 'instantiateStreaming'] as const) {
            const original = WebAssembly[name] as (...args: unknown[]) => Promise<unknown>
            Object.defineProperty(WebAssembly, name, {
                value: (...args: unknown[]) =>
                    original.apply(WebAssembly, args).then(
                        (value) => (window.csp.wasm.push(`${name} ok`), value),
                        (error: unknown) => {
                            window.csp.wasm.push(`${name} failed`)
                            throw error
                        },
                    ),
            })
        }
    })
    await page.addInitScript(instrumentRendering)
    return errors
}

// Serves the page with its policy changed, as the negative controls need.
const rewritePolicy = (page: Page, change: (policy: string) => string) =>
    page.route('**/', async (route) => {
        const response = await route.fetch()
        const body = (await response.text()).replace(
            /content="(default-src[^"]*)"/,
            (_match, policy: string) => `content="${change(policy)}"`,
        )
        await route.fulfill({ response, body })
    })

const read = (page: Page) => page.evaluate(() => window.csp)

test('the page carries the web policy first, hashing its one inline script', async ({ page }) => {
    await watch(page)
    await page.goto('/')
    const { meta, scripts, first } = await page.evaluate(() => ({
        meta: document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute('content'),
        scripts: [...document.scripts].filter((script) => !script.src).map((s) => s.textContent),
        first: document.head.firstElementChild?.getAttribute('http-equiv'),
    }))
    expect(first).toBe('Content-Security-Policy')
    expect(scripts).toHaveLength(1)
    expect(meta).toBe(webPolicy(inlineScripts(`<script>${scripts[0]}</script>`)))
    expect(meta).not.toContain("'unsafe-eval'")
    // The web makes no cross-origin requests: no https: source for requests or pictures.
    const directives = Object.fromEntries(
        (meta ?? '').split(';').map((part) => {
            const [name = '', ...sources] = part.trim().split(/\s+/)
            return [name, sources]
        }),
    )
    expect(directives['connect-src']).toEqual(["'self'", 'blob:', 'data:'])
    expect(directives['img-src']).toEqual(["'self'", 'blob:', 'data:'])
    expect(meta).not.toContain('https:')
})

for (const inWorker of [false, true])
    test(`Pixi starts, the Lyon wasm runs and the preview packages load without a violation${inWorker ? ', the preview in its worker' : ''}`, async ({
        page,
    }) => {
        const errors = await watch(page)
        await page.addInitScript((inWorker) => {
            localStorage.setItem(
                'sonolus-next-sekai-editor.previewInWorker',
                JSON.stringify(inWorker),
            )
        }, inWorker)
        const manifest = (await (await page.request.get('/release-manifest.json')).json()) as {
            previewAssets: unknown[]
            files: Record<string, string>
        }
        const wasm = Object.keys(manifest.files).filter((file) => file.endsWith('.wasm'))
        const requested: string[] = []
        page.on('request', (request) => requested.push(new URL(request.url()).pathname))
        await page.goto('/')

        // Pixi init throws without pixi.js/unsafe-eval, so the chart never draws.
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect
            .poll(() => page.evaluate(() => window.productionSmoke.chart))
            .toBeGreaterThan(0)
        await expect
            .poll(() => page.evaluate(() => window.productionSmoke.overlay))
            .toBeGreaterThan(0)
        await expect(page.getByText('does not allow unsafe-eval')).toHaveCount(0)

        // The kernel was requested and instantiated, not skipped for the JS tessellator.
        expect(wasm).toHaveLength(1)
        await expect.poll(async () => (await read(page)).wasm).toContain('instantiate ok')
        expect((await read(page)).wasm.filter((entry) => entry.includes('failed'))).toEqual([])
        expect(requested.filter((path) => path.endsWith('.wasm'))).toEqual(['/' + wasm[0]])

        if (inWorker) {
            // The release build's classic worker script runs under the policy and draws.
            await expect.poll(() => previewInWorker(page)).toBe(true)
            expect(requested.some((path) => /\/preview\.worker-[\w-]+\.js$/.test(path))).toBe(true)
            await expect.poll(() => previewPixels(page)).toBeGreaterThan(100)
        } else
            // A preview SCP load: each declared package decoded and uploaded to the preview.
            await expect
                .poll(() => page.evaluate(() => window.productionSmoke.uploads))
                .toBe(manifest.previewAssets.length)

        expect((await read(page)).violations).toEqual([])
        expect((await read(page)).hooked).toEqual([])
        expect(errors).toEqual([])
    })

test('the storage worker runs as a classic worker and restarts from its Blob copy', async ({
    page,
    browserName,
}) => {
    // The page is asked, so no platform is named (tests/browser/webkitSupport.ts).
    test.skip(
        browserName === 'webkit' &&
            !(await page.evaluate(() => typeof OffscreenCanvas !== 'undefined')),
        'This WebKit build lacks OffscreenCanvas, so the editor’s support gate refuses to start',
    )
    const errors = await watch(page)
    await page.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', '{}')
    })
    await page.goto('/')
    const status = () => page.evaluate(() => window.nseStorageTest?.status())
    const started = () => page.evaluate(() => [...window.nseStorageTest!.worker.started])
    await expect.poll(status).toEqual({ mode: 'stored' })
    const [script] = await started()
    expect(script).toMatch(/\/assets\/storage\.worker-[\w-]+\.js$/)
    // Emitted as iife, so Firefox 105 can run it: no module syntax at its top level.
    const source = await (await page.request.get(script!)).text()
    expect(source.startsWith('(function(){')).toBe(true)
    expect(source).not.toMatch(/^\s*(import|export)\s/m)

    // A later deploy has removed the script; a crash restarts from the copy kept at startup.
    await page.route('**/assets/storage.worker-*.js', (route) => route.fulfill({ status: 404 }))
    await page.evaluate(() => window.nseStorageTest!.worker.call('testCrash'))
    await expect.poll(async () => (await started()).length).toBe(2)
    expect((await started())[1]).toMatch(/^blob:/)
    await expect.poll(status).toEqual({ mode: 'stored' })
    expect(await page.evaluate(() => window.nseStorageTest!.worker.call('testLocation'))).toMatch(
        /^blob:/,
    )
    await page.evaluate(() =>
        window.nseStorageTest!.worker.call('testPut', { key: 'afterRestart', value: 1 }),
    )
    expect(
        await page.evaluate(() => window.nseStorageTest!.worker.call('testGet', 'afterRestart')),
    ).toBe(1)

    expect((await read(page)).violations).toEqual([])
    expect((await read(page)).hooked).toEqual([])
    expect(errors).toEqual([])
})

for (const [name, setting, system] of [
    ['light', 'light', 'dark'],
    ['dark', 'dark', 'light'],
    ['the system’s dark', undefined, 'dark'],
    ['the system’s light', undefined, 'light'],
] as const) {
    test(`the hashed theme script applies ${name} before the app loads`, async ({ page }) => {
        await watch(page)
        await page.emulateMedia({ colorScheme: system })
        if (setting)
            await page.addInitScript(
                (theme) =>
                    localStorage.setItem('sonolus-next-sekai-editor.theme', JSON.stringify(theme)),
                setting,
            )
        // Only the inline script runs.
        await page.route('**/assets/index-*.js', (route) => route.abort())
        await page.goto('/')
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(
            setting ?? system,
        )
        expect((await read(page)).violations).toEqual([])
    })
}

test.describe('a policy that lacks a source shows up as a violation', () => {
    test('without wasm-unsafe-eval the blocked kernel is seen and reported', async ({ page }) => {
        const errors = await watch(page)
        await rewritePolicy(page, (policy) => policy.replace(" 'wasm-unsafe-eval'", ''))
        await page.goto('/')
        await expect.poll(async () => (await read(page)).violations.length).toBeGreaterThan(0)
        const seen = await read(page)
        expect(seen.violations.map((violation) => violation.directive)).toEqual(['script-src'])
        expect(seen.violations[0]!.blocked).toBe('wasm-eval')
        expect(seen.wasm).toContain('instantiate failed')
        // The app's listener logs and calls the test hook.
        expect(seen.hooked.map((violation) => violation.blocked)).toEqual(['wasm-eval'])
        expect(errors.some((error) => error.includes('Content Security Policy violation'))).toBe(
            true,
        )
    })

    test('without the theme script’s hash the script is blocked', async ({ page }) => {
        await watch(page)
        await rewritePolicy(page, (policy) => policy.replace(/ 'sha256-[^']*'/, ''))
        await page.route('**/assets/index-*.js', (route) => route.abort())
        await page.goto('/')
        const seen = await read(page)
        expect(seen.violations.map((violation) => violation.blocked)).toEqual(['inline'])
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined()
    })
})
