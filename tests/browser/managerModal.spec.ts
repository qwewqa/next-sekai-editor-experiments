import { expect, test, type Locator, type Page } from '@playwright/test'
import { installEditorFixture } from './editorFixture'

const runtimeErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    runtimeErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test.afterEach(async ({ page }) => {
    expect(runtimeErrors.get(page)).toEqual([])
})

/** Loads the notes fixture with the given groups, each optionally in a folder. */
const seedGroups = (page: Page, groups: [name: string, folder?: string][]) =>
    page.evaluate((groups) => {
        const { history, view, fixtures, settings } = window.editorTest
        const chart = structuredClone(fixtures.notes)
        chart.isDynamicStages = true
        const folders = [...new Set(groups.flatMap(([, folder]) => folder ?? []))]
        // The fixture notes use groups 1 and 2; other ids stay clear of new ones.
        chart.groups = new Map(
            groups.map(([name, folder], i) => [
                (i < 2 ? i + 1 : 1000 + i) as never,
                folder === undefined
                    ? { name }
                    : { name, folderId: (9000 + folders.indexOf(folder)) as never },
            ]),
        )
        chart.groupFolders = new Map(
            folders.map((name, i) => [(9000 + i) as never, { name, index: 0 }]),
        )
        history.resetState(false, chart, 0, { sourceName: 'managers.json' })
        view.groupId = undefined
        view.stageId = undefined
        settings.showGroups = false
        settings.showStages = false
    }, groups)

const manyGroups = Array.from({ length: 40 }, (_, i): [string] => [`Group ${i + 1}`])

const nameButton = (scope: Locator, name: string) =>
    scope.locator('.manager-name').filter({
        has: scope.page().locator('.manager-label', { hasText: new RegExp(`^${name}$`) }),
    })

const box = async (locator: Locator) => {
    const { x, y, width, height } = (await locator.boundingBox())!
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    }
}

const settingOf = (page: Page, key: 'showGroups' | 'showStages') =>
    page.evaluate((key) => window.editorTest.settings[key], key)

test('the commands open the dialog on their tab and leave the panels alone', async ({ page }) => {
    await seedGroups(page, [['Default'], ['Lead']])
    const dialog = page.getByRole('dialog')
    await page.keyboard.press('e')
    await expect(dialog.getByRole('tab', { selected: true })).toHaveText('Groups')
    await expect(dialog).toHaveAccessibleName('Manage Groups')
    await expect(nameButton(dialog, 'Lead')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.keyboard.press('r')
    await expect(dialog.getByRole('tab', { selected: true })).toHaveText('Stages')
    await expect(dialog).toHaveAccessibleName('Manage Stages')
    await page.keyboard.press('Escape')
    expect(await settingOf(page, 'showGroups')).toBe(false)
    expect(await settingOf(page, 'showStages')).toBe(false)
    await expect(page.locator('#workspace-panel-groups')).toHaveCount(0)
})

test('the status bar scope labels run the manage commands: the dialog opens on the current row', async ({
    page,
}) => {
    await seedGroups(page, [['Default'], ['Lead'], ['Outro']])
    await page.evaluate(() => {
        window.editorTest.view.groupId = 2 as never
    })
    const dialog = page.getByRole('dialog')
    await page.locator('.status-chip').first().click()
    await expect(dialog.getByRole('tab', { selected: true })).toHaveText('Groups')
    await expect(dialog).toHaveAccessibleName('Manage Groups')
    await expect(nameButton(dialog, 'Lead')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.locator('.status-chip').nth(1).click()
    await expect(dialog.getByRole('tab', { selected: true })).toHaveText('Stages')
    await expect(dialog).toHaveAccessibleName('Manage Stages')
    await page.keyboard.press('Escape')
    expect(await settingOf(page, 'showGroups')).toBe(false)
    await expect(page.locator('#workspace-panel-groups')).toHaveCount(0)
})

test('tabs switch by pointer and by arrow keys', async ({ page }) => {
    await seedGroups(page, [['Default'], ['Lead']])
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog')
    const groups = dialog.getByRole('tab', { name: 'Groups' })
    const stages = dialog.getByRole('tab', { name: 'Stages' })
    await stages.click()
    await expect(stages).toHaveAttribute('aria-selected', 'true')
    await expect(dialog.getByRole('tabpanel')).toContainText('All Stages')
    await expect(dialog).toHaveAccessibleName('Manage Stages')
    // A pointer click leaves no focus ring on the tab.
    await expect(stages).not.toBeFocused()

    await stages.focus()
    await page.keyboard.press('ArrowRight')
    await expect(groups).toBeFocused()
    await expect(groups).toHaveAttribute('aria-selected', 'true')
    await expect(nameButton(dialog, 'Lead')).toBeVisible()
    await page.keyboard.press('End')
    await expect(stages).toBeFocused()
    await page.keyboard.press('Home')
    await expect(groups).toBeFocused()
    await expect(stages).toHaveAttribute('tabindex', '-1')
})

test.describe('size', () => {
    test('fills the phone screen less the inset', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await seedGroups(page, [['Default'], ['Lead']])
        await page.keyboard.press('e')
        expect(await box(page.getByRole('dialog'))).toEqual({
            x: 8,
            y: 8,
            width: 374,
            height: 828,
        })
    })

    test('is capped on large screens and keeps its height as content changes', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 1000 })
        await seedGroups(page, [['Default'], ['Lead', 'Verse'], ['Fill', 'Verse']])
        await page.keyboard.press('e')
        const dialog = page.getByRole('dialog')
        const before = await box(dialog)
        expect(before).toEqual({ x: 480, y: 116, width: 640, height: 768 })

        // Collapsing a folder, adding a row and switching tabs leave the size alone.
        await nameButton(dialog, 'Verse').click()
        await expect(nameButton(dialog, 'Lead')).toHaveCount(0)
        expect(await box(dialog)).toEqual(before)
        await dialog.locator('.manager-add').click()
        await page.keyboard.press('Escape')
        expect(await box(dialog)).toEqual(before)
        await dialog.getByRole('tab', { name: 'Stages' }).click()
        expect(await box(dialog)).toEqual(before)
    })

    test('a short landscape phone still floats Add over the rows', async ({ page }) => {
        await page.setViewportSize({ width: 844, height: 390 })
        await seedGroups(page, manyGroups)
        await page.keyboard.press('e')
        const dialog = page.getByRole('dialog')
        expect(await box(dialog)).toMatchObject({ y: 8, height: 374 })
        await expect(dialog.locator('.manager-entries-floating')).toHaveCount(1)
    })

    test('follows the visual viewport, as when an on-screen keyboard opens', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await seedGroups(page, [['Default'], ['Lead']])
        await page.keyboard.press('e')
        const dialog = page.getByRole('dialog')
        await page.evaluate(() => {
            const viewport = window.visualViewport!
            Object.defineProperty(viewport, 'height', { configurable: true, get: () => 500 })
            viewport.dispatchEvent(new Event('resize'))
        })
        await expect.poll(() => box(dialog)).toEqual({ x: 8, y: 8, width: 374, height: 484 })
        await page.evaluate(() => {
            const viewport = window.visualViewport!
            delete (viewport as unknown as { height?: number }).height
            viewport.dispatchEvent(new Event('resize'))
        })
        await expect.poll(() => box(dialog)).toMatchObject({ height: 828 })
    })
})

test('a name sets the target and keeps the dialog open; Select Objects closes it', async ({
    page,
}) => {
    await seedGroups(page, [['Default'], ['Lead']])
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog')
    await nameButton(dialog, 'Lead').click()
    expect(await page.evaluate(() => window.editorTest.view.groupId)).toBe(2)
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: 'More Actions for Default' }).click()
    await page.getByRole('menuitem', { name: 'Select Objects' }).click()
    await expect(dialog).toHaveCount(0)
    expect(
        await page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
    ).toBeGreaterThan(0)
})

test('Select Objects for a selection closes the dialog', async ({ page }) => {
    await seedGroups(page, [['Default'], ['Lead']])
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Select Multiple' }).click()
    await nameButton(dialog, 'Default').click()
    await dialog.getByRole('button', { name: 'More Actions for Selection' }).click()
    await page.getByRole('menuitem', { name: 'Select Objects' }).click()
    await expect(dialog).toHaveCount(0)
})

test('Escape and the backdrop end selecting before closing', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await seedGroups(page, [['Default'], ['Lead']])
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog')
    const mode = dialog.locator('.manager-all .manager-mode')
    await mode.click()
    await expect(mode).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await expect(mode).toHaveAttribute('aria-pressed', 'false')
    await expect(dialog).toBeVisible()

    // A backdrop press while selecting keeps the dialog.
    await mode.click()
    await page.mouse.click(100, 500)
    await expect(dialog).toBeVisible()
    await expect(mode).toHaveAttribute('aria-pressed', 'true')
    await dialog.locator('.manager-selection-done').click()
    await page.mouse.click(100, 500)
    await expect(dialog).toHaveCount(0)
})

test('a backdrop press while renaming only ends the rename', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await seedGroups(page, [['Default'], ['Lead']])
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'More Actions for Lead' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const field = dialog.locator('.manager-rename')
    await field.fill('Bass')
    await page.mouse.click(100, 500)
    await expect(dialog).toBeVisible()
    await expect(nameButton(dialog, 'Bass')).toBeVisible()
    await page.mouse.click(100, 500)
    await expect(dialog).toHaveCount(0)
})

test('a row drag released over the backdrop keeps the dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await seedGroups(page, [['Default'], ['Lead'], ['Bass']])
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog')
    const row = (await nameButton(dialog, 'Bass').boundingBox())!
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
    await page.mouse.down()
    await page.mouse.move(row.x + row.width / 2, row.y - 60, { steps: 8 })
    await page.mouse.move(100, row.y - 60, { steps: 8 })
    await page.mouse.up()
    await expect(dialog).toBeVisible()
})

test('a keyboard open starts on the target; Properties returns there', async ({ page }) => {
    await seedGroups(page, [['Default'], ['Lead']])
    await page.evaluate(() => {
        window.editorTest.view.groupId = 2 as never
    })
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog')
    const lead = nameButton(dialog, 'Lead')
    await expect(lead).toBeFocused()

    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    const properties = page.getByRole('dialog', { name: 'Group Properties' })
    await expect(properties).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(properties).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.manager-row-current :focus')).toHaveCount(1)
})

test('the dialog and the panel remember their scroll positions apart', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await seedGroups(page, manyGroups)
    await page.keyboard.press('e')
    const list = page.getByRole('dialog').locator('.manager-entries')
    await list.evaluate((element) => (element.scrollTop = 400))
    await list.dispatchEvent('scroll')
    await page.keyboard.press('Escape')

    await page.evaluate(() => {
        window.editorTest.settings.showGroups = true
    })
    const panel = page.locator('#workspace-panel-groups .manager-entries')
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(0)

    await page.locator('.chart-pane').focus()
    await page.keyboard.press('e')
    await expect
        .poll(() =>
            page
                .getByRole('dialog')
                .locator('.manager-entries')
                .evaluate((element) => element.scrollTop),
        )
        .toBe(400)
})
