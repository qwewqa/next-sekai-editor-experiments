import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { outlinePixels, resource } from './previewResourceFixture'

declare global {
    interface Window {
        rendererInitProbe: {
            mode: 'normal' | 'sync' | 'async' | 'pending'
            selector: string
            reject?: (reason: Error) => void
        }
    }
}

const failures = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    failures.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        window.rendererInitProbe ??= { mode: 'normal', selector: '.editor-chart' }
        const getContext: (
            this: HTMLCanvasElement,
            name: string,
            options?: unknown,
        ) => RenderingContext | null = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            name: string,
            options?: unknown,
        ) {
            const probe = window.rendererInitProbe
            if (probe.mode === 'sync' && this.matches(probe.selector) && name.startsWith('webgl'))
                return null
            return getContext.call(this, name, options)
        } as typeof HTMLCanvasElement.prototype.getContext
    })
    await page.route('**/src/rendering/resources.ts*', async (route) => {
        const response = await route.fetch()
        const original = await response.text()
        // Fail the actual async init boundary, before Pixi has installed systems.
        // This also exercises disposal of a partially initialized renderer.
        const body = original.replace(
            'this.ready = this.renderer',
            `const init = this.renderer.init.bind(this.renderer);
            this.renderer.init = (...args) => {
                const probe = window.rendererInitProbe;
                if (this.canvas.matches(probe.selector)) {
                    if (probe.mode === 'async') return Promise.reject(new Error('Injected renderer initialization failure'));
                    if (probe.mode === 'pending') return new Promise((_, reject) => { probe.reject = reject; });
                }
                return init(...args);
            };
            this.ready = this.renderer`,
        )
        expect(body).not.toBe(original)
        await route.fulfill({ response, body })
    })
})
test.afterEach(async ({ page }) => {
    expect(failures.get(page), 'renderer failures are handled by the pane').toEqual([])
})

const openEditor = async (page: Page, waitForRendering = true) => {
    await page.goto('/')
    await page.evaluate(installEditorFixture, waitForRendering)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.interaction))
}
const expectDrawn = async (page: Page, selector = '.editor-chart') => {
    await expect
        .poll(() =>
            page.evaluate(async (selector) => {
                const canvas = document.querySelector<HTMLCanvasElement>(selector)!
                const { peekDrawContext } = await window.editorRenderingReady
                const context = peekDrawContext(canvas)
                if (!context || !('ready' in context)) return false
                await context.ready
                return context
                    .getImageData(0, 0, canvas.width, canvas.height)
                    .data.some((alpha, index) => index % 4 === 3 && alpha > 0)
            }, selector),
        )
        .toBe(true)
}

test('normal startup draws without an obsolete renderer-download loading screen', async ({
    page,
}) => {
    await openEditor(page)
    await expectDrawn(page)
    await expect(page.locator('.rendering-error')).toHaveCount(0)
    await expect(page.locator('#app > [role=status]:not([data-notice-region])')).toHaveCount(0)
})

for (const mode of ['sync', 'async'] as const) {
    test(`${mode} renderer initialization failure has a local retry that preserves the chart`, async ({
        page,
    }) => {
        await page.addInitScript((mode) => {
            window.rendererInitProbe = { mode, selector: '.editor-chart' }
        }, mode)
        await openEditor(page, false)
        const alert = page.locator('.rendering-error')
        // The headline is localized; the raw message is the detail behind the disclosure.
        await expect(alert).toContainText('Graphics could not be started.')
        const message =
            mode === 'sync'
                ? 'Unable to create the editor WebGL2 context'
                : 'Injected renderer initialization failure'
        await expect(alert.getByText(message)).toBeHidden()
        await alert.getByText('Error Details', { exact: true }).click()
        await expect(alert.getByText(message)).toBeVisible()
        const before = await page.evaluate(() => window.editorTest.snapshot().notes)
        const previous = await page.locator('.editor-chart').elementHandle()
        await page.evaluate(() => {
            window.rendererInitProbe.mode = 'normal'
        })
        await alert.getByRole('button', { name: 'Reload', exact: true }).click()
        await expectDrawn(page)
        await expect(alert).toHaveCount(0)
        expect(await previous!.evaluate((canvas) => canvas.isConnected)).toBe(false)
        expect(await page.evaluate(() => window.editorTest.snapshot().notes)).toEqual(before)
    })
}

test('a late initialization rejection after pane teardown stays rejected without publishing stale UI', async ({
    page,
}) => {
    await openEditor(page)
    await expectDrawn(page)
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
        window.rendererInitProbe = { mode: 'pending', selector: '.elevation-canvas' }
    })
    await page.keyboard.press('t')
    await expect.poll(() => page.evaluate(() => !!window.rendererInitProbe.reject)).toBe(true)
    const result = await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
        const { peekDrawContext } = await window.editorRenderingReady
        const context = peekDrawContext(canvas)!
        const { closeElevationEditor } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        closeElevationEditor()
        await window.editorTest.nextTick()
        window.rendererInitProbe.reject!(new Error('Late renderer failure'))
        const message = await (context as unknown as { ready: Promise<void> }).ready.then(
            () => 'unexpected success',
            (reason: Error) => reason.message,
        )
        await window.editorTest.nextTick()
        return { message, lost: context.isContextLost(), connected: canvas.isConnected }
    })
    expect(result).toEqual({ message: 'Late renderer failure', lost: true, connected: false })
    await expect(page.locator('.rendering-error')).toHaveCount(0)
    await expectDrawn(page)
})

test('an old pane rejection cannot overwrite its successfully initialized replacement', async ({
    page,
}) => {
    await openEditor(page)
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
        window.rendererInitProbe = { mode: 'pending', selector: '.elevation-canvas' }
    })
    await page.keyboard.press('t')
    await expect.poll(() => page.evaluate(() => !!window.rendererInitProbe.reject)).toBe(true)
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toHaveCount(0)
    await page.evaluate(() => {
        window.rendererInitProbe.mode = 'normal'
    })
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
        const { peekDrawContext } = await window.editorRenderingReady
        let context = peekDrawContext(canvas)
        while (!context) {
            await new Promise(requestAnimationFrame)
            context = peekDrawContext(canvas)
        }
        await (context as unknown as { ready: Promise<void> }).ready
        window.rendererInitProbe.reject!(new Error('Obsolete pane failure'))
        await new Promise(requestAnimationFrame)
    })
    await expect(page.locator('.rendering-error')).toHaveCount(0)
    await expect(page.locator('.elevation-canvas')).toBeVisible()
})

test('preview selection initializes lazily and retries through the existing preview error UI', async ({
    page,
}) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await openEditor(page)
    await page.evaluate(() => {
        const { settings, fixtures, show } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [[{ ...base, beat: 6, left: -3, elevation: 0 }]],
            },
            3,
        )
        window.editorTest.view.cursorTime = 3
        settings.showPreview = true
        window.rendererInitProbe = { mode: 'sync', selector: '.preview-selection' }
    })
    await expect(page.locator('.preview-selection')).toBeVisible()
    const preview = page.locator('.preview')
    // Nothing selected: the outline asks for no context, so the probe cannot fail it yet.
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(preview).not.toContainText('Preview graphics could not be started.')
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
        })
    })
    await expect(preview).toContainText('Preview graphics could not be started.')
    await page.evaluate(() => {
        window.rendererInitProbe.mode = 'normal'
    })
    await preview.getByRole('button', { name: 'Reload', exact: true }).click()
    // Read through the renderer: a context the page asked for first would be the renderer's too.
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    await expect(preview).not.toContainText('Preview graphics could not be started.')
})
