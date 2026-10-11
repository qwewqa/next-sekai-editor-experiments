import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

type Text = { text: string; x: number; y: number; frame: number }

declare global {
    interface Window {
        drawnTexts: { chart: Text[]; overlay: Text[] }
    }
}

const pageErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    pageErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    // Texts the chart and the ghosts (composited onto the overlay) draw, in pane pixels, by frame.
    await page.addInitScript(() => {
        window.drawnTexts = { chart: [], overlay: [] }
        const fillText = CanvasRenderingContext2D.prototype.fillText
        CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
            const canvas = this.canvas
            const chart = document.querySelector<HTMLCanvasElement>('canvas.editor-chart')
            const kind = !(canvas instanceof HTMLCanvasElement)
                ? undefined
                : canvas === chart
                  ? 'chart'
                  : !canvas.isConnected && canvas.width === chart?.width
                    ? 'overlay'
                    : undefined
            if (kind) {
                const m = this.getTransform()
                window.drawnTexts[kind].push({
                    text,
                    x: (m.a * x + m.c * y + m.e) / devicePixelRatio,
                    y: (m.b * x + m.d * y + m.f) / devicePixelRatio,
                    frame: window.editorFrames[kind],
                })
            }
            return fillText.call(this, text, x, y, ...args)
        }
    })
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

/** The texts of each canvas's last frame. */
const lastFrame = (page: Page) =>
    page.evaluate(() => {
        const last = (texts: Text[]) => {
            const frame = Math.max(...texts.map(({ frame }) => frame))
            return texts.filter((text) => text.frame === frame)
        }
        return { chart: last(window.drawnTexts.chart), overlay: last(window.drawnTexts.overlay) }
    })

// Before the change at beat 2 the fixture's 120 BPM: a fixture beat is half a second.
const point = (page: Page, lane: number, seconds: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), {
        lane,
        beat: seconds * 2,
    })

for (const layout of ['basic', 'composed'] as const)
    for (const toolName of ['bpm', 'select'] as const)
        test(`${layout}, ${toolName} tool: beat labels make room for a dragged BPM change's ghost label`, async ({
            page,
        }, testInfo) => {
            await page.evaluate(
                async ({ layout, toolName }) => {
                    const { appImport, fixtures, show, view } = window.editorTest
                    const pivot = fixtures.events.stagePivotEvents[0]!
                    // Changing the tempo, a Composed move shows a ghost too.
                    show(
                        {
                            ...fixtures.interaction,
                            ...(layout === 'composed'
                                ? {
                                      isDynamicStages: true,
                                      stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 2 }],
                                  }
                                : {}),
                            bpms: [
                                { beat: 0, bpm: 120 },
                                { beat: 2, bpm: 60 },
                            ],
                        },
                        1.5,
                    )
                    view.layout = layout
                    const { switchToolTo } = await appImport<
                        typeof import('../../src/editor/tools')
                    >('/src/editor/tools/index.ts')
                    switchToolTo(toolName)
                },
                { layout, toolName },
            )
            await settle(page)
            const lanePx = await page.evaluate(
                () => window.editorTest.view.w / window.editorTest.settings.width,
            )
            const pane = (await page.locator('canvas.editor-chart').boundingBox())!
            // Beat 3 is at 2 s, after the 60 BPM change at 1 s.
            const beat3 = (await point(page, 0, 2)).y - pane.y
            const beatLabels = (texts: Text[]) =>
                texts.filter(({ x }) => Math.abs(x - (pane.width / 2 + 6.1 * lanePx)) < 2)
            const near = (texts: Text[], y: number) =>
                beatLabels(texts).filter((text) => Math.abs(text.y - y) < 0.45 * lanePx)

            const before = await lastFrame(page)
            expect(near(before.chart, beat3).map(({ text }) => text)).toEqual(['2.2'])

            // The BPM tool's hover ghost, with no drag, leaves the labels as they are.
            const target = await point(page, toolName === 'bpm' ? -4 : 6.4, 2)
            if (toolName === 'bpm') {
                await page.mouse.move(target.x, target.y)
                await settle(page)
                expect(await page.evaluate(() => window.editorTest.snapshot().creating)).toEqual([
                    { type: 'bpm', beat: 3 },
                ])
                expect(near((await lastFrame(page)).chart, beat3).map(({ text }) => text)).toEqual([
                    '2.2',
                ])
            }

            const from = await point(page, toolName === 'bpm' ? -4 : 6.4, 1)
            await page.mouse.move(from.x, from.y)
            await page.mouse.down()
            await page.mouse.move(target.x, target.y, { steps: 6 })
            await settle(page)
            expect(await page.evaluate(() => window.editorTest.snapshot().creating)).toEqual([
                { type: 'bpm', beat: 3 },
            ])
            const during = await lastFrame(page)
            const ghost = during.overlay.find(({ text }) => text === '60')
            expect(ghost, 'the ghost label').toBeDefined()
            // Drawn as the committed change's label at 1 s is, at beat 3.
            const committed = during.chart.find(({ text }) => text === '60')!
            const beat2 = (await point(page, 0, 1)).y - pane.y
            expect(Math.abs(ghost!.y - committed.y - (beat3 - beat2))).toBeLessThan(0.5)
            // No beat label beside it.
            expect(near(during.chart, beat3)).toEqual([])
            await page.screenshot({ path: testInfo.outputPath(`drag-${layout}-${toolName}.png`) })

            // Escape cancels: the label comes back.
            await page.keyboard.press('Escape')
            await page.mouse.up()
            await settle(page)
            expect(near((await lastFrame(page)).chart, beat3).map(({ text }) => text)).toEqual([
                '2.2',
            ])
        })

for (const layout of ['basic', 'composed'] as const)
    test(`${layout}: a paste drag of a BPM change makes room for its ghost label`, async ({
        page,
    }, testInfo) => {
        await page.evaluate((layout) => {
            Object.defineProperty(navigator.clipboard, 'writeText', {
                configurable: true,
                value: async () => undefined,
            })
            Object.defineProperty(navigator.clipboard, 'readText', {
                configurable: true,
                value: async () => '',
            })
            const { fixtures, history, show, settings, view } = window.editorTest
            settings.theme = 'dark'
            const pivot = fixtures.events.stagePivotEvents[0]!
            show(
                {
                    ...fixtures.interaction,
                    ...(layout === 'composed'
                        ? {
                              isDynamicStages: true,
                              stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 2 }],
                          }
                        : {}),
                    bpms: [
                        { beat: 0, bpm: 120 },
                        { beat: 2, bpm: 60 },
                    ],
                },
                1.5,
            )
            const entity = [...history.state.value.store.grid.bpm.values()]
                .flatMap((entities) => [...entities])
                .find(({ beat }) => beat === 2)!
            history.replaceState({ ...history.state.value, selectedEntities: [entity] })
            view.layout = layout
        }, layout)
        const change = await point(page, 0, 1)
        await page.mouse.move(change.x, change.y)
        await settle(page)
        await page.keyboard.press('c')
        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const { clipboardEntry } =
                        await window.editorTest.appImport<typeof import('../../src/clipboard')>(
                            '/src/clipboard/index.ts',
                        )
                    return clipboardEntry.value?.data?.beat
                }),
            )
            .toBe(2)
        await page.evaluate(async () => {
            const { switchToolTo } = await window.editorTest.appImport<
                typeof import('../../src/editor/tools')
            >('/src/editor/tools/index.ts')
            switchToolTo('paste')
        })
        await settle(page)
        const lanePx = await page.evaluate(
            () => window.editorTest.view.w / window.editorTest.settings.width,
        )
        const pane = (await page.locator('canvas.editor-chart').boundingBox())!
        // 4 s is beat 5, at 60 BPM after beat 2.
        const at = await point(page, 0, 4)
        const y = at.y - pane.y
        const nearLabels = (texts: Text[]) =>
            texts.filter(
                (text) =>
                    Math.abs(text.x - (pane.width / 2 + 6.1 * lanePx)) < 2 &&
                    Math.abs(text.y - y) < 0.45 * lanePx,
            )
        // The paste ghost under a resting pointer leaves the labels as they are.
        await page.mouse.move(at.x, at.y)
        await settle(page)
        const hover = await lastFrame(page)
        expect(hover.overlay.some(({ text }) => text === '60')).toBe(true)
        expect(nearLabels(hover.chart).map(({ text }) => text)).toEqual(['2.4'])

        await page.mouse.move(at.x, at.y + 40)
        await page.mouse.down()
        await page.mouse.move(at.x, at.y, { steps: 6 })
        await settle(page)
        const during = await lastFrame(page)
        const ghost = during.overlay.find(({ text }) => text === '60')!
        const committed = during.chart.find(({ text }) => text === '60')!
        expect(Math.abs(ghost.y - committed.y - (at.y - change.y))).toBeLessThan(0.5)
        expect(nearLabels(during.chart)).toEqual([])
        await page.screenshot({ path: testInfo.outputPath(`paste-${layout}-dark.png`) })

        // Escape cancels: the label comes back.
        await page.keyboard.press('Escape')
        await page.mouse.up()
        await page.mouse.move(at.x - 300, at.y + 200)
        await settle(page)
        expect(nearLabels((await lastFrame(page)).chart).map(({ text }) => text)).toEqual(['2.4'])
    })

/** Shows BPM changes at beats 0 (120) and 2 (60) in Basic with the BPM tool. */
const showBpmChanges = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, fixtures, show, view } = window.editorTest
        show(
            {
                ...fixtures.interaction,
                bpms: [
                    { beat: 0, bpm: 120 },
                    { beat: 2, bpm: 60 },
                ],
            },
            1.5,
        )
        view.layout = 'basic'
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('bpm')
    })

/** The beat column's texts within half a label of a time's y. */
const beatColumn = async (page: Page, texts: Text[], seconds: number) => {
    const pane = (await page.locator('canvas.editor-chart').boundingBox())!
    const { y, lanePx } = await page.evaluate(
        (seconds) => ({
            y: window.editorTest.point(0, seconds * 2).y,
            lanePx: window.editorTest.view.w / window.editorTest.settings.width,
        }),
        seconds,
    )
    return texts
        .filter(
            (text) =>
                Math.abs(text.x - (pane.width / 2 + 6.1 * lanePx)) < 2 &&
                Math.abs(text.y - (y - pane.y)) < 0.45 * lanePx,
        )
        .map(({ text }) => text)
}

test('basic: a dropped BPM change keeps the room it had as a ghost', async ({ page }) => {
    await showBpmChanges(page)
    await settle(page)
    // Beat 3 is at 2 s.
    expect(await beatColumn(page, (await lastFrame(page)).chart, 2)).toEqual(['2.2'])
    const from = await point(page, -4, 1)
    const to = await point(page, -4, 2)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
    expect(await beatColumn(page, (await lastFrame(page)).chart, 2)).toEqual([])
    // Dropped without Escape: the committed label takes the beat label's place at beat 3, and
    // the beat label at beat 2 comes back.
    await page.mouse.up()
    await page.mouse.move(to.x - 200, to.y + 150)
    await settle(page)
    expect(
        await page.evaluate(() =>
            [...window.editorTest.history.state.value.store.grid.bpm.values()]
                .flatMap((entities) => [...entities])
                .map(({ beat }) => beat)
                .sort(),
        ),
    ).toEqual([0, 3])
    const after = (await lastFrame(page)).chart
    // Beat 3 is now at 1.5 s, beat 2 at 1 s.
    expect(await beatColumn(page, after, 1.5)).toEqual(['60'])
    expect(await beatColumn(page, after, 1)).toEqual(['1.3'])
})

test('basic: with BPMs hidden, a drag still makes room for the ghost label it draws', async ({
    page,
}) => {
    await showBpmChanges(page)
    await page.evaluate(() => {
        const { settings, view } = window.editorTest
        view.visibilities.bpm = false
        settings.showOtherObjects = false
    })
    await settle(page)
    expect(await beatColumn(page, (await lastFrame(page)).chart, 3)).toEqual(['2.3'])
    // Adding a change at beat 4, at 3 s, by dragging from 3.5 s.
    const from = await point(page, -4, 3.5)
    const to = await point(page, -4, 3)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
    expect(await page.evaluate(() => window.editorTest.snapshot().creating)).toEqual([
        { type: 'bpm', beat: 4 },
    ])
    const during = await lastFrame(page)
    expect(await beatColumn(page, during.overlay, 3), 'the ghost label').toHaveLength(1)
    expect(await beatColumn(page, during.chart, 3)).toEqual([])
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await settle(page)
    expect(await beatColumn(page, (await lastFrame(page)).chart, 3)).toEqual(['2.3'])
})
