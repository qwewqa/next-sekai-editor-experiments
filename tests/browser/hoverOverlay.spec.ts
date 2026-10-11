import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

// The bottom tool row lies over the chart; over it, or off the pane, a click selects nothing
// there, so nothing shows as hovered.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const hovered = (page: Page) =>
    page.evaluate(() => window.editorTest.snapshot().hovered.map((entity) => entity.type))

const toolRow = (page: Page, pane: string) =>
    page.locator(`${pane} [data-editor-toolbar]`).getByRole('button', { name: 'Undo', exact: true })

test('moving from the chart onto the tool row over it, or off the pane, clears the hover', async ({
    page,
}) => {
    const button = (await toolRow(page, '.chart-pane').boundingBox())!
    const y = button.y + button.height / 2
    // A wide note under the tool row, from the chart's left beside it.
    await page.evaluate(async (y) => {
        const { show, fixtures, view, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const chart = { ...fixtures.interaction, slides: [] }
        show(chart, 8)
        settings.width = view.w / 40
        view.lane = 0
        const { yToBeat } =
            await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        show({ ...chart, slides: [[{ ...base, beat: yToBeat(y), left: -18, size: 36 }]] }, 8)
    }, y)
    await useTool(page, 'select')
    const beside = { x: button.x - 120, y }
    await page.mouse.move(beside.x - 4, beside.y)
    await page.mouse.move(beside.x, beside.y)
    await expect.poll(() => hovered(page)).toEqual(['note'])
    // Across the chart and onto the button.
    await page.mouse.move(button.x + button.width / 2, y, { steps: 6 })
    await expect.poll(() => hovered(page)).toEqual([])
    // Back on the chart, the hover returns.
    await page.mouse.move(beside.x, beside.y, { steps: 6 })
    await expect.poll(() => hovered(page)).toEqual(['note'])
    // Off the pane, to the dock rail beside it.
    const pane = (await page.locator('.chart-pane').boundingBox())!
    await page.mouse.move(pane.x + pane.width + 8, y, { steps: 6 })
    await expect.poll(() => hovered(page)).toEqual([])
})

test('Elevation Editor: moving onto its tool row clears the hover', async ({ page }) => {
    await page.evaluate(async () => {
        const { show, fixtures, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [[{ ...base, beat: 3, left: -6, size: 12, elevation: 2 }]],
            },
            3,
        )
        settings.showSidebar = false
        settings.showPreview = false
        settings.elevationEditorSideBySide = 'disallow'
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
    })
    await useTool(page, 'select')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    const button = (await toolRow(page, '.elevation-editor').boundingBox())!
    // The row scrolled to the tool row's height, beside it.
    const row = await page.evaluate(
        async (y) => {
            const { appImport, nextTick } = window.editorTest
            const { elevationLayout } = await appImport<
                typeof import('../../src/editor/elevation/scene')
            >('/src/editor/elevation/scene.ts')
            const { elevationBounds, elevationViewport } = await appImport<
                typeof import('../../src/editor/elevation/viewport')
            >('/src/editor/elevation/viewport.ts')
            elevationViewport.center =
                2 - (elevationBounds.h / 2 - y + elevationBounds.y) / elevationViewport.scale
            await nextTick()
            const [note] = elevationLayout.value.rows
            return {
                x: elevationBounds.x + note!.x - note!.w / 2 + 20,
                y: elevationBounds.y + note!.y,
            }
        },
        button.y + button.height / 2,
    )
    await page.mouse.move(row.x - 4, row.y)
    await page.mouse.move(row.x, row.y)
    await expect.poll(() => hovered(page)).toEqual(['note'])
    await page.mouse.move(button.x + button.width / 2, row.y, { steps: 6 })
    await expect.poll(() => hovered(page)).toEqual([])
})
