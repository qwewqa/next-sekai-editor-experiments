import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { resource } from '../browser/previewResourceFixture'
import { skipWhereTheEditorCannotStart } from '../browser/webkitSupport'
import { chart, instrumentRendering, previewInWorker, previewPixels, seedVersion } from './fixtures'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

test.use({ hasTouch: true })

const errors = new WeakMap<Page, string[]>()

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test.beforeEach(async ({ page, browserName }, testInfo) => {
    const messages: string[] = []
    errors.set(page, messages)
    // The browser's note that a ResizeObserver deferred a notification is not a failure; the app
    // ignores it too (src/diagnostics.ts).
    page.on('pageerror', (error) => {
        if (!error.message.startsWith('ResizeObserver loop')) messages.push(error.message)
    })
    if (browserName === 'webkit' && process.platform === 'win32') {
        testInfo.annotations.push({
            type: 'coverage',
            description:
                'Windows WebKit lacks Web Audio; editor UI only, with audio initialization stubbed.',
        })
        await page.addInitScript(() => {
            class SilentAudioContext extends EventTarget {
                state = 'suspended'
                currentTime = 0
                sampleRate = 48000
                destination = {}
                async decodeAudioData() {
                    return {
                        duration: 0.1,
                        length: 4800,
                        sampleRate: 48000,
                        numberOfChannels: 1,
                        getChannelData: () => new Float32Array(4800),
                    }
                }
                async close() {}
            }
            Object.defineProperty(window, 'AudioContext', { value: SilentAudioContext })
        })
    }
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(() => {
        Object.defineProperty(window, 'showOpenFilePicker', {
            configurable: true,
            value: undefined,
        })
        Object.defineProperty(window, 'showSaveFilePicker', {
            configurable: true,
            value: undefined,
        })
        for (const key of ['showPreview', 'showSidebar'])
            localStorage.setItem(`sonolus-next-sekai-editor.${key}`, 'false')
        // The fixture hook: a blank start, at once.
        localStorage.setItem('nse.test.startBlank', 'true')
        localStorage.setItem('sonolus-next-sekai-editor.pps', '120')
    })
    await page.addInitScript(seedVersion)
    await page.addInitScript(instrumentRendering)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    )
    const opening = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await opening
    ).setFiles({ name: 'compatibility.usc', mimeType: 'application/json', buffer: chart })
    await expect(
        page.locator('.notification, .notification-pill').filter({ hasText: 'Imported USC chart' }),
    ).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.press('f')
    const bounds = await page.locator('canvas.editor-chart').boundingBox()
    if (!bounds) throw new Error('Missing editor canvas')
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 - 30)
})

test('production imports, scales through the touch menu, applies with Enter and exports', async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTitle('Help', { exact: true }).tap()
    await page
        .getByTitle('Open Context Menu', { exact: true })
        .filter({ hasText: 'Open Context Menu' })
        .tap()
    await page.getByRole('menuitem', { name: 'Scale Width…', exact: true }).tap()
    const factor = page.getByRole('spinbutton', { name: 'Scale Factor' })
    await factor.fill('2')
    await factor.press('Enter')
    await expect(page.locator('.scaling-panel')).toHaveCount(0)
    const saving = page.waitForEvent('download')
    await page.keyboard.press('Shift+P')
    await page
        .getByRole('dialog', { name: 'Export Level Data', exact: true })
        .getByRole('button', { name: 'Export', exact: true })
        .click()
    const path = testInfo.outputPath('compatibility.leveldata.gz')
    await (await saving).saveAs(path)
    const level = JSON.parse(gunzipSync(await readFile(path)).toString()) as {
        entities: { archetype: string; data: { name: string; value?: number }[] }[]
    }
    const note = level.entities.find((entity) => /Note$/.test(entity.archetype))
    expect(note).toBeDefined()
    expect(note!.data.find((field) => field.name === '#BEAT')?.value).toBe(0.25)
    expect(note!.data.find((field) => field.name === 'size')?.value).toBe(3)
})

test('elevation controls and menus fit portrait and landscape viewports', async ({
    page,
}, testInfo) => {
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await expect(page.getByRole('spinbutton', { name: 'Beat', exact: true })).toHaveValue('1.25')
    for (const viewport of [
        { width: 390, height: 844 },
        { width: 844, height: 390 },
    ]) {
        await page.setViewportSize(viewport)
        const close = page.getByRole('button', { name: 'Close Elevation Editor' })
        await expect(close).toBeVisible()
        const closeBounds = await close.boundingBox()
        expect(closeBounds!.y).toBeGreaterThanOrEqual(0)
        expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(viewport.height)
        const toolbar = page.locator('section').filter({ has: page.locator('.elevation-canvas') })
        const utility = toolbar.getByTitle('Help', { exact: true })
        if (await utility.count()) await utility.tap()
        else await toolbar.getByTitle('Open Context Menu', { exact: true }).first().tap()
        await toolbar
            .getByTitle('Open Context Menu', { exact: true })
            .filter({ hasText: 'Open Context Menu' })
            .tap()
        const menu = page.getByRole('menu')
        await expect(menu).toBeVisible()
        const bounds = await menu.boundingBox()
        expect(bounds!.y).toBeGreaterThanOrEqual(0)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
        await page.keyboard.press('Escape')
    }
    await page.screenshot({ path: testInfo.outputPath('compatibility-landscape.png') })
})

test('WebGL2 note rendering works without native Canvas2D shape drawing', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(CanvasRenderingContext2D.prototype, 'roundRect', {
            configurable: true,
            value: undefined,
        })
        const getContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            ...args: [string, ...unknown[]]
        ) {
            if (
                args[0] === '2d' &&
                this.matches(
                    '.editor-chart, .editor-overlay, .elevation-canvas, .preview-selection',
                )
            )
                throw new Error('A displayed editor surface requested native Canvas2D')
            return Reflect.apply(getContext, this, args)
        } as typeof getContext
    })
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    const opening = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await opening
    ).setFiles({ name: 'fallback.usc', mimeType: 'application/json', buffer: chart })
    await expect(
        page.locator('.notification, .notification-pill').filter({ hasText: 'Imported USC chart' }),
    ).toBeVisible()
    await expect
        .poll(async () => {
            // Read the actual composited output; the native reference canvas
            // below only decodes a browser screenshot and never renders notes.
            const screenshot = await page.locator('canvas.editor-chart').screenshot()
            return page.evaluate(async (png) => {
                const image = new Image()
                image.src = `data:image/png;base64,${png}`
                await image.decode()
                const reference = document.createElement('canvas')
                reference.width = image.naturalWidth
                reference.height = image.naturalHeight
                const ctx = reference.getContext('2d')!
                ctx.drawImage(image, 0, 0)
                const data = ctx.getImageData(0, 0, reference.width, reference.height).data
                let colored = 0
                for (let i = 0; i < data.length; i += 4)
                    if (data[i + 3]! > 0 && data[i + 1]! - data[i]! > 10 && data[i + 2]! > 180)
                        colored++
                return colored
            }, screenshot.toString('base64'))
        })
        .toBeGreaterThan(10)
    await page.keyboard.press('f')
    const bounds = await page.locator('canvas.editor-chart').boundingBox()
    if (!bounds) throw new Error('Missing editor canvas')
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 - 30)
    const version = (selector: string) =>
        page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
            const gl = canvas.getContext('webgl2')
            return gl?.getParameter(gl.VERSION) as string | undefined
        })
    // Below 800px wide the Elevation Editor replaces the chart, so read the chart’s first.
    expect(await version('canvas.editor-chart')).toMatch(/^WebGL 2\.0/)
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    expect(await version('.elevation-canvas')).toMatch(/^WebGL 2\.0/)
})

test('lane limit commands clamp note placement in the production editor', async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTitle('No Lane Limit', { exact: true }).tap()
    await page.getByTitle('Custom Lane Limit…', { exact: true }).tap()
    await page.getByRole('spinbutton', { name: 'Maximum Lane (±)' }).fill('2')
    await page.getByRole('button', { name: 'Confirm', exact: true }).tap()
    await page.keyboard.press('a')
    const bounds = await page.locator('canvas.editor-chart').boundingBox()
    if (!bounds) throw new Error('Missing editor canvas')
    await page.mouse.click(
        bounds.x + bounds.width / 2 + (bounds.width * 7) / 16,
        bounds.y + bounds.height / 2 - 90,
    )
    const saving = page.waitForEvent('download')
    await page.keyboard.press('Shift+P')
    await page
        .getByRole('dialog', { name: 'Export Level Data', exact: true })
        .getByRole('button', { name: 'Export', exact: true })
        .click()
    const path = testInfo.outputPath('lane-limit.leveldata.gz')
    await (await saving).saveAs(path)
    const level = JSON.parse(gunzipSync(await readFile(path)).toString()) as {
        entities: { archetype: string; data: { name: string; value?: number }[] }[]
    }
    const notes = level.entities.filter((entity) => /Note$/.test(entity.archetype))
    expect(notes).toHaveLength(2)
    for (const note of notes) {
        const lane = note.data.find((field) => field.name === 'lane')!.value!
        const halfWidth = note.data.find((field) => field.name === 'size')!.value!
        expect(lane - halfWidth).toBeGreaterThanOrEqual(-2)
        expect(lane + halfWidth).toBeLessThanOrEqual(2)
    }
})

test('preview decodes textures and renders after opening and resizing', async ({ page }) => {
    // Counted on the main thread, where the preview draws with Parallel Rendering off.
    await page.evaluate(() =>
        localStorage.setItem('sonolus-next-sekai-editor.previewInWorker', 'false'),
    )
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.getByRole('tab', { name: 'Preview', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.productionSmoke.uploads)).toBe(2)
    const frames = await page.evaluate(() => window.productionSmoke.preview)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect
        .poll(() => page.evaluate(() => window.productionSmoke.preview))
        .toBeGreaterThan(frames)
    await expect(page.locator('.preview-viewport')).toBeVisible()
})

test('by default the preview draws in its worker where the browser can', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.getByRole('tab', { name: 'Preview', exact: true }).click()
    await expect(page.locator('.preview-viewport > canvas').first()).toBeVisible()
    const supported = await page.evaluate(
        () =>
            typeof OffscreenCanvas === 'function' &&
            'transferControlToOffscreen' in HTMLCanvasElement.prototype,
    )
    expect(await previewInWorker(page)).toBe(supported)
    await expect.poll(() => previewPixels(page)).toBeGreaterThan(100)
    if (supported) expect(await page.evaluate(() => window.productionSmoke.uploads)).toBe(0)
})

test('internal copy and paste survive denied browser clipboard permissions', async ({
    page,
}, testInfo) => {
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                readText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
                writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
            },
        })
    })
    await page.keyboard.press('c')
    await page.keyboard.press('v')
    const bounds = await page.locator('canvas.editor-chart').boundingBox()
    if (!bounds) throw new Error('Missing editor canvas')
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 - 90)
    const saving = page.waitForEvent('download')
    await page.keyboard.press('Shift+P')
    await page
        .getByRole('dialog', { name: 'Export Level Data', exact: true })
        .getByRole('button', { name: 'Export', exact: true })
        .click()
    const path = testInfo.outputPath('clipboard.leveldata.gz')
    await (await saving).saveAs(path)
    const level = JSON.parse(gunzipSync(await readFile(path)).toString()) as {
        entities: { archetype: string }[]
    }
    expect(level.entities.filter((entity) => /Note$/.test(entity.archetype))).toHaveLength(2)
})

test('vertical rail labels stay centered while panels open and close', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    const offsets = () =>
        page.evaluate(() =>
            [...document.querySelectorAll('[data-workspace-dock="left"] [role="tab"]')].map(
                (tab) => {
                    const label = tab.querySelector('span')!.getBoundingClientRect()
                    const box = tab.getBoundingClientRect()
                    return Math.abs(label.x + label.width / 2 - (box.x + box.width / 2))
                },
            ),
        )
    for (const name of ['Groups', 'Stages', 'Groups', 'Preview', 'Preview']) {
        await page.getByRole('tab', { name, exact: true }).click()
        for (const offset of await offsets()) expect(offset).toBeLessThan(1)
    }
})

test('selects open the list the browser and pointer allow, and show their value once', async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.keyboard.press('t')
    const snap = page.getByRole('combobox', { name: 'Elevation Snapping', exact: true })
    await expect(snap).toBeVisible()
    // The shared list needs customizable select and a fine primary pointer; Firefox,
    // older browsers and touch keep the system list.
    const shared = await page.evaluate(
        () => CSS.supports('appearance', 'base-select') && matchMedia('(pointer: fine)').matches,
    )
    if (testInfo.project.name.startsWith('firefox')) expect(shared).toBe(false)
    if (testInfo.project.name.startsWith('mobile')) expect(shared).toBe(false)
    expect(await snap.evaluate((select) => getComputedStyle(select).appearance)).toBe(
        shared ? 'base-select' : 'none',
    )
    const value = page.locator('.elevation-select .select-value')
    if (shared) await expect(value).toBeVisible()
    else await expect(value).toBeHidden()
    expect(await snap.evaluate((select) => getComputedStyle(select).color)).not.toBe(
        shared ? 'rgb(68, 68, 102)' : 'rgba(0, 0, 0, 0)',
    )
    if (testInfo.project.name.startsWith('mobile')) return
    // A closed select steps on arrows off Apple platforms, either way.
    const before = await snap.inputValue()
    await snap.focus()
    await page.keyboard.press('ArrowDown')
    await expect(snap).not.toHaveValue(before)
    expect(
        await snap.evaluate((select) => CSS.supports('selector(:open)') && select.matches(':open')),
    ).toBe(false)
})
