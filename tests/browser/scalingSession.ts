import { expect, type Page } from '@playwright/test'
import type { State } from '../../src/state'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

declare global {
    interface Window {
        scalingTest: {
            source: State
            preview: typeof import('../../src/preview/edit')
            scene: typeof import('../../src/editor/elevation/scene')
        }
    }
}

export const errors = new WeakMap<Page, string[]>()
export const panel = (page: Page) => page.locator('.scaling-panel')
export const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        await window.nsePreviewTest?.settled()
    })
export const summary = (page: Page) =>
    page.evaluate(() => {
        const { history } = window.editorTest
        const current = history.state.value
        const draft = window.scalingTest.preview.getPreviewState(current)
        const notes = (state: State) =>
            [...state.store.slides.note.values()].flat().map((note) => ({
                beat: note.beat,
                elevation: note.elevation,
                left: note.left,
                size: note.size,
            }))
        return {
            sourceUnchanged: current === window.scalingTest.source,
            draftDifferent: draft !== current,
            stored: notes(current),
            draft: notes(draft),
            canUndo: history.canUndo.value,
            dirty: history.isDirty.value,
        }
    })
export const seed = async (page: Page, elevation = false, three = false) => {
    await page.evaluate(
        async ({ elevation, three }) => {
            const { fixtures, show, history, settings } = window.editorTest
            settings.mouseSecondaryTool = 'selectContextMenu'
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    slides: [
                        [{ ...base, beat: 3, left: -4, size: 2, elevation: 1 }],
                        [
                            {
                                ...base,
                                beat: elevation ? 3 : 5,
                                left: 0,
                                size: 2,
                                elevation: three ? 2 : 3,
                            },
                        ],
                        [
                            {
                                ...base,
                                beat: three ? (elevation ? 3 : 7) : 8,
                                left: 4,
                                size: 2,
                                elevation: three ? 3 : 4,
                            },
                        ],
                        ...(three ? [[{ ...base, beat: 9, left: -8, size: 2, elevation: 4 }]] : []),
                    ],
                },
                3,
            )
            const source = history.state.value
            const selectedEntities = [...source.store.slides.note.values()]
                .flat()
                .slice(0, three ? 3 : 2)
            history.replaceState({ ...source, selectedEntities })
            const urls = new Map(
                performance
                    .getEntriesByType('resource')
                    .map((entry) => [new URL(entry.name).pathname, entry.name]),
            )
            window.scalingTest = {
                source: history.state.value,
                preview: await import(urls.get('/src/preview/edit.ts') ?? '/src/preview/edit.ts'),
                scene: await import(
                    urls.get('/src/editor/elevation/scene.ts') ?? '/src/editor/elevation/scene.ts'
                ),
            }
        },
        { elevation, three },
    )
    await settle(page)
}
export const chartPoint = (page: Page, lane: number, beat: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })
export const open = async (page: Page, axis: 'beat' | 'elevation' = 'beat') => {
    let point = await chartPoint(page, -3, 3)
    if (axis === 'elevation' && (await page.locator('.elevation-canvas').isVisible())) {
        const row = await page.evaluate(() => {
            const row = window.scalingTest.scene.elevationLayout.value.rows.find(
                (row) => row.note.left === -4,
            )!
            return { x: row.x, y: row.y }
        })
        const bounds = await page.locator('.elevation-canvas').boundingBox()
        if (!bounds) throw new Error('Missing elevation canvas')
        point = { x: bounds.x + row.x, y: bounds.y + row.y }
    }
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await page
        .getByRole('menuitem', {
            name: axis === 'beat' ? 'Scale Beats…' : 'Scale Elevations…',
            exact: true,
        })
        .click()
    await expect(panel(page)).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await settle(page)
}
export const factor = (page: Page) =>
    panel(page).getByRole('spinbutton', { name: 'Scale Factor', exact: true })
export const bootScaling = async (page: Page) => {
    const messages: string[] = []
    errors.set(page, messages)
    page.on('pageerror', (error) => messages.push(error.message))
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        window.previewTest = {
            uploads: 0,
            frames: 0,
            bitmaps: 0,
            closes: 0,
            vertices: [],
            resolutions: 0,
            aspect: 0,
            errors: [],
        }
        const isPreview = (gl: WebGL2RenderingContext) =>
            gl.canvas instanceof HTMLCanvasElement &&
            gl.canvas.matches('.preview-viewport > canvas:not(.preview-selection)')
        const clear = WebGL2RenderingContext.prototype.clear
        WebGL2RenderingContext.prototype.clear = function (...args) {
            // The background pass clears again after the foreground has been drawn.
            if (
                isPreview(this) &&
                (this.getParameter(this.COLOR_CLEAR_VALUE) as Float32Array)[3] === 0
            )
                window.previewTest.vertices = []
            return clear.apply(this, args)
        }
        const upload = WebGL2RenderingContext.prototype.bufferSubData
        WebGL2RenderingContext.prototype.bufferSubData = function (...args: unknown[]) {
            const data = args[2]
            if (isPreview(this) && data instanceof Float32Array && data[5] !== 3)
                window.previewTest.vertices.push(...data)
            return Reflect.apply(upload, this, args)
        }
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await seed(page)
}
