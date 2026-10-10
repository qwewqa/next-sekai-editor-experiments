import { expect, test, type Page } from '@playwright/test'
import type { BpmObject } from '../../src/chart/bpm'
import type { NoteObject } from '../../src/chart/note'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const panel = (page: Page) => page.locator('#workspace-panel-properties')
const selection = (page: Page) => panel(page).locator('#properties-section-selection')
const field = (page: Page, label: string) =>
    selection(page).getByRole('spinbutton', { name: label, exact: true })

/** Shows one slide of notes from partial note objects and selects them all. */
const showNotes = (page: Page, notes: Partial<NoteObject>[]) =>
    page.evaluate(async (notes) => {
        const { fixtures, show, history, store, nextTick } = window.editorTest
        const template = fixtures.interaction.slides.flat()[0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    notes.map((note, index) => ({
                        ...template,
                        beat: index,
                        left: 0,
                        size: 2,
                        isAttached: false,
                        noteType: 'default' as const,
                        ...note,
                    })),
                ],
            },
            2,
        )
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) => entity.type === 'note',
            ),
        })
        await nextTick()
    }, notes)

/** Shows BPM changes and selects those past beat 0. */
const showBpms = (page: Page, bpms: BpmObject[]) =>
    page.evaluate(async (bpms) => {
        const { fixtures, show, history, store, nextTick } = window.editorTest
        show({ ...fixtures.interaction, bpms }, 2)
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) => entity.type === 'bpm' && entity.beat > 0,
            ),
        })
        await nextTick()
    }, bpms)

const values = (page: Page, type: string, key: string) =>
    page.evaluate(
        ([type, key]) =>
            [...window.editorTest.store.getAllEntities()]
                .filter((entity) => entity.type === type)
                .sort((a, b) => a.beat - b.beat)
                .map((entity) => (entity as unknown as Record<string, unknown>)[key!]),
        [type, key],
    )
const lanes = (page: Page) => values(page, 'note', 'left')
/** A key's values in the selection as previewed, by beat; undefined without a live preview. */
const previewed = (page: Page, key: string) =>
    page.evaluate(async (key) => {
        // The app's own instance of the module, whatever its HMR version.
        const resource = performance
            .getEntriesByType('resource')
            .find((entry) => new URL(entry.name).pathname === '/src/preview/edit.ts')
        const edit = (await import(
            resource?.name ?? '/src/preview/edit.ts'
        )) as typeof import('../../src/preview/edit')
        if (!edit.previewEdit.value) return
        return edit
            .getPreviewState(window.editorTest.history.state.value)
            .selectedEntities.slice()
            .sort((a, b) => a.beat - b.beat)
            .map((entity) => (entity as unknown as Record<string, unknown>)[key])
    }, key)
const canUndo = (page: Page) => page.evaluate(() => window.editorTest.history.canUndo.value)

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        window.editorTest.settings.showSidebar = true
    })
    await expect(panel(page)).toBeVisible()
})

test('text back at the shown value commits nothing, though the shown value is rounded', async ({
    page,
}) => {
    const exact = 0.123456789
    await showNotes(page, [{ left: exact }])
    const lane = field(page, 'Lane')
    await expect(lane).toHaveValue('0.1235')
    const unchanged = async () => {
        await expect(lane).toHaveValue('0.1235')
        expect(await lanes(page)).toEqual([exact])
        expect(await canUndo(page)).toBe(false)
    }

    // Typed and deleted.
    await lane.focus()
    await page.keyboard.press('End')
    await page.keyboard.type('9')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await unchanged()

    // Retyped as shown.
    await lane.fill('0.1235')
    await lane.press('Tab')
    await unchanged()

    // Typed, then undone natively.
    await lane.focus()
    await page.keyboard.press('End')
    await page.keyboard.type('9')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(lane).toHaveValue('0.1235')
    await lane.blur()
    await unchanged()

    // Typing on from the middle keeps the caret where it was.
    await lane.focus()
    await page.keyboard.press('Home')
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
    await page.keyboard.type('9')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('7')
    await expect(lane).toHaveValue('0.12735')
    await page.keyboard.press('Enter')
    await expect.poll(() => lanes(page)).toEqual([0.12735])
})

test('arrow steps add in decimal, and stepping back changes nothing', async ({ page }) => {
    const lane = field(page, 'Lane')
    await showNotes(page, [{ left: 1.1 }])
    await lane.focus()
    await page.keyboard.press('ArrowDown')
    await expect(lane).toHaveValue('0.1')
    await page.keyboard.press('Enter')
    await expect.poll(() => lanes(page)).toEqual([0.1])

    for (const exact of [0.3, 1 / 3, 2 / 3, 0.123456789]) {
        await showNotes(page, [{ left: exact }])
        await lane.focus()
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Tab')
        expect(await lanes(page)).toEqual([exact])
        expect(await canUndo(page)).toBe(false)
    }

    // A beat shows 1 more than it holds, and steps back to exactly it too.
    const beat = field(page, 'Beat')
    await showNotes(page, [{ beat: 10 / 3 }])
    await beat.focus()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Tab')
    expect(await values(page, 'note', 'beat')).toEqual([10 / 3])
    expect(await canUndo(page)).toBe(false)
})

test('undo after a step reverts it in the field, not another field', async ({ page }) => {
    await showNotes(page, [{ left: 3 }])
    const size = field(page, 'Size')
    await size.fill('3')
    await size.press('Enter')
    await expect.poll(() => values(page, 'note', 'size')).toEqual([3])
    const lane = field(page, 'Lane')
    await lane.focus()
    await page.keyboard.press('ArrowUp')
    await expect(lane).toHaveValue('4')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(lane).toHaveValue('3')
    await expect(lane).toBeFocused()
    await lane.blur()
    expect(await lanes(page)).toEqual([3])
    expect(await values(page, 'note', 'size')).toEqual([3])
    // Back at the committed value, undo goes to the chart again.
    await lane.focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => values(page, 'note', 'size')).toEqual([2])
})

test('arrow steps stop at a limit, and a meter stays above 0', async ({ page }) => {
    const size = field(page, 'Size')
    await showNotes(page, [{ size: 0.5 }])
    await size.focus()
    await page.keyboard.press('ArrowDown')
    await expect(size).toHaveValue('0')
    await page.keyboard.press('Enter')
    await expect.poll(() => values(page, 'note', 'size')).toEqual([0])

    const meter = field(page, 'Meter')
    await showBpms(page, [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 120, meter: 1 },
    ])
    await meter.focus()
    await page.keyboard.press('ArrowDown')
    await expect(meter).toHaveValue('1')
    await page.keyboard.press('Enter')
    expect((await values(page, 'bpm', 'meter')).slice(1)).toEqual([1])
    expect(await canUndo(page)).toBe(false)

    // Each value of a mixed field stops at the limit on its own.
    await showBpms(page, [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 120, meter: 1 },
        { beat: 8, bpm: 120, meter: 3.5 },
    ])
    await expect(meter).toHaveAttribute('placeholder', '1 … 3.5')
    await meter.focus()
    await page.keyboard.press('ArrowDown')
    await expect(meter).toHaveAttribute('placeholder', '1 … 2.5')
    await page.keyboard.press('ArrowDown')
    await expect(meter).toHaveAttribute('placeholder', '1 … 1.5')
    await page.keyboard.press('Tab')
    await expect.poll(async () => (await values(page, 'bpm', 'meter')).slice(1)).toEqual([1, 1.5])
})

test.describe('the wheel', () => {
    // The scrolling ancestor of a field, and how far it has scrolled.
    const scrolled = (page: Page, label: string) =>
        field(page, label).evaluate((element) => {
            let parent = element.parentElement
            while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY))
                parent = parent.parentElement
            return parent?.scrollTop ?? 0
        })
    const wheelOver = async (page: Page, label: string, deltaY: number) => {
        const box = (await field(page, label).boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, deltaY)
    }

    test('over a focused field steps from the exact value where it stepped natively', async ({
        page,
        browserName,
    }) => {
        const exact = 0.123456789
        await showNotes(page, [{ left: exact }])
        const lane = field(page, 'Lane')
        await lane.focus()
        await wheelOver(page, 'Lane', -100)
        if (browserName !== 'chromium') {
            // Other browsers never stepped by the wheel.
            await page.waitForTimeout(100)
            await expect(lane).toHaveValue('0.1235')
            return
        }
        await expect(lane).toHaveValue('1.123456789')
        await expect.poll(() => previewed(page, 'left')).toEqual([1.123456789])
        expect(await lanes(page)).toEqual([exact])
        // Stepping back changes nothing.
        await wheelOver(page, 'Lane', 100)
        await expect(lane).toHaveValue('0.1235')
        await wheelOver(page, 'Lane', 100)
        await page.keyboard.press('Escape')
        await expect(lane).toHaveValue('0.1235')
        await wheelOver(page, 'Lane', -100)
        await wheelOver(page, 'Lane', -100)
        await page.keyboard.press('Tab')
        await expect.poll(() => lanes(page)).toEqual([2.123456789])
        await page.keyboard.press('ControlOrMeta+z')
        await expect.poll(() => lanes(page)).toEqual([exact])
        expect(await canUndo(page)).toBe(false)

        // A mixed field steps each value on its own.
        await showNotes(page, [{ left: -4 }, { left: 0 }, { left: 2 }])
        await lane.focus()
        await wheelOver(page, 'Lane', -100)
        await expect(lane).toHaveAttribute('placeholder', '-3 … 3')
        await page.keyboard.press('Enter')
        await expect.poll(() => lanes(page)).toEqual([-3, 1, 3])
    })

    test('over a field not focused scrolls the panel and leaves the field alone', async ({
        page,
        browserName,
    }) => {
        await page.setViewportSize({ width: 1600, height: 500 })
        await showNotes(page, [{ left: 1 }, { left: 2 }])
        const lane = field(page, 'Lane')
        await expect(lane).toHaveAttribute('placeholder', '1 … 2')
        await wheelOver(page, 'Lane', 100)
        await expect.poll(() => scrolled(page, 'Lane')).toBeGreaterThan(0)
        expect(await lanes(page)).toEqual([1, 2])
        await expect(lane).toHaveValue('')

        // Focused, only Chromium keeps the wheel; other browsers scroll on.
        await field(page, 'Beat').evaluate((element) => element.scrollIntoView({ block: 'start' }))
        await lane.focus()
        const before = await scrolled(page, 'Lane')
        await wheelOver(page, 'Lane', 100)
        if (browserName === 'chromium') {
            await expect(lane).toHaveAttribute('placeholder', '0 … 1')
            expect(await scrolled(page, 'Lane')).toBe(before)
        } else {
            await expect.poll(() => scrolled(page, 'Lane')).toBeGreaterThan(before)
            await expect(lane).toHaveAttribute('placeholder', '1 … 2')
        }
    })
})

test('a small value shows its digits, not 0', async ({ page }) => {
    await showNotes(page, [{ left: 0.00001 }])
    await expect(field(page, 'Lane')).toHaveValue('0.00001')
})

test.describe('a mixed number field', () => {
    test.beforeEach(async ({ page }) => {
        await showNotes(page, [{ left: -4 }, { left: 0 }, { left: 2 }])
    })

    test('steps each value on its own, previewed until left, in one undo step', async ({
        page,
    }) => {
        const lane = field(page, 'Lane')
        await expect(lane).toHaveAttribute('placeholder', '-4 … 2')
        await lane.focus()
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('ArrowUp')
        await expect(lane).toHaveAttribute('placeholder', '-2 … 4')
        await expect(lane).toHaveValue('')
        // Previewed only.
        await expect.poll(() => previewed(page, 'left')).toEqual([-2, 2, 4])
        expect(await lanes(page)).toEqual([-4, 0, 2])
        expect(await canUndo(page)).toBe(false)

        await page.keyboard.press('Tab')
        await expect.poll(() => lanes(page)).toEqual([-2, 2, 4])
        await expect(lane).toHaveAttribute('placeholder', '-2 … 4')
        await page.keyboard.press('ControlOrMeta+z')
        await expect.poll(() => lanes(page)).toEqual([-4, 0, 2])
        expect(await canUndo(page)).toBe(false)

        // Enter commits too, and stepping back to the start writes nothing.
        await lane.focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        await expect.poll(() => lanes(page)).toEqual([-5, -1, 1])
        await page.keyboard.press('ControlOrMeta+z')
        await expect.poll(() => lanes(page)).toEqual([-4, 0, 2])
        await lane.focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('Tab')
        expect(await lanes(page)).toEqual([-4, 0, 2])
        expect(await canUndo(page)).toBe(false)
    })

    test('Escape reverts every step and keeps the selection', async ({ page }) => {
        const lane = field(page, 'Lane')
        await lane.focus()
        await page.keyboard.press('ArrowUp')
        await expect.poll(() => previewed(page, 'left')).toEqual([-3, 1, 3])
        await page.keyboard.press('Escape')
        await expect(lane).toHaveAttribute('placeholder', '-4 … 2')
        expect(await previewed(page, 'left')).toBeUndefined()
        await expect(lane).toBeFocused()
        await lane.blur()
        expect(await lanes(page)).toEqual([-4, 0, 2])
        expect(await canUndo(page)).toBe(false)
        expect(
            await page.evaluate(
                () => window.editorTest.history.state.value.selectedEntities.length,
            ),
        ).toBe(3)
    })

    test('undo during steps reverts them and leaves the chart alone; typing replaces them', async ({
        page,
    }) => {
        // Typed last in another field, which a native undo would reach.
        const size = field(page, 'Size')
        await size.fill('3')
        await size.press('Enter')
        await expect.poll(() => values(page, 'note', 'size')).toEqual([3, 3, 3])

        const lane = field(page, 'Lane')
        await lane.focus()
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('ControlOrMeta+z')
        await expect(lane).toHaveAttribute('placeholder', '-4 … 2')
        await expect(lane).toBeFocused()
        await expect(size).toHaveValue('3')
        expect(await lanes(page)).toEqual([-4, 0, 2])
        expect(await values(page, 'note', 'size')).toEqual([3, 3, 3])

        await page.keyboard.press('ArrowUp')
        await expect(lane).toHaveAttribute('placeholder', '-3 … 3')
        await page.keyboard.type('5')
        await page.keyboard.press('Enter')
        await expect.poll(() => lanes(page)).toEqual([5, 5, 5])
        await page.keyboard.press('ControlOrMeta+z')
        await expect.poll(() => lanes(page)).toEqual([-4, 0, 2])
        expect(await values(page, 'note', 'size')).toEqual([3, 3, 3])
    })
})

test('Division Size steps preview until left, like other number fields', async ({ page }) => {
    await page.evaluate(async () => {
        const { fixtures, show, history, store, nextTick } = window.editorTest
        show(fixtures.events, 2)
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) => entity.type === 'stagePivotEventJoint' && entity.beat === 3,
            ),
        })
        await nextTick()
    })
    const sizes = () => values(page, 'stagePivotEventJoint', 'divisionSize')
    const division = field(page, 'Division Size')
    await expect(division).toHaveValue('1')
    const before = await sizes()

    // At its limit, a step down does nothing.
    await division.focus()
    await page.keyboard.press('ArrowDown')
    await expect(division).toHaveValue('1')
    await page.keyboard.press('ArrowUp')
    await expect(division).toHaveValue('2')
    await expect.poll(() => previewed(page, 'divisionSize')).toEqual([2])
    expect(await canUndo(page)).toBe(false)
    await page.keyboard.press('Escape')
    await expect(division).toHaveValue('1')
    expect(await previewed(page, 'divisionSize')).toBeUndefined()
    expect(await sizes()).toEqual(before)

    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    expect(await canUndo(page)).toBe(false)
    await page.keyboard.press('Tab')
    await expect.poll(sizes).toEqual([3, ...before.slice(1)])
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(sizes).toEqual(before)
    expect(await canUndo(page)).toBe(false)
})
