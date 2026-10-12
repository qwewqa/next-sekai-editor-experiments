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

/** Waits until the view holds still for two frames, so a point lands on the beat asked for. */
const settle = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(async () => {
                const { view, settings } = window.editorTest
                // Everything editorTest.point reads.
                const at = () =>
                    [
                        view.x,
                        view.y,
                        view.w,
                        view.h,
                        view.time,
                        view.lane,
                        settings.pps,
                        settings.width,
                    ].join()
                const before = at()
                await new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                )
                return !view.scrollingX && !view.scrollingY && at() === before
            }),
        )
        .toBe(true)

const point = async (page: Page, lane: number, beat: number) => {
    await settle(page)
    return await page.evaluate(([lane, beat]) => window.editorTest.point(lane, beat), [
        lane,
        beat,
    ] as const)
}

/** A tap, sent together so a slow round trip can't stretch it into a long press. */
const tapAt = (x: number, y: number, modifiers = 0) =>
    Promise.all([touch('touchStart', [[x, y]], modifiers), touch('touchEnd', [], modifiers)])

const tap = async (page: Page, lane: number, beat: number, modifiers = 0) => {
    const { x, y } = await point(page, lane, beat)
    await tapAt(x, y, modifiers)
}

/** A two-finger tap in the middle of the chart. */
const twoTap = async (page: Page) => {
    await settle(page)
    const pane = (await page.locator('canvas.editor-chart').boundingBox())!
    const x = pane.x + pane.width / 2
    const y = pane.y + pane.height / 2
    await Promise.all([
        touch('touchStart', [
            [x - 40, y],
            [x + 40, y],
        ]),
        touch('touchEnd', []),
    ])
}

const command = (page: Page, name: 'play' | 'stop' | 'jumpUp') =>
    page.evaluate(async (name) => {
        const { commands } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands')
        >('/src/editor/commands/index.ts')
        await commands[name].execute()
    }, name)

const selectedCount = (page: Page) =>
    page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length)

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

test('a tap off the grid marks the snapped beat it placed the cursor on', async ({ page }) => {
    await tap(page, 0, 3.07)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'cursor', beat: 3 }, 1.5))
    expect(await cursorTime(page)).toBe(1.5)
})

test('a Ctrl+tap on empty space keeps a cursor marker', async ({ page }) => {
    await tap(page, 0, 4)
    const marked = await shownAt(page, { kind: 'cursor', beat: 4 }, 2)
    await expect.poll(() => markerState(page)).toEqual(marked)
    // Without Ctrl, it would place the cursor at beat 3.
    await tap(page, 0, 3, 2)
    await page.evaluate(() => window.editorTest.nextTick())
    // A recognized tap moves the hover to beat 3.
    expect(await page.evaluate(() => window.editorTest.view.hoverTime)).toBeCloseTo(1.5)
    expect(await markerState(page)).toEqual(marked)
    expect(await cursorTime(page)).toBe(2)
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
    const to = await point(page, -3, 3.07)
    await touch('touchStart', [[from.x, from.y]])
    for (let step = 1; step <= 4; step++)
        await touch('touchMove', [[from.x, from.y + ((to.y - from.y) * step) / 4]])
    // The hover follows the finger, unsnapped: beat 3.07 is 1.535 seconds.
    await expect.poll(() => page.evaluate(() => window.editorTest.view.isHoverHidden)).toBe(false)
    await expect
        .poll(async () => Math.abs((await markerState(page)).time - 1.535))
        .toBeLessThan(0.01)
    await touch('touchEnd', [])
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 3 }, 1.5))
    expect(await notes(page)).toEqual([
        { beat: 3, left: -4 },
        { beat: 2, left: 2 },
    ])
})

test('a box select clears a note marker and keeps a cursor marker', async ({ page }) => {
    const boxSelect = async () => {
        const from = await point(page, -6, 4)
        const to = await point(page, 6, 1)
        await touch('touchStart', [[from.x, from.y]])
        for (let step = 1; step <= 4; step++)
            await touch('touchMove', [
                [from.x + ((to.x - from.x) * step) / 4, from.y + ((to.y - from.y) * step) / 4],
            ])
        await touch('touchEnd', [])
    }

    await tap(page, -3, 2)
    await expect.poll(async () => (await markerState(page)).marker).toBeTruthy()
    await boxSelect()
    await expect.poll(() => markerState(page)).toMatchObject({ marker: undefined, shown: false })
    expect(await selectedCount(page)).toBe(2)

    await tap(page, 0, 3)
    const marked = await shownAt(page, { kind: 'cursor', beat: 3 }, 1.5)
    await expect.poll(() => markerState(page)).toEqual(marked)
    expect(await selectedCount(page)).toBe(0)
    await boxSelect()
    await expect.poll(() => selectedCount(page)).toBe(2)
    await expect.poll(() => markerState(page)).toEqual(marked)
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

test('playback hides the marker, and stopping shows it again', async ({ page }) => {
    await page.evaluate(() => {
        window.editorTest.settings.playStartPosition = 'cursor'
    })
    await tap(page, 0, 4)
    const cursor = await shownAt(page, { kind: 'cursor', beat: 4 }, 2)
    await expect.poll(() => markerState(page)).toEqual(cursor)
    await command(page, 'play')
    await expect
        .poll(() => markerState(page))
        .toMatchObject({ marker: { kind: 'cursor', beat: 4 }, shown: false })
    // Stop takes the cursor back to its beat.
    await command(page, 'stop')
    await expect.poll(() => markerState(page)).toEqual(cursor)

    await tap(page, -3, 2)
    const note = await shownAt(page, { kind: 'entity', beat: 2 }, 1)
    await expect.poll(() => markerState(page)).toEqual(note)
    await command(page, 'play')
    await expect
        .poll(() => markerState(page))
        .toMatchObject({ marker: { kind: 'entity', beat: 2 }, shown: false })
    // A pause leaves the cursor where playback reached.
    await command(page, 'play')
    await expect.poll(() => markerState(page)).toEqual(note)
})

test('a BPM change hides a cursor marker; a note marker keeps its beat', async ({ page }) => {
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
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'cursor', beat: 4 }, 2))
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

test('Elevation pane gestures and its beat steps leave a cursor marker', async ({ page }) => {
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'allow'
    })
    await tap(page, 0, 2)
    const marked = await shownAt(page, { kind: 'cursor', beat: 2 }, 1)
    await expect.poll(() => markerState(page)).toEqual(marked)
    await page.keyboard.press('t')
    const pane = page.locator('.elevation-canvas')
    await expect(pane).toBeVisible()
    await useTool(page, 'select')
    // The pane shows the notes at the cursor's beat.
    const row = await page.evaluate(async () => {
        const { elevationLayout } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const [row] = elevationLayout.value.rows
        return row && { x: row.x, y: row.y }
    })
    expect(row).toBeTruthy()
    const box = (await pane.boundingBox())!
    await tapAt(box.x + row!.x, box.y + row!.y)
    await expect.poll(() => selectedCount(page)).toBe(1)
    await expect.poll(() => markerState(page)).toEqual(marked)

    // With the pane still active, its Next Beat moves the main cursor but sets no marker.
    const next = (await page.getByRole('button', { name: 'Next Beat' }).boundingBox())!
    await tapAt(next.x + next.width / 2, next.y + next.height / 2)
    await expect.poll(() => cursorTime(page)).toBeGreaterThan(1)
    await expect
        .poll(() => markerState(page))
        .toMatchObject({ marker: { kind: 'cursor', beat: 2 }, shown: false })
})

test('a tap in the Elevation pane keeps a note marker', async ({ page }) => {
    await tap(page, -3, 2)
    const marked = await shownAt(page, { kind: 'entity', beat: 2 }, 1)
    await expect.poll(() => markerState(page)).toEqual(marked)
    await page.keyboard.press('t')
    const pane = page.locator('.elevation-canvas')
    await expect(pane).toBeVisible()
    await useTool(page, 'select')
    // The other note's row.
    const row = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const selected: unknown[] = history.state.value.selectedEntities
        const row = elevationLayout.value.rows.find(({ note }) => !selected.includes(note))
        return row && { x: row.x, y: row.y }
    })
    expect(row).toBeTruthy()
    const box = (await pane.boundingBox())!
    await tapAt(box.x + row!.x, box.y + row!.y)
    await expect
        .poll(() => page.evaluate(() => window.editorTest.snapshot().selected))
        .toEqual([{ type: 'note', beat: 2, left: 2, size: 2 }])
    await expect.poll(() => markerState(page)).toEqual(marked)
})

test('a two-finger tap clears a note marker, also after Delete empties the selection', async ({
    page,
}) => {
    await tap(page, -3, 2)
    const marked = await shownAt(page, { kind: 'entity', beat: 2 }, 1)
    await expect.poll(() => markerState(page)).toEqual(marked)
    await twoTap(page)
    await expect.poll(() => markerState(page)).toMatchObject({ marker: undefined, shown: false })

    // Delete keeps the marker on its beat.
    await tap(page, -3, 2)
    await expect.poll(() => markerState(page)).toEqual(marked)
    await page.keyboard.press('Delete')
    await expect.poll(() => notes(page)).toEqual([{ beat: 2, left: 2 }])
    expect(await markerState(page)).toEqual(marked)
    expect(await selectedCount(page)).toBe(0)
    await twoTap(page)
    await expect.poll(() => markerState(page)).toMatchObject({ marker: undefined, shown: false })
})

test('a two-finger tap deselects and keeps a cursor marker', async ({ page }) => {
    await tap(page, -3, 2)
    await expect.poll(() => selectedCount(page)).toBe(1)
    // Jump Up moves the cursor to the last object and keeps the selection.
    await command(page, 'jumpUp')
    const { marker } = await markerState(page)
    expect(marker?.kind).toBe('cursor')
    const cursor = await shownAt(page, marker!, await cursorTime(page))
    await expect.poll(() => markerState(page)).toEqual(cursor)
    expect(await selectedCount(page)).toBe(1)
    await twoTap(page)
    await expect.poll(() => selectedCount(page)).toBe(0)
    await expect.poll(() => markerState(page)).toEqual(cursor)
})

test('a context menu Paste marks the beat it pastes at', async ({ page }) => {
    await tap(page, -3, 2)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 2 }, 1))
    const target = await point(page, 0, 4)
    const pasted = await page.evaluate(async (target) => {
        const { appImport } = window.editorTest
        const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
            '/src/editor/commands/copy/index.ts',
        )
        const { pasteAtContextPosition } = await appImport<
            typeof import('../../src/editor/contextMenuPaste')
        >('/src/editor/contextMenuPaste.ts')
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        Object.defineProperty(navigator.clipboard, 'readText', {
            configurable: true,
            value: async () => {
                throw new DOMException('Clipboard denied', 'NotAllowedError')
            },
        })
        copy.execute()
        return await pasteAtContextPosition(target.x, target.y)
    }, target)
    expect(pasted).toBe(true)
    expect((await notes(page)).map(({ beat }) => beat)).toContain(4)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: 4 }, 2))
})

test('a tap on an off-screen badge marks the note nearest it', async ({ page }) => {
    // Two notes off the right side, held in the top badge: one by the top edge, one by the badge.
    const [upper, lower] = await page.evaluate(async () => {
        const { view, settings, show, fixtures, nextTick } = window.editorTest
        // Whole milliseconds, so the marker's time reads back exactly.
        const beatAt = (y: number) =>
            (2 * Math.round((view.time + (0.5 * view.h - y) / settings.pps) * 1000)) / 1000
        const beats = [beatAt(6), beatAt(40)] as const
        const template = fixtures.interaction.slides.flat()[0]!
        show(
            {
                ...fixtures.interaction,
                slides: beats.map((beat) => [
                    { ...template, beat, left: 40, size: 2, isAttached: false },
                ]),
            },
            view.time,
        )
        await nextTick()
        return beats
    })
    const badge = page
        .locator('.editor-chart')
        .locator('..')
        .locator('.offscreen-note-indicator[data-side="right"]')
    await expect(badge).toHaveAttribute('data-count', '2')
    const bounds = (await badge.boundingBox())!
    await tapAt(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await expect.poll(() => selectedCount(page)).toBe(2)
    // The upper note comes first in painter order.
    expect(upper).toBeGreaterThan(lower)
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'entity', beat: lower }, lower / 2))
})

test('under a scaling preview that retimes, a cursor marker labels the beat the grid shows', async ({
    page,
}, testInfo) => {
    // Beat 4 is 1.5 seconds in; scaled by 2 from beat 1, the 240 BPM runs to beat 5, which is then at 1.5 seconds.
    await page.evaluate(async () => {
        const { fixtures, show, history, view, appImport, nextTick } = window.editorTest
        show(
            {
                ...fixtures.interaction,
                bpms: [
                    { beat: 0, bpm: 120 },
                    { beat: 1, bpm: 240 },
                    { beat: 3, bpm: 120 },
                ],
                slides: [],
            },
            1.5,
        )
        const { focusViewAtBeat } =
            await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        view.input = 'touch'
        focusViewAtBeat(4)
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.grid.bpm.values()]
                .flatMap((set) => [...set])
                .filter(({ beat }) => beat > 0),
        })
        await nextTick()
    })
    await expect
        .poll(() => markerState(page))
        .toEqual(await shownAt(page, { kind: 'cursor', beat: 4 }, 1.5))

    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { scaleBeat } = await appImport<
            typeof import('../../src/editor/commands/scaleSelection')
        >('/src/editor/commands/scaleSelection/index.ts')
        void scaleBeat.execute()
    })
    await expect(page.locator('.scaling-panel')).toBeVisible()
    await page.evaluate(async () => {
        const { setScalingFactor } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        setScalingFactor(2)
    })
    await expect
        .poll(() => markerState(page))
        .toEqual({
            ...(await shownAt(page, { kind: 'cursor', beat: 4 }, 1.5)),
            beat: await beatLabel(page, 5),
        })
    expect(await beatLabel(page, 5)).not.toBe(await beatLabel(page, 4))
    await page.screenshot({ path: testInfo.outputPath('scaling-preview-marker.png') })
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
