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
        // Shown while the note is in the pane.
        if (note >= pane.top + 2 && note <= pane.height - 2)
            expect(badge, `note at ${note}`).not.toBeNull()
        if (note < pane.top - 2 || note > pane.height + 2)
            expect(badge, `note at ${note}`).toBeNull()
        if (badge === null) continue
        expect(badge).toBeGreaterThanOrEqual(pane.first + 14 - 1)
        expect(badge).toBeLessThanOrEqual(pane.last - 14 + 1)
        if (previous !== undefined) {
            const move = (badge - previous) * direction
            expect(move, `note at ${note}`).toBeGreaterThanOrEqual(0)
            expect(move, `note at ${note}`).toBeLessThanOrEqual(24 + 3)
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
            [200, -10],
            [-10, 200],
            [height - 200, height + 10],
            [height + 10, height - 200],
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
    for (const [from, to] of [
        [canvas.height / 2, -10],
        [-10, canvas.height / 2],
        [canvas.height / 2, canvas.height + 10],
        [canvas.height + 10, canvas.height / 2],
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
        const first = header.y + header.height - canvas.y + 4
        expectOnlyWithScroll(rows, {
            top: first,
            height: canvas.height,
            first,
            last: canvas.height,
        })
        // Riding, the badge stays on its slot just below the note; held, it's at the edge.
        for (const { badge, offset } of rows)
            if (badge !== null && badge > first + 14 + 0.5 && badge < canvas.height - 14 - 0.5)
                expect(Math.abs(offset - 14)).toBeLessThanOrEqual(0.5)
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
        const root = pane === 'elevation' ? '.elevation-canvas ~ div' : '.editor-chart ~ div'
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
