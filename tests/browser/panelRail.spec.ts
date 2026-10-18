import { expect, test, type CDPSession, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

const shots = process.env.RAIL_MENU_SHOTS

const dock = (page: Page, side: 'left' | 'right' | 'top') =>
    page.locator(`[data-workspace-dock="${side}"]`)

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

const menu = (page: Page) => page.getByRole('menu')

const setSettings = (page: Page, values: Record<string, unknown>) =>
    page.evaluate((values) => {
        Object.assign(window.editorTest.settings, values)
    }, values)

const getSetting = (page: Page, key: string) =>
    page.evaluate(
        (key) => (window.editorTest.settings as unknown as Record<string, unknown>)[key],
        key,
    )

const activeName = (page: Page) =>
    page.evaluate(() => {
        const element = document.activeElement
        return {
            role: element?.getAttribute('role'),
            text: element?.textContent.trim(),
            focusVisible: element?.matches(':focus-visible') ?? false,
        }
    })

test.beforeEach(async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    // The fixture closes Properties; the menu offers Close only for open panels.
    await setSettings(page, { showSidebar: true })
    await expect(tab(page, 'Properties')).toHaveAttribute('aria-selected', 'true')
})

test('right click offers dock positions and moves the panel', async ({ page }) => {
    const properties = tab(page, 'Properties')
    await properties.click({ button: 'right' })

    await expect(menu(page)).toHaveAccessibleName('More Actions for Properties')
    const radios = menu(page).getByRole('menuitemradio')
    await expect(radios).toHaveText(['Dock Automatically', 'Dock Left', 'Dock Right', 'Dock Top'])
    await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true')
    for (const index of [1, 2, 3])
        await expect(radios.nth(index)).toHaveAttribute('aria-checked', 'false')
    await expect(menu(page).getByRole('menuitem', { name: 'Close Properties' })).toBeVisible()

    // A pointer-opened menu focuses its first item without a keyboard highlight.
    expect(await activeName(page)).toEqual({
        role: 'menuitemradio',
        text: 'Dock Automatically',
        focusVisible: false,
    })
    // The anchor holds its open state.
    if (shots) await page.screenshot({ path: `${shots}/desktop-right.png` })

    await menu(page).getByRole('menuitemradio', { name: 'Dock Left' }).click()
    await expect(menu(page)).toHaveCount(0)
    expect(await getSetting(page, 'propertiesPosition')).toBe('left')
    const moved = dock(page, 'left').getByRole('tab', { name: 'Properties', exact: true })
    await expect(moved).toHaveAttribute('aria-selected', 'true')
    const tile = await moved.getAttribute('aria-controls')
    await expect(dock(page, 'left').locator(`#${tile}`)).toBeVisible()

    // The new position is the checked one; a left-rail menu is shown for the record.
    await moved.click({ button: 'right' })
    await expect(menu(page).getByRole('menuitemradio', { name: 'Dock Left' })).toHaveAttribute(
        'aria-checked',
        'true',
    )
    if (shots) await page.screenshot({ path: `${shots}/desktop-left.png` })
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await expect(moved).toBeFocused()
})

test('moving a closed panel shows it in its new dock', async ({ page }) => {
    const stages = tab(page, 'Stages')
    await expect(stages).toHaveAttribute('aria-expanded', 'false')
    await stages.click({ button: 'right' })
    await menu(page).getByRole('menuitemradio', { name: 'Dock Right' }).click()
    expect(await getSetting(page, 'stagesPosition')).toBe('right')
    const moved = dock(page, 'right').getByRole('tab', { name: 'Stages', exact: true })
    await expect(moved).toHaveAttribute('aria-selected', 'true')
    expect(await getSetting(page, 'showStages')).toBe(true)
})

test('close is offered only for open panels', async ({ page }) => {
    const stages = tab(page, 'Stages')
    await expect(stages).toHaveAttribute('aria-expanded', 'false')
    await stages.click({ button: 'right' })
    await expect(menu(page).getByRole('menuitemradio')).toHaveCount(4)
    await expect(menu(page).getByRole('menuitem')).toHaveCount(0)
    await expect(menu(page).getByRole('separator')).toHaveCount(0)
    // A hidden tab holds the open state, without the visible panel's bar.
    if (shots) await page.screenshot({ path: `${shots}/desktop-hidden.png` })

    // Escape returns focus to the tab.
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await expect(stages).toBeFocused()

    const properties = tab(page, 'Properties')
    await properties.click({ button: 'right' })
    await menu(page).getByRole('menuitem', { name: 'Close Properties' }).click()
    await expect(menu(page)).toHaveCount(0)
    expect(await getSetting(page, 'showSidebar')).toBe(false)
    await expect(properties).toHaveAttribute('aria-expanded', 'false')
})

test('a click on the tab closes its menu and still toggles it', async ({ page }) => {
    const properties = tab(page, 'Properties')
    await properties.click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await properties.click()
    await expect(menu(page)).toHaveCount(0)
    await expect(properties).toHaveAttribute('aria-selected', 'false')
})

test('a press on the menu padding keeps focus in the menu', async ({ page }) => {
    const properties = tab(page, 'Properties')
    await properties.click({ button: 'right' })
    const box = (await menu(page).boundingBox())!
    await page.mouse.click(box.x + 2, box.y + 2)
    await expect(menu(page)).toBeVisible()
    expect(await menu(page).evaluate((menu) => menu.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await expect(properties).toBeFocused()
})

test('Shift+F10 and the menu key open the menu from the keyboard', async ({ page }) => {
    const properties = tab(page, 'Properties')
    await properties.focus()
    await page.keyboard.press('Shift+F10')
    await expect(menu(page)).toBeVisible()
    expect(await activeName(page)).toEqual({
        role: 'menuitemradio',
        text: 'Dock Automatically',
        focusVisible: true,
    })

    // Arrows move through the choices and on to Close, stopping at the ends.
    await page.keyboard.press('ArrowDown')
    expect((await activeName(page)).text).toBe('Dock Left')
    await page.keyboard.press('End')
    expect((await activeName(page)).text).toBe('Close Properties')
    await page.keyboard.press('ArrowDown')
    expect((await activeName(page)).text).toBe('Close Properties')
    await page.keyboard.press('ArrowUp')
    expect(await activeName(page)).toMatchObject({ role: 'menuitemradio', text: 'Dock Top' })
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowUp')
    expect((await activeName(page)).text).toBe('Dock Automatically')

    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await expect(properties).toBeFocused()

    // The menu key opens the same menu; choosing a dock keeps focus on the tab.
    await page.keyboard.press('ContextMenu')
    await expect(menu(page)).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu(page)).toHaveCount(0)
    expect(await getSetting(page, 'propertiesPosition')).toBe('left')
    await expect(dock(page, 'left').getByRole('tab', { name: 'Properties' })).toBeFocused()
})

test.describe('phone', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    const sessions = new WeakMap<Page, CDPSession>()
    const touch = async (page: Page, type: 'touchStart' | 'touchEnd', x: number, y: number) => {
        let client = sessions.get(page)
        if (!client) {
            client = await page.context().newCDPSession(page)
            sessions.set(page, client)
        }
        await client.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
        })
    }

    const center = async (page: Page, name: string) => {
        const box = await tab(page, name).boundingBox()
        if (!box) throw new Error(`${name} tab is not visible`)
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }

    test('a long press opens the menu without toggling the panel', async ({ page }) => {
        const properties = tab(page, 'Properties')
        const selected = await properties.getAttribute('aria-selected')
        const expanded = await properties.getAttribute('aria-expanded')
        const { x, y } = await center(page, 'Properties')

        await touch(page, 'touchStart', x, y)
        await page.waitForTimeout(700)
        await expect(menu(page)).toBeVisible()
        await touch(page, 'touchEnd', x, y)
        await page.waitForTimeout(100)
        await expect(menu(page)).toBeVisible()
        await expect(properties).toHaveAttribute('aria-selected', selected ?? '')
        await expect(properties).toHaveAttribute('aria-expanded', expanded ?? '')
        expect(await getSetting(page, 'showSidebar')).toBe(true)
        // Lifting the finger leaves focus in the menu, without a keyboard highlight.
        expect(await activeName(page)).toEqual({
            role: 'menuitemradio',
            text: 'Dock Automatically',
            focusVisible: false,
        })

        // The menu fits the screen with touch-sized items.
        const viewport = page.viewportSize()!
        const box = (await menu(page).boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
        const items = menu(page).locator('button')
        await expect(items).toHaveCount(5)
        for (const item of await items.all())
            expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        if (shots) await page.screenshot({ path: `${shots}/phone.png` })

        // Escape returns focus to the tab.
        await page.keyboard.press('Escape')
        await expect(menu(page)).toHaveCount(0)
        await expect(properties).toBeFocused()

        // The next tap toggles as usual.
        await properties.tap()
        await expect(properties).not.toHaveAttribute('aria-selected', selected ?? '')
    })

    test('a long press does nothing when the option is off', async ({ page }) => {
        await setSettings(page, { touchLongPressContextMenu: false })
        const properties = tab(page, 'Properties')
        const selected = await properties.getAttribute('aria-selected')
        const { x, y } = await center(page, 'Properties')
        await touch(page, 'touchStart', x, y)
        await page.waitForTimeout(700)
        await expect(menu(page)).toHaveCount(0)
        await touch(page, 'touchEnd', x, y)
        await page.waitForTimeout(100)
        await expect(menu(page)).toHaveCount(0)
        // Holding is then an ordinary tap.
        await expect(properties).not.toHaveAttribute('aria-selected', selected ?? '')
    })

    test('a tap on the menu moves the panel', async ({ page }) => {
        const { x, y } = await center(page, 'Properties')
        await touch(page, 'touchStart', x, y)
        await page.waitForTimeout(700)
        await touch(page, 'touchEnd', x, y)
        await menu(page).getByRole('menuitemradio', { name: 'Dock Top' }).tap()
        await expect(menu(page)).toHaveCount(0)
        expect(await getSetting(page, 'propertiesPosition')).toBe('top')
        await expect(
            dock(page, 'top').getByRole('tab', { name: 'Properties', exact: true }),
        ).toHaveAttribute('aria-selected', 'true')
    })
})

test('a vertical rail opens its tab menus beside the rail, toward the panel', async ({ page }) => {
    await setSettings(page, {
        groupsPosition: 'left',
        stagesPosition: 'right',
        showGroups: true,
        showStages: true,
    })
    for (const [side, name] of [
        ['left', 'Groups'],
        ['right', 'Stages'],
    ] as const) {
        const target = dock(page, side).getByRole('tab', { name, exact: true })
        await target.click({ button: 'right' })
        await expect(menu(page)).toBeVisible()
        const rail = (await dock(page, side).getByRole('tablist').boundingBox())!
        const anchor = (await target.boundingBox())!
        const box = (await menu(page).boundingBox())!
        if (side === 'left') expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width)
        else expect(box.x + box.width).toBeLessThanOrEqual(rail.x)
        // Aligned to the tab, kept 8px from the screen edge.
        expect(Math.abs(box.y - Math.max(8, anchor.y))).toBeLessThan(1)
        await page.keyboard.press('Escape')
        await expect(menu(page)).toHaveCount(0)
    }
})

test('a pressed tab takes the accent fill and hides its marker', async ({ page }) => {
    const properties = tab(page, 'Properties')
    const box = (await properties.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await expect
        .poll(() => properties.evaluate((element) => getComputedStyle(element).backgroundColor))
        .toBe('rgb(119, 239, 220)')
    await expect
        .poll(() =>
            properties
                .locator('.panel-tab-marker')
                .evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe('0')
    await page.mouse.up()
})

test('a narrowing top rail settles on one padding at any root font size', async ({ page }) => {
    // Through each width where the tabs start and stop trimming their padding.
    const sweeps = [
        [16, 414, 404],
        [16, 368, 358],
        [18, 466, 456],
        [18, 412, 402],
        [20, 518, 508],
        [20, 458, 448],
    ] as const
    const paddings = new Map<number, Set<string>>()
    for (const [root, from, to] of sweeps) {
        await page.evaluate((root) => {
            document.documentElement.style.fontSize = `${root}px`
        }, root)
        for (let width = from; width >= to; width--) {
            await page.setViewportSize({ width, height: 680 })
            // Once laid out, the tabs hold one padding for a few frames.
            const { flips, padding } = await page.evaluate(async () => {
                const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
                await frame()
                await frame()
                const strip = document.querySelector(
                    '[data-workspace-dock="top"] .panel-rail-tabs',
                )!
                let flips = 0
                const observer = new MutationObserver((records) => (flips += records.length))
                observer.observe(strip, { attributeFilter: ['class'], subtree: true })
                for (let i = 0; i < 4; i++) await frame()
                observer.disconnect()
                const tab = strip.querySelector('[role="tab"]')!
                return { flips, padding: getComputedStyle(tab).paddingLeft }
            })
            expect(flips, `${width}px at ${root}px`).toBe(0)
            paddings.set(root, (paddings.get(root) ?? new Set()).add(padding))
        }
    }
    for (const [root, seen] of paddings) expect(seen.size, `${root}px`).toBe(2)
})

test('a tab docked after the rail mounts still re-measures it when its label grows', async ({
    page,
}) => {
    await setSettings(page, {
        propertiesPosition: 'top',
        groupsPosition: 'right',
        stagesPosition: 'right',
        previewPosition: 'right',
    })
    const strip = dock(page, 'top').locator('.panel-rail-tabs')
    const tabs = strip.getByRole('tab')
    await expect(tabs).toHaveText(['Properties'])
    // Groups joins the rail, then Properties leaves it: only the later tab remains.
    await setSettings(page, { groupsPosition: 'top' })
    await expect(tabs).toHaveText(['Groups', 'Properties'])
    await setSettings(page, { propertiesPosition: 'right' })
    await expect(tabs).toHaveText(['Groups'])
    await expect(strip).not.toHaveClass(/fade-end/)
    // A label growing past the rail, as a locale or font change can, brings the fade.
    await tabs.first().evaluate((tab) => {
        tab.firstElementChild!.textContent = 'Groups '.repeat(400)
    })
    await expect(strip).toHaveClass(/fade-end/)
})

test('the top rail picks its padding by width alone, and a strip that fits shows no fade', async ({
    page,
}) => {
    test.setTimeout(90_000)
    await page.evaluate(() => {
        document.documentElement.style.fontSize = '20px'
    })
    const strip = page.locator('[data-workspace-dock="top"] .panel-rail-tabs')
    const state = () =>
        strip.evaluate(async (element) => {
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
            for (let i = 0; i < 3; i++) await frame()
            const tabs = [...element.querySelectorAll('[role="tab"]')]
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
            const labels = tabs.map((tab) => tab.firstElementChild!.getBoundingClientRect())
            const box = element.getBoundingClientRect()
            const full =
                labels.reduce((sum, label) => sum + label.width, 0) +
                (tabs.length - 1) * parseFloat(getComputedStyle(element).columnGap) +
                tabs.length * 1.5 * rem
            return {
                padding: getComputedStyle(tabs[0]!).paddingLeft,
                fade: element.classList.contains('fade-end'),
                inside: labels.at(-1)!.right <= box.right + 0.5,
                // How far the strip overflows at full padding, and at the trimmed one.
                full: full - box.width,
                trimmed: full - tabs.length * 0.5 * rem - box.width,
            }
        })
    const setWidth = (width: number) => page.setViewportSize({ width, height: 680 })
    const setLocale = (locale: string) =>
        page.evaluate((locale) => {
            window.editorTest.settings.locale = locale as never
        }, locale)

    // French with four tabs reaches the trim threshold at 390px in Chromium.
    for (const [locale, showGroups] of [
        ['fr', true],
        ['ko', false],
    ] as const) {
        await page.evaluate((showGroups) => {
            window.editorTest.settings.showGroups = showGroups
        }, showGroups)
        await setLocale(locale)
        // The widths where the full padding stops fitting, and then where trimming no
        // longer shows every label: its end padding, 0.5rem, may overflow.
        await setWidth(600)
        const wide = await state()
        expect(wide.full).toBeLessThan(-10)
        const widths = new Set(locale === 'fr' ? [388, 389, 390, 391, 392] : [])
        for (const threshold of [600 + wide.full, 600 + wide.trimmed - 10])
            for (let offset = -2; offset <= 2; offset++) widths.add(Math.round(threshold) + offset)
        for (const width of widths) {
            const arrivals = []
            for (const before of [320, 600]) {
                await setWidth(before)
                await state()
                await setWidth(width)
                arrivals.push(await state())
            }
            await setLocale('en')
            await state()
            await setLocale(locale)
            arrivals.push(await state())
            const label = `${locale} at ${width}px`
            const [first] = arrivals
            for (const arrival of arrivals) expect(arrival.padding, label).toBe(first!.padding)
            const trimmed = first!.padding === '10px'
            if (trimmed || first!.full <= 0.5) {
                expect(first, label).toMatchObject({ fade: false, inside: true })
                expect(first!.trimmed, label).toBeLessThanOrEqual(10.5)
            } else {
                // Full padding scrolls only where trimming would still hide a label.
                expect(first!.trimmed, label).toBeGreaterThan(9.5)
            }
        }
    }
})
