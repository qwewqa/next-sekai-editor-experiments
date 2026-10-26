import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, waitForStartup } from './editorFixture'

// A History dialog or Step Details chunk that fails to load (offline after a deploy): the editor
// stays as it was, and the user, who asked, is told.

const errors = new WeakMap<Page, string[]>()

// The chunk is blocked before the page loads: the warm-up would otherwise have loaded it.
const load = async (page: Page, blocked: string) => {
    const seen: string[] = []
    errors.set(page, seen)
    page.on('pageerror', (error) => seen.push(error.message))
    await page.route(blocked, (route) => route.abort())
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        localStorage.setItem('nse.test.storage', '{}')
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
}

test.afterEach(({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test('a History dialog that fails to load leaves the Elevation Editor open and says so', async ({
    page,
}) => {
    await load(page, '**/HistoryDialog.vue*')
    await page.evaluate(async () => {
        const { show, fixtures, settings, history, appImport } = window.editorTest
        show({ ...fixtures.interaction, isDynamicStages: true })
        settings.elevationEditorSideBySide = 'disallow'
        const source = history.state.value
        history.replaceState({
            ...source,
            selectedEntities: [...source.store.slides.note.values()].flat(),
        })
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
    })
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    const result = await page.evaluate(async () => {
        const { openHistoryDialog } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/openHistory')
        >('/src/editor/history/openHistory.ts')
        await openHistoryDialog('timeline')
        const { isElevationEditorOpen, elevationBeat } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        return { open: isElevationEditorOpen.value, beat: elevationBeat.value }
    })
    expect(result).toEqual({ open: true, beat: 3 })
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await expect(
        page.getByText('The Timeline could not be loaded.', { exact: true }).first(),
    ).toBeVisible()
})

test('a Step Details chunk that fails to load says so and rejects nothing', async ({ page }) => {
    await load(page, '**/StepDetailsModal.vue*')
    await page.evaluate(async () => {
        const { appImport, historySteps } = window.editorTest
        const { captureOperationRecipe } = await appImport<
            typeof import('../../src/history/operationPresentation')
        >('/src/history/operationPresentation/index.ts')
        const { openOperationDetails } = await appImport<
            typeof import('../../src/editor/history/operationDetails')
        >('/src/editor/history/operationDetails.ts')
        await openOperationDetails(
            captureOperationRecipe([
                {
                    description: {
                        kind: 'edit',
                        step: historySteps.editStep(historySteps.initialLife(1000, 999)),
                    },
                    time: 1000,
                    id: 'session:1',
                },
            ]),
            1000,
        )
    })
    await expect(page.getByText('Could not view this step', { exact: true }).first()).toBeVisible()
})
