import { expect, test, type Page } from '@playwright/test'
import { oneRowToolbarWidth } from '../../src/editor/toolbar/layout'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'
import { confirmReset } from './resetConfirm'

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

const dock = (page: Page, side: 'left' | 'right' | 'top') =>
    page.locator(`[data-workspace-dock="${side}"]`)

const tab = (page: Page, side: 'left' | 'right' | 'top', name: string) =>
    dock(page, side).getByRole('tab', { name, exact: true })

const setSettings = (page: Page, values: Record<string, unknown>) =>
    page.evaluate((values) => {
        Object.assign(window.editorTest.settings, values)
    }, values)

const getSettings = (page: Page, keys: string[]) =>
    page.evaluate(
        (keys) =>
            Object.fromEntries(
                keys.map((key) => [
                    key,
                    (window.editorTest.settings as unknown as Record<string, unknown>)[key],
                ]),
            ),
        keys,
    )

test.beforeEach(async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test('panel names hide visible panels and show hidden ones', async ({ page }) => {
    await setSettings(page, { showGroups: true })
    const groups = tab(page, 'left', 'Groups')
    const stages = tab(page, 'left', 'Stages')
    await expect(groups).toHaveAttribute('aria-selected', 'true')
    await expect(stages).toHaveAttribute('aria-selected', 'false')
    await expect(stages).toHaveAttribute('aria-expanded', 'false')

    // A closed panel opens and is shown beside its open sibling.
    await stages.click()
    await expect(stages).toHaveAttribute('aria-selected', 'true')
    await expect(groups).toHaveAttribute('aria-selected', 'true')

    // Clicking one of several visible panels closes it; its sibling remains.
    await expect(groups).toHaveAttribute('title', 'Hide Groups')
    await groups.click()
    await expect(groups).toHaveAttribute('aria-selected', 'false')
    await expect(groups).toHaveAttribute('aria-expanded', 'false')
    await expect(stages).toHaveAttribute('aria-selected', 'true')
    expect(await getSettings(page, ['showGroups'])).toEqual({ showGroups: false })

    // Clicking the only visible panel collapses the dock but keeps it open,
    // and pointer clicks leave shortcuts usable.
    await stages.click()
    await expect(stages).toHaveAttribute('aria-selected', 'false')
    await expect(stages).toHaveAttribute('aria-expanded', 'true')
    await expect(dock(page, 'left').locator('.workspace-dock-body')).toHaveCount(0)
    await expect(page.locator('[data-workspace-dock="left"] :focus')).toHaveCount(0)
    await expect(stages).toHaveAttribute('title', 'Show Stages')
    await stages.click()
    await expect(stages).toHaveAttribute('aria-selected', 'true')

    // The rail's chevron hides and shows the whole dock.
    const toggle = dock(page, 'left').getByRole('button', { name: 'Hide Left Panels' })
    await toggle.click()
    await expect(stages).toHaveAttribute('aria-selected', 'false')
    await dock(page, 'left').getByRole('button', { name: 'Show Left Panels' }).click()
    await expect(stages).toHaveAttribute('aria-selected', 'true')

    // A middle click closes a panel outright.
    await stages.click({ button: 'middle' })
    await expect(stages).toHaveAttribute('aria-expanded', 'false')
})

test('compact docks switch tabs without ever bringing back another panel', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setSettings(page, {
        showPreview: true,
        showGroups: true,
        showStages: true,
        showSidebar: true,
        panelRecency: ['groups', 'preview', 'stages', 'properties'],
    })
    const top = dock(page, 'top')
    const expanded = async (names: string[]) => {
        for (const name of ['Preview', 'Groups', 'Stages', 'Properties'])
            await expect(tab(page, 'top', name)).toHaveAttribute(
                'aria-expanded',
                String(names.includes(name)),
            )
    }
    // History is a fifth tab, closed.
    await expect(top.getByRole('tab')).toHaveCount(5)
    await expect(top.getByRole('tab', { selected: true })).toHaveCount(1)
    await expect(tab(page, 'top', 'Groups')).toHaveAttribute('aria-selected', 'true')

    // A phone's dock fits one panel: a tab takes its place, and the panels it
    // displaces close, since their tabs read as not shown anyway.
    await tab(page, 'top', 'Properties').click()
    await expect(tab(page, 'top', 'Properties')).toHaveAttribute('aria-selected', 'true')
    await expanded(['Properties'])

    // Hiding the only panel folds the dock; nothing takes its place, and the
    // same tab or the chevron brings it back.
    await tab(page, 'top', 'Properties').click()
    await expect(top.getByRole('tab', { selected: true })).toHaveCount(0)
    await expanded(['Properties'])
    await tab(page, 'top', 'Properties').click()
    await expect(tab(page, 'top', 'Properties')).toHaveAttribute('aria-selected', 'true')
    await tab(page, 'top', 'Groups').click()
    await expect(tab(page, 'top', 'Groups')).toHaveAttribute('aria-selected', 'true')
    await expanded(['Groups'])

    // Closing the shown panel by key reveals nothing in its place.
    await tab(page, 'top', 'Groups').focus()
    await page.keyboard.press('Delete')
    await expect(top.getByRole('tab', { selected: true })).toHaveCount(0)
    await expanded([])

    // Keyboard navigation moves along the strip; Enter applies the tab action.
    await page.keyboard.press('ArrowRight')
    await expect(tab(page, 'top', 'Stages')).toBeFocused()
    await page.keyboard.press('End')
    await expect(tab(page, 'top', 'History')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(tab(page, 'top', 'Preview')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-selected', 'true')
    await expanded(['Preview'])
    // Shortcuts are not triggered while a tab has keyboard focus.
    await page.keyboard.press('Delete')
    await expect(tab(page, 'top', 'Preview')).toHaveAttribute('aria-expanded', 'false')
})

test('dock resizing persists, cancels to the saved preference, and survives reload', async ({
    page,
}) => {
    await setSettings(page, { showGroups: true })
    const handle = dock(page, 'left').getByRole('separator', { name: 'Resize Left Panels' })
    const body = dock(page, 'left').locator('.workspace-dock-body')
    const before = (await body.boundingBox())!
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 })
    await page.mouse.up()
    await settle(page)
    const after = (await body.boundingBox())!
    expect(Math.round(after.width - before.width)).toBe(80)
    const { leftDockWidth } = await getSettings(page, ['leftDockWidth'])
    expect(leftDockWidth).toBe(Math.round(after.width))

    // The editor follows the dock without stale hit-testing bounds.
    const editor = (await page.locator('canvas.editor-chart').boundingBox())!
    const view = await page.evaluate(() => ({ x: window.editorTest.view.x }))
    expect(Math.abs(view.x - editor.x)).toBeLessThan(1)

    // A saved size larger than the viewport allows is clamped for display only;
    // cancelling a drag restores the saved preference, not the clamped size.
    await setSettings(page, { leftDockWidth: 5000 })
    await settle(page)
    const clamped = (await body.boundingBox())!
    expect(clamped.width).toBeLessThan(1600)
    const clampedHandle = (await handle.boundingBox())!
    await page.mouse.move(clampedHandle.x + 6, clampedHandle.y + 200)
    await page.mouse.down()
    await page.mouse.move(clampedHandle.x - 100, clampedHandle.y + 200, { steps: 3 })
    await handle.dispatchEvent('pointercancel', { pointerId: 1, isPrimary: true })
    await page.mouse.up()
    expect(await getSettings(page, ['leftDockWidth'])).toEqual({ leftDockWidth: 5000 })

    await setSettings(page, { leftDockWidth: 420 })
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect.poll(async () => Math.round((await body.boundingBox())!.width)).toBe(420)
    await expect(tab(page, 'left', 'Groups')).toHaveAttribute('aria-selected', 'true')
})

test('stacked panels resize as a pair and reset with a double click', async ({ page }) => {
    await setSettings(page, { showPreview: true, showGroups: true, showStages: true })
    const tiles = dock(page, 'left').locator('.workspace-tile')
    await expect(tiles).toHaveCount(3)
    const separator = dock(page, 'left').getByRole('separator', {
        name: 'Resize Groups and Stages',
    })
    const groups = (await tiles.nth(1).boundingBox())!
    const box = (await separator.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 4 })
    await page.mouse.up()
    await settle(page)
    expect(Math.round((await tiles.nth(1).boundingBox())!.height - groups.height)).toBe(60)

    await separator.focus()
    await page.keyboard.press('ArrowUp')
    await settle(page)
    expect(Math.round((await tiles.nth(1).boundingBox())!.height - groups.height)).toBe(44)

    await separator.dblclick()
    await settle(page)
    const weights = await page.evaluate(() => window.editorTest.settings.panelWeights)
    expect(weights.groups).toBeUndefined()
    expect(weights.stages).toBeUndefined()
})

test('rotation and resizing never overwrite saved placement or open states', async ({ page }) => {
    await setSettings(page, { showPreview: true, showGroups: true })
    const keys = [
        'previewPosition',
        'groupsPosition',
        'stagesPosition',
        'propertiesPosition',
        'showPreview',
        'showGroups',
        'showStages',
        'showSidebar',
        'leftDockWidth',
        'topDockHeight',
    ]
    const saved = await getSettings(page, keys)

    await page.setViewportSize({ width: 390, height: 844 })
    await settle(page)
    await expect(dock(page, 'top')).toBeVisible()
    await expect(dock(page, 'left')).toHaveCount(0)

    await page.setViewportSize({ width: 844, height: 390 })
    await settle(page)
    await expect(dock(page, 'left')).toBeVisible()
    await expect(dock(page, 'top')).toHaveCount(0)

    await page.setViewportSize({ width: 1600, height: 1000 })
    await settle(page)
    expect(await getSettings(page, keys)).toEqual(saved)
    await expect(tab(page, 'left', 'Preview')).toHaveAttribute('aria-selected', 'true')
    await expect(tab(page, 'left', 'Groups')).toHaveAttribute('aria-selected', 'true')
})

test('explicit placement and disabling are honored and restorable from settings', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setSettings(page, { stagesPosition: 'right', groupsPosition: 'disabled' })
    await expect(tab(page, 'right', 'Stages')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Groups', exact: true })).toHaveCount(0)

    await page.keyboard.press(',')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog
        .locator('label')
        .filter({ has: page.getByText('Groups', { exact: true }) })
        .getByRole('combobox')
        .selectOption('auto')
    expect(await getSettings(page, ['groupsPosition'])).toEqual({ groupsPosition: 'auto' })
    await page.keyboard.press('Escape')
    await expect(tab(page, 'top', 'Groups')).toBeVisible()
})

test('an on-screen keyboard does not rearrange docks while a field is edited', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 })
    // The View section always has a numeric field, even with nothing selected.
    await setSettings(page, {
        showSidebar: true,
        panelRecency: ['properties'],
        propertiesSection: 'view',
    })
    const field = dock(page, 'top').locator('input[type="number"]').first()
    await field.focus()

    // A keyboard that shrinks the layout viewport makes the screen landscape.
    await page.setViewportSize({ width: 820, height: 640 })
    await settle(page)
    await expect(dock(page, 'top')).toBeVisible()
    await expect(field).toBeFocused()

    await field.blur()
    await expect(dock(page, 'left')).toBeVisible()
    await expect(dock(page, 'top')).toHaveCount(0)
})

test('tool commands open a dialog instead of uncovering Properties', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 })
    await setSettings(page, {
        previewPosition: 'left',
        groupsPosition: 'left',
        propertiesPosition: 'left',
        showPreview: true,
        showGroups: true,
        showSidebar: true,
        propertiesSection: 'view',
        panelRecency: ['preview', 'groups', 'properties', 'stages'],
    })
    await expect(tab(page, 'left', 'Properties')).toHaveAttribute('aria-selected', 'false')
    await page.keyboard.press('a')
    await page.keyboard.press('a')
    // Covered Properties stays covered: the tool's settings open in a dialog,
    // as tapping a selected note does, so no tab switches unexpectedly.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(tab(page, 'left', 'Properties')).toHaveAttribute('aria-selected', 'false')
    expect(await getSettings(page, ['propertiesSection'])).toEqual({ propertiesSection: 'view' })
})

test('opening a dock does not pop a toolbar group under a resting pointer', async ({ page }) => {
    const toolbar = page.locator('canvas.editor-chart')
    const box = (await toolbar.boundingBox())!
    // Rest the pointer on the toolbar row, where buttons will move under it.
    await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height - 104)
    await page.evaluate(async () => {
        const { showPanel } = await window.editorTest.appImport<
            typeof import('../../src/editor/workspace')
        >('/src/editor/workspace/index.ts')
        showPanel('groups')
    })
    await expect(tab(page, 'left', 'Groups')).toHaveAttribute('aria-selected', 'true')
    await settle(page)
    await expect(page.locator('[class~="bg-bg/75"]')).toHaveCount(0)
})

test.describe('phone', () => {
    test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } })

    test('compact rails and resize targets keep a visible touch grabber', async ({ page }) => {
        await setSettings(page, { groupsPosition: 'top', showGroups: true, showPreview: false })
        const top = dock(page, 'top')
        await expect(top.getByRole('tab', { name: 'Groups' })).toBeVisible()
        expect((await top.locator('.panel-rail').boundingBox())!.height).toBe(36)
        const handle = top.getByRole('separator', { name: 'Resize Top Panels', exact: true })
        await expect(handle).toBeVisible()
        expect((await handle.boundingBox())!.height).toBe(12)
        const grabber = handle.locator('.resize-grabber')
        await expect(grabber).toHaveCSS('opacity', '1')
        const box = (await grabber.boundingBox())!
        expect([box.width, box.height]).toEqual([32, 4])
    })

    test('side placements open one drawer at a time and its scrim absorbs the dismissing tap', async ({
        page,
    }) => {
        await setSettings(page, {
            groupsPosition: 'left',
            propertiesPosition: 'right',
            showGroups: true,
            showSidebar: true,
            panelRecency: ['properties', 'groups', 'preview', 'stages'],
        })
        const left = dock(page, 'left').locator('.workspace-dock-body')
        const right = dock(page, 'right').locator('.workspace-dock-body')
        await expect(right).toBeVisible()
        await expect(left).toHaveCount(0)

        await tab(page, 'left', 'Groups').tap()
        await expect(left).toBeVisible()
        await expect(right).toHaveCount(0)

        // The drawer paints above the top dock.
        const box = (await left.boundingBox())!
        expect(
            await page.evaluate(
                ({ x, y }) =>
                    !!document
                        .elementFromPoint(x, y)
                        ?.closest('[data-workspace-dock="left"] .workspace-dock-body'),
                { x: box.x + box.width / 2, y: box.y + 20 },
            ),
        ).toBe(true)

        const before = await page.evaluate(() => window.editorTest.snapshot().notes.length)
        await page.keyboard.press('a')
        await page.touchscreen.tap(325, 600)
        await expect(left).toHaveCount(0)
        expect(await page.evaluate(() => window.editorTest.snapshot().notes.length)).toBe(before)
        await expect(tab(page, 'left', 'Groups')).toHaveAttribute('aria-expanded', 'true')
    })

    test('the top dock keeps its height while switching away from Preview', async ({ page }) => {
        await setSettings(page, {
            showPreview: true,
            showGroups: true,
            showSidebar: true,
            panelRecency: ['preview', 'groups', 'properties', 'stages'],
        })
        const body = dock(page, 'top').locator('.workspace-dock-body')
        const heights: number[] = []
        for (const name of ['Groups', 'Properties', 'Preview']) {
            await tab(page, 'top', name).tap()
            await expect(tab(page, 'top', name)).toHaveAttribute('aria-selected', 'true')
            heights.push(Math.round((await body.boundingBox())!.height))
        }
        expect(new Set(heights).size).toBe(1)
    })

    test('labels that barely overflow the rail fit by trimming tab padding', async ({ page }) => {
        // Five tabs with History: English fits at full padding from about 412 px, Japanese trims.
        await page.setViewportSize({ width: 430, height: 844 })
        await setSettings(page, { showPreview: true })
        const strip = dock(page, 'top').getByRole('tablist')
        const padding = () =>
            strip
                .getByRole('tab')
                .first()
                .evaluate((element) => getComputedStyle(element).paddingLeft)
        await expect.poll(padding).toBe('12px')

        // Japanese labels overflow a phone's rail by a few pixels at full padding.
        await setSettings(page, { locale: 'ja' })
        await expect.poll(padding).toBe('8px')
        await settle(page)
        expect(await strip.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
        )
        await expect(strip).not.toHaveClass(/fade-end/)

        await setSettings(page, { locale: 'en' })
        await expect.poll(padding).toBe('12px')
    })
})

test('the rail is a single Tab stop that follows arrow-key focus', async ({ page }) => {
    await setSettings(page, { showGroups: true })
    await tab(page, 'left', 'Groups').focus()
    await page.keyboard.press('Home')
    await expect(tab(page, 'left', 'Preview')).toBeFocused()
    await expect(dock(page, 'left').locator('[role="tab"][tabindex="0"]')).toHaveCount(1)
    await expect(tab(page, 'left', 'Preview')).toHaveAttribute('tabindex', '0')
})

const shownTabs = (page: Page) =>
    page.evaluate(() =>
        [...document.querySelectorAll('[data-panel-tab][aria-selected="true"]')].map((element) =>
            element.getAttribute('data-panel-tab'),
        ),
    )

test.describe('tablets', () => {
    test('hiding a panel never brings back one it displaced', async ({ page }) => {
        await page.setViewportSize({ width: 820, height: 1180 })
        await setSettings(page, {
            showPreview: true,
            showGroups: true,
            showStages: false,
            showSidebar: false,
            panelRecency: ['preview', 'groups', 'stages', 'properties'],
        })
        // A portrait tablet's top dock fits three panels in a row.
        await tab(page, 'top', 'Stages').click()
        await expect.poll(() => shownTabs(page)).toEqual(['preview', 'groups', 'stages'])
        await tab(page, 'top', 'Properties').click()
        await expect.poll(() => shownTabs(page)).toEqual(['preview', 'stages', 'properties'])
        await expect(tab(page, 'top', 'Groups')).toHaveAttribute('aria-expanded', 'false')

        // Closing Properties by its tab, or Preview by the menu, leaves the
        // displaced Groups closed.
        await tab(page, 'top', 'Properties').click()
        await expect.poll(() => shownTabs(page)).toEqual(['preview', 'stages'])
        await tab(page, 'top', 'Preview').click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Close Preview' }).click()
        await expect.poll(() => shownTabs(page)).toEqual(['stages'])
    })

    test('a tab on a folded dock shows only that panel; the chevron restores', async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 820 })
        await setSettings(page, {
            showPreview: true,
            showGroups: true,
            showStages: false,
            showSidebar: true,
            panelRecency: ['preview', 'groups', 'properties', 'stages'],
        })
        await expect.poll(() => shownTabs(page)).toEqual(['preview', 'groups', 'properties'])
        await dock(page, 'left').getByRole('button', { name: 'Hide Left Panels' }).click()
        await expect.poll(() => shownTabs(page)).toEqual(['properties'])

        await tab(page, 'left', 'Stages').click()
        await expect.poll(() => shownTabs(page)).toEqual(['stages', 'properties'])
        await dock(page, 'left').getByRole('button', { name: 'Hide Left Panels' }).click()
        await dock(page, 'left').getByRole('button', { name: 'Show Left Panels' }).click()
        await expect.poll(() => shownTabs(page)).toEqual(['stages', 'properties'])
    })

    test('rotating keeps the same panels shown', async ({ page }) => {
        await page.setViewportSize({ width: 820, height: 1180 })
        await setSettings(page, {
            showPreview: true,
            showGroups: false,
            showStages: false,
            showSidebar: true,
            panelRecency: ['preview', 'properties', 'groups', 'stages'],
        })
        await expect.poll(() => shownTabs(page)).toEqual(['preview', 'properties'])
        await dock(page, 'top').getByRole('button', { name: 'Hide Top Panels' }).click()
        await expect.poll(() => shownTabs(page)).toEqual([])

        // Landscape splits them between two side docks; both stay folded.
        await page.setViewportSize({ width: 1180, height: 820 })
        await expect(dock(page, 'left')).toBeVisible()
        await expect.poll(() => shownTabs(page)).toEqual([])
        await page.setViewportSize({ width: 820, height: 1180 })
        await expect(dock(page, 'top')).toBeVisible()
        await expect.poll(() => shownTabs(page)).toEqual([])

        // Shown panels stay shown across a rotation and back.
        await dock(page, 'top').getByRole('button', { name: 'Show Top Panels' }).click()
        await expect.poll(() => shownTabs(page)).toEqual(['preview', 'properties'])
        await page.setViewportSize({ width: 1180, height: 820 })
        await expect.poll(() => shownTabs(page)).toEqual(['preview', 'properties'])
        await page.setViewportSize({ width: 820, height: 1180 })
        await expect.poll(() => shownTabs(page)).toEqual(['preview', 'properties'])
    })
})

const toolRows = (page: Page) =>
    page
        .locator('[data-editor-toolbar] > div > div > button')
        .evaluateAll(
            (tools) =>
                new Set(tools.map((tool) => Math.round(tool.getBoundingClientRect().top))).size,
        )

const dockWidth = async (page: Page, side: 'left' | 'right') =>
    Math.round((await dock(page, side).locator('.workspace-dock-body').boundingBox())!.width)

test.describe('default side docks', () => {
    for (const [width, height, size] of [
        [1280, 800, 304],
        [1366, 768, 347],
        [1440, 900, 384],
        [1600, 1000, 384],
    ] as const) {
        test(`leave the toolbar one row at ${width}x${height}`, async ({ page }) => {
            await page.setViewportSize({ width, height })
            await setSettings(page, {
                showPreview: true,
                showSidebar: true,
                leftDockWidth: 0,
                rightDockWidth: 0,
            })
            await settle(page)
            expect(await dockWidth(page, 'left')).toBe(size)
            expect(await dockWidth(page, 'right')).toBe(size)
            await expect.poll(() => toolRows(page)).toBe(1)
        })
    }

    test('assume the toolbar width it really needs for one row', async ({ page }) => {
        const count = await page.locator('[data-editor-toolbar] > div > div > button').count()
        const need = oneRowToolbarWidth(count, 16, false)
        const editor = page.locator('[data-editor-toolbar]')
        for (const [room, rows] of [
            [need, 1],
            [need - 1, 2],
        ] as const) {
            await setSettings(page, {
                showPreview: true,
                showSidebar: true,
                rightDockWidth: 384,
                leftDockWidth: 1600 - 2 * 36 - 384 - room,
            })
            await settle(page)
            expect(Math.round((await editor.boundingBox())!.width)).toBe(room)
            await expect.poll(() => toolRows(page)).toBe(rows)
        }
    })
})

test.describe('Groups and Stages side by side', () => {
    const tile = (page: Page, id: 'preview' | 'groups' | 'stages') =>
        page.locator(`#workspace-panel-${id}`)
    const box = async (page: Page, id: 'preview' | 'groups' | 'stages') => {
        const { x, y, width, height } = (await tile(page, id).boundingBox())!
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height }
    }
    // Groups and Stages share a row: the same top, Stages to the right of Groups.
    const sideBySide = async (page: Page) => {
        const [groups, stages] = [await box(page, 'groups'), await box(page, 'stages')]
        return groups.y === stages.y && stages.x === groups.x + groups.width + 4
    }

    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 2560, height: 1440 })
        await setSettings(page, {
            showPreview: true,
            showGroups: true,
            showStages: true,
            leftDockWidth: 500,
        })
        await settle(page)
    })

    test('a drag of the panel edge puts them side by side from 772 px, and Escape stacks them again', async ({
        page,
    }) => {
        await setSettings(page, { leftDockWidth: 740 })
        await settle(page)
        expect(await sideBySide(page)).toBe(false)
        const handle = dock(page, 'left').getByRole('separator', { name: 'Resize Left Panels' })
        const edge = (await handle.boundingBox())!
        const [x, y] = [edge.x + edge.width / 2, edge.y + 700]
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 31, y, { steps: 3 })
        await settle(page)
        expect(await dockWidth(page, 'left')).toBe(771)
        expect(await sideBySide(page)).toBe(false)
        const preview = await box(page, 'preview')
        await page.mouse.move(x + 32, y)
        await settle(page)
        expect(await sideBySide(page)).toBe(true)
        expect((await box(page, 'groups')).width).toBe(384)
        expect((await box(page, 'stages')).width).toBe(384)
        // Preview keeps its height across the change, but for the 1 px it widened.
        expect(Math.abs((await box(page, 'preview')).height - preview.height)).toBeLessThan(1)

        // Escape during the drag restores the width, and so the stack.
        await page.keyboard.press('Escape')
        await page.mouse.move(x + 120, y, { steps: 2 })
        await page.mouse.up()
        await settle(page)
        expect(await dockWidth(page, 'left')).toBe(740)
        expect(await sideBySide(page)).toBe(false)
        expect(await getSettings(page, ['leftDockWidth'])).toEqual({ leftDockWidth: 740 })

        // A drag that ends wide keeps them side by side; one back below 772 stacks them.
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 100, y, { steps: 4 })
        await page.mouse.up()
        await settle(page)
        expect(await sideBySide(page)).toBe(true)
        expect(await getSettings(page, ['leftDockWidth'])).toEqual({ leftDockWidth: 840 })
        await page.mouse.move(x + 100, y)
        await page.mouse.down()
        await page.mouse.move(x + 20, y, { steps: 4 })
        await page.mouse.up()
        await settle(page)
        expect(await sideBySide(page)).toBe(false)
        expect(await getSettings(page, ['leftDockWidth'])).toEqual({ leftDockWidth: 760 })
    })

    test('the divider between them resizes by pointer and keys, resets, and survives reload', async ({
        page,
    }) => {
        await setSettings(page, { leftDockWidth: 800 })
        await settle(page)
        const divider = dock(page, 'left').getByRole('separator', {
            name: 'Resize Groups and Stages',
        })
        await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
        await expect(divider).toHaveAttribute('aria-valuenow', '398')
        await expect(divider).toHaveAttribute('aria-valuemin', '260')
        await expect(divider).toHaveAttribute('aria-valuemax', '536')
        const weights = await getSettings(page, ['panelWeights'])

        const line = (await divider.boundingBox())!
        const [x, y] = [line.x + line.width / 2, line.y + line.height / 2]
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 60, y, { steps: 4 })
        await settle(page)
        expect((await box(page, 'groups')).width).toBe(458)
        expect(await getSettings(page, ['groupsStagesSplit'])).toEqual({ groupsStagesSplit: 0.5 })
        await page.mouse.up()
        await settle(page)
        expect((await box(page, 'stages')).width).toBe(796 - 458)
        expect(await getSettings(page, ['panelWeights'])).toEqual(weights)

        // Escape during a drag keeps the saved width.
        await page.mouse.move(x + 60, y)
        await page.mouse.down()
        await page.mouse.move(x - 100, y, { steps: 4 })
        await page.keyboard.press('Escape')
        await page.mouse.up()
        await settle(page)
        expect((await box(page, 'groups')).width).toBe(458)

        await divider.focus()
        await page.keyboard.press('ArrowLeft')
        await expect(divider).toHaveAttribute('aria-valuenow', '442')
        await page.keyboard.press('Shift+ArrowRight')
        await expect(divider).toHaveAttribute('aria-valuenow', '506')
        await page.keyboard.press('End')
        await expect(divider).toHaveAttribute('aria-valuenow', '536')
        expect((await box(page, 'stages')).width).toBe(260)
        await page.keyboard.press('Home')
        await expect(divider).toHaveAttribute('aria-valuenow', '260')
        await page.keyboard.press('ArrowRight')
        await expect(divider).toHaveAttribute('aria-valuenow', '276')
        expect(await getSettings(page, ['panelWeights'])).toEqual(weights)

        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await setSettings(page, { showPreview: true })
        await expect(divider).toHaveAttribute('aria-valuenow', '276')
        expect((await box(page, 'groups')).width).toBe(276)

        // Enter and a double click both make the widths equal.
        await divider.focus()
        await page.keyboard.press('Enter')
        await expect(divider).toHaveAttribute('aria-valuenow', '398')
        await page.keyboard.press('ArrowLeft')
        await expect(divider).toHaveAttribute('aria-valuenow', '382')
        await divider.dblclick()
        await expect(divider).toHaveAttribute('aria-valuenow', '398')
        expect(await getSettings(page, ['groupsStagesSplit'])).toEqual({ groupsStagesSplit: 0.5 })
    })

    test('Settings › Panels chooses Auto, Enabled or Disabled, each kept after a reload', async ({
        page,
    }) => {
        const choice = () =>
            page
                .getByRole('dialog')
                .locator('[data-settings-section="panels"]')
                .getByRole('combobox', { name: 'Groups and Stages Side by Side' })
        const reload = async () => {
            await page.reload()
            await expect(page.locator('canvas.editor-chart')).toBeVisible()
            await page.evaluate(installEditorFixture)
            await setSettings(page, { showPreview: true })
            await settle(page)
        }
        // Auto at 600 px: too narrow.
        await setSettings(page, { leftDockWidth: 600 })
        await settle(page)
        expect(await sideBySide(page)).toBe(false)
        await page.keyboard.press(',')
        await expect(choice()).toHaveValue('auto')
        await expect(choice()).toHaveAccessibleDescription(
            /^When Preview, Groups and Stages are all shown in the left panels/,
        )
        await choice().selectOption('enabled')
        await page.keyboard.press('Escape')
        await settle(page)
        expect(await sideBySide(page)).toBe(true)
        await reload()
        expect(await getSettings(page, ['groupsStagesSideBySide'])).toEqual({
            groupsStagesSideBySide: 'enabled',
        })
        expect(await sideBySide(page)).toBe(true)

        // Disabled keeps them stacked, however wide.
        await setSettings(page, { leftDockWidth: 900 })
        await page.keyboard.press(',')
        await expect(choice()).toHaveValue('enabled')
        await choice().selectOption('disabled')
        await page.keyboard.press('Escape')
        await settle(page)
        expect(await sideBySide(page)).toBe(false)
        await reload()
        expect(await getSettings(page, ['groupsStagesSideBySide'])).toEqual({
            groupsStagesSideBySide: 'disabled',
        })
        expect(await sideBySide(page)).toBe(false)

        // Reset Settings returns to Auto.
        await page.keyboard.press(',')
        await page
            .getByRole('dialog')
            .getByRole('button', { name: 'Reset Settings…', exact: true })
            .click()
        await confirmReset(page, 'Reset Settings')
        await expect(choice()).toHaveValue('auto')
        expect(await getSettings(page, ['groupsStagesSideBySide'])).toEqual({
            groupsStagesSideBySide: 'auto',
        })
    })

    test("a text size change with no window resize moves them to Auto's new width and ends a drag", async ({
        page,
    }) => {
        await setSettings(page, { leftDockWidth: 800 })
        await settle(page)
        expect(await sideBySide(page)).toBe(true)
        const saved = await getSettings(page, ['panelWeights'])
        const separator = dock(page, 'left').getByRole('separator', {
            name: 'Resize Preview, Groups and Stages',
        })
        const line = (await separator.boundingBox())!
        const [x, y] = [line.x + 100, line.y + line.height / 2]
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x, y + 40, { steps: 2 })
        // 20 px text: Auto now needs 964 px.
        const textSize = (size: string) =>
            page.evaluate((size) => {
                document.documentElement.style.fontSize = size
            }, size)
        await textSize('20px')
        await expect.poll(() => sideBySide(page)).toBe(false)
        await page.mouse.move(x, y + 80, { steps: 2 })
        await page.mouse.up()
        await settle(page)
        expect(await getSettings(page, ['panelWeights'])).toEqual(saved)
        await textSize('')
        await expect.poll(() => sideBySide(page)).toBe(true)
    })

    test('a drag between tiles ends when they go side by side or back, as with Escape', async ({
        page,
    }) => {
        const saved = await getSettings(page, ['panelWeights', 'groupsStagesSplit'])
        const tiles = async () =>
            Promise.all((['preview', 'groups', 'stages'] as const).map((id) => box(page, id)))
        // Each separator is dragged, the panels' width crosses 772 px, and the drag goes on.
        for (const [name, from, to] of [
            ['Resize Groups and Stages', 500, 800],
            ['Resize Preview and Groups', 771, 772],
            ['Resize Preview, Groups and Stages', 772, 771],
        ] as const) {
            await setSettings(page, { leftDockWidth: from })
            await settle(page)
            const separator = dock(page, 'left').getByRole('separator', { name, exact: true })
            const line = (await separator.boundingBox())!
            const [x, y] = [line.x + 100, line.y + line.height / 2]
            await page.mouse.move(x, y)
            await page.mouse.down()
            await page.mouse.move(x, y + 40, { steps: 2 })
            await setSettings(page, { leftDockWidth: to })
            await settle(page)
            // The draft is dropped at once, and the release saves nothing.
            const dropped = await tiles()
            await page.mouse.move(x + 20, y + 80, { steps: 2 })
            await settle(page)
            expect(await tiles(), name).toEqual(dropped)
            await page.mouse.up()
            await settle(page)
            expect(await getSettings(page, ['panelWeights', 'groupsStagesSplit']), name).toEqual(
                saved,
            )
            expect(await tiles(), name).toEqual(dropped)
        }
    })

    test('the dividers above and below them resize both at once and reset all they changed', async ({
        page,
    }) => {
        await setSettings(page, {
            leftDockWidth: 800,
            propertiesPosition: 'left',
            showSidebar: true,
        })
        await settle(page)
        const above = dock(page, 'left').getByRole('separator', {
            name: 'Resize Preview, Groups and Stages',
        })
        const below = dock(page, 'left').getByRole('separator', {
            name: 'Resize Groups, Stages and Properties',
        })
        const groups = await box(page, 'groups')
        const line = (await above.boundingBox())!
        const [x, y] = [line.x + 200, line.y + line.height / 2]
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x, y + 80, { steps: 4 })
        await page.mouse.up()
        await settle(page)
        const after = await box(page, 'groups')
        expect(Math.round(after.height - groups.height)).toBe(-80)
        expect(Math.round((await box(page, 'stages')).height)).toBe(Math.round(after.height))

        await below.focus()
        await page.keyboard.press('ArrowDown')
        await settle(page)
        expect(Math.round((await box(page, 'stages')).height - after.height)).toBe(16)
        const { panelWeights } = (await getSettings(page, ['panelWeights'])) as {
            panelWeights: Record<string, number>
        }
        // The two keep the proportion they had.
        expect(panelWeights.groups).toBeCloseTo(panelWeights.stages ?? 0, 9)

        await above.dblclick()
        await settle(page)
        const reset = (await getSettings(page, ['panelWeights'])) as {
            panelWeights: Record<string, number>
        }
        expect(Object.keys(reset.panelWeights)).toEqual(['properties'])
    })
})
