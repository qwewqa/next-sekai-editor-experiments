import { expect, test, type Page } from '@playwright/test'
import type { GroupId } from '../../src/chart/groups'
import type { TimeScaleObject } from '../../src/chart/timeScale'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const pageErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    pageErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test.afterEach(({ page }) => {
    expect(pageErrors.get(page), 'uncaught browser errors').toEqual([])
})

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

// The fixture's 120 BPM, below beat 0 too.
const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })

const timeScales = (page: Page) =>
    page.evaluate(() =>
        [...window.editorTest.history.state.value.store.grid.timeScale.values()]
            .flatMap((entities) => [...entities])
            .map(({ beat, editorLane, timeScale }) => ({ beat, editorLane, timeScale }))
            .sort((a, b) => a.beat - b.beat),
    )

const selected = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.history.state.value.selectedEntities.map(({ type, beat }) => ({
            type,
            beat,
        })),
    )

const cursor = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.querySelector('.editor')!).cursor)

const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
    await page.mouse.up()
    await settle(page)
}

const notice = (page: Page) => page.locator('.notification')

// A visible time scale at beat 0 in the default group.
const start: TimeScaleObject = {
    groupId: 1 as GroupId,
    beat: 0,
    editorLane: 4,
    timeScale: 2,
    skip: 0,
    timeScaleEase: 'none',
    timeScaleTransition: 'timeScale',
    hideNotes: false,
}
const initial = [{ beat: 0, editorLane: 4, timeScale: 2 }]

const show = (page: Page, layout: 'basic' | 'composed', timeScales: TimeScaleObject[]) =>
    page.evaluate(
        ({ layout, timeScales }) => {
            const { fixtures, show, view } = window.editorTest
            const pivot = fixtures.events.stagePivotEvents[0]!
            show(
                {
                    ...fixtures.interaction,
                    timeScales,
                    ...(layout === 'composed' && {
                        isDynamicStages: true,
                        stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 2 }],
                    }),
                },
                1.5,
            )
            view.layout = layout
        },
        { layout, timeScales },
    )

for (const layout of ['basic', 'composed'] as const)
    test.describe(layout, () => {
        test.beforeEach(async ({ page }) => {
            await show(page, layout, [start])
            await page.keyboard.press('w')
            await settle(page)
        })

        test('a drag from empty space below beat 0 adds a time scale where it drops', async ({
            page,
        }) => {
            const below = await point(page, -4, -1)
            await page.mouse.move(below.x, below.y)
            await settle(page)
            expect(await cursor(page)).toBe('crosshair')

            await drag(page, below, await point(page, -4, 1))
            await expect(notice(page)).toHaveText('Added 1 time scale')
            const added = [...initial, { beat: 1, editorLane: -4, timeScale: 1 }]
            expect(await timeScales(page)).toEqual(added)
            expect(await selected(page)).toEqual([{ type: 'timeScale', beat: 1 }])
            // Its properties, as any add shows them.
            const dialog = page.getByRole('dialog')
            await expect(dialog).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)

            await page.keyboard.press('Control+z')
            await settle(page)
            expect(await timeScales(page)).toEqual(initial)
            await page.keyboard.press('Control+y')
            await settle(page)
            expect(await timeScales(page)).toEqual(added)
        })

        test('Escape cancels a drag from below beat 0', async ({ page }) => {
            const below = await point(page, -4, -1)
            const to = await point(page, -4, 2)
            await page.mouse.move(below.x, below.y)
            await page.mouse.down()
            await page.mouse.move(to.x, to.y, { steps: 6 })
            await settle(page)
            await expect(notice(page)).toHaveText('Adding 1 time scale')
            await page.keyboard.press('Escape')
            await page.mouse.up()
            await settle(page)
            expect(await timeScales(page)).toEqual(initial)
            expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(
                0,
            )
            expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
        })

        test('below beat 0, a tap or a drop selects its time scale as before', async ({ page }) => {
            const below = await point(page, -4, -1)
            await page.mouse.click(below.x, below.y)
            await settle(page)
            await expect(notice(page)).toHaveText('Selected 1 time scale')
            expect(await selected(page)).toEqual([{ type: 'timeScale', beat: 0 }])
            await page.keyboard.press('Escape')

            await drag(page, await point(page, -4, 2), await point(page, -4, -1))
            await expect(notice(page)).toHaveText('Selected 1 time scale')
            expect(await timeScales(page)).toEqual(initial)
        })

        test('a press on or within snapping of its marker line still moves it', async ({
            page,
        }) => {
            // Its marker, and just under its line at 1/4 snapping.
            for (const [lane, beat] of [
                [4, 0],
                [-4, -0.1],
            ]) {
                const from = await point(page, lane!, beat!)
                await page.mouse.move(from.x, from.y)
                await settle(page)
                expect(await cursor(page), `lane ${lane}, beat ${beat}`).toBe('move')
                await drag(page, from, await point(page, lane!, 1))
                await expect(notice(page)).toHaveText('Moved 1 time scale')
                expect(await timeScales(page)).toEqual([
                    { beat: 1, editorLane: lane, timeScale: 2 },
                ])
                await page.keyboard.press('Control+z')
                await settle(page)
                expect(await timeScales(page)).toEqual(initial)
            }
        })
    })

test('with no time scale at beat 0, a tap below it still adds one there', async ({ page }) => {
    await show(page, 'basic', [])
    await page.keyboard.press('w')
    const below = await point(page, -4, -1)
    await page.mouse.click(below.x, below.y)
    await settle(page)
    await expect(notice(page)).toHaveText('Added 1 time scale')
    expect(await timeScales(page)).toEqual([{ beat: 0, editorLane: -4, timeScale: 1 }])
})

test.describe('with touch', () => {
    test.use({ hasTouch: true })

    test('a touch drag from empty space below beat 0 adds a time scale', async ({ page }) => {
        await show(page, 'basic', [start])
        await page.keyboard.press('w')
        const client = await page.context().newCDPSession(page)
        const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) =>
            client.send('Input.dispatchTouchEvent', {
                type,
                touchPoints: points.map(([x, y], id) => ({ x, y, id })),
            })
        const from = await point(page, -4, -1)
        const to = await point(page, -4, 1)
        await touch('touchStart', [[from.x, from.y]])
        for (let step = 1; step <= 6; step++)
            await touch('touchMove', [[from.x, from.y + ((to.y - from.y) * step) / 6]])
        await settle(page)
        await touch('touchEnd', [])
        await settle(page)
        await expect(notice(page)).toHaveText('Added 1 time scale')
        expect(await timeScales(page)).toEqual([
            ...initial,
            { beat: 1, editorLane: -4, timeScale: 1 },
        ])
    })
})
