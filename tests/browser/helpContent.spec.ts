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

const titles = (dialog: ReturnType<Page['locator']>) =>
    dialog.getByRole('heading', { level: 2 }).evaluateAll((headings) =>
        headings.map((heading) =>
            [...heading.childNodes]
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent)
                .join('')
                .trim(),
        ),
    )

// The shared lines that name a pointer: each has a Click sibling key for a mouse.
const pointerKeys = [
    ['gettingStarted', 'bpm'],
    ['gettingStarted', 'notes'],
    ['selectTool', 'select'],
    ['eraserTool', 'erase'],
    ['eraserTool', 'selection'],
    ['brushTool', 'brush'],
    ['pasteTool', 'paste'],
    ['generateSlideNotesTool', 'generate'],
    ['generateSlideNotesTool', 'generateMultiple'],
    ['adding', 'add'],
    ['adding', 'edit'],
    ['adding', 'modifiers'],
    ['noteTool', 'quickEdit'],
    ['slideTool', 'connect'],
    ['slideTool', 'quickEdit'],
    ['event', 'quickEdit'],
] as const

const lineText = (group: string, key: string) =>
    (modal as unknown as Record<string, Record<string, string>>)[group]![key]!

/** The text of the lines in every section except those with the given titles. */
const linesOutside = (dialog: ReturnType<Page['locator']>, skipped: string[]) =>
    dialog
        .locator('section')
        .evaluateAll(
            (sections, skipped) =>
                sections
                    .filter(
                        (section) =>
                            !skipped.includes(section.querySelector('h2')!.textContent!.trim()),
                    )
                    .flatMap((section) =>
                        [...section.querySelectorAll('li')].map((li) => li.textContent!),
                    ),
            skipped,
        )

const heading = (dialog: ReturnType<Page['locator']>, title: string) =>
    dialog.getByRole('heading', { level: 2, name: new RegExp(`^${title}( |$)`) })

test.describe('with a fine pointer', () => {
    test('Getting Started, Mouse and Keyboard come first and Touchscreen is before About', async ({
        page,
    }) => {
        await boot(page)
        const all = await titles(await openHelp(page))
        expect(all.slice(0, 4)).toEqual([
            modal.gettingStarted.title,
            modal.mouse.title,
            modal.keyboard.title,
            messages.help.fileTitle,
        ])
        expect(all.slice(-2)).toEqual([modal.touchscreen.title, messages.settings.about.title])
    })

    test('the shared lines say click, and only the Touchscreen section says tap', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        for (const [group, key] of pointerKeys) {
            await expect(dialog).toContainText(lineText(group, `${key}Click`))
            await expect(dialog).not.toContainText(lineText(group, key))
        }
        const lines = await linesOutside(dialog, [modal.touchscreen.title])
        expect(lines.filter((line) => /\btap/i.test(line))).toEqual([])
    })

    test('the right button line follows the Secondary Tool setting', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(dialog).toContainText(modal.mouse.contextMenu)
        await expect(dialog).not.toContainText(
            modal.mouse.secondary.slice(0, modal.mouse.secondary.indexOf('{0}')),
        )

        await page.evaluate(() => (window.editorTest.settings.mouseSecondaryTool = 'select'))
        await expect(dialog).toContainText(
            modal.mouse.secondary.replace('{0}', messages.commands.select.title),
        )
        await expect(dialog).not.toContainText(modal.mouse.contextMenu)

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
    })

    test('a tool heading shows its current shortcut, and none when it has no binding', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const note = heading(dialog, messages.commands.note.title.default)
        await expect(note.locator('kbd')).toHaveText('A')

        await page.evaluate(() => {
            const { settings } = window.editorTest
            settings.keyboardShortcuts = { ...settings.keyboardShortcuts, note: 'q' }
        })
        await expect(note.locator('kbd')).toHaveText('Q')

        const offset = heading(dialog, messages.commands.offset.title)
        await expect(offset).toBeVisible()
        await expect(offset.locator('kbd')).toHaveCount(0)
    })
})

test.describe('with a coarse pointer', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('Touchscreen comes after Getting Started, and Mouse and Keyboard are before About', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const all = await titles(dialog)
        expect(all.slice(0, 3)).toEqual([
            modal.gettingStarted.title,
            modal.touchscreen.title,
            messages.help.fileTitle,
        ])
        expect(all.slice(-3)).toEqual([
            modal.mouse.title,
            modal.keyboard.title,
            messages.settings.about.title,
        ])
    })

    test('the shared lines say tap, and only the Mouse section says click', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        for (const [group, key] of pointerKeys) {
            await expect(dialog).toContainText(lineText(group, key))
            await expect(dialog).not.toContainText(lineText(group, `${key}Click`))
        }
        const lines = await linesOutside(dialog, [modal.mouse.title])
        expect(lines.filter((line) => /\bclick/i.test(line))).toEqual([])
    })

    test('headings show no shortcuts', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(heading(dialog, messages.commands.note.title.default)).toBeVisible()
        await expect(dialog.locator('h2 kbd')).toHaveCount(0)
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
    const aboutTitle = messages.settings.about.title
    const aboutOf = (dialog: ReturnType<Page['locator']>) =>
        dialog.locator('section').filter({
            has: dialog.page().getByRole('heading', { name: aboutTitle, exact: true }),
        })

    test('is the last section, holds only the links and is laid out like the others', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const sections = dialog.locator('section')
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
