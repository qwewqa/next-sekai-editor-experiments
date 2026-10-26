import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, touchInput } from './editorFixture'

// Middle-click autoscroll in the chart and the Elevation Editor. The speed curve and the button
// rules are in tests/editor/autoscroll.test.ts; these cases cover the browser's event orders.

test.use({ viewport: { width: 1400, height: 900 } })

// The session the page started, before the fixture's chart opens a new one.
const startup = new WeakMap<Page, string | undefined>()

/** Records every release and click before the app's listeners, to read what they did to it. */
const recordReleases = () => {
    const events: Event[] = []
    ;(window as unknown as { releases: Event[] }).releases = events
    for (const type of ['mouseup', 'auxclick', 'click', 'contextmenu'])
        addEventListener(type, (event) => events.push(event), true)
}

const releases = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as { releases: MouseEvent[] }).releases.map((event) => ({
            type: event.type,
            button: event.button,
            prevented: event.defaultPrevented,
        })),
    )
const clearReleases = (page: Page) =>
    page.evaluate(() => {
        ;(window as unknown as { releases: Event[] }).releases.length = 0
    })

test.beforeEach(async ({ page }) => {
    await page.addInitScript(recordReleases)
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    startup.set(
        page,
        await page.evaluate(async () => {
            const { flusher } = await import('/src/local/storing.ts')
            return flusher?.session?.id
        }),
    )
    await page.evaluate(installEditorFixture)
    await settle(page)
})

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

const middleDown = (page: Page) => page.mouse.down({ button: 'middle' })
const middleUp = (page: Page) => page.mouse.up({ button: 'middle' })

const viewTime = (page: Page) => page.evaluate(() => window.editorTest.view.time)
const viewLane = (page: Page) => page.evaluate(() => window.editorTest.view.lane)
const noteCount = (page: Page) => page.evaluate(() => window.editorTest.snapshot().notes.length)
const center = (page: Page) =>
    page.evaluate(async () => {
        const { elevationViewport } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        return elevationViewport.center
    })

/** The autoscroll's marker and cursor are both gone. */
const expectStopped = async (page: Page) => {
    await expect(page.locator('.autoscroll-marker')).toHaveCount(0)
    await expect(page.locator('html[data-autoscroll]')).toHaveCount(0)
}

/** Reads a value across two settled frames and expects it unchanged. */
const expectStill = async (page: Page, read: () => Promise<number>) => {
    await settle(page)
    const before = await read()
    await settle(page)
    expect(await read()).toBe(before)
}

const paneCenter = async (page: Page, selector: string) => {
    const box = (await page.locator(selector).boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Away from time 0, so a stop cannot be mistaken for the clamp. */
const showFar = (page: Page) =>
    page.evaluate(() => {
        const { fixtures, show, view } = window.editorTest
        show(fixtures.interaction, 3)
        view.time = 500
    })

const openElevation = (page: Page, sideBySide: 'allow' | 'disallow') =>
    page.evaluate(async (sideBySide) => {
        const { settings, history, appImport, nextTick } = window.editorTest
        settings.elevationEditorSideBySide = sideBySide
        const [note] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [note!] })
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
        await nextTick()
    }, sideBySide)

test('chart, click mode: the start stops what moves, a move scrolls, a press stops it', async ({
    page,
}) => {
    await showFar(page)
    await page.keyboard.press('a')
    await page.evaluate(async () => {
        const { view } = window.editorTest
        // An ease that will not finish, and playback.
        view.scrollingY = {
            type: 'ease',
            from: { time: 0, viewTime: view.time },
            to: { time: 1e9, viewTime: view.time },
        }
        const { startOrStopPlayer } =
            await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                '/src/editor/player.ts',
            )
        startOrStopPlayer()
    })
    const start = await paneCenter(page, 'canvas.editor-chart')
    await page.mouse.move(start.x, start.y)
    await expect
        .poll(() => page.evaluate(() => window.editorTest.snapshot().creating.length))
        .toBe(1)
    const notes = await noteCount(page)

    await middleDown(page)
    await middleUp(page)
    await expect(page.locator('.autoscroll-marker')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-autoscroll', 'y')
    const state = await page.evaluate(async () => {
        const { view } = window.editorTest
        const { isPlaying } =
            await window.editorTest.appImport<typeof import('../../src/player')>('/src/player.ts')
        return {
            playing: isPlaying.value,
            ease: view.scrollingY,
            entities: view.entities.hovered.length + view.entities.creating.length,
            hoverHidden: view.isHoverHidden,
        }
    })
    expect(state).toEqual({ playing: false, ease: undefined, entities: 0, hoverHidden: true })

    // Down scrolls as the wheel turned down does; a sideways move leaves the lane in Basic.
    const lane = await viewLane(page)
    const before = await viewTime(page)
    await page.mouse.move(start.x + 150, start.y + 120, { steps: 4 })
    await expect.poll(() => viewTime(page)).toBeLessThan(before - 0.5)
    expect(await viewLane(page)).toBe(lane)

    await page.mouse.click(start.x, start.y)
    await expectStopped(page)
    await expectStill(page, () => viewTime(page))
    expect(await noteCount(page)).toBe(notes)
})

test('chart, hold mode in Composed: down and right scroll time and lanes, the release stops', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                stageTransformEvents: [0, 8].map((beat) => ({
                    stageId: base.stageId,
                    beat,
                    rotation: 0,
                    xTranslation: beat * 3,
                    yTranslation: 0,
                    elevation: 0,
                    anchor: 'default' as const,
                    eventEase: 'linear' as const,
                })),
                slides: [[{ ...base, beat: 4, left: -1, size: 2 }]],
            },
            2,
        )
        settings.width = 16
        settings.maxScrollX = 0
        view.layout = 'composed'
        view.time = 500
    })
    await settle(page)
    const lane = await viewLane(page)
    const time = await viewTime(page)
    const start = await paneCenter(page, 'canvas.editor-chart')
    await page.mouse.move(start.x, start.y)
    await middleDown(page)
    await expect(page.locator('html')).toHaveAttribute('data-autoscroll', 'xy')
    await page.mouse.move(start.x + 60, start.y + 60, { steps: 4 })
    await expect.poll(() => viewTime(page)).toBeLessThan(time)
    await expect.poll(() => viewLane(page)).toBeGreaterThan(lane)
    await middleUp(page)
    await expectStopped(page)
    await expectStill(page, () => viewTime(page))
})

test('Elevation Editor: Escape stops, a key keeps the held middle button owned until its release', async ({
    page,
}) => {
    await openElevation(page, 'disallow')
    await expect(page.locator('.elevation-editor')).toBeVisible()
    await settle(page)
    const selected = () =>
        page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length)
    const picked = await selected()
    const start = await paneCenter(page, '.elevation-canvas')
    await page.mouse.move(start.x, start.y)
    await middleDown(page)
    const before = await center(page)
    await page.mouse.move(start.x, start.y - 80, { steps: 4 })
    await expect.poll(() => center(page)).toBeGreaterThan(before)

    await page.keyboard.press('Escape')
    await expectStopped(page)
    await expectStill(page, () => center(page))
    expect(await selected()).toBe(picked)
    await expect(page.locator('.elevation-editor')).toBeVisible()

    // No command is bound to this key, and the release after it still belongs to the autoscroll.
    await page.keyboard.press('ScrollLock')
    await clearReleases(page)
    await middleUp(page)
    await settle(page)
    const seen = await releases(page)
    expect(seen.map(({ type }) => type)).toEqual(expect.arrayContaining(['mouseup', 'auxclick']))
    expect(seen.every(({ button, prevented }) => button === 1 && prevented)).toBe(true)
})

test('a middle press during a left drag is refused and its release does not end the drag', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, settings } = window.editorTest
        const template = fixtures.interaction.slides.flat()[0]!
        settings.dragToPanY = false
        settings.pps = 200
        show(
            {
                ...fixtures.interaction,
                slides: [[{ ...template, beat: 8, left: -1, size: 2, isAttached: false }]],
            },
            0,
        )
        view.time = 4
    })
    await settle(page)
    await page.keyboard.press('a')
    const point = (lane: number, beat: number) =>
        page.evaluate(([lane, beat]) => window.editorTest.point(lane, beat), [lane, beat] as const)
    const from = await point(0, 8)
    const middle = await point(0, 9)
    const to = await point(0, 10)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(middle.x, middle.y, { steps: 3 })
    await middleDown(page)
    await middleUp(page)
    await expectStopped(page)
    await page.mouse.move(to.x, to.y, { steps: 3 })
    await page.mouse.up()
    expect(
        await page.evaluate(() => window.editorTest.snapshot().notes.map((n) => n.beat)),
    ).toEqual([10])
})

test('a press on the minimap while it runs stops it and does not jump; the next one jumps', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, settings } = window.editorTest
        settings.showMinimap = true
        const chart = structuredClone(fixtures.interaction)
        const far = structuredClone(chart.slides[3]![0]!)
        far.beat = 240
        chart.slides.push([far])
        show(chart, 3)
        view.time = 100
    })
    const strip = page.locator('[data-minimap]')
    await expect(strip).toBeVisible()
    await settle(page)
    const start = await paneCenter(page, 'canvas.editor-chart')
    await page.mouse.move(start.x, start.y)
    await middleDown(page)
    await middleUp(page)
    await expect(page.locator('.autoscroll-marker')).toBeVisible()
    const box = (await strip.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8)
    await expectStopped(page)
    await expectStill(page, () => viewTime(page))
    expect(await viewTime(page)).toBeGreaterThan(50)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8)
    await expect.poll(() => viewTime(page)).toBeLessThan(50)
})

test('a lost release and a blur end the motion', async ({ page }) => {
    await showFar(page)
    const start = await paneCenter(page, 'canvas.editor-chart')
    await page.mouse.move(start.x, start.y)
    await middleDown(page)
    await page.mouse.move(start.x, start.y + 60, { steps: 3 })
    await expect(page.locator('.autoscroll-marker')).toBeVisible()
    await page.evaluate(() =>
        window.dispatchEvent(
            new PointerEvent('pointermove', { pointerType: 'mouse', buttons: 0, button: -1 }),
        ),
    )
    await expectStopped(page)
    await middleUp(page)

    await middleDown(page)
    await middleUp(page)
    await expect(page.locator('.autoscroll-marker')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expectStopped(page)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
})

test('Elevation peek overlay: a middle press scrolls while held', async ({ page }) => {
    const first = startup.get(page)
    await openElevation(page, 'allow')
    await expect(page.locator('.elevation-editor')).toBeVisible()
    // Peeking needs a stored first entry.
    await expect
        .poll(() =>
            page.evaluate(async (first) => {
                const { flusher } =
                    await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                        '/src/local/storing.ts',
                    )
                const session = flusher?.session
                return !!session && session.id !== first && flusher.newestSeq(session) > 0
            }, first),
        )
        .toBe(true)
    await page.evaluate(async () => {
        const [peek, { flusher }] = await Promise.all([
            window.editorTest.appImport<typeof import('../../src/history/peek')>(
                '/src/history/peek.ts',
            ),
            window.editorTest.appImport<typeof import('../../src/local/storing')>(
                '/src/local/storing.ts',
            ),
        ])
        await peek.peekEntry(
            peek.entryKey(flusher!.session!.id, flusher!.newestSeq(flusher!.session!)),
        )
    })
    const overlay = page.locator('.elevation-peek-overlay')
    await expect(overlay).toBeVisible()
    const box = (await overlay.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    const before = await center(page)
    await middleDown(page)
    await page.mouse.move(x, y - 80, { steps: 4 })
    await expect.poll(() => center(page)).toBeGreaterThan(before)
    await middleUp(page)
    await expectStopped(page)
    await expectStill(page, () => center(page))
})

test('hold middle, stop with left, release middle first: nothing is placed and the next click works', async ({
    page,
}) => {
    await showFar(page)
    await page.keyboard.press('a')
    const start = await paneCenter(page, 'canvas.editor-chart')
    const notes = await noteCount(page)
    await page.mouse.move(start.x, start.y)
    await middleDown(page)
    await page.mouse.move(start.x, start.y + 60, { steps: 3 })
    await page.mouse.down()
    await expectStopped(page)
    await clearReleases(page)
    await middleUp(page)
    await page.mouse.up()
    await expectStill(page, () => viewTime(page))
    const seen = await releases(page)
    expect(seen.filter(({ type }) => type === 'mouseup').map(({ button }) => button)).toEqual([
        1, 0,
    ])
    expect(seen.every(({ prevented }) => prevented)).toBe(true)
    expect(await noteCount(page)).toBe(notes)
    await page.mouse.click(start.x, start.y)
    await expect.poll(() => noteCount(page)).toBe(notes + 1)
})

test.describe('with a touch down', () => {
    test.use({ hasTouch: true })

    test('a middle click starts nothing and the touch still scrolls', async ({ page }) => {
        await showFar(page)
        const start = await paneCenter(page, 'canvas.editor-chart')
        const touch = await touchInput(page)
        const fingers = (dy: number): [number, number][] => [
            [start.x - 200, start.y + dy],
            [start.x - 100, start.y + dy],
        ]
        await touch('touchStart', fingers(0))
        await page.mouse.move(start.x, start.y)
        await middleDown(page)
        await middleUp(page)
        await settle(page)
        await expectStopped(page)
        const before = await viewTime(page)
        for (const dy of [20, 60, 120]) await touch('touchMove', fingers(dy))
        await expect.poll(() => viewTime(page)).not.toBe(before)
        await touch('touchEnd', [])
    })
})
