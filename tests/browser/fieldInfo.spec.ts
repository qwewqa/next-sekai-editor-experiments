import { expect, test, type Locator, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, touchInput } from './editorFixture'

// The info button after a described setting's label, and its bubble: the inventory in Settings,
// the hit area, the names, and opening and closing by mouse, keyboard and touch; overflow,
// placement and long locales.

const boot = async (page: Page, locale?: string) => {
    await page.addInitScript(installCanvasCounters)
    if (locale)
        await page.addInitScript((locale) => {
            localStorage.setItem('sonolus-next-sekai-editor.locale', JSON.stringify(locale))
        }, locale)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

/** Opens Settings and waits until every section has mounted. */
const openSettings = async (page: Page) => {
    await page.keyboard.press(',')
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('[data-settings-section="about"]')).toBeAttached()
    await expect(dialog.locator('select').first()).toBeFocused()
    return dialog
}

/** The described field labelled `name`, its info button and the open bubble. */
const field = (dialog: Locator, name: string) => {
    const root = dialog.locator('.form-field').filter({
        has: dialog.page().locator('.form-field-text', {
            hasText: new RegExp(
                `^${name.replace(/[()]/g, String.raw`\$&`).replace(/ /g, String.raw`\s*`)}$`,
            ),
        }),
    })
    return { root, info: root.locator('[data-field-info]') }
}
const bubble = (page: Page) => page.locator('[data-field-info-bubble]')

/** When the bubble last appeared and went, against the last pointer enter and leave on a button. */
const watchTimes = (page: Page) =>
    page.evaluate(() => {
        const times = { enter: 0, leave: 0, shown: 0, gone: 0 }
        ;(window as { infoTimes?: typeof times }).infoTimes = times
        document.addEventListener(
            'pointerover',
            (event) => {
                if ((event.target as Element).closest?.('[data-field-info]'))
                    times.enter = performance.now()
            },
            true,
        )
        document.addEventListener(
            'pointerout',
            (event) => {
                if ((event.target as Element).closest?.('[data-field-info]'))
                    times.leave = performance.now()
            },
            true,
        )
        new MutationObserver(() => {
            const open = document.querySelector('[data-field-info-bubble]') !== null
            if (open && !times.shown) times.shown = performance.now()
            if (!open && times.shown && !times.gone) times.gone = performance.now()
        }).observe(document.body, { childList: true, subtree: true })
    })
const times = (page: Page) =>
    page.evaluate(
        () =>
            (
                window as {
                    infoTimes?: { enter: number; leave: number; shown: number; gone: number }
                }
            ).infoTimes!,
    )

const box = async (locator: Locator) => {
    const value = await locator.boundingBox()
    if (!value) throw new Error('not visible')
    return value
}

test.describe('in Settings', () => {
    test.beforeEach(async ({ page }) => {
        await boot(page)
    })

    test('34 described rows, each with a 24 px face, a 44 px target and exact names', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        await expect(dialog.locator('[data-field-info]')).toHaveCount(34)
        const { root, info } = field(dialog, 'Name Contrast')
        await expect(info).toHaveAccessibleName('About Name Contrast')
        const toggle = root.getByRole('switch')
        await expect(toggle).toHaveAccessibleName('Name Contrast')
        await expect(toggle).toHaveAccessibleDescription(
            'Outlines group and stage names in black and brightens stage names.',
        )
        await expect(info).toHaveAccessibleDescription(
            'Outlines group and stage names in black and brightens stage names.',
        )
        // A select and a number field are named by their label's text alone, too.
        await expect(
            field(dialog, 'Waveform Visualization').root.getByRole('combobox'),
        ).toHaveAccessibleName('Waveform Visualization')
        await expect(
            field(dialog, 'Render Scale').root.getByRole('spinbutton'),
        ).toHaveAccessibleName('Render Scale')
        await info.scrollIntoViewIfNeeded()
        const face = await box(info)
        expect(face.width).toBeCloseTo(24, 0)
        expect(face.height).toBeCloseTo(24, 0)
        // The target reaches 21 px from the centre on every side; the control keeps its own edge.
        const hits = await info.evaluate((button) => {
            const { left, top, width, height } = button.getBoundingClientRect()
            const x = left + width / 2
            const y = top + height / 2
            return [
                [x - 21, y],
                [x + 21, y],
                [x, y - 21],
                [x, y + 21],
            ].map(([px, py]) => document.elementFromPoint(px!, py!) === button)
        })
        expect(hits).toEqual([true, true, true, true])
        const control = await box(toggle)
        expect(
            await page.evaluate(
                ({ x, y }) =>
                    (document.elementFromPoint(x, y) as HTMLElement | null)?.getAttribute('role'),
                { x: control.x + 2, y: control.y + control.height / 2 },
            ),
        ).toBe('switch')
        // A press on the label's text presses the switch, not the info button.
        const before = await toggle.getAttribute('aria-checked')
        await root.locator('.form-field-text').click()
        await expect(toggle).not.toHaveAttribute('aria-checked', before!)
        await expect(bubble(page)).toHaveCount(0)
    })

    test("a select's lines follow its sentence, named and ordered as its options", async ({
        page,
    }) => {
        // The locale lists the choices in the reverse of the select's order.
        await page.evaluate(async () => {
            const { i18n } =
                await window.editorTest.appImport<typeof import('../../src/i18n')>(
                    '/src/i18n/index.ts',
                )
            const description = i18n.value.settings.descriptions.elevationEditorSideBySide
            const { auto, allow, disallow } = description.choices
            description.choices = { disallow, allow, auto }
        })
        const dialog = await openSettings(page)
        const { root, info } = field(dialog, 'Elevation Editor Side by Side')
        const intro = 'Sets whether the Elevation Editor opens beside the chart or in place of it.'
        const lines = [
            'Auto: Opens it beside the chart when there is room.',
            'Always: Opens it beside the chart even when the chart gets narrow.',
            'Never: Opens it in place of the chart.',
        ]
        await info.scrollIntoViewIfNeeded()
        await info.click()
        const shown = bubble(page)
        await expect(shown.locator('p')).toHaveText(intro)
        await expect(shown.locator('li')).toHaveText(lines)
        await expect(shown.locator('li > span')).toHaveText(['Auto: ', 'Always: ', 'Never: '])
        const layout = await shown.locator('p, li').evaluateAll((elements) =>
            elements.map((element) => {
                const { top, bottom, left } = element.getBoundingClientRect()
                const style = getComputedStyle(element)
                const name = element.querySelector('span')
                return {
                    top,
                    bottom,
                    left,
                    padding: style.paddingLeft,
                    indent: style.textIndent,
                    marker: style.listStyleType,
                    before: getComputedStyle(element, '::before').content,
                    weight: name && getComputedStyle(name).fontWeight,
                    sameInk: !name || getComputedStyle(name).color === style.color,
                }
            }),
        )
        // 8 px after the sentence and 4 px between lines.
        expect(layout[1]!.top - layout[0]!.bottom).toBeCloseTo(8, 0)
        for (let index = 2; index < layout.length; index++)
            expect(layout[index]!.top - layout[index - 1]!.bottom).toBeCloseTo(4, 0)
        // Each line starts at the sentence's left edge, with no indent or bullet, so wrapped
        // lines stay flush left; the names are semibold in the same ink.
        for (const line of layout.slice(1)) {
            expect(line.left).toBeCloseTo(layout[0]!.left, 0)
            expect(line).toMatchObject({
                padding: '0px',
                indent: '0px',
                marker: 'none',
                before: 'none',
                weight: '600',
                sameInk: true,
            })
        }
        // Screen readers hear the sentence and then each line, on the control and the button.
        const spoken = [intro, ...lines].join(' ')
        await expect(root.getByRole('combobox')).toHaveAccessibleDescription(spoken)
        await expect(info).toHaveAccessibleDescription(spoken)
    })

    test("Show Quick Scroll Zone's description is its own", async ({ page }) => {
        const dialog = await openSettings(page)
        const { root, info } = field(dialog, 'Show Quick Scroll Zone')
        const intro =
            'Sets when to shade the zone at the chart’s right edge where you can scroll with one finger.'
        const lines = [
            'On: Shades the zone on any device.',
            'Off: Leaves the zone unshaded.',
            'Touch Screens Only: Shades the zone when touch input is available.',
        ]
        await expect(root.getByRole('combobox')).toHaveAccessibleDescription(
            [intro, ...lines].join(' '),
        )
        await info.scrollIntoViewIfNeeded()
        await info.click()
        await expect(bubble(page).locator('p')).toHaveText(intro)
        await expect(bubble(page).locator('li')).toHaveText(lines)
    })

    test('a mouse opens it after 400 ms and closes it 150 ms after leaving; a click pins it', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        await watchTimes(page)
        const { info } = field(dialog, 'Show Other Groups')
        await info.scrollIntoViewIfNeeded()
        await info.hover()
        await expect(bubble(page)).toHaveText(
            'Shows objects in other groups, faded, while a group is focused.',
        )
        await expect(info).toHaveAttribute('aria-expanded', 'true')
        const opened = await times(page)
        expect(opened.shown - opened.enter).toBeGreaterThanOrEqual(390)
        await page.mouse.move(5, 5)
        await expect(bubble(page)).toHaveCount(0)
        const closed = await times(page)
        expect(closed.gone - closed.leave).toBeGreaterThanOrEqual(140)

        // Pinned, it stays when the pointer leaves, and a second click closes it. The click
        // never reaches the switch in the same label.
        const toggle = field(dialog, 'Show Other Groups').root.getByRole('switch')
        const checked = await toggle.getAttribute('aria-checked')
        await info.click()
        await expect(toggle).toHaveAttribute('aria-checked', checked!)
        await expect(bubble(page)).toBeVisible()
        await page.mouse.move(5, 5)
        await page.waitForTimeout(400)
        await expect(bubble(page)).toBeVisible()
        await info.click()
        await expect(bubble(page)).toHaveCount(0)
    })

    test('the pointer can move into the bubble and wheel it; Escape closes it and Settings stays', async ({
        page,
    }) => {
        await page.evaluate(async () => {
            const { i18n } =
                await window.editorTest.appImport<typeof import('../../src/i18n')>(
                    '/src/i18n/index.ts',
                )
            i18n.value.settings.descriptions.previewInWorker = Array(30)
                .fill('A line long enough to make the bubble scroll.')
                .join(' ')
        })
        const dialog = await openSettings(page)
        const { info } = field(dialog, 'Parallel Rendering')
        await info.scrollIntoViewIfNeeded()
        await info.hover()
        const shown = bubble(page)
        await expect(shown).toBeVisible()
        const scroller = shown.locator('[tabindex="-1"]')
        expect(
            await scroller.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true)
        const area = await box(shown)
        await page.mouse.move(area.x + area.width / 2, area.y + 10, { steps: 4 })
        await page.mouse.wheel(0, 200)
        await expect
            .poll(() => scroller.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0)
        await page.waitForTimeout(300)
        await expect(shown).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(shown).toHaveCount(0)
        await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
    })

    test('the keyboard: Tab opens it after the delay, Enter pins and closes, Escape and Tab away close', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        const { root, info } = field(dialog, 'Zero-Width Notes')
        // From the field before it, Tab lands on the info button.
        await field(dialog, 'Waveform Visualization').root.locator('select').focus()
        await page.keyboard.press('Tab')
        await expect(info).toBeFocused()
        await expect(bubble(page).locator('p')).toHaveText(
            'Sets which notes can be made zero lanes wide with the editing tools.',
        )
        await page.keyboard.press('Enter')
        await expect(info).toHaveAttribute('aria-expanded', 'true')
        await page.keyboard.press('Enter')
        await expect(bubble(page)).toHaveCount(0)
        await page.keyboard.press('Enter')
        await expect(bubble(page)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(bubble(page)).toHaveCount(0)
        await expect(info).toBeFocused()
        await expect(dialog).toBeVisible()
        await page.keyboard.press('Enter')
        await expect(bubble(page)).toBeVisible()
        await page.keyboard.press('Tab')
        await expect(root.locator('select')).toBeFocused()
        await expect(bubble(page)).toHaveCount(0)
    })

    test('Escape after a click inside the bubble closes it for good and focuses the button', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        const { info } = field(dialog, 'Zero-Width Notes')
        await info.click()
        const scroller = bubble(page).locator('[tabindex="-1"]')
        await scroller.click()
        await expect(scroller).toBeFocused()
        // The pointer leaves for the dialog's title bar, where no button could show a bubble.
        const frame = await box(dialog)
        const [x, y] = [frame.x + frame.width / 2, frame.y + 20]
        expect(
            await page.evaluate(
                ([x, y]) =>
                    document
                        .elementsFromPoint(x!, y!)
                        .some((el) => el.closest('[data-field-info]')),
                [x, y],
            ),
        ).toBe(false)
        await page.mouse.move(x, y)
        await page.keyboard.press('Escape')
        await expect(bubble(page)).toHaveCount(0)
        await expect(info).toBeFocused()
        // Past the 400 ms a keyboard focus waits before it shows the bubble.
        await page.waitForTimeout(600)
        await expect(bubble(page)).toHaveCount(0)
    })

    test('one bubble at a time, never over its own field, and nothing around it moves', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        const first = field(dialog, 'Show Other Groups')
        const second = field(dialog, 'Show Other Stages')
        await first.info.scrollIntoViewIfNeeded()
        const rows = dialog.locator('[data-settings-section="editor"] .form-field')
        const before = await rows.evaluateAll((elements) =>
            elements.map((element) => JSON.stringify(element.getBoundingClientRect())),
        )
        await first.info.click()
        await expect(bubble(page)).toBeVisible()
        const over = await box(bubble(page))
        const row = await box(first.root)
        expect(over.y).toBeGreaterThanOrEqual(row.y + row.height)
        await page.evaluate(
            () =>
                new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
        )
        expect(
            await rows.evaluateAll((elements) =>
                elements.map((element) => JSON.stringify(element.getBoundingClientRect())),
            ),
        ).toEqual(before)
        await second.info.click()
        await expect(bubble(page)).toHaveCount(1)
        await expect(bubble(page)).toHaveText(
            'Shows objects on other stages, faded, while a stage is focused.',
        )
        await expect(first.info).toHaveAttribute('aria-expanded', 'false')
    })
})

test("in Japanese, a choice's name takes the locale's colon", async ({ page }) => {
    await boot(page, 'ja')
    const dialog = await openSettings(page)
    const { root, info } = field(dialog, '高さエディターを並べて表示')
    await expect(root.getByRole('combobox')).toHaveAccessibleDescription(
        / 常に：譜面の幅が狭くなっても、譜面の横に開きます。 /,
    )
    await info.scrollIntoViewIfNeeded()
    await info.click()
    await expect(bubble(page).locator('li > span')).toHaveText(['自動：', '常に：', 'しない：'])
})

test.describe('on touch', () => {
    test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

    test.beforeEach(async ({ page }) => {
        await boot(page)
    })

    test('a tap opens it, a tap inside keeps it, a tap on another switch closes it and toggles', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        const { info } = field(dialog, 'Show Other Groups')
        await info.scrollIntoViewIfNeeded()
        await info.tap()
        const shown = bubble(page)
        await expect(shown).toBeVisible()
        await shown.tap()
        await page.waitForTimeout(300)
        await expect(shown).toBeVisible()
        const other = field(dialog, 'Show Stage Name').root.getByRole('switch')
        const before = await other.getAttribute('aria-checked')
        await other.tap()
        await expect(shown).toHaveCount(0)
        await expect(other).not.toHaveAttribute('aria-checked', before!)
    })

    test('a swipe on the list closes it', async ({ page }) => {
        const dialog = await openSettings(page)
        const { info } = field(dialog, 'Show Other Groups')
        await info.scrollIntoViewIfNeeded()
        await info.tap()
        await expect(bubble(page)).toBeVisible()
        const list = await box(field(dialog, 'Show Group Name').root)
        const touch = await touchInput(page)
        const x = list.x + 40
        const y = list.y + list.height / 2
        await touch('touchStart', [[x, y]])
        for (let step = 1; step <= 5; step++) await touch('touchMove', [[x, y - step * 20]])
        await touch('touchEnd', [])
        await expect(bubble(page)).toHaveCount(0)
    })

    test('a visual viewport resize, as the keyboard shows and hides, places it again', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        const target = field(dialog, 'Preview Duration (ms)')
        await target.info.evaluate((button) => button.scrollIntoView({ block: 'center' }))
        await target.info.tap()
        const shown = bubble(page)
        await expect(shown).toBeVisible()
        const row = await box(target.root)
        expect((await box(shown)).y).toBeGreaterThanOrEqual(row.y + row.height)
        // The keyboard covers what is below the row: the visual viewport ends 20 px under it.
        const resize = (height: number | undefined) =>
            page.evaluate((height) => {
                const viewport = window.visualViewport!
                if (height === undefined) delete (viewport as { height?: number }).height
                else
                    Object.defineProperty(viewport, 'height', { configurable: true, value: height })
                viewport.dispatchEvent(new Event('resize'))
            }, height)
        await resize(row.y + row.height + 20)
        await expect
            .poll(async () => (await box(shown)).y + (await box(shown)).height)
            .toBeLessThanOrEqual(row.y)
        // The keyboard hides: back under the row.
        await resize(undefined)
        await expect
            .poll(async () => (await box(shown)).y)
            .toBeGreaterThanOrEqual(row.y + row.height)
    })
})

test.describe('at 320 x 256 in French', () => {
    test.use({ hasTouch: true, viewport: { width: 320, height: 256 } })

    test('the bubble fits beside its field, and a longer one scrolls inside by touch and by keys', async ({
        page,
    }) => {
        await boot(page, 'fr')
        let dialog = await openSettings(page)
        let { root, info } = field(dialog, 'Rendu en parallèle')
        await info.evaluate((button) => button.scrollIntoView({ block: 'center' }))
        await info.tap()
        let area = await box(bubble(page))
        const row = await box(root)
        expect(area.y).toBeGreaterThanOrEqual(8)
        expect(area.y + area.height).toBeLessThanOrEqual(256 - 8)
        expect(area.y + area.height <= row.y || area.y >= row.y + row.height).toBe(true)
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)

        // A description too long for either side.
        await page.evaluate(async () => {
            const { i18n } =
                await window.editorTest.appImport<typeof import('../../src/i18n')>(
                    '/src/i18n/index.ts',
                )
            i18n.value.settings.descriptions.previewInWorker = Array(12)
                .fill(i18n.value.settings.descriptions.previewInWorker)
                .join(' ')
        })
        dialog = await openSettings(page)
        ;({ root, info } = field(dialog, 'Rendu en parallèle'))
        await info.evaluate((button) => button.scrollIntoView({ block: 'center' }))
        const listTop = () => info.evaluate((button) => button.closest('.scroll-edges')!.scrollTop)
        const before = await listTop()
        await info.tap()
        const shown = bubble(page)
        await expect(shown).toBeVisible()
        const scroller = shown.locator('[tabindex="-1"]')
        expect(
            await scroller.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true)
        area = await box(shown)
        expect(area.y).toBeGreaterThanOrEqual(8)
        expect(area.y + area.height).toBeLessThanOrEqual(256 - 8)
        // A drag inside scrolls the bubble, not the list.
        const touch = await touchInput(page)
        const x = area.x + area.width / 2
        const y = area.y + area.height - 10
        await touch('touchStart', [[x, y]])
        for (let step = 1; step <= 4; step++) await touch('touchMove', [[x, y - step * 10]])
        await touch('touchEnd', [])
        await expect
            .poll(() => scroller.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0)
        await expect(shown).toBeVisible()
        expect(await listTop()).toBe(before)

        // With focus on the button, the scroll keys reach the end and focus stays.
        await scroller.evaluate((element) => element.scrollTo({ top: 0 }))
        await info.focus()
        for (const key of ['ArrowDown', 'PageDown', 'End']) await page.keyboard.press(key)
        await expect
            .poll(() =>
                scroller.evaluate(
                    (element) =>
                        element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
                ),
            )
            .toBe(true)
        await expect(info).toBeFocused()
        expect(await listTop()).toBe(before)
        // Tab goes on to the switch, past the bubble, and closes it.
        await page.keyboard.press('Tab')
        await expect(root.getByRole('switch')).toBeFocused()
        await expect(shown).toHaveCount(0)
        await page.keyboard.press('Shift+Tab')
        await expect(info).toBeFocused()
        await expect(shown).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(shown).toHaveCount(0)
        await expect(dialog).toBeVisible()
    })
})

test('at 360 px it stays 8 px inside, and at 844 x 390 it flips above near the bottom', async ({
    page,
}) => {
    await page.setViewportSize({ width: 360, height: 640 })
    await boot(page)
    let dialog = await openSettings(page)
    const narrow = field(dialog, 'Drag to Pan X')
    await narrow.info.scrollIntoViewIfNeeded()
    await narrow.info.click()
    let area = await box(bubble(page))
    expect(area.x).toBeGreaterThanOrEqual(8)
    expect(area.x + area.width).toBeLessThanOrEqual(360 - 8)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.setViewportSize({ width: 844, height: 390 })
    dialog = await openSettings(page)
    const low = field(dialog, 'Preview Duration (ms)')
    await low.info.evaluate((button) => button.scrollIntoView({ block: 'end' }))
    await low.info.click()
    area = await box(bubble(page))
    const row = await box(low.root)
    expect(area.y + area.height).toBeLessThanOrEqual(row.y)
})

for (const locale of ['fr', 'tr'] as const)
    for (const width of [360, 390])
        test(`${locale} at ${width} px: labels fit, the button stays in the label column, controls line up`, async ({
            page,
        }) => {
            await page.setViewportSize({ width, height: 800 })
            await boot(page, locale)
            const dialog = await openSettings(page)
            const rows = await dialog.locator('.form-field').evaluateAll((fields) =>
                fields.flatMap((root) => {
                    const info = root.querySelector('[data-field-info]')
                    const label = root.querySelector('.form-field-label')
                    const text = root.querySelector<HTMLElement>('.form-field-text')
                    const control = root.querySelector('.form-field-toggle > input')
                    if (
                        !label ||
                        !text ||
                        !control ||
                        root.classList.contains('form-field-value-stacked')
                    )
                        return []
                    return [
                        {
                            info: !!info,
                            fits: text.scrollWidth <= text.clientWidth + 1,
                            inLabel:
                                !info ||
                                info.getBoundingClientRect().right <=
                                    label.getBoundingClientRect().right + 0.5,
                            controlX: Math.round(control.getBoundingClientRect().left),
                            roomy: label.classList.contains('form-field-label-roomy'),
                        },
                    ]
                }),
            )
            const described = rows.filter((row) => row.info)
            expect(described.length).toBeGreaterThan(5)
            for (const row of rows) expect(row).toMatchObject({ fits: true, inLabel: true })
            // A label over two lines gives its control less room, with or without the button.
            for (const roomy of [false, true]) {
                const plain = rows.filter((row) => !row.info && row.roomy === roomy)
                if (!plain.length) continue
                for (const row of described.filter((row) => row.roomy === roomy))
                    expect(plain.map((other) => other.controlX)).toContain(row.controlX)
            }
        })
