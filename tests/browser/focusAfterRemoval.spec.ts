import { expect, test, type Page } from '@playwright/test'
import type { PlatformOverride } from '../../src/platform/detect'
import { installCanvasCounters, installEditorFixture, installTestPlatform } from './editorFixture'

// Focus after a control goes: when an action removes, hides or disables the
// focused control, or closes its surface, focus moves to the opener if it survives, else to the
// chart pane, never to the page's body.

const errors = new WeakMap<Page, string[]>()

const boot = async (page: Page, override?: PlatformOverride) => {
    const collected: string[] = []
    errors.set(page, collected)
    page.on('pageerror', (error) => collected.push(error.message))
    await page.addInitScript(installCanvasCounters)
    if (override) await page.addInitScript(installTestPlatform, override)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

test.afterEach(({ page }) => {
    expect(errors.get(page) ?? []).toEqual([])
})

const notifyCard = (page: Page, dismissing: boolean) =>
    page.evaluate(async (dismissing) => {
        const n = await window.editorTest.appImport<typeof import('../../src/editor/notification')>(
            '/src/editor/notification.ts',
        )
        n.notify(() => 'A card', {
            action: {
                label: () => 'Act',
                run: () => {
                    if (dismissing) n.dismissNoticeCard()
                },
            },
        })
    }, dismissing)

const focusChart = (page: Page) => page.locator('.chart-pane').first().focus()

test.describe('a notice card that goes while it holds focus', () => {
    test('Close by key hands focus to the chart', async ({ page }) => {
        await boot(page)
        await focusChart(page)
        await notifyCard(page, false)
        await page.keyboard.press('Alt+KeyN')
        await expect(page.locator('[data-notice-action]')).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(page.locator('[data-notice-close]')).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page.locator('[data-notice-card]')).toHaveCount(0)
        await expect(page.locator('.chart-pane').first()).toBeFocused()
    })

    test('an action that dismisses the card hands focus back to where Alt+N took it from', async ({
        page,
    }) => {
        await boot(page)
        await focusChart(page)
        await notifyCard(page, true)
        await page.keyboard.press('Alt+KeyN')
        await page.keyboard.press('Enter')
        await expect(page.locator('[data-notice-card]')).toHaveCount(0)
        await expect(page.locator('.chart-pane').first()).toBeFocused()
    })

    test('a card taken away by an edit or a timeout hands focus on too', async ({ page }) => {
        await boot(page)
        await focusChart(page)
        await notifyCard(page, false)
        await page.keyboard.press('Alt+KeyN')
        await expect(page.locator('[data-notice-action]')).toBeFocused()
        await page.evaluate(async () => {
            const n = await window.editorTest.appImport<
                typeof import('../../src/editor/notification')
            >('/src/editor/notification.ts')
            n.dismissNoticeCard()
        })
        await expect(page.locator('.chart-pane').first()).toBeFocused()
    })
})

test('the file chip, taken away by its own dialog, hands focus to the chart', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const state = await window.editorTest.appImport<
            typeof import('../../src/editor/file/state')
        >('/src/editor/file/state.ts')
        const stack =
            await window.editorTest.appImport<typeof import('../../src/history/stack')>(
                '/src/history/stack.ts',
            )
        state.bindFile(
            { name: 'probe.nxsp', event: 'downloaded', at: Date.now() },
            stack.liveState.value,
        )
    })
    const chip = page.locator('[data-file-chip]')
    await chip.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // The dialog has placed its focus, on its default.
    await expect(dialog.getByRole('button', { name: 'Download Again' })).toBeFocused()
    // A key press just after opening is ignored, so it is repeated until the dialog takes it.
    await expect(async () => {
        await dialog.getByRole('button', { name: 'I Have the File' }).focus()
        await page.keyboard.press('Enter')
        await expect(dialog).toHaveCount(0, { timeout: 500 })
    }).toPass()
    await expect(chip).toHaveCount(0)
    await expect(page.locator('.chart-pane').first()).toBeFocused()
})

test.describe('the Elevation Editor in full screen', () => {
    test.beforeEach(async ({ page }) => {
        await boot(page)
        await page.setViewportSize({ width: 700, height: 800 })
        await expect
            .poll(() =>
                page.evaluate(
                    async () =>
                        (
                            await window.editorTest.appImport<
                                typeof import('../../src/editor/elevation/state')
                            >('/src/editor/elevation/state.ts')
                        ).isElevationSideBySide.value,
                ),
            )
            .toBe(false)
    })

    test('opening hands focus to the editor, Escape and Close hand it back to the chart', async ({
        page,
    }) => {
        await focusChart(page)
        await page.keyboard.press('t')
        await expect(page.locator('.elevation-editor')).toBeVisible()
        await expect(page.locator('.elevation-editor')).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(page.locator('.elevation-editor')).toHaveCount(0)
        await expect(page.locator('.chart-pane')).toBeFocused()

        // The header's Close, reached by key, takes the whole editor with it.
        await page.keyboard.press('t')
        await expect(page.locator('.elevation-editor')).toBeFocused()
        await page.getByRole('button', { name: 'Close Elevation Editor' }).focus()
        await page.keyboard.press('Enter')
        await expect(page.locator('.elevation-editor')).toHaveCount(0)
        await expect(page.locator('.chart-pane')).toBeFocused()
    })

    test('Edit Elevations in the context menu lands on the editor', async ({ page }) => {
        await page.evaluate(() => {
            window.editorTest.settings.mouseSecondaryTool = 'selectContextMenu'
        })
        const point = await page.evaluate(() => window.editorTest.point(-3, 3))
        await page.mouse.click(point.x, point.y, { button: 'right' })
        await page.getByRole('menuitem', { name: 'Edit Elevations', exact: true }).click()
        await expect(page.locator('.elevation-editor')).toBeVisible()
        await expect(page.locator('.elevation-editor')).toBeFocused()
    })

    test('Previous Beat, pressed to the first beat, hands focus to the Beat field', async ({
        page,
    }) => {
        await page.evaluate(async () => {
            const state = await window.editorTest.appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            state.openElevationEditor(0.5)
        })
        const previous = page.getByRole('button', { name: 'Previous Beat' })
        await previous.focus()
        for (let n = 0; n < 10 && (await previous.isEnabled()); n++)
            await page.keyboard.press('Enter')
        await expect(previous).toBeDisabled()
        await expect(page.getByRole('spinbutton', { name: 'Beat' })).toBeFocused()
    })
})

test('a context menu closed by a view change gives focus back', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => {
        window.editorTest.settings.mouseSecondaryTool = 'selectContextMenu'
    })
    await focusChart(page)
    const point = await page.evaluate(() => window.editorTest.point(-3, 3))
    await page.mouse.click(point.x, point.y, { button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    expect(
        await page.evaluate(
            () => !!document.querySelector('[role="menu"]')?.contains(document.activeElement),
        ),
    ).toBe(true)
    await page.evaluate(() => {
        window.editorTest.settings.pps += 20
    })
    await expect(menu).toHaveCount(0)
    await expect(page.locator('.chart-pane').first()).toBeFocused()
})

test.describe('Export', () => {
    const opfs: PlatformOverride = { fileSystemAccess: 'opfs' }

    const slowDismissedPicker = (page: Page) =>
        page.evaluate(async () => {
            const { platform } =
                await window.editorTest.appImport<typeof import('../../src/platform')>(
                    '/src/platform/index.ts',
                )
            const save = platform.saveFile.bind(platform)
            platform.saveFile = async (request) => {
                await new Promise((resolve) => setTimeout(resolve, 400))
                return save(request)
            }
            localStorage.setItem('nse.test.picks', JSON.stringify([null]))
        })

    test('Export, when its picker is dismissed, keeps focus on the button', async ({ page }) => {
        await boot(page, opfs)
        await page.evaluate(() => {
            window.editorTest.history.resetState(false)
        })
        await slowDismissedPicker(page)
        await page.keyboard.press('Shift+P')
        const dialog = page.getByRole('dialog')
        const field = dialog.getByRole('textbox', { name: 'File Name' })
        await expect(field).toBeFocused()
        const submit = dialog.getByRole('button', { name: 'Export', exact: true })
        await submit.focus()
        await page.keyboard.press('Enter')
        await expect(submit).toBeDisabled()
        await expect(submit).toBeEnabled()
        await expect(dialog).toBeVisible()
        await expect(submit).toBeFocused()
    })

    test('a second Export while the first is opening opens no second dialog', async ({ page }) => {
        await boot(page, opfs)
        // Two presses within the first one's read of the remembered target.
        await page.evaluate(async () => {
            const { commands } = await import('/src/editor/commands/index.ts')
            commands.exportLevel.execute()
            commands.exportLevel.execute()
        })
        await expect(page.getByRole('dialog')).toHaveCount(1)
        await page.waitForTimeout(300)
        await expect(page.getByRole('dialog')).toHaveCount(1)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
    })
})

test('the toolbar editor, removing the last tool of a group, focuses the group Add button', async ({
    page,
}) => {
    await boot(page)
    await page.evaluate(() => {
        window.editorTest.settings.toolbar = [['select'], ['note', 'slide']]
    })
    await page.keyboard.press(',')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const group = dialog.locator('[data-toolbar-group="1"]')
    // The group's buttons: Add, then its tools.
    await expect(group.locator('button')).toHaveCount(3)
    await group.locator('button').nth(2).focus()
    await page.keyboard.press('Enter')
    await expect(group.locator('button')).toHaveCount(2)
    await expect(group.locator('button').first()).toBeFocused()
})
