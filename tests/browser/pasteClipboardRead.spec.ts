import { expect, test, type Page } from '@playwright/test'
import {
    installCanvasCounters,
    installEditorFixture,
    touchInput,
    useTool,
    type TouchInput,
} from './editorFixture'

// The Paste tool reads the system clipboard on a press too, as a hover does for the mouse.

test.use({ hasTouch: true })

let touch: TouchInput

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    touch = await touchInput(page)
})

type Clip = {
    text: string
    reads: number
    copies: string[]
    // Reads wait for release() while set.
    hold: boolean
    release?: () => void
}

/**
 * Two notes at beat 2, sizes 2 and 4, each copied in turn through a stubbed
 * clipboard; the clipboard ends holding the size 4 copy, and the size 2 copy
 * stands for one made in another app.
 */
const setup = async (page: Page) => {
    await page.evaluate(async () => {
        const { fixtures, show, nextTick } = window.editorTest
        const template = fixtures.interaction.slides.flat()[0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...template, beat: 2, left: -5, size: 2, isAttached: false }],
                    [{ ...template, beat: 2, left: 2, size: 4, isAttached: false }],
                ],
            },
            1.1,
        )
        await nextTick()
        const clip: Clip = { text: '', reads: 0, copies: [], hold: false }
        Object.assign(window, { clip })
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async (value: string) => {
                clip.text = value
                clip.copies.push(value)
            },
        })
        Object.defineProperty(navigator.clipboard, 'readText', {
            configurable: true,
            value: async () => {
                clip.reads++
                if (clip.hold)
                    return await new Promise<string>((resolve) => {
                        clip.release = () => resolve(clip.text)
                    })
                const { text } = clip
                await new Promise((resolve) => setTimeout(resolve))
                return text
            },
        })
    })
    for (const size of [2, 4]) {
        await page.evaluate((size) => {
            const { history } = window.editorTest
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...history.state.value.store.slides.note.values()]
                    .flat()
                    .filter((note) => note.size === size),
            })
        }, size)
        await page.keyboard.press('c')
    }
    await expect
        .poll(() => page.evaluate(() => (window as never as { clip: Clip }).clip.copies.length))
        .toBe(2)
}

/** The other app's copy: the size 2 note. */
const copyElsewhere = (page: Page) =>
    page.evaluate(() => {
        const { clip } = window as never as { clip: Clip }
        clip.text = clip.copies[0]!
    })

const reads = (page: Page) => page.evaluate(() => (window as never as { clip: Clip }).clip.reads)

/** Switches to Paste, waits for its read, and leaves the copies in place. */
const pasteTool = async (page: Page) => {
    await page.keyboard.press('v')
    await expect.poll(() => reads(page)).toBeGreaterThan(0)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
}

/** Holds reads until release(). */
const hold = (page: Page) =>
    page.evaluate(() => {
        ;(window as never as { clip: Clip }).clip.hold = true
    })

const release = (page: Page) =>
    page.evaluate(() => (window as never as { clip: Clip }).clip.release!())

const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(([lane, beat]) => window.editorTest.point(lane, beat), [lane, beat] as const)

/** Sizes of the notes off beat 2, the pasted ones. */
const pasted = (page: Page) =>
    page.evaluate(() =>
        window.editorTest
            .snapshot()
            .notes.filter(({ beat }) => beat !== 2)
            .map(({ size }) => size),
    )

test('a touch tap reads the clipboard once and pastes what it holds now', async ({ page }) => {
    await setup(page)
    await pasteTool(page)
    await copyElsewhere(page)
    const before = await reads(page)
    const { x, y } = await point(page, 0, 6)
    await touch('touchStart', [[x, y]])
    await touch('touchEnd', [])
    await expect.poll(() => pasted(page)).toEqual([2])
    expect(await reads(page)).toBe(before + 1)
})

test('a touch tap waits for a slow read', async ({ page }) => {
    await setup(page)
    await pasteTool(page)
    await copyElsewhere(page)
    await hold(page)
    const before = await reads(page)
    const { x, y } = await point(page, 0, 6)
    await touch('touchStart', [[x, y]])
    await touch('touchEnd', [])
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(await pasted(page)).toEqual([])
    await release(page)
    await expect.poll(() => pasted(page)).toEqual([2])
    expect(await reads(page)).toBe(before + 1)
})

test('a touch tap waits at most 15 s for a read, then pastes what was last read', async ({
    page,
}) => {
    await setup(page)
    await pasteTool(page)
    await copyElsewhere(page)
    await page.evaluate(() => {
        ;(window as never as { clip: Clip }).clip.hold = true
    })
    await page.clock.install()
    const tap = async (beat: number) => {
        const { x, y } = await point(page, 0, beat)
        await touch('touchStart', [[x, y]])
        await touch('touchEnd', [])
    }
    await tap(6)
    await page.clock.fastForward(14000)
    expect(await pasted(page)).toEqual([])
    await page.clock.runFor(1100)
    await expect.poll(() => pasted(page)).toEqual([4])
    // The late read is what the next paste takes, even while its own read hangs.
    await page.evaluate(() => (window as never as { clip: Clip }).clip.release!())
    await tap(8)
    await page.clock.fastForward(15100)
    await expect.poll(() => pasted(page)).toEqual([4, 2])
})

test('a touch drag reads the clipboard as it presses and pastes what it holds now', async ({
    page,
}) => {
    await setup(page)
    await pasteTool(page)
    await copyElsewhere(page)
    const before = await reads(page)
    const { x, y } = await point(page, 0, 6)
    await touch('touchStart', [[x, y]])
    for (let step = 1; step <= 4; step++) await touch('touchMove', [[x + step * 10, y]])
    // The ghost is the new copy.
    expect(
        await page.evaluate(() => window.editorTest.snapshot().creating.map(({ size }) => size)),
    ).toEqual([2])
    await touch('touchEnd', [])
    await expect.poll(() => pasted(page)).toEqual([2])
    expect(await reads(page)).toBe(before + 1)
})

test('a click where the mouse already hovered reuses that read', async ({ page }) => {
    await setup(page)
    await pasteTool(page)
    const { x, y } = await point(page, 0, 6)
    await page.mouse.move(x, y)
    await expect.poll(() => reads(page)).toBeGreaterThan(1)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
    const before = await reads(page)
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(() => pasted(page)).toEqual([4])
    expect(await reads(page)).toBe(before)
})

test('choosing Paste under a resting mouse reads there, and a click pastes what it holds now', async ({
    page,
}) => {
    await setup(page)
    const { x, y } = await point(page, 0, 6)
    // The mouse rests here before Paste is chosen; choosing it hovers here, which reads.
    await page.mouse.move(x, y)
    await copyElsewhere(page)
    await pasteTool(page)
    const before = await reads(page)
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(() => pasted(page)).toEqual([2])
    expect(await reads(page)).toBe(before)
})

test('after leaving the window, a click where the mouse hovered reads again', async ({ page }) => {
    await setup(page)
    await pasteTool(page)
    const { x, y } = await point(page, 0, 6)
    await page.mouse.move(x, y)
    await expect.poll(() => reads(page)).toBeGreaterThan(1)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
    // Copying in another app takes the focus away and back.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await copyElsewhere(page)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const before = await reads(page)
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(() => pasted(page)).toEqual([2])
    expect(await reads(page)).toBe(before + 1)
})

/** Beats of the pasted notes. */
const pastedBeats = (page: Page) =>
    page.evaluate(() =>
        window.editorTest
            .snapshot()
            .notes.filter(({ beat }) => beat !== 2)
            .map(({ beat }) => beat),
    )

const settle = (page: Page) =>
    page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))

/** Clicks with Paste where its hover's read is held, so the paste waits. */
const clickWaiting = async (page: Page, beat: number, beforeWait?: () => Promise<void>) => {
    await setup(page)
    await beforeWait?.()
    await pasteTool(page)
    await hold(page)
    const before = await reads(page)
    const { x, y } = await point(page, 0, beat)
    await page.mouse.move(x, y)
    await expect.poll(() => reads(page)).toBe(before + 1)
    await page.mouse.click(x, y)
}

const waiting = (page: Page) =>
    page.evaluate(async () => {
        const { hasWaitingPaste } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools/paste')
        >('/src/editor/tools/paste/index.ts')
        return hasWaitingPaste()
    })

const pasteEffects = (page: Page) =>
    page.evaluate(async () => {
        const { history, view, snapshot, appImport } = window.editorTest
        const { loadedStates } =
            await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        const { notification } = await appImport<typeof import('../../src/editor/notification')>(
            '/src/editor/notification.ts',
        )
        return {
            notes: snapshot().notes,
            step: history.headStep.value,
            steps: loadedStates().length,
            notification: notification.value.id,
            marker: view.touchMarker,
        }
    })

for (const boundary of ['noteUndoRedo', 'peekRoundTrip', 'replacedStack'] as const)
    test(`a held read cannot revive a waiting Paste after ${boundary} returns to the same chart references`, async ({
        page,
    }) => {
        await clickWaiting(page, 6, async () => {
            if (boundary !== 'noteUndoRedo') return
            await page.evaluate(async () => {
                const { editSelectedEditableEntities } = await window.editorTest.appImport<
                    typeof import('../../src/editor/sidebars/default')
                >('/src/editor/sidebars/default/index.ts')
                editSelectedEditableEntities({ size: 5 })
            })
        })
        await expect.poll(() => waiting(page)).toBe(true)
        const sameReferences = await page.evaluate(async (boundary) => {
            const { history, appImport } = window.editorTest
            const before = history.state.value
            if (boundary === 'noteUndoRedo') {
                history.undoState()
                history.redoState()
            } else if (boundary === 'peekRoundTrip') {
                history.peek.value = { source: 'clipboard-read-test', state: before }
                history.peek.value = undefined
            } else {
                const { resetStates } =
                    await appImport<typeof import('../../src/history/stack')>(
                        '/src/history/stack.ts',
                    )
                resetStates({ isDirty: false, step: history.headStep.value!, state: before })
            }
            return history.state.value === before
        }, boundary)
        expect(sameReferences).toBe(true)
        const before = await pasteEffects(page)
        await release(page)
        await expect.poll(() => waiting(page)).toBe(false)
        expect(await pasteEffects(page)).toEqual(before)
        await expect(page.getByRole('dialog')).toHaveCount(0)
        expect(await pastedBeats(page)).toEqual([])
    })

for (const boundary of ['toolRoundTrip', 'cancelledDrag'] as const)
    test(`a held read cannot revive the old Paste tap after ${boundary}`, async ({ page }) => {
        await clickWaiting(page, 6)
        await expect.poll(() => waiting(page)).toBe(true)
        if (boundary === 'toolRoundTrip') {
            await page.evaluate(async () => {
                const { switchToolTo } = await window.editorTest.appImport<
                    typeof import('../../src/editor/tools')
                >('/src/editor/tools/index.ts')
                switchToolTo('select')
                switchToolTo('paste')
            })
        } else {
            const start = await point(page, 0, 8)
            const end = await point(page, 0, 9)
            await page.mouse.move(start.x, start.y)
            await page.mouse.down()
            await page.mouse.move(end.x, end.y, { steps: 5 })
            await expect
                .poll(() =>
                    page.evaluate(async () => {
                        const { isDragging } = await window.editorTest.appImport<
                            typeof import('../../src/editor/controls/gestures/recognizers/drag')
                        >('/src/editor/controls/gestures/recognizers/drag.ts')
                        return isDragging.value
                    }),
                )
                .toBe(1)
            await page.keyboard.press('Escape')
            await page.mouse.up()
        }
        const before = await pasteEffects(page)
        await release(page)
        await expect.poll(() => waiting(page)).toBe(false)
        expect(await pasteEffects(page)).toEqual(before)
        expect(await pastedBeats(page)).toEqual([])
    })

test('selection and metadata edits including a metadata Undo/Redo preserve the saved Paste coordinate', async ({
    page,
}) => {
    await clickWaiting(page, 6)
    await expect.poll(() => waiting(page)).toBe(true)
    const metadata = page.evaluate(async () => {
        const { properties } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/properties')
        >('/src/editor/commands/properties/index.ts')
        await properties.execute()
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('spinbutton', { name: 'Initial Life', exact: true }).fill('777')
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await metadata
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.undoState()
        history.redoState()
        const current = history.state.value
        history.replaceState({
            ...current,
            selectedEntities: [],
            levelInfo: { ...current.levelInfo, title: 'Changed during read' },
            bgm: { ...current.bgm, offset: 0.125 },
        })
    })
    const before = await pasteEffects(page)
    const time = await page.evaluate(() => window.editorTest.view.time)
    await page.mouse.move((await point(page, 0, 6)).x, (await point(page, 0, 6)).y)
    await page.mouse.wheel(0, -300)
    await expect.poll(() => page.evaluate(() => window.editorTest.view.time)).not.toBe(time)
    await release(page)
    await expect.poll(() => pastedBeats(page)).toEqual([6])
    const after = await pasteEffects(page)
    expect(after.steps).toBe(before.steps + 1)
    expect(after.step?.operation).toMatchObject({
        id: 'nse.object.paste',
        data: { placed: { note: 1 }, at: 'pointer' },
    })
    expect(
        await page.evaluate(() => {
            const { initialLife, levelInfo, bgm } = window.editorTest.history.state.value
            return { initialLife, title: levelInfo.title, offset: bgm.offset }
        }),
    ).toEqual({ initialLife: 777, title: 'Changed during read', offset: 0.125 })
})

test('the clipboard wait ends before a valid Dynamic Stages enable and Paste', async ({ page }) => {
    await clickWaiting(page, 6, async () => {
        await page.evaluate(async () => {
            const { show, fixtures, history, appImport } = window.editorTest
            const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
                '/src/editor/commands/copy/index.ts',
            )
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    slides: [[{ ...fixtures.interaction.slides[0]![0]!, beat: 2 }]],
                    cameraEvents: [{ ...fixtures.events.cameraEvents[0]!, beat: 2 }],
                },
                1.1,
            )
            const current = history.state.value
            history.replaceState({
                ...current,
                selectedEntities: [
                    ...[...current.store.slides.note.values()].flat(),
                    ...[...current.store.grid.cameraEventJoint.values()].flatMap((bucket) => [
                        ...bucket,
                    ]),
                ],
            })
            copy.execute()
            const { clipboardEntry } =
                await appImport<typeof import('../../src/clipboard')>('/src/clipboard/index.ts')
            if (clipboardEntry.value?.data?.chart.cameraEvents.length !== 1)
                throw new Error('Expected a copied native event')
            show({ ...fixtures.interaction, isDynamicStages: false, slides: [] }, 1.1)
        })
    })
    await expect.poll(() => waiting(page)).toBe(true)
    const before = await pasteEffects(page)
    await release(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect.poll(() => waiting(page)).toBe(false)
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => pastedBeats(page)).toEqual([6])
    const after = await pasteEffects(page)
    expect(after.steps).toBe(before.steps + 2)
    expect(after.step?.operation).toMatchObject({
        id: 'nse.object.paste',
        data: { placed: { note: 1, cameraEvent: 1 }, variant: 'basic', at: 'pointer' },
    })
    expect(await page.evaluate(() => window.editorTest.history.state.value.isDynamicStages)).toBe(
        true,
    )
})

test('a click that waits for a read pastes where it clicked, though the view scrolls meanwhile', async ({
    page,
}) => {
    await clickWaiting(page, 6)
    const time = () => page.evaluate(() => window.editorTest.view.time)
    const before = await time()
    await page.mouse.wheel(0, -300)
    await expect.poll(time).not.toBe(before)
    expect(await pastedBeats(page)).toEqual([])
    await release(page)
    await expect.poll(() => pastedBeats(page)).toEqual([6])
})

test('a click that waits for a read pastes nothing once another tool is chosen', async ({
    page,
}) => {
    await clickWaiting(page, 6)
    await useTool(page, 'select')
    await release(page)
    await settle(page)
    expect(await pastedBeats(page)).toEqual([])
})

test('a click that waits for a read pastes nothing during a drag, and leaves the drag alone', async ({
    page,
}) => {
    await clickWaiting(page, 6)
    const from = await point(page, 0, 8)
    const to = await point(page, 0, 9)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await release(page)
    await settle(page)
    expect(await pastedBeats(page)).toEqual([])
    await page.mouse.up()
    await expect.poll(() => pastedBeats(page)).toEqual([9])
})

test('further Paste taps while a paste waits for a read are ignored', async ({ page }) => {
    await setup(page)
    await page.evaluate(() => {
        const { settings, history } = window.editorTest
        settings.mouseSecondaryTool = 'selectContextMenu'
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    await hold(page)
    await page.clock.install()
    // With Select, the menu's Paste starts the read and waits; a Paste tap meanwhile pastes nothing.
    const menu = await point(page, 0, 6)
    await page.mouse.click(menu.x, menu.y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click()
    await useTool(page, 'paste')
    const tap = await point(page, 0, 8)
    await touch('touchStart', [[tap.x, tap.y]])
    await touch('touchEnd', [])
    await page.clock.fastForward(15100)
    await expect.poll(() => pastedBeats(page)).toEqual([6])
    await release(page)
    await page.clock.fastForward(15100)
    await settle(page)
    expect(await pastedBeats(page)).toEqual([6])
})

test("the context menu's Paste while a click waits on the same read pastes nothing", async ({
    page,
}) => {
    await clickWaiting(page, 6)
    await page.evaluate(() => {
        const { settings, history } = window.editorTest
        settings.mouseSecondaryTool = 'selectContextMenu'
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    // The menu's Paste joins the held read; both would resume when it settles.
    const menu = await point(page, 0, 8)
    await page.mouse.click(menu.x, menu.y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click()
    await settle(page)
    expect(await pastedBeats(page)).toEqual([])
    await release(page)
    await expect.poll(() => pastedBeats(page)).toEqual([6])
    await settle(page)
    expect(await pastedBeats(page)).toEqual([6])
})

const secondaryToolState = (page: Page) =>
    page.evaluate(async () => {
        const { toolName, secondarySwitchBack, toolChoiceRevision } =
            await window.editorTest.appImport<typeof import('../../src/editor/tools/state')>(
                '/src/editor/tools/state.ts',
            )
        return {
            effective: toolName.value,
            base: secondarySwitchBack.value ?? toolName.value,
            saved: secondarySwitchBack.value,
            choice: toolChoiceRevision.value,
        }
    })

const pressSecondaryWhileWaiting = async (page: Page) => {
    await clickWaiting(page, 6)
    await expect.poll(() => waiting(page)).toBe(true)
    await page.evaluate(() => {
        const { settings, history } = window.editorTest
        settings.mouseSecondaryTool = 'selectContextMenu'
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    const state = await secondaryToolState(page)
    const at = await point(page, 0, 8)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down({ button: 'right' })
    expect(await secondaryToolState(page)).toMatchObject({
        effective: 'select',
        base: 'paste',
        saved: 'paste',
        choice: state.choice,
    })
    return state
}

for (const restore of [true, false])
    test(`a ${restore ? 'restored' : 'non-restored'} secondary cancellation ${restore ? 'preserves' : 'abandons'} the waiting Paste`, async ({
        page,
    }) => {
        const initial = await pressSecondaryWhileWaiting(page)
        await page.evaluate(async (restore) => {
            const { cancelMouseControls } = await window.editorTest.appImport<
                typeof import('../../src/editor/controls/mouse')
            >('/src/editor/controls/mouse.ts')
            cancelMouseControls(restore)
            if (restore) {
                const { paste } = await window.editorTest.appImport<
                    typeof import('../../src/editor/commands/paste')
                >('/src/editor/commands/paste/index.ts')
                paste.execute()
            }
        }, restore)
        await page.mouse.up({ button: 'right' })
        expect(await secondaryToolState(page)).toMatchObject({
            effective: restore ? 'paste' : 'select',
            base: restore ? 'paste' : 'select',
            saved: undefined,
            choice: initial.choice,
        })
        const before = await pasteEffects(page)
        await release(page)
        await expect.poll(() => waiting(page)).toBe(false)
        if (restore) {
            await expect.poll(() => pastedBeats(page)).toEqual([6])
            expect((await pasteEffects(page)).steps).toBe(before.steps + 1)
        } else {
            expect(await pastedBeats(page)).toEqual([])
            expect(await pasteEffects(page)).toEqual(before)
        }
    })

test('an explicit Select command during its temporary override abandons the pending Paste', async ({
    page,
}) => {
    const initial = await pressSecondaryWhileWaiting(page)
    await page.evaluate(async () => {
        const { select } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/select')
        >('/src/editor/commands/select/index.ts')
        select.execute()
    })
    expect(await secondaryToolState(page)).toMatchObject({
        effective: 'select',
        base: 'paste',
        saved: 'paste',
        choice: initial.choice + 1,
    })
    await page.mouse.up({ button: 'right' })
    expect(await secondaryToolState(page)).toMatchObject({
        effective: 'paste',
        base: 'paste',
        saved: undefined,
        choice: initial.choice + 1,
    })
    const before = await pasteEffects(page)
    await release(page)
    await expect.poll(() => waiting(page)).toBe(false)
    expect(await pasteEffects(page)).toEqual(before)
    expect(await pastedBeats(page)).toEqual([])
})

test('an actual secondary drag still abandons the waiting Paste while its base tool is unchanged', async ({
    page,
}) => {
    const initial = await pressSecondaryWhileWaiting(page)
    const end = await point(page, 0, 9)
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { isDragging } = await window.editorTest.appImport<
                    typeof import('../../src/editor/controls/gestures/recognizers/drag')
                >('/src/editor/controls/gestures/recognizers/drag.ts')
                return isDragging.value
            }),
        )
        .toBe(1)
    expect(await secondaryToolState(page)).toMatchObject({ base: 'paste', choice: initial.choice })
    await page.mouse.up({ button: 'right' })
    expect(await secondaryToolState(page)).toMatchObject({
        effective: 'paste',
        base: 'paste',
        choice: initial.choice,
    })
    const before = await pasteEffects(page)
    await release(page)
    await expect.poll(() => waiting(page)).toBe(false)
    expect(await pasteEffects(page)).toEqual(before)
    expect(await pastedBeats(page)).toEqual([])
})

test('a click where the mouse hovered waits for that read, however long it has run', async ({
    page,
}) => {
    await setup(page)
    await pasteTool(page)
    await hold(page)
    await page.clock.install()
    const before = await reads(page)
    const { x, y } = await point(page, 0, 6)
    await page.mouse.move(x, y)
    await expect.poll(() => reads(page)).toBe(before + 1)
    await page.clock.fastForward(15100)
    await copyElsewhere(page)
    await page.mouse.click(x, y)
    await settle(page)
    expect(await pasted(page)).toEqual([])
    await release(page)
    await expect.poll(() => pasted(page)).toEqual([2])
    expect(await reads(page)).toBe(before + 1)
})

test('an Elevation Editor Paste tap waits at most 15 s for a read', async ({ page }) => {
    await setup(page)
    await page.evaluate(async () => {
        const { settings, appImport } = window.editorTest
        settings.elevationEditorSideBySide = 'disallow'
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(6)
    })
    const canvas = page.locator('.elevation-canvas')
    await expect(canvas).toBeVisible()
    await useTool(page, 'paste')
    await hold(page)
    await page.clock.install()
    const bounds = (await canvas.boundingBox())!
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.clock.fastForward(14000)
    expect(await pastedBeats(page)).toEqual([])
    await page.clock.runFor(1100)
    await expect.poll(() => pastedBeats(page)).toEqual([6])
})

test('an Elevation beat away and back cannot revive a waiting Paste tap', async ({ page }) => {
    await setup(page)
    await page.evaluate(async () => {
        const { settings, appImport } = window.editorTest
        settings.elevationEditorSideBySide = 'disallow'
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(6)
    })
    const canvas = page.locator('.elevation-canvas')
    await expect(canvas).toBeVisible()
    await useTool(page, 'paste')
    await hold(page)
    const bounds = (await canvas.boundingBox())!
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await expect.poll(() => waiting(page)).toBe(true)
    await page.evaluate(async () => {
        const { elevationBeat } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        elevationBeat.value = 8
        elevationBeat.value = 6
    })
    const before = await pasteEffects(page)
    await release(page)
    await expect.poll(() => waiting(page)).toBe(false)
    expect(await pasteEffects(page)).toEqual(before)
    expect(await pastedBeats(page)).toEqual([])
})

test("the context menu's Paste waits at most 15 s for a read", async ({ page }) => {
    await setup(page)
    await page.evaluate(() => {
        const { settings, history } = window.editorTest
        settings.mouseSecondaryTool = 'selectContextMenu'
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    await hold(page)
    await page.clock.install()
    const { x, y } = await point(page, 0, 6)
    await page.mouse.click(x, y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click()
    await page.clock.fastForward(14000)
    expect(await pastedBeats(page)).toEqual([])
    await page.clock.runFor(1100)
    await expect.poll(() => pastedBeats(page)).toEqual([6])
})

test('an Elevation Editor Paste drag while a tap waits for a read lands, and the tap pastes nothing', async ({
    page,
}) => {
    await setup(page)
    await page.evaluate(async () => {
        const { settings, appImport } = window.editorTest
        settings.elevationEditorSideBySide = 'disallow'
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(6)
    })
    const canvas = page.locator('.elevation-canvas')
    await expect(canvas).toBeVisible()
    await useTool(page, 'paste')
    await hold(page)
    const bounds = (await canvas.boundingBox())!
    const y = bounds.y + bounds.height / 2
    await page.mouse.click(bounds.x + bounds.width * 0.3, y)
    await settle(page)
    expect(await pastedBeats(page)).toEqual([])
    await page.mouse.move(bounds.x + bounds.width * 0.6, y)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width * 0.7, y, { steps: 5 })
    await page.mouse.up()
    const lefts = () =>
        page.evaluate(() =>
            window.editorTest
                .snapshot()
                .notes.filter(({ beat }) => beat !== 2)
                .map(({ left }) => left),
        )
    await expect.poll(lefts).toHaveLength(1)
    const [left] = await lefts()
    expect(left).toBeGreaterThan(0)
    await release(page)
    await settle(page)
    expect(await lefts()).toEqual([left])
})
