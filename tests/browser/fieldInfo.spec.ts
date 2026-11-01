import { expect, test, type Locator, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import {
    addBrushProperty,
    installCanvasCounters,
    installEditorFixture,
    touchInput,
} from './editorFixture'

// The info button after a described setting's or chart property's label, and its bubble: the
// inventory in Settings and on the property surfaces, the hit area, the names, and opening and
// closing by mouse, keyboard and touch; overflow, placement and long locales.

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

/** Whether pointing at or pressing an element puts it in its hovered or pressed state. */
const pointerState = (locator: Locator) =>
    locator.evaluate((element) => ({
        hover: element.matches(':hover'),
        active: element.matches(':active'),
    }))

const box = async (locator: Locator) => {
    const value = await locator.boundingBox()
    if (!value) throw new Error('not visible')
    return value
}

test.describe('in Settings', () => {
    test.beforeEach(async ({ page }) => {
        await boot(page)
    })

    test('35 described rows, each with a 24 px face, a 44 px target and exact names', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        await expect(dialog.locator('[data-field-info]')).toHaveCount(35)
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

    test('pointing at or pressing the button leaves its control at rest; the label text still reaches it', async ({
        page,
    }) => {
        const dialog = await openSettings(page)
        for (const [name, role] of [
            ['Name Contrast', 'switch'],
            ['Beat Display', 'combobox'],
            ['Max Scroll X (lanes)', 'spinbutton'],
        ] as const) {
            const { root, info } = field(dialog, name)
            const control = root.getByRole(role)
            await info.scrollIntoViewIfNeeded()
            const face = await box(info)
            await page.mouse.move(face.x + face.width / 2, face.y + face.height / 2)
            await expect.poll(() => pointerState(info)).toEqual({ hover: true, active: false })
            expect(await pointerState(control)).toEqual({ hover: false, active: false })
            await page.mouse.down()
            await expect.poll(() => pointerState(info)).toEqual({ hover: true, active: true })
            expect(await pointerState(control)).toEqual({ hover: false, active: false })
            await page.mouse.up()
            await expect(bubble(page)).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(bubble(page)).toHaveCount(0)
            // A click on the label's text still toggles or focuses the control.
            const checked = await control.getAttribute('aria-checked')
            await root.locator('.form-field-text').click()
            if (role === 'switch')
                await expect(control).not.toHaveAttribute('aria-checked', checked!)
            else await expect(control).toBeFocused()
        }
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
            'Shows objects in other groups, faded, while one group is current.',
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
            'Shows objects on other stages, faded, while one stage is current.',
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

    test('a tap on the button leaves its control at rest', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'Touch is driven through CDP.')
        const dialog = await openSettings(page)
        // A tap's pressed state can end before a frame on a slow machine, so it is read as the
        // tap's click is dispatched, while the tap holds it.
        for (const [name, role] of [
            ['Name Contrast', 'switch'],
            ['Beat Display', 'combobox'],
        ] as const) {
            const { root, info } = field(dialog, name)
            const control = root.getByRole(role)
            await info.scrollIntoViewIfNeeded()
            const [infoHandle, controlHandle] = [
                await info.elementHandle(),
                await control.elementHandle(),
            ]
            const pressed = page.evaluate(
                ([info, control]) =>
                    new Promise<{ info: boolean; control: boolean }>((resolve) =>
                        document.addEventListener(
                            'click',
                            () =>
                                resolve({
                                    info: info!.matches(':active'),
                                    control: control!.matches(':active'),
                                }),
                            { capture: true, once: true },
                        ),
                    ),
                [infoHandle, controlHandle] as const,
            )
            await info.tap()
            expect(await pressed).toEqual({ info: true, control: false })
            await expect(bubble(page)).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(bubble(page)).toHaveCount(0)
        }
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

// The same ⓘ on chart properties: only where a surface asks for them, and none with Show Property
// Descriptions off.
test.describe('on chart properties', () => {
    test.use({ viewport: { width: 1600, height: 1000 } })

    const panel = (page: Page) => page.locator('#workspace-panel-properties')
    const selection = (page: Page) => panel(page).locator('#properties-section-selection')
    const toolSection = (page: Page) => panel(page).locator('#properties-section-tool')
    const toolDialog = (page: Page) => page.locator('.editor-tool-modal')
    const tools = [
        'note',
        'slide',
        'cameraEvent',
        'stageMaskEvent',
        'stagePivotEvent',
        'stageStyleEvent',
        'stageTransformEvent',
    ] as const

    const showDescriptions = (page: Page, shown: boolean) =>
        page.evaluate(async (shown) => {
            window.editorTest.settings.showPropertyDescriptions = shown
            await window.editorTest.nextTick()
        }, shown)

    /** Every object of the events chart, with the connectors chart's slides, selected. */
    const selectEveryKind = (page: Page) =>
        page.evaluate(async () => {
            const { fixtures, show, history, store, settings, nextTick } = window.editorTest
            settings.showSidebar = true
            settings.propertiesConnectorExpanded = true
            show({ ...fixtures.events, slides: fixtures.connectors.slides })
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()],
            })
            await nextTick()
        })

    /** Shows the interaction chart and selects its first note. */
    const selectNote = (page: Page) =>
        page.evaluate(async () => {
            const { fixtures, show, history, store, nextTick } = window.editorTest
            show(fixtures.interaction, 3)
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()]
                    .filter((entity) => entity.type === 'note')
                    .slice(0, 1),
            })
            await nextTick()
        })

    /** Five notes in two slides whose eases, attachments and criticals differ. */
    const selectMixed = (page: Page) =>
        page.evaluate(async () => {
            const { fixtures, show, history, store, settings, nextTick } = window.editorTest
            settings.showSidebar = true
            const template = fixtures.interaction.slides.flat()[0]!
            const note = (values: Partial<typeof template>) => ({
                ...template,
                left: 0,
                size: 2,
                isAttached: false,
                isCritical: false,
                ...values,
            })
            show(
                {
                    ...fixtures.interaction,
                    slides: [
                        [
                            note({ beat: 0, left: -4, connectorEase: 'inQuad' }),
                            note({ beat: 1, isAttached: true }),
                            note({ beat: 2, left: 1, isCritical: true }),
                        ],
                        [
                            note({ beat: 3, left: 2, connectorEase: 'outQuad', noteStyle: 'red' }),
                            note({ beat: 4, left: 4 }),
                        ],
                    ],
                },
                2,
            )
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()].filter(
                    (entity) => entity.type === 'note',
                ),
            })
            await nextTick()
        })

    /** How many info buttons each of these fields has. */
    const infoIn = (fields: Locator) =>
        fields.evaluateAll((fields) =>
            fields.map((field) => field.querySelectorAll('[data-field-info]').length),
        )
    const infoPerField = (scope: Locator) => infoIn(scope.locator('.form-field'))

    const useTool = (page: Page, name: string) =>
        page.evaluate(async (name) => {
            const { switchToolTo } = await window.editorTest.appImport<
                typeof import('../../src/editor/tools')
            >('/src/editor/tools/index.ts')
            switchToolTo(name as never)
            await window.editorTest.nextTick()
        }, name)

    /** The tool's button, pressed while its tool is in use and Properties is hidden. */
    const openToolDialog = (page: Page, name: string) =>
        page.evaluate(async (name) => {
            const { appImport } = window.editorTest
            const { commands } = await appImport<typeof import('../../src/editor/commands')>(
                '/src/editor/commands/index.ts',
            )
            const { runCommand } = await appImport<
                typeof import('../../src/editor/commands/runCommand')
            >('/src/editor/commands/runCommand.ts')
            void runCommand(commands[name as keyof typeof commands], 'toolbar')
        }, name)

    /** The selection's own dialog, as Edit Properties opens it while Properties is hidden. */
    const openSelectionDialog = (page: Page) =>
        page.evaluate(async () => {
            const { focusSelectionProperties } = await window.editorTest.appImport<
                typeof import('../../src/editor/editSelectionProperties')
            >('/src/editor/editSelectionProperties.ts')
            await focusSelectionProperties(true)
        })

    const openManagerProperties = (page: Page, kind: 'group' | 'stage') =>
        page.evaluate(async (kind) => {
            const { appImport } = window.editorTest
            if (kind === 'group') {
                const { openGroupProperties } = await appImport<
                    typeof import('../../src/editor/workspace/manager/groups')
                >('/src/editor/workspace/manager/groups.ts')
                void openGroupProperties(1 as never)
            } else {
                const { openStageProperties } = await appImport<
                    typeof import('../../src/editor/workspace/manager/stages')
                >('/src/editor/workspace/manager/stages.ts')
                void openStageProperties(1 as never)
            }
        }, kind)

    const row = (scope: Locator, name: string) =>
        scope.locator('.form-field').filter({ has: scope.page().getByText(name, { exact: true }) })

    /** Each surface's info buttons per field. */
    const surveyProperties = async (page: Page) => {
        const counts: Record<string, number[]> = {}
        await selectEveryKind(page)
        await expect(selection(page).locator('.form-field').first()).toBeVisible()
        counts.selection = await infoPerField(selection(page))
        for (const name of tools) {
            await useTool(page, name)
            await expect(toolSection(page).locator('.form-field').first()).toBeVisible()
            counts[`${name} panel`] = await infoPerField(toolSection(page))
        }
        await page.evaluate(() => (window.editorTest.settings.propertiesPosition = 'disabled'))
        await expect(panel(page)).toBeHidden()
        await openSelectionDialog(page)
        await expect(toolDialog(page).locator('.form-field').first()).toBeVisible()
        counts['selection dialog'] = await infoPerField(toolDialog(page))
        await page.keyboard.press('Escape')
        await expect(toolDialog(page)).toHaveCount(0)
        for (const name of tools) {
            await useTool(page, name)
            await openToolDialog(page, name)
            await expect(toolDialog(page).locator('.form-field').first()).toBeVisible()
            counts[`${name} dialog`] = await infoPerField(toolDialog(page))
            await page.keyboard.press('Escape')
            await expect(toolDialog(page)).toHaveCount(0)
        }
        for (const kind of ['group', 'stage'] as const) {
            await openManagerProperties(page, kind)
            const dialog = page.getByRole('dialog')
            await expect(dialog.locator('.form-field').first()).toBeVisible()
            counts[kind] = await infoPerField(dialog)
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
        }
        await page.locator('[data-status-label]').click()
        const levelInfo = page.getByRole('dialog', { name: 'Level Info', exact: true })
        await expect(levelInfo).toBeVisible()
        counts.levelInfo = await infoPerField(levelInfo)
        counts.initialLife = await infoIn(row(levelInfo, 'Initial Life'))
        await page.keyboard.press('Escape')
        await expect(levelInfo).toHaveCount(0)
        return counts
    }

    test.beforeEach(async ({ page }) => {
        await boot(page)
    })

    test('with the setting on, every property field has one info button, and Brush and View have none', async ({
        page,
    }) => {
        test.setTimeout(60_000)
        const { levelInfo, initialLife, ...surfaces } = await surveyProperties(page)
        for (const [surface, fields] of Object.entries(surfaces)) {
            expect(fields.length, surface).toBeGreaterThan(1)
            expect(new Set(fields), surface).toEqual(new Set([1]))
        }
        expect(surfaces.selection!.length).toBeGreaterThan(60)
        // Group Properties has Name and Force Note Speed; in Level Info, only Initial Life.
        expect(surfaces.group).toEqual([1, 1])
        expect(initialLife).toEqual([1])
        expect(levelInfo!.reduce((sum, count) => sum + count, 0)).toBe(1)

        await page.evaluate(() => (window.editorTest.settings.propertiesPosition = 'right'))
        await useTool(page, 'brush')
        await addBrushProperty(toolSection(page), 'noteType')
        await addBrushProperty(toolSection(page), 'groupId')
        const brush = await infoPerField(toolSection(page))
        expect(brush.length).toBeGreaterThan(1)
        expect(new Set(brush)).toEqual(new Set([0]))
        const view = await infoPerField(panel(page).locator('#properties-section-view'))
        expect(view.length).toBeGreaterThan(3)
        expect(new Set(view)).toEqual(new Set([0]))
    })

    test('with the setting off, no property field has one, and Settings keeps its own', async ({
        page,
    }) => {
        test.setTimeout(60_000)
        await showDescriptions(page, false)
        for (const [surface, fields] of Object.entries(await surveyProperties(page))) {
            expect(fields.length, surface).toBeGreaterThan(0)
            expect(new Set(fields), surface).toEqual(new Set([0]))
        }
        const dialog = await openSettings(page)
        await expect(dialog.locator('[data-field-info]')).toHaveCount(35)
    })

    for (const where of ['panel', 'selection dialog'] as const)
        test(`in the ${where}, Delete and arrows in a pinned bubble or on its button reach no shortcut`, async ({
            page,
        }) => {
            await page.evaluate((hidden) => {
                const { settings } = window.editorTest
                if (hidden) settings.propertiesPosition = 'disabled'
                else settings.showSidebar = true
            }, where === 'selection dialog')
            await selectNote(page)
            if (where === 'selection dialog') await openSelectionDialog(page)
            const scope = where === 'panel' ? selection(page) : toolDialog(page)
            const info = row(scope, 'Note Type').locator('[data-field-info]')
            await info.click()
            await expect(bubble(page)).toBeVisible()
            const state = () =>
                page.evaluate(() => ({
                    selected: window.editorTest.history.state.value.selectedEntities.length,
                    notes: window.editorTest.snapshot().notes.length,
                    time: window.editorTest.view.time,
                }))
            const before = await state()
            expect(before.selected).toBe(1)
            await bubble(page).click()
            for (const key of ['Delete', 'ArrowDown', 'ArrowDown']) await page.keyboard.press(key)
            await expect(bubble(page)).toBeVisible()
            expect(await state()).toEqual(before)
            // An arrow on the button may scroll the list, which closes the bubble as any scroll does.
            await info.focus()
            for (const key of ['Delete', 'ArrowDown', 'ArrowDown']) await page.keyboard.press(key)
            expect(await state()).toEqual(before)
        })

    test('a press on the chart that closes a pinned bubble adds no note; the next one does', async ({
        page,
    }) => {
        await page.evaluate(() => (window.editorTest.settings.showSidebar = true))
        await selectNote(page)
        await useTool(page, 'note')
        const info = row(selection(page), 'Note Type').locator('[data-field-info]')
        await info.click()
        await expect(bubble(page)).toBeVisible()
        // With focus in the bubble, which goes back to the button.
        await bubble(page).click()
        const count = () => page.evaluate(() => window.editorTest.snapshot().notes.length)
        const before = await count()
        const point = await page.evaluate(() => window.editorTest.point(6, 4))
        await page.mouse.click(point.x, point.y)
        await expect(bubble(page)).toHaveCount(0)
        await expect(info).toBeFocused()
        expect(await count()).toBe(before)
        await page.mouse.click(point.x, point.y)
        await expect.poll(count).toBe(before + 1)
    })

    test("in a mixed selection, the button's description is the property's, and the control's starts with its state", async ({
        page,
    }) => {
        await selectMixed(page)
        const { descriptions, ease } = en.modals.form
        const lines = (['none', 'linear', 'in', 'out', 'inOut', 'outIn'] as const).map(
            (value) => `${ease[value]}: ${descriptions.easeType.choices[value]}`,
        )
        const description = [descriptions.connectorEase, ...lines].join(' ')
        const type = row(selection(page), 'Ease Type')
        await expect(type.locator('[data-field-info]')).toHaveAccessibleDescription(description)
        await expect(type.getByRole('combobox')).toHaveAccessibleName('Ease Type')
        await expect(type.getByRole('combobox')).toHaveAccessibleDescription(
            `Applies to 2 of 5 selected objects. Mixed: In 1, Out 1. ${description}`,
        )
    })

    for (const shown of [true, false])
        test(`Group Properties: Name keeps its name, takes focus on a keyboard open and is focused by its label, with descriptions ${shown ? 'on' : 'off'}`, async ({
            page,
        }) => {
            await showDescriptions(page, shown)
            // As from a menu by keyboard.
            await page.keyboard.press('Shift')
            await openManagerProperties(page, 'group')
            const dialog = page.getByRole('dialog', { name: 'Group Properties' })
            const name = dialog.getByRole('textbox', { name: 'Name', exact: true })
            await expect(name).toBeFocused()
            // The name is selected, so typing replaces it.
            expect(
                await name.evaluate((input: HTMLInputElement) => [
                    input.selectionStart,
                    input.selectionEnd === input.value.length && input.value.length > 0,
                ]),
            ).toEqual([0, true])
            await expect(dialog.locator('[data-field-info]')).toHaveCount(shown ? 2 : 0)
            await dialog.getByRole('spinbutton', { name: 'Force Note Speed', exact: true }).focus()
            await row(dialog, 'Name').locator('.form-field-text').click()
            await expect(name).toBeFocused()
        })

    test('long text values in Level Info stay beside their labels', async ({ page }) => {
        await page.locator('[data-status-label]').click()
        const levelInfo = page.getByRole('dialog', { name: 'Level Info', exact: true })
        const title = levelInfo.getByRole('textbox', { name: 'Title', exact: true })
        await title.fill('A title much too long to show in full beside its label '.repeat(3))
        await title.press('Tab')
        // The fit runs over the next frames.
        await page.evaluate(
            () =>
                new Promise((resolve) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => setTimeout(resolve, 50)),
                    ),
                ),
        )
        await expect(row(levelInfo, 'Title')).not.toHaveClass(/form-field-value-stacked/)
    })

    for (const start of ['control', 'info button'] as const)
        test(`after Show Property Descriptions goes off in Settings opened from the ${start}, focus returns to the field's control, and Delete deletes nothing`, async ({
            page,
        }) => {
            await page.evaluate(() => (window.editorTest.settings.showSidebar = true))
            await selectNote(page)
            const field = row(selection(page), 'Note Type')
            const type = field.getByRole('combobox')
            // Turning descriptions off removes the info button, which Settings would give focus back to.
            await (start === 'control' ? type : field.locator('[data-field-info]')).focus()
            await page.keyboard.press('Control+Comma')
            const dialog = page.getByRole('dialog', { name: 'Settings' })
            await expect(dialog).toBeVisible()
            await dialog.getByRole('switch', { name: 'Show Property Descriptions' }).click()
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
            await expect(type).toBeFocused()
            await page.keyboard.press('Delete')
            expect(
                await page.evaluate(() => ({
                    selected: window.editorTest.history.state.value.selectedEntities.length,
                    notes: window.editorTest.snapshot().notes.length,
                })),
            ).toEqual({ selected: 1, notes: 4 })
        })

    for (const kept of [true, false])
        test(`Settings opened from a focused bubble gives focus back to the field with descriptions ${kept ? 'kept' : 'turned off'}, and Delete deletes nothing`, async ({
            page,
        }) => {
            await page.evaluate(() => (window.editorTest.settings.showSidebar = true))
            await selectNote(page)
            const field = row(selection(page), 'Note Type')
            const info = field.locator('[data-field-info]')
            await info.click()
            await bubble(page).click()
            await expect(bubble(page).locator(':focus')).toHaveCount(1)
            // Settings takes focus, so the bubble closes.
            await page.keyboard.press('Control+Comma')
            const dialog = page.getByRole('dialog', { name: 'Settings' })
            await expect(dialog).toBeVisible()
            if (!kept)
                await dialog.getByRole('switch', { name: 'Show Property Descriptions' }).click()
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
            await expect(kept ? info : field.getByRole('combobox')).toBeFocused()
            await page.keyboard.press('Delete')
            expect(
                await page.evaluate(() => ({
                    selected: window.editorTest.history.state.value.selectedEntities.length,
                    notes: window.editorTest.snapshot().notes.length,
                })),
            ).toEqual({ selected: 1, notes: 4 })
        })

    test('with Ease Function disabled, Settings that hides descriptions leaves focus in Properties, and Delete deletes nothing', async ({
        page,
    }) => {
        const state = () =>
            page.evaluate(() => ({
                selected: window.editorTest.history.state.value.selectedEntities.length,
                notes: window.editorTest.snapshot().notes.length,
            }))
        await page.evaluate(async () => {
            const { fixtures, show, history, store, settings, nextTick } = window.editorTest
            settings.showSidebar = true
            settings.propertiesConnectorExpanded = true
            show(fixtures.connectors)
            // The head of the slide with a linear ease.
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()].filter(
                    (entity) =>
                        entity.type === 'note' &&
                        entity.beat === 1 &&
                        Math.abs(entity.left + 6.6) < 0.01,
                ),
            })
            await nextTick()
        })
        const before = await state()
        expect(before.selected).toBe(1)
        const field = row(selection(page), 'Ease Function')
        await expect(field.getByRole('combobox')).toBeDisabled()
        await field.locator('[data-field-info]').focus()
        await page.keyboard.press('Control+Comma')
        const dialog = page.getByRole('dialog', { name: 'Settings' })
        await expect(dialog).toBeVisible()
        await dialog.getByRole('switch', { name: 'Show Property Descriptions' }).click()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(panel(page).locator(':focus')).toHaveCount(1)
        await page.keyboard.press('Delete')
        expect(await state()).toEqual(before)
    })

    test('a scroll that closes a bubble holding focus gives focus back to its button, and Delete deletes nothing', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1600, height: 600 })
        await page.evaluate(() => (window.editorTest.settings.showSidebar = true))
        await selectNote(page)
        const info = row(selection(page), 'Note Type').locator('[data-field-info]')
        await info.click()
        // A press on its text focuses the bubble.
        await bubble(page).click()
        await expect(bubble(page).locator(':focus')).toHaveCount(1)
        const list = await box(row(selection(page), 'Lane'))
        await page.mouse.move(list.x + 20, list.y + list.height / 2)
        await page.mouse.wheel(0, 200)
        await expect(bubble(page)).toHaveCount(0)
        await expect(info).toBeFocused()
        await page.keyboard.press('Delete')
        expect(
            await page.evaluate(() => ({
                selected: window.editorTest.history.state.value.selectedEntities.length,
                notes: window.editorTest.snapshot().notes.length,
            })),
        ).toEqual({ selected: 1, notes: 4 })
    })

    test('after the setting goes off and on, Ctrl+Z in a field showing its value undoes the edit in the chart', async ({
        page,
    }) => {
        await page.evaluate(() => (window.editorTest.settings.showSidebar = true))
        await selectNote(page)
        const left = () => page.evaluate(() => window.editorTest.snapshot().selected[0]?.left)
        expect(await left()).toBe(-4)
        const lane = row(selection(page), 'Lane').getByRole('spinbutton')
        await lane.fill('2')
        await lane.press('Enter')
        await expect.poll(left).toBe(2)
        await showDescriptions(page, false)
        await showDescriptions(page, true)
        await lane.focus()
        await page.keyboard.press('Control+z')
        await expect.poll(left).toBe(-4)
    })

    test('a choice shows its lines as segments and as a select', async ({ page }) => {
        await page.evaluate(async () => {
            const { fixtures, show, history, store, settings, nextTick } = window.editorTest
            settings.showSidebar = true
            settings.rightDockWidth = 480
            show(fixtures.events)
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()]
                    .filter((entity) => entity.type === 'stageTransformEventJoint')
                    .slice(0, 1),
            })
            await nextTick()
        })
        const anchor = row(selection(page), 'Anchor')
        const lines = ['Default:', 'Center:']
        await expect(anchor.getByRole('radiogroup')).toBeVisible()
        await anchor.locator('[data-field-info]').click()
        await expect(bubble(page).locator('li > span')).toHaveText(lines)
        await page.keyboard.press('Escape')
        // Too narrow for both segments beside the label.
        await page.evaluate(() => (window.editorTest.settings.rightDockWidth = 300))
        await expect(anchor.getByRole('combobox')).toBeVisible()
        await anchor.locator('[data-field-info]').click()
        await expect(bubble(page).locator('li > span')).toHaveText(lines)
    })

    test('the setting is on by default, outlasts a reload and comes back on with Reset Settings', async ({
        page,
    }) => {
        await page.evaluate(() => (window.editorTest.settings.showSidebar = true))
        await selectNote(page)
        const infos = selection(page).locator('[data-field-info]')
        await expect(infos.first()).toBeVisible()
        const dialog = await openSettings(page)
        const toggle = dialog.getByRole('switch', { name: 'Show Property Descriptions' })
        await expect(toggle).toHaveAttribute('aria-checked', 'true')
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-checked', 'false')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(infos).toHaveCount(0)

        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await page.evaluate(() => (window.editorTest.settings.showSidebar = true))
        await selectNote(page)
        await expect(selection(page).locator('.form-field').first()).toBeVisible()
        await expect(infos).toHaveCount(0)
        await page.evaluate(async () => {
            const { resetSettings } =
                await window.editorTest.appImport<typeof import('../../src/settings')>(
                    '/src/settings.ts',
                )
            resetSettings()
            window.editorTest.settings.showSidebar = true
        })
        await expect(infos.first()).toBeVisible()
    })

    test('in a 300 px French dock, the labels and coverage refit in place when the setting changes', async ({
        page,
    }) => {
        await page.evaluate(() => (window.editorTest.settings.locale = 'fr'))
        await page.evaluate(() => (window.editorTest.settings.rightDockWidth = 300))
        /** How each field is fitted: its label's lines and roominess, and where its values go. */
        const layout = () =>
            selection(page)
                .locator('.form-field')
                .evaluateAll((fields) =>
                    fields.map((field) => {
                        const text = field.querySelector<HTMLElement>('.form-field-text')!
                        const inline = field.querySelector('.form-field-inline')
                        return [
                            text.textContent,
                            Math.round(text.getBoundingClientRect().height),
                            field
                                .querySelector('.form-field-label')
                                ?.classList.contains('form-field-label-roomy'),
                            field.classList.contains('form-field-value-stacked'),
                            inline ? !inline.classList.contains('form-field-stacked') : undefined,
                        ].join(' ')
                    }),
                )
        // Reads the layout once it stops changing.
        const settled = async () => {
            let last: string[] = []
            await expect
                .poll(async () => {
                    const now = await layout()
                    const same = JSON.stringify(now) === JSON.stringify(last)
                    last = now
                    return same && now.length > 0
                })
                .toBe(true)
            return last
        }
        // A fresh mount removes the fields and adds them again.
        const remount = async () => {
            await page.evaluate(async () => {
                const { history, nextTick } = window.editorTest
                history.replaceState({ ...history.state.value, selectedEntities: [] })
                await nextTick()
            })
            await expect(selection(page).locator('.form-field')).toHaveCount(0)
            await selectMixed(page)
        }
        await showDescriptions(page, false)
        await remount()
        const off = await settled()
        await showDescriptions(page, true)
        await remount()
        const on = await settled()
        // The info buttons change how some labels fit.
        expect(on).not.toEqual(off)
        await showDescriptions(page, false)
        await expect.poll(layout).toEqual(off)
        await showDescriptions(page, true)
        await expect.poll(layout).toEqual(on)
    })
})

test.describe('on chart properties in an overlay drawer', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('the first Escape closes the bubble and the drawer stays; the next one closes the drawer', async ({
        page,
    }) => {
        await boot(page)
        const drawer = () =>
            page.evaluate(async () => {
                const workspace = await window.editorTest.appImport<
                    typeof import('../../src/editor/workspace')
                >('/src/editor/workspace/index.ts')
                return workspace.drawerSide.value ?? null
            })
        await page.evaluate(async () => {
            const { fixtures, show, history, store, settings, nextTick, appImport } =
                window.editorTest
            settings.propertiesPosition = 'right'
            show(fixtures.interaction, 3)
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()]
                    .filter((entity) => entity.type === 'note')
                    .slice(0, 1),
            })
            const workspace = await appImport<typeof import('../../src/editor/workspace')>(
                '/src/editor/workspace/index.ts',
            )
            workspace.showPanel('properties')
            await nextTick()
        })
        await expect.poll(drawer).toBe('right')
        const info = page
            .locator('#properties-section-selection .form-field')
            .filter({ has: page.getByText('Note Type', { exact: true }) })
            .locator('[data-field-info]')
        await info.click()
        await expect(bubble(page)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(bubble(page)).toHaveCount(0)
        await expect(info).toBeFocused()
        expect(await drawer()).toBe('right')
        await page.keyboard.press('Escape')
        await expect.poll(drawer).toBe(null)
    })
})

test.describe('on chart properties by touch', () => {
    test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

    test('in the selection dialog, a tap that closes a pinned bubble still toggles the switch it lands on', async ({
        page,
    }) => {
        await boot(page)
        await page.evaluate(async () => {
            const { fixtures, show, history, store, settings, nextTick, appImport } =
                window.editorTest
            settings.propertiesPosition = 'disabled'
            show(fixtures.interaction, 3)
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()]
                    .filter((entity) => entity.type === 'note')
                    .slice(0, 1),
            })
            await nextTick()
            const { focusSelectionProperties } = await appImport<
                typeof import('../../src/editor/editSelectionProperties')
            >('/src/editor/editSelectionProperties.ts')
            await focusSelectionProperties(true)
        })
        const dialog = page.locator('.editor-tool-modal')
        // The bubble opens over the rows below Fake, clear of Critical's switch above it.
        const info = dialog
            .locator('.form-field')
            .filter({ has: page.getByText('Fake', { exact: true }) })
            .locator('[data-field-info]')
        const critical = dialog.getByRole('checkbox', { name: 'Critical', exact: true })
        await critical.scrollIntoViewIfNeeded()
        await info.scrollIntoViewIfNeeded()
        await info.tap()
        await expect(bubble(page)).toBeVisible()
        const [shown, target] = [await box(bubble(page)), await box(critical)]
        expect(shown.y >= target.y + target.height || shown.y + shown.height <= target.y).toBe(true)
        await expect(critical).toHaveAttribute('aria-checked', 'false')
        await critical.tap()
        await expect(bubble(page)).toHaveCount(0)
        await expect(critical).toHaveAttribute('aria-checked', 'true')
    })
})
