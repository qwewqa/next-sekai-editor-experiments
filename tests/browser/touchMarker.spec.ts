import { expect, test, type Page } from '@playwright/test'
import {
    installCanvasCounters,
    installEditorFixture,
    touchInput,
    useTool,
    type TouchInput,
} from './editorFixture'

test.use({ hasTouch: true })

let touch: TouchInput

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    touch = await touchInput(page)
    await showNotes(page)
    await useTool(page, 'select')
})

/** Two lone notes at beat 2, on lanes -3 and 3, at 120 BPM. */
const showNotes = (page: Page) =>
    page.evaluate(async () => {
        const { fixtures, show, nextTick } = window.editorTest
        const template = fixtures.interaction.slides.flat()[0]!
        show(
            {
                ...fixtures.interaction,
                slides: [-4, 2].map((left) => [
                    { ...template, beat: 2, left, size: 2, isAttached: false },
                ]),
            },
            1.1,
        )
        await nextTick()
    })

const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(([lane, beat]) => window.editorTest.point(lane, beat), [lane, beat] as const)

const tap = async (page: Page, lane: number, beat: number) => {
    const { x, y } = await point(page, lane, beat)
    await touch('touchStart', [[x, y]])
    await touch('touchEnd', [])
}

/** The touch marker, the input, and the hover labels: whether shown, their line's time and their beat. */
const markerState = (page: Page) =>
    page.evaluate(async () => {
        const { view, settings, appImport } = window.editorTest
        const { hoverLabelCenter } = await appImport<typeof import('../../src/editor/edgeLabels')>(
            '/src/editor/edgeLabels.ts',
        )
        const labels = document.querySelector('.editor-hover-labels')!
        return {
            marker: view.touchMarker && { ...view.touchMarker },
            input: view.input,
            shown: getComputedStyle(labels).visibility === 'visible',
            time:
                Math.round(
                    (view.time + (0.5 * view.h - hoverLabelCenter.value) / settings.pps) * 1000,
                ) / 1000,
            beat: labels.lastElementChild?.textContent,
        }
    })

/** The beat label's text at a beat. */
const beatLabel = (page: Page, beat: number) =>
    page.evaluate(async (beat) => {
        const { settings, appImport } = window.editorTest
        const { formatBeatPosition } = await appImport<
            typeof import('../../src/editor/beatDisplay')
        >('/src/editor/beatDisplay.ts')
        const { drawnBpms } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        return formatBeatPosition(drawnBpms.value, beat, settings.beatDisplay, true)
    }, beat)

const shownAt = async (page: Page, marker: { kind: string; beat: number }, time: number) => ({
    marker,
    input: 'touch',
    shown: true,
    time,
    beat: await beatLabel(page, marker.beat),
})

const cursorTime = (page: Page) => page.evaluate(() => window.editorTest.view.cursorTime)

const notes = (page: Page) =>
    page.evaluate(() =>
        window.editorTest
            .snapshot()
            .notes.map(({ beat, left }) => ({ beat, left }))
            .sort((a, b) => a.left! - b.left!),
    )

test('a tap on empty space marks the cursor it placed, over the edge labels under it', async ({
    page,
}) => {
    await tap(page, 0, 3)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'cursor', beat: 3 }, 1.5))
    expect(await cursorTime(page)).toBe(1.5)

    // A quarter beat 15 to 30 pixels below the top.
    const top = await page.evaluate(() => {
        const { view, settings } = window.editorTest
        return Math.floor((view.time + (view.h / 2 - 15) / settings.pps) * 8) / 4
    })
    await tap(page, -8, top)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'cursor', beat: top }, top / 2))
    expect(
        await page.evaluate(async () => {
            const { coveredEdgeLabels } = await window.editorTest.appImport<
                typeof import('../../src/editor/edgeLabels')
            >('/src/editor/edgeLabels.ts')
            return coveredEdgeLabels.value.top
        }),
    ).toEqual({ time: true, beat: true })
})

test('a tap on a note marks its beat and leaves the cursor', async ({ page }) => {
    await tap(page, -3, 2)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 2 }, 1))
    expect(await cursorTime(page)).toBe(100)
})

test('a Note tool tap marks the note it adds', async ({ page }) => {
    await useTool(page, 'note')
    await tap(page, 0, 3)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 3 }, 1.5))
    expect(await notes(page)).toContainEqual({ beat: 3, left: 0 })
})

test('the marker stays on its beat through a pinch, a two-finger pan and a quick scroll', async ({
    page,
}) => {
    await tap(page, -3, 2)
    const marked = await shownAt(page, { kind: 'entity', beat: 2 }, 1)
    await expect.poll(() => markerState(page)).toEqual(marked)
    const viewTime = () => page.evaluate(() => window.editorTest.view.time)

    const { x, y } = await point(page, 0, 3)
    let before = await viewTime()
    await touch('touchStart', [
        [x - 40, y],
        [x + 40, y],
    ])
    for (let step = 1; step <= 4; step++)
        await touch('touchMove', [
            [x - 40, y + step * 15],
            [x + 40, y + step * 15],
        ])
    await touch('touchEnd', [])
    expect(await viewTime()).not.toBe(before)
    await expect.poll(() => markerState(page)).toEqual(marked)

    const pps = () => page.evaluate(() => window.editorTest.settings.pps)
    before = await pps()
    await touch('touchStart', [
        [x, y - 40],
        [x, y + 40],
    ])
    for (let step = 1; step <= 4; step++)
        await touch('touchMove', [
            [x, y - 40 - step * 20],
            [x, y + 40 + step * 20],
        ])
    await touch('touchEnd', [])
    expect(await pps()).not.toBe(before)
    await expect.poll(() => markerState(page)).toEqual(marked)

    const pane = (await page.locator('canvas.editor-chart').boundingBox())!
    const edge = pane.x + pane.width - 10
    before = await viewTime()
    await touch('touchStart', [[edge, y]])
    for (let step = 1; step <= 4; step++) await touch('touchMove', [[edge, y + step * 20]])
    await touch('touchEnd', [])
    expect(await viewTime()).not.toBe(before)
    await expect.poll(() => markerState(page)).toEqual(marked)
})

test('a move drag shows the finger, then marks where it lands', async ({ page }) => {
    const from = await point(page, -3, 2)
    const to = await point(page, -3, 3)
    await touch('touchStart', [[from.x, from.y]])
    for (let step = 1; step <= 4; step++)
        await touch('touchMove', [[from.x, from.y + ((to.y - from.y) * step) / 4]])
    // The hover follows the finger, unsnapped.
    await expect.poll(() => page.evaluate(() => window.editorTest.view.isHoverHidden)).toBe(false)
    await expect.poll(async () => (await markerState(page)).time).toBe(1.5)
    await touch('touchEnd', [])
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 3 }, 1.5))
    expect(await notes(page)).toEqual([
        { beat: 3, left: -4 },
        { beat: 2, left: 2 },
    ])
})

test('a box select leaves no marker', async ({ page }) => {
    await tap(page, -3, 2)
    await expect.poll(async () => (await markerState(page)).marker).toBeTruthy()
    const from = await point(page, -6, 4)
    const to = await point(page, 6, 1)
    await touch('touchStart', [[from.x, from.y]])
    for (let step = 1; step <= 4; step++)
        await touch('touchMove', [
            [from.x + ((to.x - from.x) * step) / 4, from.y + ((to.y - from.y) * step) / 4],
        ])
    await touch('touchEnd', [])
    await expect.poll(() => markerState(page)).toMatchObject({ marker: undefined, shown: false })
    expect(
        await page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
    ).toBe(2)
})

test('Escape during a drag brings back the marker from before it', async ({ page }) => {
    await page.evaluate(() => {
        window.editorTest.settings.touchQuickScrollZone = 0
    })
    await tap(page, 0, 4)
    const marked = await shownAt(page, { kind: 'cursor', beat: 4 }, 2)
    await expect.poll(() => markerState(page)).toEqual(marked)
    const from = await point(page, -3, 2)
    await touch('touchStart', [[from.x, from.y]])
    for (let step = 1; step <= 4; step++) await touch('touchMove', [[from.x, from.y - step * 15]])
    await expect.poll(() => page.evaluate(() => window.editorTest.view.isHoverHidden)).toBe(false)
    await page.keyboard.press('Escape')
    await touch('touchEnd', [])
    await expect.poll(() => markerState(page)).toEqual(marked)
    expect(await notes(page)).toEqual([
        { beat: 2, left: -4 },
        { beat: 2, left: 2 },
    ])
})

test('a mouse move replaces the marker, and a touch then hides the hover and its ghost', async ({
    page,
}) => {
    await useTool(page, 'note')
    await tap(page, -3, 2)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 2 }, 1))

    const { x, y } = await point(page, 0, 3)
    await page.mouse.move(x, y)
    const hover = () =>
        page.evaluate(() => {
            const { view } = window.editorTest
            return { hidden: view.isHoverHidden, creating: view.entities.creating.length }
        })
    await expect
        .poll(() => markerState(page))
        .toMatchObject({ marker: undefined, input: 'mouse', shown: true, time: 1.5 })
    expect(await hover()).toEqual({ hidden: false, creating: 1 })

    // A pinch taps nothing.
    await touch('touchStart', [
        [x - 40, y + 60],
        [x + 40, y + 60],
    ])
    for (let step = 1; step <= 4; step++)
        await touch('touchMove', [
            [x - 40 - step * 15, y + 60],
            [x + 40 + step * 15, y + 60],
        ])
    await touch('touchEnd', [])
    await expect
        .poll(() => markerState(page))
        .toMatchObject({ marker: undefined, input: 'touch', shown: false })
    expect(await hover()).toEqual({ hidden: true, creating: 0 })

    // What would hover again under a resting mouse doesn't bring it back.
    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { commands } = await appImport<typeof import('../../src/editor/commands')>(
            '/src/editor/commands/index.ts',
        )
        await commands.laneLimitSix.execute()
        history.replaceState({ ...history.state.value })
    })
    await expect
        .poll(() => markerState(page))
        .toMatchObject({ marker: undefined, input: 'touch', shown: false })
    expect(await hover()).toEqual({ hidden: true, creating: 0 })
})

for (const phase of ['pressed', 'dragging'] as const)
    test(`a touch while the mouse is ${phase} leaves no marker after the mouse drag`, async ({
        page,
    }) => {
        const from = await point(page, -3, 2)
        const to = await point(page, -1, 3)
        const other = await point(page, 0, 4)
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        if (phase === 'dragging') await page.mouse.move(to.x, to.y, { steps: 4 })
        await touch('touchStart', [[other.x, other.y]])
        await touch('touchEnd', [])
        if (phase === 'pressed') await page.mouse.move(to.x, to.y, { steps: 4 })
        await page.mouse.up()
        expect(await notes(page)).toEqual([
            { beat: 3, left: -2 },
            { beat: 2, left: 2 },
        ])
        expect(await markerState(page)).toMatchObject({ marker: undefined, input: 'mouse' })
    })

test('playback and a BPM change hide a cursor marker; a note marker keeps its beat', async ({
    page,
}) => {
    const addBpm = () =>
        page.evaluate(async () => {
            const { history, appImport } = window.editorTest
            const { createTransaction } = await appImport<
                typeof import('../../src/state/transaction')
            >('/src/state/transaction.ts')
            const { addBpm } = await appImport<typeof import('../../src/state/mutations/bpm')>(
                '/src/state/mutations/bpm.ts',
            )
            const transaction = createTransaction(history.state.value)
            addBpm(transaction, { beat: 1, bpm: 60 })
            history.pushState(() => 'BPM', transaction.commit(history.state.value.selectedEntities))
        })

    await tap(page, 0, 4)
    await expect.poll(async () => (await markerState(page)).shown).toBe(true)
    await page.evaluate(async () => {
        const { commands } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands')
        >('/src/editor/commands/index.ts')
        await commands.play.execute()
    })
    await expect
        .poll(() => markerState(page))
        .toMatchObject({ marker: { kind: 'cursor', beat: 4 }, shown: false })

    await tap(page, 0, 4)
    await expect.poll(async () => (await markerState(page)).shown).toBe(true)
    await addBpm()
    await expect
        .poll(() => markerState(page))
        .toMatchObject({ marker: { kind: 'cursor', beat: 4 }, shown: false })

    await showNotes(page)
    await tap(page, -3, 2)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 2 }, 1))
    await addBpm()
    // Beat 1 at 0.5 seconds, then a beat a second.
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 2 }, 1.5))
})

test('taps in the Elevation pane leave the marker', async ({ page }) => {
    await tap(page, -3, 2)
    const marked = await shownAt(page, { kind: 'entity', beat: 2 }, 1)
    await expect.poll(() => markerState(page)).toEqual(marked)
    await page.keyboard.press('t')
    const pane = page.locator('.elevation-canvas')
    await expect(pane).toBeVisible()
    const box = (await pane.boundingBox())!
    for (const [fx, fy] of [
        [0.5, 0.5],
        [0.3, 0.7],
    ] as const) {
        await touch('touchStart', [[box.x + box.width * fx, box.y + box.height * fy]])
        await touch('touchEnd', [])
    }
    expect((await markerState(page)).marker).toEqual(marked.marker)
})

test('a two-finger tap clears a note marker, and keeps a cursor marker; Delete keeps it', async ({
    page,
}) => {
    await tap(page, -3, 2)
    const marked = await shownAt(page, { kind: 'entity', beat: 2 }, 1)
    await expect.poll(() => markerState(page)).toEqual(marked)
    await page.keyboard.press('Delete')
    await expect.poll(() => notes(page)).toEqual([{ beat: 2, left: 2 }])
    expect(await markerState(page)).toEqual(marked)

    const twoTap = async () => {
        const { x, y } = await point(page, 0, 3)
        await touch('touchStart', [
            [x - 40, y],
            [x + 40, y],
        ])
        await touch('touchEnd', [])
    }
    await tap(page, 3, 2)
    await expect.poll(() => markerState(page)).toEqual(marked)
    await twoTap()
    await expect.poll(() => markerState(page)).toMatchObject({ marker: undefined, shown: false })

    await tap(page, 0, 4)
    const cursor = await shownAt(page, { kind: 'cursor', beat: 4 }, 2)
    await expect.poll(() => markerState(page)).toEqual(cursor)
    await twoTap()
    await expect.poll(() => markerState(page)).toEqual(cursor)
})

test('loading a chart clears the marker', async ({ page }) => {
    await tap(page, -3, 2)
    await expect.poll(async () => (await markerState(page)).shown).toBe(true)
    await showNotes(page)
    await expect.poll(() => markerState(page)).toMatchObject({ marker: undefined, shown: false })
})

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('both labels show inside the pane', async ({ page }) => {
        await tap(page, 0, 3)
        await expect
            .poll(() => markerState(page))
            .toEqual(await shownAt(page, { kind: 'cursor', beat: 3 }, 1.5))
        const pane = (await page.locator('canvas.editor-chart').boundingBox())!
        for (const span of await page.locator('.editor-hover-labels > span').all()) {
            const box = (await span.boundingBox())!
            expect(box.width).toBeGreaterThan(0)
            expect(box.x).toBeGreaterThanOrEqual(pane.x)
            expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width)
            expect(box.y).toBeGreaterThanOrEqual(pane.y)
            expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height)
        }
    })
})
