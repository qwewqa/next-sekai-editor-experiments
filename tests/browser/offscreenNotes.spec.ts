import { expect, test, type Locator, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show, settings, history } = window.editorTest
        settings.showOtherGroups = false
        settings.showOtherObjects = false
        settings.elevationEditorSideBySide = 'allow'
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: -40, size: 2, elevation: 2 }],
                    ...Array.from({ length: 12 }, () => [
                        { ...base, beat: 3, left: 40, size: 2, elevation: 2 },
                    ]),
                    [{ ...base, beat: 3, left: 0, size: 2, elevation: 2 }],
                    [{ ...base, beat: 500, left: 40, size: 2, elevation: 2 }],
                ],
            },
            1.5,
        )
        const current = history.state.value
        history.replaceState({
            ...current,
            selectedEntities: [...current.store.slides.note.values()][0]!,
        })
    })
})

test('main editor counts offscreen notes and indicators disappear after panning or filtering', async ({
    page,
}) => {
    const editor = page.locator('.editor-chart').locator('..')
    const indicators = editor.locator('.offscreen-note-indicator')
    await expect(indicators).toHaveCount(2)
    await expect(editor.locator('[data-side="left"]')).toHaveAttribute('data-count', '1')
    await expect(editor.locator('[data-side="right"]')).toHaveAttribute('data-count', '12')
    await page.evaluate(() => {
        window.editorTest.view.lane = 40
    })
    await expect(indicators).toHaveCount(1)
    await expect(indicators).toHaveAttribute('data-side', 'left')
    await expect(indicators).toHaveAttribute('data-count', '2')
    await page.evaluate(() => {
        const { view } = window.editorTest
        view.visibilities = { ...view.visibilities, note: false }
    })
    await expect(indicators).toHaveCount(0)
})

test('elevation editor shows directional counts and stays legible on phones', async ({
    page,
}, testInfo) => {
    await page.keyboard.press('t')
    const editor = page.locator('.elevation-editor')
    await expect(editor.locator('[data-side="left"]')).toHaveAttribute('data-count', '1')
    await expect(editor.locator('[data-side="right"]')).toHaveAttribute('data-count', '12')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
    })
    const header = await editor.locator('.elevation-header').boundingBox()
    for (const indicator of await editor.locator('.offscreen-note-indicator').all()) {
        await expect(indicator).toBeInViewport()
        const bounds = await indicator.boundingBox()
        expect(bounds!.y).toBeGreaterThanOrEqual(header!.y + header!.height)
        expect(bounds!.width).toBeGreaterThan(20)
    }
    await page.screenshot({ path: testInfo.outputPath('offscreen-phone.png') })
})

test('offscreen counts follow live width previews and revert on Cancel', async ({ page }) => {
    await page.evaluate(() => {
        const { history, settings } = window.editorTest
        const current = history.state.value
        history.replaceState({
            ...current,
            selectedEntities: [...current.store.slides.note.values()].flat(),
        })
        settings.keyboardShortcuts = { ...settings.keyboardShortcuts, scaleWidth: 'F10' }
    })
    await page.keyboard.press('F10')
    await page.getByRole('spinbutton', { name: 'Scale Factor' }).fill('0.1')
    const editor = page.locator('.editor-chart').locator('..')
    await expect(editor.locator('[data-side="left"]')).toHaveAttribute('data-count', '14')
    await expect(editor.locator('[data-side="right"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editor.locator('[data-side="left"]')).toHaveAttribute('data-count', '1')
    await expect(editor.locator('[data-side="right"]')).toHaveAttribute('data-count', '12')
})

const selectedCount = (page: Page) =>
    page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length)

const hoveredCount = (page: Page) =>
    page.evaluate(() => window.editorTest.view.entities.hovered.length)

const center = async (indicator: Locator) => {
    const bounds = (await indicator.boundingBox())!
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

const clickIndicator = async (page: Page, indicator: Locator, ctrl = false) => {
    const { x, y } = await center(indicator)
    await page.mouse.move(x, y)
    if (ctrl) await page.keyboard.down('Control')
    await page.mouse.click(x, y)
    if (ctrl) await page.keyboard.up('Control')
}

test('select tool clicks select the notes behind a badge, with Ctrl toggling', async ({
    page,
}, testInfo) => {
    const editor = page.locator('.editor-chart').locator('..')
    const left = editor.locator('[data-side="left"]')
    const right = editor.locator('[data-side="right"]')
    const canUndo = () => page.evaluate(() => window.editorTest.history.canUndo.value)
    expect(await canUndo()).toBe(false)

    const { x, y } = await center(right)
    // The far edge of the badge is still inside its hit area.
    const bounds = (await right.boundingBox())!
    await page.mouse.move(bounds.x + 1, y)
    await expect(editor).toHaveCSS('cursor', 'pointer')
    await page.mouse.move(x, y)
    await expect(editor).toHaveCSS('cursor', 'pointer')
    await expect(right).toHaveClass(/is-hovered/)
    await expect(left).not.toHaveClass(/is-hovered/)
    await page.screenshot({ path: testInfo.outputPath('offscreen-select-hover-desktop.png') })

    await page.mouse.click(x, y)
    expect(await selectedCount(page)).toBe(12)
    await expect(page.locator('.notification')).toHaveText('Selected 12 objects')
    await expect(right).toHaveClass(/border-white(\s|$)/)
    // The resting mouse hovers again, as after any tap; so does a click that changes nothing.
    await expect.poll(() => hoveredCount(page)).toBe(12)
    await page.evaluate(() => {
        window.editorTest.view.entities = { hovered: [], creating: [] }
    })
    await page.mouse.click(x, y)
    expect(await selectedCount(page)).toBe(12)
    await expect.poll(() => hoveredCount(page)).toBe(12)

    await clickIndicator(page, left, true)
    expect(await selectedCount(page)).toBe(13)
    await clickIndicator(page, left, true)
    expect(await selectedCount(page)).toBe(12)
    await clickIndicator(page, left)
    expect(await selectedCount(page)).toBe(1)
    // Selection changes never add undo steps.
    expect(await canUndo()).toBe(false)

    // Away from the badge the select tool behaves as before.
    await page.mouse.move(x - 120, y)
    await expect(editor).toHaveCSS('cursor', 'default')
    await expect(right).not.toHaveClass(/is-hovered/)
})

test('Shift extends a badge selection to the whole slides', async ({ page }) => {
    await page.evaluate(() => {
        const { fixtures, show } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [
                        { ...base, beat: 2, left: 0, size: 2 },
                        { ...base, beat: 3, left: 40, size: 2 },
                    ],
                ],
            },
            1.5,
        )
    })
    const right = page.locator('.editor-chart').locator('..').locator('[data-side="right"]')
    await expect(right).toHaveAttribute('data-count', '1')
    const { x, y } = await center(right)
    await page.mouse.move(x, y)
    await page.keyboard.down('Shift')
    await page.mouse.click(x, y)
    await page.keyboard.up('Shift')
    expect(await selectedCount(page)).toBe(2)
    await page.mouse.click(x, y)
    expect(await selectedCount(page)).toBe(1)
})

test('pressing and dragging from a badge box-selects instead', async ({ page }) => {
    const editor = page.locator('.editor-chart').locator('..')
    const right = editor.locator('[data-side="right"]')
    const { x, y } = await center(right)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 100, y + 60, { steps: 5 })
    await expect(editor).toHaveCSS('cursor', 'crosshair')
    await page.mouse.up()
    expect(await selectedCount(page)).toBe(0)
})

for (const dimming of ['type', 'group'] as const) {
    test(`notes dimmed by ${dimming} are counted but cannot be selected from their badge`, async ({
        page,
    }) => {
        await page.evaluate((dimming) => {
            const { view, settings } = window.editorTest
            if (dimming === 'type') {
                settings.showOtherObjects = true
                view.visibilities = { ...view.visibilities, note: false }
            } else {
                settings.showOtherGroups = true
                view.groupId = 2 as typeof view.groupId
            }
        }, dimming)
        const editor = page.locator('.editor-chart').locator('..')
        const right = editor.locator('[data-side="right"]')
        await expect(right).toHaveAttribute('data-count', '12')
        await expect(right).toHaveAttribute('data-selectable', '0')
        const { x, y } = await center(right)
        await page.mouse.move(x, y)
        await expect(editor).toHaveCSS('cursor', 'default')
        await expect(right).not.toHaveClass(/is-hovered/)
        await page.mouse.click(x, y)
        expect(await selectedCount(page)).toBe(0)
    })
}

test('isolating another group removes its notes from offscreen counts in both editors', async ({
    page,
}) => {
    await page.keyboard.press('t')
    await page.evaluate(() => {
        window.editorTest.view.groupId = 2 as typeof window.editorTest.view.groupId
    })
    await expect(page.locator('.offscreen-note-indicator')).toHaveCount(0)
    await page.evaluate(() => {
        window.editorTest.view.groupId = undefined
    })
    await expect(
        page.locator('.editor-chart').locator('..').locator('.offscreen-note-indicator'),
    ).toHaveCount(2)
    await expect(page.locator('.elevation-editor .offscreen-note-indicator')).toHaveCount(2)
})

test('other tools ignore the badges', async ({ page }) => {
    const editor = page.locator('.editor-chart').locator('..')
    const right = editor.locator('[data-side="right"]')
    const notes = () => page.evaluate(() => window.editorTest.snapshot().notes.length)
    const before = await notes()
    await page.keyboard.press('a')
    const { x, y } = await center(right)
    await page.mouse.move(x, y)
    await expect(right).not.toHaveClass(/is-hovered/)
    await page.mouse.click(x, y)
    expect(await notes()).toBe(before + 1)
})

test('elevation editor badges select their notes too', async ({ page }) => {
    await page.keyboard.press('t')
    const pane = page.locator('.elevation-editor')
    const editor = pane.locator('.editor')
    const left = pane.locator('[data-side="left"]')
    const right = pane.locator('[data-side="right"]')
    await expect(right).toHaveAttribute('data-count', '12')
    const { x, y } = await center(right)
    await page.mouse.move(x, y)
    await expect(editor).toHaveCSS('cursor', 'pointer')
    await expect(right).toHaveClass(/is-hovered/)
    await page.mouse.click(x, y)
    expect(await selectedCount(page)).toBe(12)
    // The resting mouse hovers again, as after any tap.
    await expect.poll(() => hoveredCount(page)).toBe(12)
    await clickIndicator(page, left, true)
    expect(await selectedCount(page)).toBe(13)
    await clickIndicator(page, left, true)
    expect(await selectedCount(page)).toBe(12)
})

test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('badges show the hover state at phone size', async ({ page }, testInfo) => {
        const editor = page.locator('.editor-chart').locator('..')
        const right = editor.locator('[data-side="right"]')
        await expect(right).toBeVisible()
        const { x, y } = await center(right)
        await page.mouse.move(x, y)
        await expect(editor).toHaveCSS('cursor', 'pointer')
        await expect(right).toHaveClass(/is-hovered/)
        await page.screenshot({ path: testInfo.outputPath('offscreen-select-hover-phone.png') })
    })

    test.describe('touch', () => {
        test.use({ hasTouch: true })

        test('tapping a badge selects its notes', async ({ page }) => {
            const editor = page.locator('.editor-chart').locator('..')
            const right = editor.locator('[data-side="right"]')
            const { x, y } = await center(right)
            await page.touchscreen.tap(x, y)
            await expect.poll(() => selectedCount(page)).toBe(12)
            await expect(right).not.toHaveClass(/is-hovered/)
            // A tap leaves no hover outline.
            expect(await hoveredCount(page)).toBe(0)
        })
    })
})

test('badges keep clear of the range labels and the elevation axis', async ({ page }) => {
    await page.evaluate(() => {
        const { fixtures, show, history } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    // Notes from the bottom of the view past its top.
                    ...Array.from({ length: 80 }, (_, index) => [
                        { ...base, beat: index / 4, left: -40, size: 2 },
                    ]),
                    ...Array.from({ length: 10 }, (_, index) => [
                        { ...base, beat: 12, left: index ? -40 : 0, size: 2, elevation: index },
                    ]),
                ],
            },
            4,
        )
        const [target] = [...history.state.value.store.slides.note.values()]
            .flat()
            .filter((note) => note.beat === 12 && note.left === 0)
        history.replaceState({ ...history.state.value, selectedEntities: [target!] })
        const fillText = CanvasRenderingContext2D.prototype.fillText
        const axis: number[] = []
        Object.assign(window, { axisLabelXs: axis })
        // Keeps the labels of the latest elevation frame.
        const clearRect = CanvasRenderingContext2D.prototype.clearRect
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
            if (this.canvas.classList.contains('elevation-canvas')) axis.length = 0
            return clearRect.apply(this, args)
        }
        CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
            if (this.canvas.classList.contains('elevation-canvas') && /^-?\d+$/.test(text))
                axis.push(x)
            return fillText.call(this, text, x, y, maxWidth)
        }
    })
    const editor = page.locator('.editor-chart').locator('..')
    const range = await page.evaluate(() =>
        [...document.querySelectorAll('span')]
            .filter((span) => /^\d\d:\d\d\.\d{3}$/.test(span.textContent ?? ''))
            .map((span) => span.getBoundingClientRect())
            .filter(({ height, top }) => height && top >= 0)
            .map(({ top, bottom }) => ({ top, bottom })),
    )
    const [upper, lower] = range.sort((a, b) => a.top - b.top)
    const badges = await editor
        .locator('.offscreen-note-indicator')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()))
    expect(badges.length).toBeGreaterThan(5)
    for (const badge of badges) {
        expect(badge.top).toBeGreaterThanOrEqual(upper!.bottom)
        expect(badge.bottom).toBeLessThanOrEqual(lower!.top)
    }

    await page.keyboard.press('t')
    const pane = page.locator('.elevation-editor')
    await expect(pane.locator('[data-side="left"]').first()).toBeVisible()
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    const canvasLeft = await pane
        .locator('.elevation-canvas')
        .evaluate((canvas) => canvas.getBoundingClientRect().left)
    const badgeRight = Math.max(
        ...(await pane
            .locator('[data-side="left"]')
            .evaluateAll((elements) =>
                elements.map((element) => element.getBoundingClientRect().right),
            )),
    )
    const xs = await page.evaluate(
        () => (window as unknown as { axisLabelXs: number[] }).axisLabelXs,
    )
    expect(xs.length).toBeGreaterThan(0)
    for (const x of xs) expect(canvasLeft + x).toBeGreaterThanOrEqual(badgeRight)
})

// Each frame, how far the left badge sits from its note (beat 3, lane -40), in px.
const recordBadgeOffsets = (page: Page) =>
    page.evaluate(() => {
        const { point } = window.editorTest
        const offsets: number[] = []
        let recording = true
        const record = () => {
            if (!recording) return
            const badge = document.querySelector(
                '.editor-chart ~ div .offscreen-note-indicator[data-side="left"]',
            )
            if (badge) {
                const { top, height } = badge.getBoundingClientRect()
                offsets.push(top + height / 2 - point(-40, 3).y)
            }
            requestAnimationFrame(record)
        }
        requestAnimationFrame(record)
        Object.assign(window, {
            stopBadgeOffsets: () => {
                recording = false
                return offsets
            },
        })
    })

for (const { name, smooth, pps } of [
    { name: 'stepped', smooth: false },
    { name: 'eased', smooth: true },
    // Beat 3 is 0.2 px into its slot from time 0, 30 slots up.
    { name: 'eased, with the note at a slot edge,', smooth: true, pps: (30 * 28 - 0.2) / 1.5 },
]) {
    test(`badges move with their notes while ${name} wheel scrolling`, async ({ page }) => {
        await page.evaluate(
            ({ smooth, pps }) => {
                const { view, settings } = window.editorTest
                settings.mouseSmoothScrolling = smooth
                if (pps) settings.pps = pps
                // Beat 3 in the middle of the view, far from the badge band's edges.
                view.time = 1.5
            },
            { smooth, pps },
        )
        const chart = (await page.locator('canvas.editor-chart').boundingBox())!
        await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height / 2)
        await recordBadgeOffsets(page)
        for (const delta of [7, 7, 7, 7, 7, -5, -5, -5, 11, 11, 11, 11]) {
            await page.mouse.wheel(0, delta)
            await page.waitForTimeout(40)
        }
        await page.waitForTimeout(300)
        const offsets = await page.evaluate(() =>
            (window as unknown as { stopBadgeOffsets: () => number[] }).stopBadgeOffsets(),
        )
        expect(offsets.length).toBeGreaterThan(10)
        expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1)
        expect(Math.abs(offsets[0]!)).toBeLessThanOrEqual(14)
    })
}

test('elevation editor badges move with their notes as the elevation view pans', async ({
    page,
}) => {
    await page.keyboard.press('t')
    const badge = page.locator('.elevation-editor [data-side="left"]')
    await expect(badge).toHaveAttribute('data-count', '1')
    const offsets = await page.evaluate(async () => {
        const { appImport, nextTick } = window.editorTest
        const { elevationViewport } = await appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const canvas = document.querySelector('.elevation-canvas')!
        const offsets: number[] = []
        const start = elevationViewport.center
        for (let step = 0; step < 12; step++) {
            elevationViewport.center = start + step * 0.07
            await nextTick()
            const badge = document.querySelector('.elevation-editor [data-side="left"]')!
            const { top, height } = badge.getBoundingClientRect()
            const note = canvas.getBoundingClientRect().top + elevationLayout.value.yAt(2)
            offsets.push(top + height / 2 - note)
        }
        return offsets
    })
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1)
})
