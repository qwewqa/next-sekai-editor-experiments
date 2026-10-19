import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The Elevation Editor says what its taps and drags do, with the chart's notices and history labels.

type Scene = typeof import('../../src/editor/elevation/scene')
type Notification = typeof import('../../src/editor/notification')
const scenePath = '/src/editor/elevation/scene.ts'
const notificationPath = '/src/editor/notification.ts'

const errors = new WeakMap<Page, string[]>()
const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
const at = async (page: Page, lane: number, elevation: number) => {
    const local = await page.evaluate(
        async ({ scenePath, lane, elevation }) => {
            const { xAt, yAt } = (await window.editorTest.appImport<Scene>(scenePath))
                .elevationLayout.value
            return { x: xAt(lane), y: yAt(elevation) }
        },
        { scenePath, lane, elevation },
    )
    const box = (await page.locator('.elevation-canvas').boundingBox())!
    return { x: box.x + local.x, y: box.y + local.y }
}
// The notice shown now, if any.
const notice = (page: Page) =>
    page.evaluate(
        async (path) =>
            (await window.editorTest.appImport<Notification>(path)).notification.value.message?.(),
        notificationPath,
    )
const noticeId = (page: Page) =>
    page.evaluate(
        async (path) =>
            (await window.editorTest.appImport<Notification>(path)).notification.value.id,
        notificationPath,
    )
const click = async (page: Page, lane: number, elevation: number, modifiers: string[] = []) => {
    const { x, y } = await at(page, lane, elevation)
    for (const key of modifiers) await page.keyboard.down(key)
    await page.mouse.click(x, y)
    for (const key of modifiers) await page.keyboard.up(key)
    await settle(page)
}
// Presses at one lane and elevation, and moves to another.
const press = async (page: Page, from: [number, number], to: [number, number]) => {
    const start = await at(page, ...from)
    const end = await at(page, ...to)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 6 })
    await settle(page)
}
const selectBoth = (page: Page) =>
    page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()]
                .flat()
                .filter((note) => note.beat === 6),
        })
    })

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        // Lanes -3 and 3 at beat 6.
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 6, left: -4, size: 2, elevation: 1 }],
                    [{ ...base, beat: 6, left: 2, size: 2, elevation: 3 }],
                    [{ ...base, beat: 8, left: 0, size: 2, elevation: 2 }],
                ],
            },
            3,
        )
        view.cursorTime = 3
        settings.elevationEditorSideBySide = 'disallow'
        Object.assign(settings, { elevationSnap: 2 })
    })
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await settle(page)
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test('taps say what they select and deselect', async ({ page }) => {
    await click(page, -3, 1)
    expect(await notice(page)).toBe('Selected 1 object')
    await click(page, 3, 3, ['Control'])
    expect(await notice(page)).toBe('Selected 2 objects')
    await click(page, 3, 3, ['Control'])
    expect(await notice(page)).toBe('Selected 1 object')
    await click(page, 6, 6)
    expect(await notice(page)).toBe('Deselected all objects')
    // With nothing selected, an empty tap says nothing.
    const id = await noticeId(page)
    await click(page, 6, 6)
    expect(await noticeId(page)).toBe(id)

    // The Note tool says it in its own words.
    await page.keyboard.press('a')
    await click(page, -3, 1)
    expect(await notice(page)).toBe('Selected 1 note')
})

test("the context menu's selection says it as Select does, whatever the tool", async ({ page }) => {
    await page.evaluate(() => (window.editorTest.settings.mouseSecondaryTool = 'selectContextMenu'))
    await page.keyboard.press('a')
    const { x, y } = await at(page, -3, 1)
    await page.mouse.click(x, y, { button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    expect(await notice(page)).toBe('Selected 1 object')
})

test('an empty tap with the Eraser deselects in its own words', async ({ page }) => {
    // The locales word Select's and the Eraser's alike, so the Eraser's is marked here.
    const { eraser, select } = await page.evaluate(async () => {
        const { i18n } =
            await window.editorTest.appImport<typeof import('../../src/i18n')>('/src/i18n/index.ts')
        i18n.value.tools.eraser.deselected = 'Eraser deselected all objects'
        return {
            eraser: i18n.value.tools.eraser.deselected,
            select: i18n.value.tools.select.deselected,
        }
    })
    expect(eraser).not.toBe(select)
    await page.keyboard.press('g')
    await selectBoth(page)
    await click(page, 6, 6)
    expect(await notice(page)).toBe(eraser)
})

test('a box selection says how many it selects as it changes, and on the drop', async ({
    page,
}) => {
    await press(page, [-6, 5], [-2, 0])
    expect(await notice(page)).toBe('Selecting 1 object')
    const id = await noticeId(page)
    // The same count says nothing again.
    const same = await at(page, -1, 0)
    await page.mouse.move(same.x, same.y, { steps: 2 })
    await settle(page)
    expect(await noticeId(page)).toBe(id)
    const end = await at(page, 5, 0)
    await page.mouse.move(end.x, end.y, { steps: 4 })
    await settle(page)
    expect(await notice(page)).toBe('Selecting 2 objects')
    await page.mouse.up()
    await settle(page)
    expect(await notice(page)).toBe('Selected 2 objects')
})

test('a move says it is moving, and Escape or a drop where it started clears that', async ({
    page,
}) => {
    await selectBoth(page)
    await press(page, [3, 3], [3, 5])
    expect(await notice(page)).toBe('Moving 2 objects')
    await page.keyboard.press('Escape')
    await settle(page)
    expect(await notice(page)).toBeUndefined()

    await press(page, [3, 3], [3, 5])
    expect(await notice(page)).toBe('Moving 2 objects')
    const back = await at(page, 3, 3)
    await page.mouse.move(back.x, back.y, { steps: 4 })
    await page.mouse.up()
    await settle(page)
    expect(await notice(page)).toBeUndefined()
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
})

test('the Note tool says it is moving, editing or adding one note', async ({ page }) => {
    await page.keyboard.press('a')
    await press(page, [3, 3], [3, 5])
    expect(await notice(page)).toBe('Moving 1 note')
    await page.keyboard.press('Escape')
    await press(page, [3.85, 3], [5.85, 3])
    expect(await notice(page)).toBe('Editing 1 note')
    await page.keyboard.press('Escape')
    await press(page, [-6, 6], [-5, 6])
    expect(await notice(page)).toBe('Adding 1 note')
    await page.mouse.up()
})

for (const [kind, prepare, from, to, label] of [
    ['a lane move', selectBoth, [3, 3], [5, 3], 'Moved 2 notes'],
    ['a resize', undefined, [3.85, 3], [5.85, 3], 'Edited 1 note'],
    ['an elevation change', selectBoth, [3, 3], [3, 5], 'Changed elevation of 2 notes'],
] as const)
    test(`${kind} is named for what it changed, in its notice and its undo step`, async ({
        page,
    }) => {
        await prepare?.(page)
        await press(page, [...from], [...to])
        await page.mouse.up()
        await settle(page)
        expect(await notice(page)).toBe(label)
        const outcome = await page.evaluate(() => {
            const { history } = window.editorTest
            return {
                operation: history.headStep.value?.operation,
                notes: [...history.state.value.store.slides.note.values()].flat()
                    .filter(({ beat }) => beat === 6)
                    .map(({ left, size, elevation }) => ({ left, size, elevation })),
            }
        })
        const targets = kind === 'a resize' ? 1 : 2
        expect(outcome.operation).toMatchObject({
            id: kind === 'an elevation change' ? 'nse.note.elevation' : kind === 'a resize' ? 'nse.object.edit' : 'nse.object.move',
            data: kind === 'an elevation change' ? { targets } : { subject: 'note', targets },
        })
        expect(outcome.notes).toEqual(kind === 'an elevation change'
            ? [{ left: -4, size: 2, elevation: 3 }, { left: 2, size: 2, elevation: 5 }]
            : kind === 'a resize'
              ? [{ left: -4, size: 2, elevation: 1 }, { left: 2, size: 4, elevation: 3 }]
              : [{ left: -2, size: 2, elevation: 1 }, { left: 4, size: 2, elevation: 3 }])
        await page.keyboard.press('Control+z')
        expect(await notice(page)).toBe(`Undid "${label}"`)
    })

test('the Note tool names its moves and elevation changes as the chart does', async ({ page }) => {
    await page.keyboard.press('a')
    await press(page, [3, 3], [5, 3])
    await page.mouse.up()
    await settle(page)
    expect(await notice(page)).toBe('Moved 1 note')
    await press(page, [-3, 1], [-3, 2])
    await page.mouse.up()
    await settle(page)
    expect(await notice(page)).toBe('Changed elevation of 1 note')
})

test('a card in the full-screen Elevation Editor sits above its toolbar, and a tap keeps it', async ({
    page,
}) => {
    await page.evaluate(async (path) => {
        const { notify } = await window.editorTest.appImport<Notification>(path)
        notify(() => 'Nothing to undo', {
            action: { label: () => 'Open History', run: () => undefined },
        })
    }, notificationPath)
    const card = page.locator('.elevation-editor [data-notice-card]')
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: 'Close' })).toBeVisible()
    const toolbar = (await page
        .locator('.elevation-editor [data-editor-toolbar] > div')
        .boundingBox())!
    await expect
        .poll(async () => {
            const box = await card.boundingBox()
            return box ? box.y + box.height : Infinity
        })
        .toBeLessThanOrEqual(toolbar.y)
    // Selecting says it as quick feedback and leaves the card.
    await click(page, -3, 1)
    expect(await notice(page)).toBe('Selected 1 object')
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Close' }).click()
    await expect(card).toHaveCount(0)
})
