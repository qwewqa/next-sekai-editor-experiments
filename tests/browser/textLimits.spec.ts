import { expect, test, type Locator, type Page } from '@playwright/test'
import { installEditorFixture } from './editorFixture'

// Text fields cap typing and pasting at a generous length, and a longer stored name stays whole
// and can be shortened.

const long = 'x'.repeat(800)

test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate((long) => {
        const { history, view, fixtures } = window.editorTest
        const chart = structuredClone(fixtures.notes)
        chart.groups = new Map([
            [1 as never, { name: 'Default' }],
            [2 as never, { name: long }],
        ])
        history.resetState(false, chart, 0, { sourceName: 'limits.json' })
        view.groupId = undefined
        view.groupVisibility = new Map()
    }, long)
})

const maxLength = (input: Locator) =>
    input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.maxLength)

const groupNames = (page: Page) =>
    page.evaluate(() =>
        [...window.editorTest.history.state.value.groups.values()].map(({ name }) => name),
    )

test('text fields take text up to their limit and keep a longer stored name whole', async ({
    page,
}) => {
    // Level Info: names and credits, the Tags line and Description.
    await page.locator('[data-status-label]').click()
    const info = page.getByRole('dialog', { name: 'Level Info', exact: true })
    const field = (name: string) => info.getByRole('textbox', { name, exact: true })
    for (const name of ['Title', 'Artists', 'Author'])
        expect(await maxLength(field(name))).toBe(512)
    expect(await maxLength(field('Tags'))).toBe(4096)
    expect(await maxLength(field('Description'))).toBe(32768)

    // A paste past the limit keeps the first 512 characters.
    await field('Title').focus()
    await page.keyboard.insertText('t'.repeat(600))
    await field('Title').press('Tab')
    await info.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(info).toHaveCount(0)
    expect(await page.evaluate(() => window.editorTest.history.state.value.levelInfo.title)).toBe(
        't'.repeat(512),
    )

    // Group Properties: the stored 800-character name can be shortened while still over 512.
    await page.evaluate(async () => {
        const { openGroupProperties } = await window.editorTest.appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        void openGroupProperties(2 as never)
    })
    const properties = page.getByRole('dialog', { name: 'Group Properties' })
    const name = properties.getByRole('textbox', { name: 'Name', exact: true })
    await expect(name).toHaveValue(long)
    expect(await maxLength(name)).toBe(800)
    await name.press('End')
    for (let i = 0; i < 100; i++) await name.press('Backspace')
    await name.press('Tab')
    await expect.poll(() => groupNames(page)).toEqual(['Default', 'x'.repeat(700)])
    await page.keyboard.press('Escape')
    await expect(properties).toHaveCount(0)

    // Inline rename: 512 for a short name, the stored length for a longer one.
    await page.evaluate(() => {
        window.editorTest.settings.showGroups = true
    })
    const panel = page.locator('#workspace-panel-groups')
    const rename = panel.locator('.manager-rename')
    const rowName = (index: number) => panel.locator('.manager-entry .manager-name').nth(index)
    await rowName(0).focus()
    await page.keyboard.press('F2')
    await expect(rename).toBeFocused()
    expect(await maxLength(rename)).toBe(512)
    await page.keyboard.press('Escape')
    await expect(rename).toHaveCount(0)

    await rowName(1).focus()
    await page.keyboard.press('F2')
    await expect(rename).toHaveValue('x'.repeat(700))
    expect(await maxLength(rename)).toBe(700)
    await page.keyboard.press('End')
    for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await expect.poll(() => groupNames(page)).toEqual(['Default', 'x'.repeat(690)])
})
