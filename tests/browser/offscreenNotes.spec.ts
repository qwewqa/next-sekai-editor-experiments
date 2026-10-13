import { expect, test, type Locator, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, touchInput, useTool } from './editorFixture'

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

// At beat 3: a note in view, two far above and one far below; at beat 4, one in view.
const showAboveAndBelow = async (page: Page) => {
    await page.evaluate(() => {
        const { fixtures, show, view } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: 0, size: 2, elevation: 2 }],
                    [{ ...base, beat: 3, left: 0, size: 2, elevation: 40 }],
                    [{ ...base, beat: 3, left: 0, size: 2, elevation: 41 }],
                    [{ ...base, beat: 3, left: 2, size: 2, elevation: -30 }],
                    [{ ...base, beat: 4, left: 0, size: 2, elevation: 2 }],
                ],
            },
            1.5,
        )
        view.cursorTime = 1.5
    })
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    // Closer than the fit, which takes them all in.
    await page.evaluate(async () => {
        const { elevationViewport } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        Object.assign(elevationViewport, { center: 2, scale: 60 })
    })
}

// The page x of a lane in the elevation editor.
const elevationLaneX = (page: Page, lane: number) =>
    page.evaluate(async (lane) => {
        const { appImport } = window.editorTest
        const { elevationBounds } = await appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        return elevationBounds.x + elevationLayout.value.xAt(lane)
    }, lane)

const badgeCount = (page: Page, side: string) =>
    page
        .locator(`.elevation-editor [data-side="${side}"]`)
        .evaluateAll((elements) =>
            elements.reduce((sum, element) => sum + Number(element.getAttribute('data-count')), 0),
        )

for (const { name, width, side } of [
    { name: 'full', width: 1600, side: 'disallow' },
    { name: 'side by side', width: 1600, side: 'allow' },
    { name: 'phone', width: 390, side: 'disallow' },
] as const) {
    test(`elevation editor shows notes above and below at their lanes, ${name}`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height: 844 })
        await page.evaluate((side) => {
            window.editorTest.settings.elevationEditorSideBySide = side
        }, side)
        await showAboveAndBelow(page)
        const pane = page.locator('.elevation-editor')
        const top = pane.locator('[data-side="top"]')
        const bottom = pane.locator('[data-side="bottom"]')
        await expect(top).toHaveAttribute('data-count', '2')
        await expect(bottom).toHaveAttribute('data-count', '1')
        await expect(top).toHaveAttribute('aria-label', 'Notes Off-Screen Above: 2')
        const header = (await pane.locator('.elevation-header').boundingBox())!
        const toolbar = (await pane.locator('[data-editor-toolbar] > div').boundingBox())!
        const topBox = (await top.boundingBox())!
        const bottomBox = (await bottom.boundingBox())!
        // Clear of the header and the toolbar.
        expect(topBox.y).toBeGreaterThanOrEqual(header.y + header.height)
        expect(bottomBox.y + bottomBox.height).toBeLessThanOrEqual(toolbar.y)
        await expect(top).toBeInViewport({ ratio: 1 })
        await expect(bottom).toBeInViewport({ ratio: 1 })
        // At their notes' lanes, within half a cell.
        expect(
            Math.abs(topBox.x + topBox.width / 2 - (await elevationLaneX(page, 1))),
        ).toBeLessThanOrEqual(24)
        expect(
            Math.abs(bottomBox.x + bottomBox.width / 2 - (await elevationLaneX(page, 3))),
        ).toBeLessThanOrEqual(24)
    })
}

test('top and bottom badges select their notes as the side badges do', async ({ page }) => {
    await showAboveAndBelow(page)
    const pane = page.locator('.elevation-editor')
    const editor = pane.locator('.editor')
    const top = pane.locator('[data-side="top"]')
    const bottom = pane.locator('[data-side="bottom"]')
    const { x, y } = await center(top)
    await page.mouse.move(x, y)
    await expect(editor).toHaveCSS('cursor', 'pointer')
    await expect(top).toHaveClass(/is-hovered/)
    await page.mouse.click(x, y)
    expect(await selectedCount(page)).toBe(2)
    await clickIndicator(page, bottom, true)
    expect(await selectedCount(page)).toBe(3)
    await clickIndicator(page, bottom, true)
    expect(await selectedCount(page)).toBe(2)
    // Pressing and dragging from it box-selects.
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 100, y + 60, { steps: 5 })
    await page.mouse.up()
    expect(await selectedCount(page)).toBe(0)
})

test('top and bottom badges follow beat changes, scrolling and zooming', async ({ page }) => {
    await showAboveAndBelow(page)
    const pane = page.locator('.elevation-editor')
    await expect.poll(() => badgeCount(page, 'top')).toBe(2)
    await pane.getByRole('button', { name: 'Next Beat', exact: true }).click()
    await expect.poll(() => badgeCount(page, 'top')).toBe(0)
    await expect.poll(() => badgeCount(page, 'bottom')).toBe(0)
    await pane.getByRole('button', { name: 'Previous Beat', exact: true }).click()
    await expect.poll(() => badgeCount(page, 'top')).toBe(2)
    // Notes under the header count as above.
    await page.evaluate(async () => {
        const { elevationViewport, elevationBounds } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        const header = document.querySelector('.elevation-header')!.getBoundingClientRect()
        const scale = 20
        Object.assign(elevationViewport, {
            scale,
            center: 40.5 - (elevationBounds.h / 2 - header.height / 2) / scale,
        })
    })
    await expect.poll(() => badgeCount(page, 'top')).toBe(2)
    await page.evaluate(async () => {
        const { elevationViewport } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        Object.assign(elevationViewport, { center: 2, scale: 60 })
    })
    // Scrolling up to the notes above leaves the others below.
    const canvas = (await pane.locator('.elevation-canvas').boundingBox())!
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
    for (let i = 0; i < 60 && (await badgeCount(page, 'top')); i++) {
        await page.mouse.wheel(0, -200)
        await page.evaluate(() => window.editorTest.nextTick())
    }
    await expect.poll(() => badgeCount(page, 'top')).toBe(0)
    await expect.poll(() => badgeCount(page, 'bottom')).toBe(2)
    // Zooming out takes them all in.
    await page.keyboard.down('Control')
    for (let i = 0; i < 60 && (await badgeCount(page, 'bottom')); i++) {
        await page.mouse.wheel(0, 200)
        await page.evaluate(() => window.editorTest.nextTick())
    }
    await page.keyboard.up('Control')
    await expect.poll(() => badgeCount(page, 'bottom')).toBe(0)
    await expect(pane.locator('.offscreen-note-indicator')).toHaveCount(0)
})

test.describe('touch on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('tapping a top badge selects its notes', async ({ page }) => {
        await page.evaluate(() => {
            window.editorTest.settings.elevationEditorSideBySide = 'disallow'
        })
        await showAboveAndBelow(page)
        const top = page.locator('.elevation-editor [data-side="top"]')
        const { x, y } = await center(top)
        await page.touchscreen.tap(x, y)
        await expect.poll(() => selectedCount(page)).toBe(2)
        await expect(top).not.toHaveClass(/is-hovered/)
    })
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

// Badge pane y per step (null when there's none), checked against the scroll's direction.
const expectOnlyWithScroll = (
    rows: { note: number; badge: number | null }[],
    // Notes count from top to the pane's bottom; badges are centred from first + 14 to last - 14.
    pane: { top: number; height: number; first: number; last: number },
) => {
    const direction = Math.sign(rows.at(-1)!.note - rows[0]!.note)
    let previous: number | undefined
    let hops = 0
    for (const { note, badge } of rows) {
        // Shown while the note is in the pane, and until its slot leaves it.
        if (note >= pane.top + 2 && note <= pane.height - 2)
            expect(badge, `note at ${note}`).not.toBeNull()
        if (note < pane.top - 56 - 2 || note > pane.height + 56 + 2)
            expect(badge, `note at ${note}`).toBeNull()
        if (badge === null) continue
        expect(badge).toBeGreaterThanOrEqual(pane.first + 14 - 1)
        expect(badge).toBeLessThanOrEqual(pane.last - 14 + 1)
        if (previous !== undefined) {
            const move = (badge - previous) * direction
            expect(move, `note at ${note}`).toBeGreaterThanOrEqual(0)
            expect(move, `note at ${note}`).toBeLessThanOrEqual(28 + 3)
            if (move > 3) hops++
        }
        previous = badge
    }
    // Riding with the note, then one hop to the edge it's held at (or back).
    expect(hops).toBe(1)
}

for (const layout of ['basic', 'composed'] as const) {
    test(`a lone badge moves only with the scroll across the edges in the ${layout} layout`, async ({
        page,
    }) => {
        await page.evaluate((layout) => {
            const { fixtures, show, view } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show({
                ...fixtures.interaction,
                slides: [[{ ...base, beat: 3, left: -40, size: 2, elevation: 2 }]],
            })
            view.layout = layout
        }, layout)
        const height = await page.evaluate(() => window.editorTest.view.h)
        for (const [from, to] of [
            [200, -70],
            [-70, 200],
            [height - 200, height + 70],
            [height + 70, height - 200],
        ] as const) {
            const rows = await page.evaluate(
                async ({ from, to }) => {
                    const { view, settings, nextTick } = window.editorTest
                    const rows: { note: number; badge: number | null }[] = []
                    const steps = Math.ceil(Math.abs(to - from) / 1.5)
                    for (let i = 0; i <= steps; i++) {
                        const note = from + ((to - from) * i) / steps
                        // Beat 3 is at 1.5 s.
                        view.time = 1.5 + (note - view.h / 2) / settings.pps
                        await nextTick()
                        const badge = document.querySelector(
                            '.editor-chart ~ div .offscreen-note-indicator[data-side="left"]',
                        )
                        const bounds = badge?.getBoundingClientRect()
                        rows.push({
                            note,
                            badge: bounds ? bounds.top + bounds.height / 2 - view.y : null,
                        })
                    }
                    return rows
                },
                { from, to },
            )
            expectOnlyWithScroll(rows, { top: 0, height, first: 24, last: height - 24 })
        }
    })
}

test('elevation editor badges of elevation 0 notes keep their slot as the view pans', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, history } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        // Imported notes default to elevation 0, which sits exactly on a slot boundary.
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: 40, size: 2, elevation: 0 }],
                    [{ ...base, beat: 3, left: 0, size: 2, elevation: 2 }],
                ],
            },
            1.5,
        )
        const current = history.state.value
        history.replaceState({
            ...current,
            selectedEntities: [...current.store.slides.note.values()][1]!,
        })
    })
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-editor [data-side="right"]')).toHaveAttribute(
        'data-count',
        '1',
    )
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
        // Fractional centres, which used to put elevation 0 a rounding error into the slot above.
        for (let step = 0; step < 40; step++) {
            elevationViewport.center = start + step * 0.0137
            await nextTick()
            const badge = document.querySelector('.elevation-editor [data-side="right"]')!
            const { top, height } = badge.getBoundingClientRect()
            const note = canvas.getBoundingClientRect().top + elevationLayout.value.yAt(0)
            offsets.push(top + height / 2 - note)
        }
        return offsets
    })
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1)
})

test('elevation editor badges of elevation 0 notes move only with the scroll', async ({ page }) => {
    await page.evaluate(() => {
        const { fixtures, show, history } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        // Imported notes default to elevation 0.
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: 40, size: 2, elevation: 0 }],
                    [{ ...base, beat: 3, left: 0, size: 2, elevation: 2 }],
                ],
            },
            1.5,
        )
        const current = history.state.value
        history.replaceState({
            ...current,
            selectedEntities: [...current.store.slides.note.values()][1]!,
        })
    })
    await page.keyboard.press('t')
    const badge = page.locator('.elevation-editor [data-side="right"]')
    await expect(badge).toHaveAttribute('data-count', '1')
    const header = (await page.locator('.elevation-editor .elevation-header').boundingBox())!
    const canvas = (await page.locator('.elevation-canvas').boundingBox())!
    const first = header.y + header.height - canvas.y + 4
    // From inside each edge's riding badges, past the edge.
    const top = Math.min(first + 150, canvas.height / 2)
    const bottom = Math.max(canvas.height - 150, canvas.height / 2)
    for (const [from, to] of [
        [top, -70],
        [-70, top],
        [bottom, canvas.height + 70],
        [canvas.height + 70, bottom],
    ] as const) {
        const rows = await page.evaluate(
            async ({ from, to }) => {
                const { appImport, nextTick } = window.editorTest
                const { elevationViewport } = await appImport<
                    typeof import('../../src/editor/elevation/viewport')
                >('/src/editor/elevation/viewport.ts')
                const { elevationLayout } = await appImport<
                    typeof import('../../src/editor/elevation/scene')
                >('/src/editor/elevation/scene.ts')
                const canvas = document.querySelector('.elevation-canvas')!
                const rows: { note: number; badge: number | null; offset: number }[] = []
                // Fractional steps of the centre, which used to flip elevation 0 between slots.
                const steps = Math.ceil(Math.abs(to - from) / 1.37)
                for (let i = 0; i <= steps; i++) {
                    const { height, elevationScale } = elevationLayout.value
                    const y = from + ((to - from) * i) / steps
                    elevationViewport.center = (y - height / 2) / elevationScale
                    await nextTick()
                    const note = elevationLayout.value.yAt(0)
                    const badge = document.querySelector('.elevation-editor [data-side="right"]')
                    const bounds = badge?.getBoundingClientRect()
                    const center = bounds
                        ? bounds.top + bounds.height / 2 - canvas.getBoundingClientRect().top
                        : null
                    rows.push({ note, badge: center, offset: center === null ? 0 : center - note })
                }
                return rows
            },
            { from, to },
        )
        expectOnlyWithScroll(rows, {
            top: first,
            height: canvas.height,
            first,
            last: canvas.height,
        })
        // Riding, the badge stays on the note's slot; held, it's at the edge.
        const riding = rows.flatMap(({ badge, offset }) =>
            badge !== null && badge > first + 14 + 0.5 && badge < canvas.height - 14 - 0.5
                ? [offset]
                : [],
        )
        expect(riding.length).toBeGreaterThan(10)
        expect(Math.max(...riding) - Math.min(...riding)).toBeLessThanOrEqual(1)
        for (const offset of riding) expect(Math.abs(offset)).toBeLessThanOrEqual(14.5)
    }
})

type NoteBadgeFrame = {
    content: number
    badges: { y: number; side: string; notes: number[]; hit: boolean }[]
}

// Every frame: each badge's pane y, its notes, and whether hit tests there find it.
const recordNoteBadges = (page: Page, root: string) =>
    page.evaluate(async (root) => {
        const { appImport, view, settings } = window.editorTest
        const { hitOffscreenIndicator } = await appImport<
            typeof import('../../src/editor/offscreenIndicators')
        >('/src/editor/offscreenIndicators.ts')
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const ids = new Map<object, number>()
        const frames: NoteBadgeFrame[] = []
        let recording = true
        const record = () => {
            if (!recording) return
            const pane = document.querySelector(root)!.getBoundingClientRect()
            const badges = [
                ...document.querySelectorAll<HTMLElement>(`${root} .offscreen-note-indicator`),
            ].map((badge) => {
                const { left, top, width, height } = badge.getBoundingClientRect()
                const at = (dy: number) =>
                    hitOffscreenIndicator(left + width / 2, top + height / 2 + dy)
                const group = at(0)
                return {
                    y: top + height / 2 - pane.top,
                    side: badge.dataset.side!,
                    notes: (group?.targets ?? []).map((note) => {
                        if (!ids.has(note)) ids.set(note, ids.size)
                        return ids.get(note)!
                    }),
                    hit: !!group && at(-11) === group && at(11) === group,
                }
            })
            frames.push({
                // A content y, to tell which way it moves.
                content: root.includes('elevation')
                    ? elevationLayout.value.yAt(0)
                    : view.time * settings.pps,
                badges,
            })
            requestAnimationFrame(record)
        }
        requestAnimationFrame(record)
        Object.assign(window, {
            stopNoteBadges: () => {
                recording = false
                return frames
            },
        })
    }, root)

for (const pane of ['basic', 'composed', 'elevation'] as const) {
    test(`dense badges take notes in only with the scroll at the ${pane} edges`, async ({
        page,
    }) => {
        // Real wheel scrolls over many frames; slow under a loaded run.
        test.slow()
        await page.evaluate((pane) => {
            const { fixtures, show, view, settings, history } = window.editorTest
            settings.mouseSmoothScrolling = true
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    slides: [
                        // 10 px apart in time and 0.15 apart in elevation, off both sides.
                        ...Array.from({ length: 160 }, (_, i) => [
                            {
                                ...base,
                                beat: 2 + i * 0.05,
                                left: i % 2 ? -40 : 40,
                                size: 2,
                                elevation: i * 0.15 - 12,
                            },
                        ]),
                        [{ ...base, beat: 6, left: 0, size: 2, elevation: 0 }],
                    ],
                },
                3,
            )
            settings.pps = 400
            if (pane !== 'elevation') view.layout = pane
            const current = history.state.value
            history.replaceState({
                ...current,
                selectedEntities: [...current.store.slides.note.values()].at(-1)!,
            })
        }, pane)
        if (pane === 'elevation') await page.keyboard.press('t')
        const root =
            pane === 'elevation'
                ? '.elevation-canvas ~ .offscreen-notes'
                : '.editor-chart ~ .offscreen-notes'
        await expect(page.locator(`${root} .offscreen-note-indicator`).first()).toBeVisible()
        const box = (await page.locator(root).boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        for (const direction of [1, -1]) {
            await recordNoteBadges(page, root)
            // The elevation editor's wheel isn't eased, so it takes smaller steps.
            const [steps, delta] = pane === 'elevation' ? [60, 9] : [25, 40]
            for (let i = 0; i < steps; i++) {
                await page.mouse.wheel(0, direction * delta)
                await page.waitForTimeout(30)
            }
            await page.waitForTimeout(400)
            const frames = await page.evaluate(() =>
                (window as unknown as { stopNoteBadges: () => NoteBadgeFrame[] }).stopNoteBadges(),
            )
            const moving = frames.filter(
                (frame, i) => i && frame.content !== frames[i - 1]!.content,
            )
            expect(moving.length).toBeGreaterThan(10)
            // Collected rather than asserted one by one: there are thousands.
            const problems: string[] = []
            let badges = 0
            for (const [i, frame] of frames.entries()) {
                for (const badge of frame.badges) {
                    badges++
                    // Hit tests find each badge where it's drawn.
                    if (!badge.hit) problems.push(`frame ${i}: no hit at ${badge.y}`)
                    for (const other of frame.badges)
                        if (
                            other.side === badge.side &&
                            other.y > badge.y &&
                            other.y - badge.y < 24
                        )
                            problems.push(`frame ${i}: overlap at ${badge.y}`)
                }
                if (i < 2) continue
                const motion = Math.sign(frame.content - frames[i - 1]!.content)
                if (!motion) continue
                const at = (index: number) =>
                    new Map(frames[index]!.badges.flatMap((b) => b.notes.map((n) => [n, b.y])))
                const [before, previous, current] = [at(i - 2), at(i - 1), at(i)]
                const steady = Math.sign(frames[i - 1]!.content - frames[i - 2]!.content) === motion
                for (const [note, y] of current) {
                    // A note's badge never moves against the scroll,
                    const last = previous.get(note)
                    if (last !== undefined && (y - last) * motion < -0.5)
                        problems.push(`frame ${i}: note ${note} ${last} -> ${y}`)
                    // nor leaves a badge and comes back.
                    if (steady && before.has(note) && !previous.has(note))
                        problems.push(`frame ${i}: note ${note} came back`)
                }
            }
            expect(problems).toEqual([])
            expect(badges).toBeGreaterThan(50)
        }
    })
}

type ZoomFrame = { notes: number[]; badges: number[] }

// Every frame: the pane ys of the notes off the left side, in order, and of the left badges.
const recordZoom = (page: Page, pane: 'chart' | 'elevation', beats: number[] = []) =>
    page.evaluate(
        async ({ pane, beats }) => {
            const { appImport, view, settings } = window.editorTest
            const { elevationLayout } = await appImport<
                typeof import('../../src/editor/elevation/scene')
            >('/src/editor/elevation/scene.ts')
            const root =
                pane === 'chart'
                    ? '.editor-chart ~ .offscreen-notes'
                    : '.elevation-canvas ~ .offscreen-notes'
            const frames: ZoomFrame[] = []
            let recording = true
            const record = () => {
                if (!recording) return
                const top = document.querySelector(root)!.getBoundingClientRect().top
                frames.push({
                    // 120 BPM: beat b at b / 2 s.
                    notes:
                        pane === 'chart'
                            ? beats.map(
                                  (beat) => view.h / 2 - (beat / 2 - view.time) * settings.pps,
                              )
                            : elevationLayout.value.rows
                                  .filter((row) => row.x + row.w / 2 < 0)
                                  .map((row) => row.y),
                    badges: [
                        ...document.querySelectorAll<HTMLElement>(
                            `${root} .offscreen-note-indicator[data-side="left"]`,
                        ),
                    ].map((badge) => {
                        const { top: y, height } = badge.getBoundingClientRect()
                        return y + height / 2 - top
                    }),
                })
                requestAnimationFrame(record)
            }
            requestAnimationFrame(record)
            Object.assign(window, {
                stopZoom: () => {
                    recording = false
                    return frames
                },
            })
        },
        { pane, beats },
    )

// Notes clear of the edges whose badge, the one drawn nearest, moves against them or while they hold still.
const zoomProblems = async (page: Page) => {
    const frames = await page.evaluate(() =>
        (window as unknown as { stopZoom: () => ZoomFrame[] }).stopZoom(),
    )
    const height = await page.evaluate(() => window.editorTest.view.h)
    const nearest = (badges: number[], y: number) =>
        badges.reduce<number | undefined>(
            (best, badge) =>
                best === undefined || Math.abs(badge - y) < Math.abs(best - y) ? badge : best,
            undefined,
        )
    const problems: string[] = []
    let moving = 0
    for (let i = 1; i < frames.length; i++) {
        const [a, b] = [frames[i - 1]!, frames[i]!]
        if (a.notes.length !== b.notes.length || a.notes.every((y, k) => y === b.notes[k])) continue
        moving++
        a.notes.forEach((from, k) => {
            const to = b.notes[k]!
            if ([from, to].some((y) => y < 90 || y > Math.min(height, 600) - 90)) return
            const [badgeFrom, badgeTo] = [nearest(a.badges, from), nearest(b.badges, to)]
            if (badgeFrom === undefined || badgeTo === undefined) return
            if (Math.abs(badgeFrom - from) > 20 || Math.abs(badgeTo - to) > 20) return
            const [note, badge] = [to - from, badgeTo - badgeFrom]
            if (
                Math.abs(badge) > 0.5 &&
                (Math.abs(note) < 0.5 || Math.sign(badge) !== Math.sign(note))
            )
                problems.push(`frame ${i}: note ${from} -> ${to}, badge ${badgeFrom} -> ${badgeTo}`)
        })
    }
    return { moving, problems }
}

test.describe('zooming', () => {
    test.use({ hasTouch: true })

    // Notes left of the lanes at many beats around the view, apart by more than a slot.
    const beats = Array.from({ length: 24 }, (_, i) => 6 + i * 0.5 + (i % 3) * 0.13)

    for (const layout of ['basic', 'composed'] as const)
        for (const input of ['ctrl-wheel', 'pinch'] as const)
            test(`${layout}: badges move only with their notes under a ${input} zoom`, async ({
                page,
            }) => {
                await page.evaluate(
                    ({ layout, beats }) => {
                        const { fixtures, show, view, settings } = window.editorTest
                        const base = fixtures.interaction.slides[0]![0]!
                        show({
                            ...fixtures.interaction,
                            slides: beats.map((beat) => [
                                { ...base, beat, left: -40, size: 2, elevation: 2 },
                            ]),
                        })
                        view.layout = layout
                        settings.pps = 300
                        view.lane = 0
                        // Time 0 well above the pane, so zooming moves it far.
                        view.time = 6
                    },
                    { layout, beats },
                )
                const chart = (await page.locator('canvas.editor-chart').boundingBox())!
                const [x, y] = [chart.x + chart.width / 2, chart.y + chart.height / 2]
                await page.mouse.move(x, y)
                await recordZoom(page, 'chart', beats)
                if (input === 'ctrl-wheel') {
                    await page.keyboard.down('Control')
                    for (let i = 0; i < 12; i++) {
                        await page.mouse.wheel(0, i < 6 ? -40 : 40)
                        await page.waitForTimeout(60)
                    }
                    await page.keyboard.up('Control')
                } else {
                    const touch = await touchInput(page)
                    await touch('touchStart', [
                        [x, y - 60],
                        [x, y + 60],
                    ])
                    for (let step = 1; step <= 30; step++) {
                        const distance = 60 + (step <= 15 ? step : 30 - step) * 6
                        await touch('touchMove', [
                            [x, y - distance],
                            [x, y + distance],
                        ])
                        await page.waitForTimeout(16)
                    }
                    await touch('touchEnd', [])
                }
                await page.waitForTimeout(300)
                const { moving, problems } = await zoomProblems(page)
                expect(moving).toBeGreaterThan(5)
                expect(problems).toEqual([])
            })

    for (const input of ['ctrl-wheel', 'scale'] as const)
        test(`elevation editor: badges move only with their notes under a ${input} zoom`, async ({
            page,
        }) => {
            await page.evaluate(() => {
                const { fixtures, show, history } = window.editorTest
                const base = fixtures.interaction.slides[0]![0]!
                show(
                    {
                        ...fixtures.interaction,
                        slides: [
                            ...Array.from({ length: 16 }, (_, i) => [
                                { ...base, beat: 3, left: -40, size: 2, elevation: 1 + i * 0.37 },
                            ]),
                            [{ ...base, beat: 3, left: 0, size: 2, elevation: 2 }],
                        ],
                    },
                    1.5,
                )
                const current = history.state.value
                history.replaceState({
                    ...current,
                    selectedEntities: [...current.store.slides.note.values()].at(-1)!,
                })
            })
            await page.keyboard.press('t')
            const canvas = page.locator('.elevation-canvas')
            await expect(
                page.locator('.elevation-editor .offscreen-note-indicator').first(),
            ).toBeVisible()
            const box = (await canvas.boundingBox())!
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await recordZoom(page, 'elevation')
            if (input === 'ctrl-wheel') {
                await page.keyboard.down('Control')
                for (let i = 0; i < 12; i++) {
                    await page.mouse.wheel(0, i < 6 ? -40 : 40)
                    await page.waitForTimeout(60)
                }
                await page.keyboard.up('Control')
            } else
                await page.evaluate(async () => {
                    const { elevationViewport } = await window.editorTest.appImport<
                        typeof import('../../src/editor/elevation/viewport')
                    >('/src/editor/elevation/viewport.ts')
                    const scale = elevationViewport.scale
                    for (let frame = 0; frame < 40; frame++) {
                        elevationViewport.scale = scale * (1 + 0.005 * frame)
                        await new Promise((resolve) => requestAnimationFrame(resolve))
                    }
                })
            await page.waitForTimeout(300)
            const { moving, problems } = await zoomProblems(page)
            expect(moving).toBeGreaterThan(5)
            expect(problems).toEqual([])
        })
})

test.describe('held badges', () => {
    // Notes off the left 70 px apart, two or three slots: always one within the hold at each edge.
    test.beforeEach(async ({ page }) => {
        await page.evaluate(() => {
            const { fixtures, show, view, settings } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            settings.pps = 400
            show(
                {
                    ...fixtures.interaction,
                    bpms: [{ beat: 0, bpm: 120 }],
                    slides: Array.from({ length: 340 }, (_, i) => [
                        { ...base, beat: 2 + i * 0.35, left: -40, size: 2, elevation: 2 },
                    ]),
                },
                30,
            )
            view.lane = 0
        })
        await expect(
            page.locator('.editor-chart ~ div .offscreen-note-indicator').first(),
        ).toBeVisible()
    })

    // Every frame, whether a left badge is held at the top and at the bottom.
    const recordHeld = (page: Page) =>
        page.evaluate(() => {
            const { view } = window.editorTest
            const frames: { time: number; top: boolean; bottom: boolean }[] = []
            let recording = true
            const record = () => {
                if (!recording) return
                const ys = [
                    ...document.querySelectorAll<HTMLElement>(
                        '.editor-chart ~ div .offscreen-note-indicator[data-side="left"]',
                    ),
                ].map((badge) => {
                    const { top, height } = badge.getBoundingClientRect()
                    return top + height / 2 - view.y
                })
                frames.push({
                    time: view.time,
                    top: ys.some((y) => Math.abs(y - 38) < 1),
                    bottom: ys.some((y) => Math.abs(y - (view.h - 38)) < 1),
                })
                requestAnimationFrame(record)
            }
            requestAnimationFrame(record)
            Object.assign(window, {
                stopHeld: () => {
                    recording = false
                    return frames
                },
            })
        })
    const expectAlwaysHeld = async (page: Page) => {
        const frames = await page.evaluate(() =>
            (
                window as unknown as {
                    stopHeld: () => { time: number; top: boolean; bottom: boolean }[]
                }
            ).stopHeld(),
        )
        const moving = frames.filter((frame, i) => i && frame.time !== frames[i - 1]!.time)
        expect(moving.length).toBeGreaterThan(20)
        expect(frames.filter((frame) => !frame.top || !frame.bottom)).toEqual([])
    }

    // Plays until the view has moved on 40 frames, however slow the machine.
    const play = (page: Page) =>
        page.evaluate(async () => {
            const { view } = window.editorTest
            const player =
                await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                    '/src/editor/player.ts',
                )
            player.startOrStopPlayer()
            let moved = 0
            let last = view.time
            const end = performance.now() + 20000
            while (moved < 40 && performance.now() < end) {
                await new Promise(requestAnimationFrame)
                if (view.time !== last) moved++
                last = view.time
            }
            player.startOrStopPlayer()
        })

    test('stay on every frame of playback', async ({ page }) => {
        await recordHeld(page)
        await play(page)
        await expectAlwaysHeld(page)
    })

    // Notes 80 px apart, counted further past the pane than drawn notes' padding of a few px a lane.
    const showWide = (page: Page) =>
        page.evaluate(() => {
            const { fixtures, show, view, settings } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            settings.width = 100
            show(
                {
                    ...fixtures.interaction,
                    bpms: [{ beat: 0, bpm: 120 }],
                    slides: Array.from({ length: 300 }, (_, i) => [
                        { ...base, beat: 2 + i * 0.4, left: -80, size: 2, elevation: 2 },
                    ]),
                },
                30,
            )
            view.lane = 0
        })

    test('stay on every frame of playback at a wide lane zoom', async ({ page }) => {
        await showWide(page)
        await recordHeld(page)
        await play(page)
        await expectAlwaysHeld(page)
    })

    test('stay at every step of a fine scroll at a wide lane zoom', async ({ page }) => {
        await showWide(page)
        // Notes on whole beats pass the top edge too, just past the beat buckets in view.
        const missing = await page.evaluate(async () => {
            const { view, settings, nextTick } = window.editorTest
            const start = view.time
            const missing: number[] = []
            for (let scroll = 0; scroll < 3000; scroll += 0.5) {
                view.time = start + scroll / settings.pps
                await nextTick()
                const ys = [
                    ...document.querySelectorAll<HTMLElement>(
                        '.editor-chart ~ div .offscreen-note-indicator[data-side="left"]',
                    ),
                ].map((badge) => {
                    const { top, height } = badge.getBoundingClientRect()
                    return top + height / 2 - view.y
                })
                if (
                    !ys.some((y) => Math.abs(y - 38) < 1) ||
                    !ys.some((y) => Math.abs(y - (view.h - 38)) < 1)
                )
                    missing.push(scroll)
            }
            return missing
        })
        expect(missing).toEqual([])
    })

    for (const edge of ['top', 'bottom'] as const)
        test(`stay on every frame of a fast pan at the ${edge} edge`, async ({ page }) => {
            await useTool(page, 'note')
            const chart = (await page.locator('canvas.editor-chart').boundingBox())!
            const x = chart.x + chart.width / 2
            // A new note dragged from the empty lanes, held at the edge.
            await page.mouse.move(x, chart.y + chart.height / 2)
            await page.mouse.down()
            await page.mouse.move(x + 30, chart.y + chart.height / 2 + 30, { steps: 3 })
            await recordHeld(page)
            await page.mouse.move(
                x + 40,
                edge === 'top' ? chart.y + 2 : chart.y + chart.height - 2,
                {
                    steps: 4,
                },
            )
            await page.waitForTimeout(1500)
            await expectAlwaysHeld(page)
            await page.mouse.up()
        })
})

test('every point down both sides hits the nearest badge, with no gaps between neighbours', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        settings.pps = 300
        // Clusters and gaps of every few slots, off both sides.
        show(
            {
                ...fixtures.interaction,
                bpms: [{ beat: 0, bpm: 120 }],
                slides: Array.from({ length: 120 }, (_, i) => [
                    {
                        ...base,
                        beat: 2 + i * 0.13 + (i % 7) * 0.05,
                        left: i % 2 ? -40 : 40,
                        size: 2,
                        elevation: 2,
                    },
                ]),
            },
            5,
        )
        view.lane = 0
    })
    await expect(
        page.locator('.editor-chart ~ div .offscreen-note-indicator').first(),
    ).toBeVisible()
    for (const shift of [0, 0.37, 5.81, 13.2, 21.9]) {
        const problems = await page.evaluate(async (shift) => {
            const { appImport, view, settings, nextTick } = window.editorTest
            const { hitOffscreenIndicator } = await appImport<
                typeof import('../../src/editor/offscreenIndicators')
            >('/src/editor/offscreenIndicators.ts')
            view.time = 5 + shift / settings.pps
            await nextTick()
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const problems: string[] = []
            for (const side of ['left', 'right']) {
                const x = side === 'left' ? view.x + 8 : view.x + view.w - 8
                const badges = [
                    ...document.querySelectorAll<HTMLElement>(
                        `.editor-chart ~ div .offscreen-note-indicator[data-side="${side}"]`,
                    ),
                ]
                    .map((badge) => {
                        const { top, height } = badge.getBoundingClientRect()
                        return { y: top + height / 2, top, bottom: top + height }
                    })
                    .sort((a, b) => a.y - b.y)
                if (badges.length < 4) problems.push(`${side}: ${badges.length} badges`)
                const nearest = (y: number) =>
                    badges.reduce((best, badge) =>
                        Math.abs(badge.y - y) < Math.abs(best.y - y) ? badge : best,
                    )
                // The scrolling layer's offset, which riding badges are placed from.
                const layer = document.querySelector<HTMLElement>(
                    '.editor-chart ~ .offscreen-notes [style*="translateY"]',
                )!
                const anchor = Number(/translateY\(([-\d.e+]+)px\)/.exec(layer.style.transform)![1])
                // The drawn badge a hit test finds.
                const hitAt = (y: number) => {
                    const group = hitOffscreenIndicator(x, y)
                    if (!group) return
                    const drawn = view.y + (group.fixed ? group.y : anchor + group.y)
                    return (
                        badges.find((badge) => Math.abs(badge.y - drawn) < 0.5) ?? {
                            y: NaN,
                            top: NaN,
                            bottom: NaN,
                        }
                    )
                }
                for (let y = Math.ceil(view.y); y < view.y + view.h; y++) {
                    const point = y + 0.5
                    const hit = hitAt(point)
                    const inside = badges.find(
                        (badge) => point >= badge.top && point <= badge.bottom,
                    )
                    if (hit && Number.isNaN(hit.y))
                        problems.push(`${side} ${point}: an undrawn badge`)
                    // Inside a badge, it hits that badge.
                    if (inside && hit !== inside) problems.push(`${side} ${point}: inside a badge`)
                    // Anywhere it hits, it's the nearest badge.
                    if (
                        hit &&
                        hit !== nearest(point) &&
                        Math.abs(hit.y - point) - Math.abs(nearest(point).y - point) > 0.5
                    )
                        problems.push(`${side} ${point}: not the nearest`)
                }
                // Between neighbours, slots apart with none between, every point hits one of them.
                for (let i = 1; i < badges.length; i++) {
                    const [above, below] = [badges[i - 1]!, badges[i]!]
                    if (below.y - above.y >= 56) continue
                    for (let y = Math.ceil(above.y); y < below.y; y++)
                        if (!hitAt(y + 0.5)) problems.push(`${side} ${y + 0.5}: a gap`)
                }
            }
            return problems
        }, shift)
        expect(problems).toEqual([])
    }
})

// Every frame the pointer hovers a badge: whether exactly that badge, as drawn, has the ring.
const recordHoverRing = (page: Page, root: string) =>
    page.evaluate(async (root) => {
        const { appImport, view } = window.editorTest
        const { hitOffscreenIndicator } = await appImport<
            typeof import('../../src/editor/offscreenIndicators')
        >('/src/editor/offscreenIndicators.ts')
        const result = { hovered: 0, problems: [] as string[] }
        let recording = true
        const record = () => {
            if (!recording) return
            const group = hitOffscreenIndicator(view.pointer.x, view.pointer.y)
            if (group) {
                result.hovered++
                const rings = [
                    ...document.querySelectorAll<HTMLElement>(
                        `${root} .offscreen-note-indicator.is-hovered`,
                    ),
                ]
                const ring = rings[0]
                const layers = ring?.closest('.overflow-hidden')
                const layer = layers?.querySelector<HTMLElement>('[style*="translateY"]')
                const anchor = Number(
                    /translateY\(([-\d.e+]+)px\)/.exec(layer?.style.transform ?? '')?.[1],
                )
                const bounds = ring?.getBoundingClientRect()
                const y = bounds
                    ? bounds.top + bounds.height / 2 - layers!.getBoundingClientRect().top
                    : NaN
                const drawn = group.fixed ? group.y : anchor + group.y
                if (
                    rings.length !== 1 ||
                    ring!.dataset.side !== group.side ||
                    ring!.dataset.count !== String(group.count) ||
                    !(Math.abs(y - drawn) < 0.5)
                )
                    result.problems.push(
                        `${group.side} ${group.count} at ${drawn}: ${rings.length} rings, ${ring?.dataset.count} at ${y}`,
                    )
            }
            requestAnimationFrame(record)
        }
        requestAnimationFrame(record)
        Object.assign(window, {
            stopHoverRing: () => {
                recording = false
                return result
            },
        })
    }, root)
const expectHoverRing = async (page: Page) => {
    const { hovered, problems } = await page.evaluate(() =>
        (
            window as unknown as { stopHoverRing: () => { hovered: number; problems: string[] } }
        ).stopHoverRing(),
    )
    expect(hovered).toBeGreaterThan(20)
    expect(problems).toEqual([])
}
// Every 10 frames, selects or deselects the notes of the badges held at the edges, leaving the rest as they are.
const toggleHeldSelection = (page: Page, root: string) =>
    page.evaluate(async (root) => {
        const { appImport, history } = window.editorTest
        const { hitOffscreenIndicator } = await appImport<
            typeof import('../../src/editor/offscreenIndicators')
        >('/src/editor/offscreenIndicators.ts')
        for (let frame = 0; frame < 100; frame++) {
            if (frame % 10 === 5) {
                const [top, , bottom] = document
                    .querySelector(`${root} .offscreen-note-indicator`)!
                    .closest('.overflow-hidden')!.children
                const held = [top!, bottom!].flatMap((layer) =>
                    [...layer.querySelectorAll('.offscreen-note-indicator')].flatMap((badge) => {
                        const { left, top, width, height } = badge.getBoundingClientRect()
                        return (
                            hitOffscreenIndicator(left + width / 2, top + height / 2)?.targets ?? []
                        )
                    }),
                )
                const state = history.state.value
                history.replaceState({
                    ...state,
                    selectedEntities: state.selectedEntities.length ? [] : held,
                })
            }
            await new Promise((resolve) => requestAnimationFrame(resolve))
        }
    }, root)

test.describe('the hover ring', () => {
    test.beforeEach(async ({ page }) => {
        await page.evaluate(() => {
            const { fixtures, show, view, settings } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show({
                ...fixtures.interaction,
                slides: Array.from({ length: 60 }, (_, i) => [
                    { ...base, beat: i * 0.37 + (i % 4) * 0.05, left: -40, size: 2, elevation: 2 },
                ]),
            })
            settings.pps = 300
            view.lane = 0
            view.time = 5
        })
        await useTool(page, 'select')
    })

    const hoverRiding = async (page: Page, root: string, index: number) => {
        const riding = page
            .locator(`${root} [style*="translateY"] .offscreen-note-indicator`)
            .nth(index)
        const { x, y } = await center(riding)
        await page.mouse.move(x, y)
        await expect(riding).toHaveClass(/is-hovered/)
        await recordHoverRing(page, root)
    }

    test('stays on the hovered badge as the chart scrolls', async ({ page }) => {
        await hoverRiding(page, '.editor-chart ~ .offscreen-notes', 3)
        await page.evaluate(async () => {
            const { view, settings } = window.editorTest
            for (let frame = 0; frame < 300; frame++) {
                view.time += 1 / settings.pps
                await new Promise((resolve) => requestAnimationFrame(resolve))
            }
        })
        await expectHoverRing(page)
    })

    test('stays on the hovered badge in playback', async ({ page }) => {
        await hoverRiding(page, '.editor-chart ~ .offscreen-notes', 3)
        await page.evaluate(async () => {
            const player =
                await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                    '/src/editor/player.ts',
                )
            player.startOrStopPlayer()
            await new Promise((resolve) => setTimeout(resolve, 1500))
            player.startOrStopPlayer()
        })
        await expectHoverRing(page)
    })

    test('stays on the hovered badge as held notes are selected', async ({ page }) => {
        await hoverRiding(page, '.editor-chart ~ .offscreen-notes', 3)
        await toggleHeldSelection(page, '.editor-chart ~ .offscreen-notes')
        await expectHoverRing(page)
    })

    test('stays on the hovered badge in the elevation editor', async ({ page }) => {
        await page.evaluate(() => {
            const { fixtures, show, history } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    slides: [
                        ...Array.from({ length: 120 }, (_, i) => [
                            { ...base, beat: 3, left: -40, size: 2, elevation: i * 0.53 },
                        ]),
                        [{ ...base, beat: 3, left: 0, size: 2, elevation: 30 }],
                    ],
                },
                1.5,
            )
            const current = history.state.value
            history.replaceState({
                ...current,
                selectedEntities: [...current.store.slides.note.values()].at(-1)!,
            })
        })
        await page.keyboard.press('t')
        await expect(
            page.locator('.elevation-editor .offscreen-note-indicator').first(),
        ).toBeVisible()
        await page.evaluate(async () => {
            const { elevationViewport } = await window.editorTest.appImport<
                typeof import('../../src/editor/elevation/viewport')
            >('/src/editor/elevation/viewport.ts')
            elevationViewport.scale = 40
            elevationViewport.center = 30.13
        })
        await hoverRiding(page, '.elevation-editor', 5)
        await page.evaluate(async () => {
            const { elevationViewport } = await window.editorTest.appImport<
                typeof import('../../src/editor/elevation/viewport')
            >('/src/editor/elevation/viewport.ts')
            for (let frame = 0; frame < 120; frame++) {
                elevationViewport.center += 1 / elevationViewport.scale
                await new Promise((resolve) => requestAnimationFrame(resolve))
            }
        })
        await toggleHeldSelection(page, '.elevation-editor')
        await expectHoverRing(page)
    })
})

// Each chart badge's side, pane y and count.
const chartBadges = (page: Page) =>
    page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.editor-chart ~ div .offscreen-note-indicator')]
            .map((badge) => {
                const { top, height } = badge.getBoundingClientRect()
                const y = top + height / 2 - window.editorTest.view.y
                return `${badge.dataset.side} ${y.toFixed(2)} ${badge.dataset.count}`
            })
            .sort(),
    )

test('badges keep their slots as the pane and the lanes change width', async ({ page }) => {
    await page.evaluate(async () => {
        const { fixtures, show, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        settings.pps = 300
        settings.width = 40
        await new Promise((resolve) => requestAnimationFrame(resolve))
        // Notes at every phase of the slots, off the left at every width here.
        show({
            ...fixtures.interaction,
            bpms: [{ beat: 0, bpm: 120 }],
            slides: Array.from({ length: 80 }, (_, i) => [
                { ...base, beat: 6 + i * 0.18753, left: -80, size: 2, elevation: 2 },
            ]),
        })
        view.lane = 0
        // Badges placed from a fractional pane y.
        view.time = 9 + 0.43 / settings.pps
    })
    await expect(
        page.locator('.editor-chart ~ div .offscreen-note-indicator').first(),
    ).toBeVisible()
    const before = await chartBadges(page)
    const height = await page.evaluate(() => window.editorTest.view.h)
    expect(before.length).toBeGreaterThan(10)
    for (const width of [...Array.from({ length: 30 }, (_, i) => 12 + i * 2.913), 40]) {
        await page.evaluate((width) => {
            window.editorTest.settings.width = width
        }, width)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
        expect(await chartBadges(page), `width ${width}`).toEqual(before)
    }
    for (const width of [1563, 1499, 1437, 1381, 1290, 1211, 1187, 1123, 1600]) {
        const previous = await page.evaluate(() => window.editorTest.view.w)
        await page.setViewportSize({ width, height: 1000 })
        await expect.poll(() => page.evaluate(() => window.editorTest.view.w)).not.toBe(previous)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
        expect(await page.evaluate(() => window.editorTest.view.h)).toBe(height)
        expect(await chartBadges(page), `pane ${width}`).toEqual(before)
    }
})

test('the badge of a note at the zoom centre stays put as the chart zooms', async ({ page }) => {
    await page.evaluate(async () => {
        const { fixtures, show, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show({
            ...fixtures.interaction,
            bpms: [{ beat: 0, bpm: 120 }],
            slides: Array.from({ length: 24 }, (_, i) => [
                { ...base, beat: i * 0.5 + (i % 3) * 0.13, left: -40, size: 2, elevation: 2 },
            ]),
        })
        view.lane = 0
        // The note of beat 6 starts on a slot boundary, as asserted below.
        view.time = 3
        await new Promise((resolve) => requestAnimationFrame(resolve))
        settings.pps = 300
    })
    const chart = (await page.locator('canvas.editor-chart').boundingBox())!
    await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height / 2)
    await page.waitForTimeout(100)
    const middle = await page.evaluate(
        () => window.editorTest.view.y + window.editorTest.view.h / 2,
    )
    // The badge nearest the middle note.
    const badgeY = () =>
        page.evaluate(
            (middle) =>
                Math.min(
                    ...[
                        ...document.querySelectorAll(
                            '.editor-chart ~ div .offscreen-note-indicator',
                        ),
                    ].map((badge) => {
                        const { top, height } = badge.getBoundingClientRect()
                        return Math.abs(top + height / 2 - middle) < 28
                            ? top + height / 2
                            : Infinity
                    }),
                ),
            middle,
        )
    const start = await badgeY()
    // On a slot boundary, its badge half a slot off the middle.
    expect(Math.abs(Math.abs(start - middle) - 14)).toBeLessThanOrEqual(0.5)
    const ys = new Set([start])
    await page.keyboard.down('Control')
    for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, i < 6 ? -40 : 40)
        await page.waitForTimeout(60)
        ys.add(await badgeY())
    }
    await page.keyboard.up('Control')
    expect(await page.evaluate(() => window.editorTest.view.time)).toBe(3)
    expect([...ys]).toHaveLength(1)
})
