import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'
import { confirmReset } from './resetConfirm'

// Settings opens with its first screen (Editor and Local Data) and mounts the other sections in
// the frames after; a jump to one that is not there yet mounts up to it first.

const SECTIONS = 10

const boot = async (page: Page) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

/** Opens Settings and runs `act` in the first frame that shows it, before any later section mounts. */
const openAndAct = (page: Page, act: 'pill:about' | 'pill:keyboardShortcuts' | 'close' | 'reset') =>
    page.evaluate(async (act) => {
        const { openSettings } =
            (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
        void openSettings()
        return new Promise<boolean>((resolve) => {
            const poll = () => {
                const dialog = document.querySelector('dialog[open]')
                if (!dialog?.querySelector('[data-settings-pill]'))
                    return void requestAnimationFrame(poll)
                // The deferred sections are not there yet.
                const early = !document.getElementById('settings-about')
                if (act === 'close')
                    dialog.querySelector<HTMLElement>('button[aria-label="Close"]')?.click()
                else if (act === 'reset')
                    [...dialog.querySelectorAll<HTMLElement>('button')]
                        .find((button) => button.textContent.trim() === 'Reset Settings')
                        ?.click()
                else
                    dialog
                        .querySelector<HTMLElement>(`[data-settings-pill="${act.slice(5)}"]`)
                        ?.click()
                resolve(early)
            }
            poll()
        })
    }, act)

const mounted = (page: Page) =>
    expect(page.locator('[data-settings-section]')).toHaveCount(SECTIONS)

/** The heading's distance below the top of the scrolling part of the dialog. */
const below = (page: Page, id: string) =>
    page.evaluate((id) => {
        const section = document.getElementById(`settings-${id}`)!
        const scroller = section.parentElement!
        return section.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    }, id)

const sections = (page: Page) =>
    page.evaluate(() =>
        [...document.querySelectorAll('[data-settings-section]')].map((section) =>
            section.getAttribute('data-settings-section'),
        ),
    )

test('the dialog opens with Editor and Local Data, and the other sections follow', async ({
    page,
}) => {
    await boot(page)
    // Sampled in the page: the first frame that shows the dialog has the first screen only.
    const first = await page.evaluate(async () => {
        const { openSettings } =
            (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
        void openSettings()
        return new Promise<(string | null)[]>((resolve) => {
            const poll = () => {
                if (!document.querySelector('dialog[open] [data-settings-pill]'))
                    return void requestAnimationFrame(poll)
                resolve(
                    [...document.querySelectorAll('[data-settings-section]')].map((section) =>
                        section.getAttribute('data-settings-section'),
                    ),
                )
            }
            poll()
        })
    })
    expect(first).toEqual(['editor', 'localData'])
    await mounted(page)
    expect(await sections(page)).toEqual([
        'editor',
        'localData',
        'panels',
        'preview',
        'toolbar',
        'play',
        'touch',
        'mouse',
        'keyboardShortcuts',
        'about',
    ])
    // Every shortcut row is there.
    expect(await page.locator('#settings-keyboardShortcuts .form-field').count()).toBeGreaterThan(
        100,
    )
})

for (const target of ['about', 'keyboardShortcuts'] as const) {
    for (const profile of [
        { name: 'desktop', viewport: { width: 1280, height: 800 }, locale: 'en' },
        { name: 'phone in French', viewport: { width: 390, height: 844 }, locale: 'fr' },
    ] as const) {
        test(`a ${target} pill pressed in the first frame lands on it (${profile.name})`, async ({
            page,
        }) => {
            await page.setViewportSize(profile.viewport)
            await boot(page)
            await page.evaluate((locale) => {
                window.editorTest.settings.locale = locale
            }, profile.locale)
            expect(await openAndAct(page, `pill:${target}`)).toBe(true)
            const heading = page.locator(`#settings-${target} [data-settings-heading]`)
            await expect(heading).toBeFocused()
            await expect(heading).toBeInViewport()
            await mounted(page)
            // Nothing mounted since has moved it: it was placed after the labels above it fitted.
            const settled = await below(page, target)
            await page.evaluate(
                () =>
                    new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100))),
            )
            expect(Math.abs((await below(page, target)) - settled)).toBeLessThan(2)
            await expect(heading).toBeInViewport()
            // Where a pill puts a section when everything is there already (the gap above it is 32 px).
            if (target === 'keyboardShortcuts') expect(settled).toBeLessThan(40)
        })
    }
}

test('Settings closed in its first frame leaves nothing behind, and opens whole again', async ({
    page,
}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
    })
    await boot(page)
    expect(await openAndAct(page, 'close')).toBe(true)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // Time for the stages that would have followed.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))
    await expect(page.locator('[data-settings-section]')).toHaveCount(0)
    await page.keyboard.press(',')
    await mounted(page)
    expect(errors).toEqual([])
})

test('Reset Settings in the first frame applies to the sections that mount after', async ({
    page,
}) => {
    await boot(page)
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.previewHighlightSelection = false
        settings.touchQuickScrollWidth = 77
    })
    expect(await openAndAct(page, 'reset')).toBe(true)
    await confirmReset(page, 'Reset Settings')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await mounted(page)
    const dialog = page.getByRole('dialog')
    await expect(
        dialog.getByRole('switch', { name: 'Highlight Selection', exact: true }),
    ).toBeChecked()
    expect(await page.evaluate(() => window.editorTest.settings.touchQuickScrollWidth)).not.toBe(77)
    await expect(
        dialog.getByRole('spinbutton', { name: /Quick Scroll Zone Width/ }),
    ).not.toHaveValue('77')
})

test('each label is fitted once when Settings opens', async ({ page }) => {
    await page.addInitScript(() => {
        // A fit reads the computed style of the label's text once.
        const counts = new Map<Element, number>()
        ;(window as unknown as { fitCounts: typeof counts }).fitCounts = counts
        const original = window.getComputedStyle.bind(window)
        window.getComputedStyle = (element: Element, pseudo?: string | null) => {
            if (element.classList.contains('form-field-text'))
                counts.set(element, (counts.get(element) ?? 0) + 1)
            return original(element, pseudo)
        }
    })
    await boot(page)
    await page.keyboard.press(',')
    await mounted(page)
    // The frames a second fit would come in.
    for (let frame = 0; frame < 5; frame++)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    const fits = await page.evaluate(() => {
        const counts = (window as unknown as { fitCounts: Map<Element, number> }).fitCounts
        const texts = [...document.querySelectorAll('dialog[open] .form-field-text')]
        return {
            fields: texts.length,
            most: Math.max(...texts.map((text) => counts.get(text) ?? 0)),
        }
    })
    expect(fits.fields).toBeGreaterThan(150)
    expect(fits.most).toBe(1)
})
