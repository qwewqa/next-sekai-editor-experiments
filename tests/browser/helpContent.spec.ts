import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type english from '../../src/i18n/en/index.json'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { REPOSITORY } from './sourceRepository'

// Help: the order of its sections by pointer, and the lines and shortcuts that depend on the
// settings.

const messages = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english
const { modal } = messages.help

const sectionTitles = Object.values(messages.help.sections)
const aboutTitle = messages.settings.about.title

const boot = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

const openHelp = async (page: Page) => {
    await page.evaluate(async () => {
        const { commands } =
            (await import('/src/editor/commands/index.ts')) as typeof import('../../src/editor/commands')
        const { runCommand } =
            (await import('/src/editor/commands/runCommand.ts')) as typeof import('../../src/editor/commands/runCommand')
        await runCommand(commands.help, 'button')
    })
    const dialog = page.getByRole('dialog', { name: modal.title })
    await expect(dialog).toBeVisible()
    return dialog
}

const textOf = (headings: Element[]) =>
    headings.map((heading) =>
        [...heading.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join('')
            .trim(),
    )

const sectionHeadings = (dialog: ReturnType<Page['locator']>) =>
    dialog.getByRole('heading', { level: 2 }).evaluateAll(textOf)

/** The entries of Controls, in order, by the id of the entry. */
const controlsEntries = (dialog: ReturnType<Page['locator']>) =>
    dialog
        .locator('#help-controls [id^="help-entry-"]')
        .evaluateAll((entries) => entries.map((entry) => entry.id.replace('help-entry-', '')))

// The shared lines that name a pointer: each has a Click sibling key for a mouse.
const pointerKeys = [
    'modal.selectTool.select',
    'modal.eraserTool.erase',
    'modal.eraserTool.selection',
    'modal.brushTool.brush',
    'modal.pasteTool.paste',
    'modal.generateSlideNotesTool.generate',
    'modal.adding.add',
    'modal.adding.edit',
    'modal.adding.modifiers',
    'modal.noteTool.quickEdit',
    'modal.slideTool.connect',
    'slideTool.quickEditPanel',
    'event.easeStep',
    'history.view',
    'groups.current',
    'stages.current',
    'preview.drag',
    'minimap.overview',
] as const

const lineText = (path: string) =>
    path
        .split('.')
        .reduce<unknown>(
            (value, key) => (value as Record<string, unknown>)[key],
            messages.help,
        ) as string

/** The text of the lines in every entry except those with the given ids. */
const linesOutside = (dialog: ReturnType<Page['locator']>, skipped: string[]) =>
    dialog
        .locator('[id^="help-entry-"]')
        .evaluateAll(
            (entries, skipped) =>
                entries
                    .filter((entry) => !skipped.includes(entry.id.replace('help-entry-', '')))
                    .flatMap((entry) =>
                        [...entry.querySelectorAll('li')].map((li) => li.textContent!),
                    ),
            skipped,
        )

const heading = (dialog: ReturnType<Page['locator']>, title: string) =>
    dialog.getByRole('heading', { level: 3, name: new RegExp(`^${title}( |,|$)`) })

test.describe('with a fine pointer', () => {
    test('the sections come in order, with About last', async ({ page }) => {
        await boot(page)
        expect(await sectionHeadings(await openHelp(page))).toEqual([...sectionTitles, aboutTitle])
    })

    test('Controls has Mouse and Keyboard first, then the basics, and Touchscreen last', async ({
        page,
    }) => {
        await boot(page)
        expect(await controlsEntries(await openHelp(page))).toEqual([
            'mouse',
            'keyboard',
            'adding',
            'toolbarPanels',
            'touch',
        ])
    })

    test('the shared lines say click, and only the Touchscreen entry says tap', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        for (const key of pointerKeys) {
            await expect(dialog).toContainText(lineText(`${key}Click`))
            await expect(dialog).not.toContainText(lineText(key))
        }
        const lines = await linesOutside(dialog, ['touch'])
        expect(lines.filter((line) => /\btap/i.test(line))).toEqual([])
    })

    test('the right button lines follow the Secondary Tool setting', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(dialog).toContainText(modal.mouse.contextMenu)
        await expect(dialog).toContainText(messages.help.mouse.deselect)
        await expect(dialog).not.toContainText(
            modal.mouse.secondary.slice(0, modal.mouse.secondary.indexOf('{0}')),
        )

        await page.evaluate(() => (window.editorTest.settings.mouseSecondaryTool = 'select'))
        await expect(dialog).toContainText(
            modal.mouse.secondary.replace('{0}', messages.commands.select.title),
        )
        await expect(dialog).not.toContainText(modal.mouse.contextMenu)
        await expect(dialog).not.toContainText(messages.help.mouse.deselect)

        await page.evaluate(() => (window.editorTest.settings.mouseSecondaryTool = 'eraser'))
        await expect(dialog).toContainText(
            modal.mouse.secondary.replace('{0}', messages.commands.eraser.title),
        )
    })

    test('the long press and quick scroll lines follow their settings', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(dialog).toContainText(modal.touchscreen.longPress)
        await expect(dialog).toContainText(modal.touchscreen.quickScroll)

        await page.evaluate(() => {
            window.editorTest.settings.touchLongPressContextMenu = false
            window.editorTest.settings.touchQuickScrollWidth = 0
        })
        await expect(dialog).not.toContainText(modal.touchscreen.longPress)
        await expect(dialog).not.toContainText(modal.touchscreen.quickScroll)
        await expect(dialog).toContainText(modal.touchscreen.scroll)
        // A mouse always has the right button for a panel tab.
        await expect(dialog).toContainText(messages.help.toolbarPanels.panelTabClick)
    })

    test('Deselect has an entry only while it switches to Select', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(heading(dialog, messages.commands.deselect.title)).toBeVisible()
        await expect(dialog).toContainText(messages.help.deselect.select)

        await page.evaluate(() => (window.editorTest.settings.deselectSwitchesToSelect = false))
        await expect(heading(dialog, messages.commands.deselect.title)).toHaveCount(0)
        await expect(dialog).not.toContainText(messages.help.deselect.select)
    })

    test('a tool heading shows its current shortcut, and none when it has no binding', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const note = heading(dialog, messages.commands.note.title.default)
        await expect(note.locator('kbd').first()).toHaveText('A')

        await page.evaluate(() => {
            const { settings } = window.editorTest
            settings.keyboardShortcuts = { ...settings.keyboardShortcuts, note: 'q' }
        })
        await expect(note.locator('kbd').first()).toHaveText('Q')

        const offset = heading(dialog, messages.commands.offset.title)
        await expect(offset).toBeVisible()
        await expect(offset.locator('kbd')).toHaveCount(0)
    })
})

test.describe('with a coarse pointer', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('Controls has Touchscreen first, then the basics, and Mouse and Keyboard last', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        expect(await controlsEntries(dialog)).toEqual([
            'touch',
            'adding',
            'toolbarPanels',
            'mouse',
            'keyboard',
        ])
        expect(await sectionHeadings(dialog)).toEqual([...sectionTitles, aboutTitle])
    })

    test('the shared lines say tap, and only the Mouse entry says click', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        for (const key of pointerKeys) {
            await expect(dialog).toContainText(lineText(key))
            await expect(dialog).not.toContainText(lineText(`${key}Click`))
        }
        const lines = await linesOutside(dialog, ['mouse'])
        expect(lines.filter((line) => /\bclick/i.test(line))).toEqual([])
    })

    test('the panel tab line follows the Long-Press for Context Menu setting', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(dialog).toContainText(messages.help.toolbarPanels.panelTab)
        await page.evaluate(() => (window.editorTest.settings.touchLongPressContextMenu = false))
        await expect(dialog).not.toContainText(messages.help.toolbarPanels.panelTab)
    })

    test('headings show no shortcuts', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(heading(dialog, messages.commands.note.title.default)).toBeVisible()
        await expect(dialog.locator('h3 kbd')).toHaveCount(0)
    })

    test('the About links wrap inside the dialog', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const links = dialog.locator('[data-about-link]')
        await links.last().scrollIntoViewIfNeeded()
        const box = await dialog.boundingBox()
        for (const link of await links.all()) {
            const linkBox = (await link.boundingBox())!
            expect(linkBox.x).toBeGreaterThanOrEqual(box!.x)
            expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(box!.x + box!.width)
        }
        // The dialog body scrolls vertically only.
        expect(
            await links.first().evaluate((link) => {
                const body = link.closest('.overflow-y-auto')!
                return body.scrollWidth <= body.clientWidth
            }),
        ).toBe(true)
    })
})

// The About section ends Help with the links of Settings › About; settingsAbout.spec.ts checks
// that the two rows agree.
test.describe('About', () => {
    const aboutOf = (dialog: ReturnType<Page['locator']>) =>
        dialog.locator('section[data-help-section]').filter({
            has: dialog.page().getByRole('heading', { name: aboutTitle, exact: true }),
        })

    test('is the last section, holds only the links and is laid out like the others', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const sections = dialog.locator('section[data-help-section]')
        const about = aboutOf(dialog)
        await expect(about).toHaveCount(1)
        await expect(sections.last()).toContainText(aboutTitle)
        await expect(about.locator('[data-about-link]').first()).toBeVisible()
        await expect(about.locator('ul, li')).toHaveCount(0)
        await expect(
            about.locator(
                'button, input, [data-about-name], [data-about-version], [data-about-usage-statistics], [data-about-diagnostics]',
            ),
        ).toHaveCount(0)

        const layout = await sections.evaluateAll((all) =>
            all.map((section) => {
                const heading = section.querySelector('h2')!
                const style = getComputedStyle(heading)
                return {
                    type: [style.fontSize, style.fontWeight, style.lineHeight].join(' '),
                    left: heading.getBoundingClientRect().left,
                    headingToContent:
                        heading.nextElementSibling!.getBoundingClientRect().top -
                        heading.getBoundingClientRect().bottom,
                    top: section.getBoundingClientRect().top,
                    bottom: section.getBoundingClientRect().bottom,
                }
            }),
        )
        const gaps = layout.slice(1).map((section, i) => section.top - layout[i]!.bottom)
        expect(new Set(layout.map((section) => section.type)).size).toBe(1)
        expect(new Set(layout.map((section) => section.left)).size).toBe(1)
        expect(new Set(layout.map((section) => section.headingToContent)).size).toBe(1)
        expect(new Set(gaps).size).toBe(1)
    })

    test('the links come last in Tab order and keep their names', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const links = aboutOf(dialog).getByRole('link')
        const count = await links.count()
        expect(count).toBeGreaterThan(1)
        // The arrow is hidden from the name, so each name is the label alone.
        await expect(dialog.getByRole('link', { name: 'Source Code', exact: true })).toBeVisible()

        const stops = await dialog
            .locator('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
            .evaluateAll((all) => all.map((element) => element.hasAttribute('data-about-link')))
        expect(stops.slice(-count).every(Boolean)).toBe(true)
        expect(stops.slice(0, -count).some(Boolean)).toBe(false)

        await links.first().focus()
        for (let i = 0; i < count; i++) {
            await expect(links.nth(i)).toBeFocused()
            if (i < count - 1) await page.keyboard.press('Tab')
        }
    })

    test('a link opens in a new page and leaves Help open', async ({ page, context }) => {
        await context.route('https://github.com/**', (route) =>
            route.fulfill({ body: 'ok', contentType: 'text/html' }),
        )
        await boot(page)
        const dialog = await openHelp(page)
        const popup = page.waitForEvent('popup')
        await dialog.getByRole('link', { name: 'Source Code', exact: true }).click()
        expect((await popup).url()).toBe(`https://github.com/${REPOSITORY}`)
        expect(page.url()).toMatch(/127\.0\.0\.1/)
        await expect(dialog).toBeVisible()
    })
})
