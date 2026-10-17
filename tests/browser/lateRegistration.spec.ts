import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test('a command registered at run time shows in the toolbar and runs from its key', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.showPreview = false
        // Stored before the command exists, as a newer build's settings would be.
        settings.toolbar = [...settings.toolbar, ['lateTest']]
        settings.keyboardShortcuts = { ...settings.keyboardShortcuts, lateTest: 'F9' }
    })
    const button = page.locator('[data-editor-toolbar] button[title="Late Test"]')
    await expect(button).toHaveCount(0)
    await page.keyboard.press('F9')

    await page.evaluate(async () => {
        const { registerCommand } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/index')
        >('/src/editor/commands/index.ts')
        const { default: UndoIcon } = await window.editorTest.appImport<{
            default: import('vue').Component
        }>('/src/editor/commands/undo/UndoIcon.vue')
        const w = window as unknown as { lateRuns: number }
        w.lateRuns = 0
        registerCommand('lateTest', {
            title: () => 'Late Test',
            icon: { is: UndoIcon },
            readOnly: true,
            execute() {
                w.lateRuns++
            },
        })
        await window.editorTest.nextTick()
    })
    await expect(button).toBeVisible()

    await page.keyboard.press('F9')
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { lateRuns: number }).lateRuns))
        .toBe(1)
})

test('a chord bound only to an unregistered command leaves a plain binding working', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { settings, appImport } = window.editorTest
        const { registerCommand } = await appImport<
            typeof import('../../src/editor/commands/index')
        >('/src/editor/commands/index.ts')
        const { default: UndoIcon } = await appImport<{ default: import('vue').Component }>(
            '/src/editor/commands/undo/UndoIcon.vue',
        )
        const w = window as unknown as { plainRuns: number }
        w.plainRuns = 0
        registerCommand('plainTest', {
            title: () => 'Plain Test',
            icon: { is: UndoIcon },
            readOnly: true,
            execute() {
                w.plainRuns++
            },
        })
        settings.keyboardShortcuts = {
            ...settings.keyboardShortcuts,
            ghost: 'Mod+F9',
            plainTest: 'F9',
        }
    })
    await page.keyboard.press('Control+F9')
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { plainRuns: number }).plainRuns))
        .toBe(1)
})
