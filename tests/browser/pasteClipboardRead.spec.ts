import { expect, test, type CDPSession, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The Paste tool reads the system clipboard on a press too, as a hover does for the mouse.

test.use({ hasTouch: true })

let client: CDPSession

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    client = await page.context().newCDPSession(page)
})

type Clip = {
    text: string
    reads: number
    copies: string[]
    delay: number
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
        const clip: Clip = { text: '', reads: 0, copies: [], delay: 0, hold: false }
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
                await new Promise((resolve) => setTimeout(resolve, clip.delay))
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

const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) =>
    client.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    })

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
    await page.evaluate(() => {
        ;(window as never as { clip: Clip }).clip.delay = 400
    })
    const before = await reads(page)
    const { x, y } = await point(page, 0, 6)
    await touch('touchStart', [[x, y]])
    await touch('touchEnd', [])
    expect(await pasted(page)).toEqual([])
    await expect.poll(() => pasted(page)).toEqual([2])
    expect(await reads(page)).toBe(before + 1)
})

test('a touch tap waits at most 5 s for a read, then pastes what was last read', async ({
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
    await page.clock.runFor(4000)
    expect(await pasted(page)).toEqual([])
    await page.clock.runFor(1100)
    await expect.poll(() => pasted(page)).toEqual([4])
    // The late read is what the next paste takes, even while its own read hangs.
    await page.evaluate(() => (window as never as { clip: Clip }).clip.release!())
    await tap(8)
    await page.clock.runFor(5100)
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

test('a click without a hover reads the clipboard and pastes what it holds now', async ({
    page,
}) => {
    await setup(page)
    const { x, y } = await point(page, 0, 6)
    // The mouse rests here before Paste is chosen, so Paste never hovers it.
    await page.mouse.move(x, y)
    await pasteTool(page)
    await copyElsewhere(page)
    const before = await reads(page)
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(() => pasted(page)).toEqual([2])
    expect(await reads(page)).toBe(before + 1)
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
