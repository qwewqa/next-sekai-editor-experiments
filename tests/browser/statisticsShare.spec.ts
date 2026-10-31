import { expect, test, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Share Image: the card's size, its buttons on each kind of device, and the press flow: the
// clipboard write and the share run within the press, for the card with the link just typed.

type Recorded = {
    writes: { active: boolean; size?: number }[]
    shares: { active: boolean; at: number; size: number }[]
    pressedAt: number
}

const shareDialog = (page: Page) =>
    page.getByRole('dialog', { name: en.statistics.shareImageTitle, exact: true })
const preview = (page: Page) => shareDialog(page).locator('[data-share-preview]')
const primary = (page: Page) => shareDialog(page).locator('[data-share-primary]')

const start = async (page: Page, { title = 'Brain Rot' } = {}) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate((title) => {
        const { fixtures, show, history } = window.editorTest
        show(structuredClone(fixtures.notes))
        const current = history.state.value
        history.replaceState({
            ...current,
            levelInfo: { ...current.levelInfo, title, artists: ' Tokyo Manaka ', rating: 29 },
        })
    }, title)
}

const openShare = async (page: Page) => {
    await page.evaluate(async () => {
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        const { commands } = await import('/src/editor/commands/index.ts')
        void runCommand(commands.statistics, 'button')
    })
    await page.locator('[data-statistics-share]').click()
    await expect(preview(page)).toBeVisible()
}

/** Wraps the clipboard and share calls to record when they run and what they carry. */
const record = (page: Page, { share = false } = {}) =>
    page.addInitScript((share) => {
        const recorded: Recorded = { writes: [], shares: [], pressedAt: 0 }
        ;(window as unknown as { recorded: Recorded }).recorded = recorded
        const active = () => navigator.userActivation.isActive
        window.addEventListener('keydown', () => (recorded.pressedAt = performance.now()), true)
        window.addEventListener('pointerdown', () => (recorded.pressedAt = performance.now()), true)
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                write: (items: ClipboardItem[]) => {
                    const entry: Recorded['writes'][number] = { active: active() }
                    recorded.writes.push(entry)
                    return items[0]!.getType('image/png').then((blob) => {
                        entry.size = blob.size
                    })
                },
                writeText: () => Promise.resolve(),
            },
        })
        if (!share) return
        navigator.canShare = () => true
        navigator.share = (data?: ShareData) => {
            recorded.shares.push({
                active: active(),
                at: performance.now(),
                size: data?.files?.[0]?.size ?? 0,
            })
            return new Promise((resolve) => setTimeout(resolve, 300))
        }
    }, share)

const recorded = (page: Page) =>
    page.evaluate(() => (window as unknown as { recorded: Recorded }).recorded)

test('the card is 1600 x 900, its preview is the PNG, and focus starts on Copy Image', async ({
    page,
}) => {
    await start(page)
    await openShare(page)
    expect(
        await preview(page).evaluate((image) => [
            (image as HTMLImageElement).naturalWidth,
            (image as HTMLImageElement).naturalHeight,
        ]),
    ).toEqual([1600, 900])
    await expect(preview(page)).toHaveAttribute('alt', /^Brain Rot\nCombo: /)
    await expect(primary(page)).toHaveText(en.statistics.copyImage)
    await expect(primary(page)).toBeFocused()
})

test('Enter in Link copies the card with the link just typed, inside the press', async ({
    page,
}) => {
    await record(page)
    await start(page)
    await openShare(page)
    const before = await preview(page).evaluate(async (image) => {
        const response = await fetch((image as HTMLImageElement).src)
        return (await response.blob()).size
    })
    const link = shareDialog(page).locator('[data-share-link]')
    await link.fill('https://example.com/levels/a-long-level-name')
    await link.press('Enter')
    await expect.poll(async () => (await recorded(page)).writes.length).toBe(1)
    await expect.poll(async () => (await recorded(page)).writes[0]?.size).toBeGreaterThan(0)
    const [write] = (await recorded(page)).writes
    expect(write?.active).toBe(true)
    expect(write?.size).not.toBe(before)
    await expect(
        page.locator('.notification', { hasText: en.statistics.copiedImage }),
    ).toBeVisible()
    // A held Enter acts once: its repeats do nothing.
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await page.waitForTimeout(200)
    expect((await recorded(page)).writes).toHaveLength(2)
})

test('Copy Image is hidden without ClipboardItem; Download Image then fills its place', async ({
    page,
}) => {
    await page.addInitScript(() => {
        delete (window as unknown as { ClipboardItem?: unknown }).ClipboardItem
    })
    await start(page)
    await openShare(page)
    await expect(
        shareDialog(page).getByRole('button', { name: en.statistics.copyImage }),
    ).toHaveCount(0)
    await expect(primary(page)).toHaveText(en.statistics.downloadImage)
})

test('a desktop that can share files still shows Copy Image', async ({ page }) => {
    await record(page, { share: true })
    await start(page)
    await openShare(page)
    await expect(primary(page)).toHaveText(en.statistics.copyImage)
})

test('Download Image saves the card as the title and .png, or Untitled.png', async ({ page }) => {
    await start(page)
    await openShare(page)
    const download = page.waitForEvent('download')
    await shareDialog(page).locator('[data-share-download]').click()
    expect((await download).suggestedFilename()).toBe('Brain Rot.png')
})

test('an untitled level downloads as Untitled.png', async ({ page }) => {
    await start(page, { title: '  ' })
    await openShare(page)
    const download = page.waitForEvent('download')
    await shareDialog(page).locator('[data-share-download]').click()
    expect((await download).suggestedFilename()).toBe(`${en.save.placeholder}.png`)
})

test.describe('on a touch device that shares files', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    test('Share replaces Copy Image, shares within the press, and a double tap shares once', async ({
        page,
    }) => {
        await record(page, { share: true })
        await start(page)
        await openShare(page)
        await expect(primary(page)).toHaveText(en.statistics.share)
        const link = shareDialog(page).locator('[data-share-link]')
        await link.fill('https://example.com/x')
        await primary(page).tap()
        await primary(page).tap()
        await expect.poll(async () => (await recorded(page)).shares.length).toBe(1)
        await page.waitForTimeout(400)
        const result = await recorded(page)
        expect(result.shares).toHaveLength(1)
        expect(result.shares[0]?.active).toBe(true)
        expect(result.shares[0]!.at - result.pressedAt).toBeLessThan(1000)
        expect(result.shares[0]?.size).toBeGreaterThan(0)
    })
})
