import { expect, test, type Page } from '@playwright/test'
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

const bpms = (page: Page) =>
    page.evaluate(() =>
        [...window.editorTest.history.state.value.store.grid.bpm.values()]
            .flatMap((entities) => [...entities])
            .map(({ beat, bpm, meter }) => ({ beat, bpm, meter }))
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

const initial = [{ beat: 0, bpm: 120, meter: 4 }]

for (const layout of ['basic', 'composed'] as const)
    test.describe(layout, () => {
        test.beforeEach(async ({ page }) => {
            await page.evaluate((layout) => {
                const { fixtures, show, view } = window.editorTest
                const pivot = fixtures.events.stagePivotEvents[0]!
                show(
                    layout === 'composed'
                        ? {
                              ...fixtures.interaction,
                              isDynamicStages: true,
                              stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 2 }],
                          }
                        : fixtures.interaction,
                    1.5,
                )
                view.layout = layout
            }, layout)
            await page.keyboard.press('q')
            await settle(page)
        })

        test('a drag from empty space below beat 0 adds a change where it drops', async ({
            page,
        }) => {
            const below = await point(page, -4, -1)
            await page.mouse.move(below.x, below.y)
            await settle(page)
            expect(await cursor(page)).toBe('crosshair')

            await drag(page, below, await point(page, -4, 1))
            await expect(notice(page)).toHaveText('Added 1 BPM change')
            expect(await bpms(page)).toEqual([...initial, { beat: 1, bpm: 120, meter: 4 }])
            expect(await selected(page)).toEqual([{ type: 'bpm', beat: 1 }])
            // Its properties, as any add shows them.
            const dialog = page.getByRole('dialog', { name: 'BPM Properties' })
            await expect(dialog).toBeVisible()
            await expect(dialog.getByRole('spinbutton', { name: 'Beat' })).toHaveValue('2')
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)

            await page.keyboard.press('Control+z')
            await settle(page)
            expect(await bpms(page)).toEqual(initial)
            await page.keyboard.press('Control+y')
            await settle(page)
            expect(await bpms(page)).toEqual([...initial, { beat: 1, bpm: 120, meter: 4 }])
        })

        test('Escape cancels a drag from below beat 0', async ({ page }) => {
            const below = await point(page, -4, -1)
            const to = await point(page, -4, 2)
            await page.mouse.move(below.x, below.y)
            await page.mouse.down()
            await page.mouse.move(to.x, to.y, { steps: 6 })
            await settle(page)
            await expect(notice(page)).toHaveText('Adding 1 BPM change')
            await page.keyboard.press('Escape')
            await page.mouse.up()
            await settle(page)
            expect(await bpms(page)).toEqual(initial)
            // What shows is the resting mouse's own hover: a ghost where a tap would add.
            const creating = () =>
                page.evaluate(() =>
                    window.editorTest.view.entities.creating.map(({ type, beat }) => [type, beat]),
                )
            const shown = await creating()
            await page.mouse.move(to.x + 1, to.y)
            await page.mouse.move(to.x, to.y)
            expect(await creating()).toEqual(shown)
            expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
        })

        test('below beat 0, a tap or a drop selects its change as before', async ({ page }) => {
            const below = await point(page, -4, -1)
            await page.mouse.click(below.x, below.y)
            await settle(page)
            await expect(notice(page)).toHaveText('Selected 1 BPM change')
            expect(await selected(page)).toEqual([{ type: 'bpm', beat: 0 }])
            await page.keyboard.press('Escape')

            await drag(page, await point(page, -4, 2), await point(page, -4, -1))
            await expect(notice(page)).toHaveText('Selected 1 BPM change')
            expect(await bpms(page)).toEqual(initial)
        })

        test('a press on or within snapping of the initial change still grabs it', async ({
            page,
        }) => {
            // Its label, and just under its line at 1/4 snapping.
            for (const [lane, beat] of [
                [6.4, 0],
                [-4, -0.1],
            ]) {
                const from = await point(page, lane!, beat!)
                await page.mouse.move(from.x, from.y)
                await settle(page)
                expect(await cursor(page), `lane ${lane}, beat ${beat}`).toBe('ns-resize')
                await drag(page, from, await point(page, lane!, 1))
                await expect(notice(page)).toHaveText('Moved 1 BPM change')
                // The initial change stays at 0.
                expect(await bpms(page)).toEqual([...initial, { beat: 1, bpm: 120, meter: 4 }])
                await page.keyboard.press('Control+z')
                await settle(page)
                expect(await bpms(page)).toEqual(initial)
            }
        })

        test('the BPM label rounds as Properties does and its box covers it', async ({ page }) => {
            const at = await point(page, 0, 4)
            await page.mouse.click(at.x, at.y)
            const dialog = page.getByRole('dialog', { name: 'BPM Properties' })
            const field = dialog.getByRole('spinbutton', { name: 'BPM' })
            await field.fill('150.123456789')
            await field.press('Enter')
            await expect(notice(page)).toHaveText('Set BPM to 150.123456789 on 1 BPM change')
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
            // Only the label rounds.
            expect(await bpms(page)).toEqual([
                ...initial,
                { beat: 4, bpm: 150.123456789, meter: 4 },
            ])

            const { labelEnd, boxEnd } = await page.evaluate(async () => {
                const { view, settings, history, appImport } = window.editorTest
                // Where the chart draws the label, and at what size.
                const { BPM_LABEL } = await appImport<
                    typeof import('../../src/state/entities/bpm')
                >('/src/state/entities/bpm.ts')
                const entity = history.state.value.selectedEntities[0]!
                const lanePx = view.w / settings.width
                const ctx = document.createElement('canvas').getContext('2d')!
                ctx.font = `${BPM_LABEL.size * lanePx}px ${getComputedStyle(document.querySelector('.editor')!).fontFamily}`
                return {
                    labelEnd: BPM_LABEL.lane + ctx.measureText('150.1235').width / lanePx,
                    boxEnd: entity.hitbox!.lane + entity.hitbox!.w,
                }
            })
            expect(boxEnd).toBeGreaterThanOrEqual(labelEnd)

            // Pointing at the label's last figure selects its change.
            await page.evaluate(async () => {
                const { appImport, history } = window.editorTest
                const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                    '/src/editor/tools/index.ts',
                )
                switchToolTo('select')
                history.replaceState({ ...history.state.value, selectedEntities: [] })
            })
            const end = await point(page, labelEnd - 0.1, 4)
            await page.mouse.move(end.x, end.y)
            await settle(page)
            expect(await page.evaluate(() => window.editorTest.snapshot().hovered)).toEqual([
                { type: 'bpm', beat: 4 },
            ])
            await page.mouse.click(end.x, end.y)
            await settle(page)
            expect(await selected(page)).toEqual([{ type: 'bpm', beat: 4 }])
        })
    })

test.describe('with touch', () => {
    test.use({ hasTouch: true })

    test('a touch drag from empty space below beat 0 adds a change', async ({ page }) => {
        await page.evaluate(() => {
            const { fixtures, show } = window.editorTest
            show(fixtures.interaction, 1.5)
        })
        await page.keyboard.press('q')
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
        await expect(notice(page)).toHaveText('Added 1 BPM change')
        expect(await bpms(page)).toEqual([...initial, { beat: 1, bpm: 120, meter: 4 }])
    })
})

test('the Properties panel shows a new change with the meter in effect', async ({ page }) => {
    await page.evaluate(() => {
        const { fixtures, settings, show } = window.editorTest
        settings.showSidebar = true
        show({ ...fixtures.interaction, bpms: [{ beat: 0, bpm: 120, meter: 3 }] }, 3)
    })
    await page.keyboard.press('q')
    const at = await point(page, 0, 5)
    await page.mouse.click(at.x, at.y)
    const panel = page.locator('#workspace-panel-properties')
    await expect(panel.getByRole('spinbutton', { name: 'BPM' })).toHaveValue('120')
    await expect(panel.getByRole('spinbutton', { name: 'Meter' })).toHaveValue('3')
    expect(await bpms(page)).toEqual([
        { beat: 0, bpm: 120, meter: 3 },
        { beat: 5, bpm: 120, meter: 3 },
    ])
})
