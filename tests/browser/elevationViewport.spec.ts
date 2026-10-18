import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const errors = new WeakMap<Page, string[]>()
const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
const elevation = (page: Page) =>
    page.evaluate(async () => {
        const { appImport } = window.editorTest
        const [viewport, scene] = await Promise.all([
            appImport<typeof import('../../src/editor/elevation/viewport')>(
                '/src/editor/elevation/viewport.ts',
            ),
            appImport<typeof import('../../src/editor/elevation/scene')>(
                '/src/editor/elevation/scene.ts',
            ),
        ])
        const { center, scale } = viewport.elevationViewport
        const { laneScale, height, yAt } = scene.elevationLayout.value
        // The toolbar's top in the pane.
        const pane = document.querySelector('.elevation-editor')!
        const toolbar =
            pane.querySelector('[data-editor-toolbar] > div')!.getBoundingClientRect().top -
            pane.getBoundingClientRect().top
        return { center, scale, laneScale, height, toolbar, top: yAt(20), low: yAt(-2) }
    })
const viewport = async (page: Page) => {
    const { center, scale } = await elevation(page)
    return { center, scale }
}
// Notes from beat 6, two beats apart, each at an elevation and optionally a lane.
const showChart = (page: Page, notes: (number | [elevation: number, left: number])[]) =>
    page.evaluate((notes) => {
        const { fixtures, show, view } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: notes.map((note, i) => {
                    const [elevation, left] = typeof note === 'number' ? [note, 0] : note
                    return [{ ...base, beat: 6 + 2 * i, left, size: 2, elevation }]
                }),
            },
            3,
        )
        view.cursorTime = 3
    }, notes)
const open = async (page: Page) => {
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await settle(page)
}
const close = async (page: Page) => {
    await page.getByRole('button', { name: 'Close Elevation Editor', exact: true }).click()
    await expect(page.locator('.elevation-editor')).toHaveCount(0)
}
// Scrolls and zooms the view away from its fit.
const moveView = async (page: Page) => {
    const box = (await page.locator('.elevation-canvas').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 120)
    await page.keyboard.press('=')
    await settle(page)
}

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    // At beat 8, a note past the lanes on the right.
    await showChart(page, [2, [3, 30]])
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
    })
    await settle(page)
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test.describe('the view', () => {
    test('is kept across beat changes, with badges for notes outside it', async ({ page }) => {
        await open(page)
        await moveView(page)
        const moved = await viewport(page)
        const beat = page.getByRole('spinbutton', { name: 'Beat', exact: true })
        await page.getByRole('button', { name: 'Next Beat', exact: true }).click()
        await expect(beat).toHaveValue('7.25')
        expect(await viewport(page)).toEqual(moved)
        const badges = page.locator('.elevation-editor .offscreen-note-indicator')
        await expect(badges).toHaveCount(0)
        await beat.fill('9')
        await beat.press('Enter')
        await settle(page)
        expect(await viewport(page)).toEqual(moved)
        // The new beat's note past the lanes has a badge.
        await expect(badges).toHaveCount(1)
    })

    test('is kept when the editor closes and reopens', async ({ page }) => {
        await open(page)
        await moveView(page)
        const moved = await viewport(page)
        await close(page)
        await open(page)
        expect(await viewport(page)).toEqual(moved)
        // Side by side too.
        await close(page)
        await page.evaluate(() => {
            window.editorTest.settings.elevationEditorSideBySide = 'allow'
        })
        await open(page)
        expect(await viewport(page)).toEqual(moved)
    })

    test('is fitted on the first open after a chart load', async ({ page }) => {
        await open(page)
        const fitted = await viewport(page)
        await moveView(page)
        await close(page)
        await showChart(page, [2, [3, 30]])
        await open(page)
        expect(await viewport(page)).toEqual(fitted)
        // Another chart fits its own notes, above the toolbar.
        await close(page)
        await showChart(page, [-2])
        await open(page)
        const { low, toolbar } = await elevation(page)
        expect(low).toBeGreaterThan(0)
        expect(low).toBeLessThan(toolbar)
    })

    test('starts at 1:1 with the lock off, keeping 0 and the notes in view, and leaves the zooms apart', async ({
        page,
    }) => {
        // The y of an elevation; 0's lowest is 16px over the toolbar.
        const yOf = (view: Awaited<ReturnType<typeof elevation>>, value: number) =>
            view.height / 2 - (value - view.center) * view.scale
        for (const width of [1600, 390]) {
            await page.setViewportSize({ width, height: 844 })
            await settle(page)
            await showChart(page, [2])
            await open(page)
            const fitted = await elevation(page)
            expect(fitted.scale).toBe(fitted.laneScale)
            expect(await page.evaluate(() => window.editorTest.settings.elevationSquareGrid)).toBe(
                false,
            )
            // With 0 and the note in view, 3 is in the middle.
            expect(fitted.center).toBe(3)
            expect(yOf(fitted, 2)).toBeLessThan(fitted.toolbar)
            // Notes too far above for 0 leave 0 at its lowest; on the phone, with the
            // lanes zoomed out, both fit.
            await close(page)
            await showChart(page, [20])
            await open(page)
            const high = await elevation(page)
            expect(high.scale).toBe(high.laneScale)
            if (width === 1600) {
                expect(yOf(high, 0)).toBeCloseTo(high.toolbar - 16, 6)
            } else {
                expect(high.top).toBeGreaterThan(0)
                expect(yOf(high, 0)).toBeLessThan(high.toolbar - 16)
            }
            // A lane zoom leaves the y-zoom.
            await page.keyboard.press(']')
            await settle(page)
            const zoomed = await elevation(page)
            expect(zoomed.laneScale).toBeGreaterThan(high.laneScale)
            expect(zoomed.scale).toBe(high.scale)
            await close(page)
        }
    })

    test('fits a new pane size until it is first adjusted', async ({ page }) => {
        const resize = async (width: number, height: number) => {
            await page.setViewportSize({ width, height })
            await settle(page)
        }
        const openHigh = async () => {
            await resize(1600, 844)
            await showChart(page, [20])
            await open(page)
        }
        // Unadjusted, a pane settling to another size gets a new 1:1 fit, 0 at its lowest.
        await openHigh()
        const fitted = await elevation(page)
        await resize(1200, 700)
        const refitted = await elevation(page)
        expect(refitted.laneScale).toBeLessThan(fitted.laneScale)
        expect(refitted.scale).toBe(refitted.laneScale)
        expect(refitted.height / 2 - (0 - refitted.center) * refitted.scale).toBeCloseTo(
            refitted.toolbar - 16,
            6,
        )
        await close(page)
        // Scrolling, zooming either axis or toggling 1:1 keeps the view.
        const box = async () => (await page.locator('.elevation-canvas').boundingBox())!
        const lock = page.getByRole('button', { name: '1:1 Grid', exact: true })
        const adjustments = [
            async () => {
                const { x, y, width, height } = await box()
                await page.mouse.move(x + width / 2, y + height / 2)
                await page.mouse.wheel(0, 120)
            },
            () => page.keyboard.press('='),
            () => page.keyboard.press(']'),
            async () => {
                await lock.click()
                await lock.click()
            },
        ]
        for (const adjust of adjustments) {
            await openHigh()
            await adjust()
            await settle(page)
            const kept = await viewport(page)
            await resize(1200, 700)
            expect(await viewport(page)).toEqual(kept)
            await close(page)
        }
    })

    test('is fitted on reopening after a chart load closes it', async ({ page }) => {
        await open(page)
        await moveView(page)
        // At beat 8 as the load closes it, and reopened at beat 6.
        const beat = page.getByRole('spinbutton', { name: 'Beat', exact: true })
        await beat.fill('9')
        await beat.press('Enter')
        await settle(page)
        await showChart(page, [-2, 20])
        await expect(page.locator('.elevation-editor')).toHaveCount(0)
        await open(page)
        await expect(beat).toHaveValue('7')
        // Fitted to beat 6's note, not beat 8's.
        const { low, toolbar } = await elevation(page)
        expect(low).toBeGreaterThan(0)
        expect(low).toBeLessThan(toolbar)
    })

    test('drops its last frame while its pane has no size', async ({ page }) => {
        await open(page)
        const canvas = page.locator('.elevation-canvas')
        const size = () => canvas.evaluate((element: HTMLCanvasElement) => element.width)
        expect(await size()).toBeGreaterThan(0)
        const hide = (display: string) =>
            page.evaluate((display) => {
                document.querySelector<HTMLElement>('.elevation-editor')!.style.display = display
            }, display)
        await hide('none')
        await expect.poll(size).toBe(0)
        await hide('')
        await expect.poll(size).toBeGreaterThan(0)
    })

    test('is fitted on a chart load while open side by side', async ({ page }) => {
        await page.evaluate(() => {
            window.editorTest.settings.elevationEditorSideBySide = 'allow'
        })
        await open(page)
        await moveView(page)
        await showChart(page, [-2])
        await settle(page)
        await expect(page.locator('.elevation-editor')).toBeVisible()
        const { low, toolbar } = await elevation(page)
        expect(low).toBeGreaterThan(0)
        expect(low).toBeLessThan(toolbar)
    })
})

test.describe('the 1:1 grid', () => {
    const lock = (page: Page) => page.getByRole('button', { name: '1:1 Grid', exact: true })
    const axes = async (page: Page) => ({
        ...(await elevation(page)),
        width: await page.evaluate(() => window.editorTest.settings.width),
    })
    const expectSquare = async (page: Page) => {
        const { scale, laneScale } = await axes(page)
        expect(scale).toBeCloseTo(laneScale, 9)
    }
    const pinch = async (page: Page, axis: 'x' | 'y', from: number, to: number) => {
        const box = (await page.locator('.elevation-canvas').boundingBox())!
        const touch = (type: string, distance: number) =>
            page.evaluate(
                ({ type, x, y, distance, axis }) => {
                    const target = document.querySelector('.elevation-editor .editor')!
                    const changedTouches = [-1, 1].map(
                        (direction, index) =>
                            new Touch({
                                identifier: index + 1,
                                target,
                                clientX: x + (axis === 'x' ? direction * distance : 0),
                                clientY: y + (axis === 'y' ? direction * distance : 0),
                            }),
                    )
                    target.dispatchEvent(
                        new TouchEvent(type, { changedTouches, bubbles: true, cancelable: true }),
                    )
                },
                { type, x: box.x + box.width / 2, y: box.y + box.height / 2, distance, axis },
            )
        await touch('touchstart', from)
        await touch('touchmove', (from + to) / 2)
        await settle(page)
        await touch('touchmove', to)
        await settle(page)
        await touch('touchend', to)
        await settle(page)
    }

    test('locks the y-zoom to the lane zoom about the centre, and is stored', async ({ page }) => {
        await open(page)
        // Away from the 1:1 it starts at.
        await page.keyboard.press('=')
        await settle(page)
        const before = await axes(page)
        await expect(lock(page)).toHaveAttribute('aria-pressed', 'false')
        expect(before.scale).not.toBeCloseTo(before.laneScale, 3)
        await lock(page).click()
        await expect(lock(page)).toHaveAttribute('aria-pressed', 'true')
        const after = await axes(page)
        expect(after.scale).toBe(after.laneScale)
        expect(after.center).toBe(before.center)
        expect(after.width).toBe(before.width)
        expect(
            await page.evaluate(() =>
                localStorage.getItem('sonolus-next-sekai-editor.elevationSquareGrid'),
            ),
        ).toBe('true')
    })

    test('stays locked across reopening and a reload', async ({ page }) => {
        await open(page)
        await lock(page).click()
        await close(page)
        await page.evaluate(() => (window.editorTest.settings.width = 30))
        await open(page)
        await expect(lock(page)).toHaveAttribute('aria-pressed', 'true')
        await expectSquare(page)
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await showChart(page, [2])
        await open(page)
        await expect(lock(page)).toHaveAttribute('aria-pressed', 'true')
        await expectSquare(page)
        // The fit after the load keeps the scale and frames the notes.
        const { center } = await viewport(page)
        expect(center).toBeGreaterThan(0)
        expect(center).toBeLessThan(5)
    })

    test('follows a lane zoom', async ({ page }) => {
        await open(page)
        await lock(page).click()
        const before = await axes(page)
        await page.keyboard.press(']')
        await settle(page)
        const after = await axes(page)
        expect(after.width).toBeLessThan(before.width)
        expect(after.scale).toBeGreaterThan(before.scale)
        expect(after.center).toBe(before.center)
        await expectSquare(page)
    })

    test('zooms lanes on a y-zoom, within the width range', async ({ page }) => {
        await open(page)
        await lock(page).click()
        const before = await axes(page)
        await page.keyboard.press('-')
        await settle(page)
        const out = await axes(page)
        expect(out.width).toBeCloseTo(before.width * 1.1, 6)
        expect(out.scale).toBeLessThan(before.scale)
        await expectSquare(page)
        // Ctrl+wheel zooms in y.
        const box = (await page.locator('.elevation-canvas').boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -100)
        await page.keyboard.up('Control')
        await settle(page)
        const wheeled = await axes(page)
        expect(wheeled.width).toBeLessThan(out.width)
        await expectSquare(page)
        // Past the width range, a zoom stops.
        await page.evaluate(() => (window.editorTest.settings.width = 16))
        await settle(page)
        const narrowest = await axes(page)
        await page.keyboard.press('=')
        await settle(page)
        expect(await axes(page)).toEqual(narrowest)
        await page.evaluate(() => (window.editorTest.settings.width = 100))
        await settle(page)
        const widest = await axes(page)
        await page.keyboard.press('-')
        await settle(page)
        expect(await axes(page)).toEqual(widest)
    })

    test.describe('with touch', () => {
        test.use({ hasTouch: true })

        test('zooms both axes with either pinch', async ({ page }) => {
            await open(page)
            await lock(page).click()
            const before = await axes(page)
            await pinch(page, 'y', 100, 50)
            const pinched = await axes(page)
            expect(pinched.width).toBeGreaterThan(before.width)
            await expectSquare(page)
            await pinch(page, 'x', 100, 200)
            const spread = await axes(page)
            expect(spread.width).toBeLessThan(pinched.width)
            await expectSquare(page)
        })
    })

    test('follows the pane width side by side', async ({ page }) => {
        await page.evaluate(() => {
            window.editorTest.settings.elevationEditorSideBySide = 'allow'
        })
        await open(page)
        await lock(page).click()
        const before = await axes(page)
        const divider = page.getByRole('separator', {
            name: 'Resize Elevation Editor',
            exact: true,
        })
        const separator = (await divider.boundingBox())!
        await page.mouse.move(separator.x + separator.width / 2, separator.y + 200)
        await page.mouse.down()
        await page.mouse.move(separator.x - 160, separator.y + 200, { steps: 5 })
        await page.mouse.up()
        await settle(page)
        const after = await axes(page)
        expect(after.scale).toBeGreaterThan(before.scale)
        await expectSquare(page)
    })

    test('shows the lock on in Highlight in high contrast', async ({ page }) => {
        await page.emulateMedia({ forcedColors: 'active' })
        await open(page)
        await lock(page).click()
        await page.mouse.move(0, 0)
        const highlight = await page.evaluate(() => {
            const probe = document.createElement('span')
            probe.style.color = 'Highlight'
            document.body.append(probe)
            const { color } = getComputedStyle(probe)
            probe.remove()
            return color
        })
        // Past its colour transition.
        await expect
            .poll(() => lock(page).evaluate((button) => getComputedStyle(button).backgroundColor))
            .toBe(highlight)
    })

    test('unlocks keeping both zooms', async ({ page }) => {
        await open(page)
        await lock(page).click()
        await lock(page).click()
        await expect(lock(page)).toHaveAttribute('aria-pressed', 'false')
        const unlocked = await axes(page)
        expect(unlocked.scale).toBe(unlocked.laneScale)
        await page.keyboard.press('=')
        await settle(page)
        const zoomed = await axes(page)
        expect(zoomed.width).toBe(unlocked.width)
        expect(zoomed.scale).toBeGreaterThan(unlocked.scale)
        await page.keyboard.press('[')
        await settle(page)
        expect((await axes(page)).scale).toBe(zoomed.scale)
    })
})

// Whether every point on a line between two page points hits one of the controls.
const tiles = (
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
    selectors: string[],
) =>
    page.evaluate(
        ({ from, to, selectors }) => {
            const misses: string[] = []
            const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * 2)
            for (let i = 0; i <= steps; i++) {
                const x = from.x + ((to.x - from.x) * i) / steps
                const y = from.y + ((to.y - from.y) * i) / steps
                const element = document.elementFromPoint(x, y)
                if (!selectors.some((selector) => element?.closest(selector)))
                    misses.push(`${x},${y}: ${element?.className}`)
            }
            return misses
        },
        { from, to, selectors },
    )

for (const coarse of [false, true])
    test.describe(`a narrow header with a ${coarse ? 'coarse' : 'fine'} pointer`, () => {
        test.use(coarse ? { hasTouch: true, isMobile: true } : {})

        test('keeps the pressed 1:1 off the snap field, its hit areas meeting', async ({
            page,
        }) => {
            await page.setViewportSize({ width: 300, height: 700 })
            await open(page)
            const square = page.locator('.elevation-square')
            await square.click()
            await expect(square).toHaveAttribute('aria-pressed', 'true')
            const box = async (selector: string) =>
                (await page.locator(`.elevation-editor ${selector}`).boundingBox())!
            const snap = await box('.elevation-snap select')
            const beat = await box('.elevation-beat-field input')
            const next = await box('.elevation-beat > button:last-child')
            const lock = await box('.elevation-square')
            expect([next.width, next.height, lock.width, lock.height]).toEqual([32, 32, 32, 32])
            // The narrow header clips the top and extends Next Beat into its 4px row gap.
            const hitReach = await page.evaluate(({ x, y, width, height }) => {
                const button = document.querySelector('.elevation-beat > button:last-child')!
                const target = getComputedStyle(button, '::before')
                return {
                    inset: [target.top, target.bottom],
                    below: [1, 3, 5].map(
                        (dy) =>
                            document
                                .elementFromPoint(x + width / 2, y + height + dy)
                                ?.closest('button') === button,
                    ),
                }
            }, next)
            expect(hitReach).toEqual({ inset: ['-2px', '-4px'], below: [true, true, false] })
            // 0.25rem apart, as in wider headers; Next Beat and 1:1 share the column.
            expect(lock.x - (snap.x + snap.width)).toBeCloseTo(4, 1)
            expect(next.x - (beat.x + beat.width)).toBeCloseTo(4, 1)
            expect(lock.x + lock.width).toBeCloseTo(next.x + next.width, 1)
            const mid = (b: typeof lock) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
            // Across the gaps, each point hits a field or the button beside it.
            expect(
                await tiles(page, { x: mid(snap).x, y: mid(lock).y }, mid(lock), [
                    '.elevation-snap',
                    '.elevation-square',
                ]),
            ).toEqual([])
            expect(
                await tiles(page, { x: mid(beat).x, y: mid(next).y }, mid(next), [
                    '.elevation-beat-field',
                    '.elevation-beat > button:last-child',
                ]),
            ).toEqual([])
            expect(
                await tiles(page, mid(next), mid(lock), [
                    '.elevation-beat > button:last-child',
                    '.elevation-square',
                ]),
            ).toEqual([])
            // The Beat and snap values start at the same x.
            const start = (selector: string) =>
                page
                    .locator(`.elevation-editor ${selector}`)
                    .evaluate(
                        (element) =>
                            element.getBoundingClientRect().x +
                            parseFloat(getComputedStyle(element).paddingLeft),
                    )
            expect(await start('.elevation-beat-field input')).toBeCloseTo(
                await start('.elevation-snap select'),
                1,
            )
        })
    })

test('the pressed 1:1 glows on hover, as the toolbar tool in use does', async ({ page }) => {
    await open(page)
    const square = page.locator('.elevation-square')
    await square.click()
    const shadow = () => square.evaluate((element) => getComputedStyle(element).boxShadow)
    const lock = (await square.boundingBox())!
    await page.mouse.move(lock.x + lock.width / 2, lock.y + lock.height / 2)
    const accent = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
    )
    await expect.poll(shadow).toContain(`rgb(${accent.split(/\s+/).join(', ')})`)
    await page.mouse.move(0, 0)
    await expect.poll(shadow).not.toContain(`rgb(${accent.split(/\s+/).join(', ')})`)
})

for (const coarse of [false, true])
    test.describe(`the 1:1 button with a ${coarse ? 'coarse' : 'fine'} pointer`, () => {
        test.use(coarse ? { hasTouch: true, isMobile: true } : {})

        for (const width of [1600, 390])
            test(`rests raised, unlike the arrows, and ends the controls row at ${width}px`, async ({
                page,
            }) => {
                await page.setViewportSize({ width, height: 844 })
                await open(page)
                const look = (selector: string) =>
                    page.locator(`.elevation-editor ${selector}`).evaluate((element) => {
                        const { backgroundColor, boxShadow } = getComputedStyle(element)
                        return { backgroundColor, shadow: boxShadow !== 'none' }
                    })
                const square = await look('.elevation-square')
                expect(square.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
                expect(square.shadow).toBe(true)
                expect(await look('.elevation-beat > button:last-child')).toEqual({
                    backgroundColor: 'rgba(0, 0, 0, 0)',
                    shadow: false,
                })
                const box = async (selector: string) =>
                    (await page.locator(`.elevation-editor ${selector}`).boundingBox())!
                const lock = await box('.elevation-square')
                const controls = await box('.elevation-controls')
                const snap = await box('.elevation-snap')
                expect(lock.x + lock.width).toBeCloseTo(controls.x + controls.width, 1)
                expect(lock.x - (snap.x + snap.width)).toBeGreaterThan(8)
                // Its whole round top edge takes the press, under the close button too.
                const top = await page.evaluate(
                    ({ x, y, width }) =>
                        [-0.75, -0.5, 0, 0.5, 0.75].map((offset) => {
                            const radius = width / 2
                            const edge = radius - Math.sqrt(1 - offset ** 2) * radius
                            return !!document
                                .elementFromPoint(x + radius + offset * radius, y + edge + 1)
                                ?.closest('.elevation-square')
                        }),
                    lock,
                )
                expect(top).toEqual([true, true, true, true, true])
            })
    })
