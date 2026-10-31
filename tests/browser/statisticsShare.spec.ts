import { expect, test, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Share Image: the card's size, its buttons on each kind of device, and the press flow: the
// clipboard write runs within the press, for the card with the link just typed.

type Recorded = { writes: { active: boolean; size?: number }[] }

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

/** Wraps the clipboard to record when it is written and what it carries. */
const record = (page: Page) =>
    page.addInitScript(() => {
        const recorded: Recorded = { writes: [] }
        ;(window as unknown as { recorded: Recorded }).recorded = recorded
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                write: (items: ClipboardItem[]) => {
                    const entry: Recorded['writes'][number] = {
                        active: navigator.userActivation.isActive,
                    }
                    recorded.writes.push(entry)
                    return items[0]!.getType('image/png').then((blob) => {
                        entry.size = blob.size
                    })
                },
                writeText: () => Promise.resolve(),
            },
        })
    })

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
    await expect.poll(async () => (await recorded(page)).writes.length).toBe(2)
    // The repeats had their keydowns before the write that settled; nothing follows them.
    await expect.poll(async () => (await recorded(page)).writes[1]?.size).toBeGreaterThan(0)
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

test('Download Image saves the card as the title and .png, or Untitled.png', async ({ page }) => {
    await start(page)
    await openShare(page)
    const download = page.waitForEvent('download')
    await shareDialog(page).locator('[data-share-download]').click()
    expect((await download).suggestedFilename()).toBe('Brain Rot.png')
})

test('the card keeps the level as it was when the dialog opened', async ({ page }) => {
    await start(page)
    await openShare(page)
    const link = shareDialog(page).locator('[data-share-link]')
    /** The preview's PNG, once it shows the card for this link. */
    const cardFor = async (value: string) => {
        const before = await preview(page).getAttribute('src')
        await link.fill(value)
        await expect(preview(page)).not.toHaveAttribute('src', before ?? '')
        return preview(page).evaluate(async (image) => {
            const bytes = new Uint8Array(
                await (await fetch((image as HTMLImageElement).src)).arrayBuffer(),
            )
            return Array.from(bytes).join(',')
        })
    }
    const first = await cardFor('https://example.com/a')
    // Another state arrives (a peek, a step from a notice) while the dialog is open.
    await page.evaluate(() => {
        const { history } = window.editorTest
        const current = history.state.value
        history.replaceState({ ...current, levelInfo: { ...current.levelInfo, title: 'Other' } })
    })
    await cardFor('https://example.com/b')
    expect(await cardFor('https://example.com/a')).toBe(first)
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

test.describe('on a phone', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    test('Copy Image and Download Image share one row, and the Web Share API is not offered', async ({
        page,
    }) => {
        await page.addInitScript(() => {
            navigator.canShare = () => true
            navigator.share = () => Promise.resolve()
        })
        await start(page)
        await openShare(page)
        await expect(primary(page)).toHaveText(en.statistics.copyImage)
        const download = await shareDialog(page).locator('[data-share-download]').boundingBox()
        const copy = await primary(page).boundingBox()
        expect(download && copy && Math.abs(download.y - copy.y) < 1).toBe(true)
    })
})

/** Makes the next `count` card encodes fail, as `toBlob` giving null does. */
const failEncodes = (page: Page, count: number) =>
    page.addInitScript((count) => {
        let left = count
        const toBlob = HTMLCanvasElement.prototype.toBlob
        HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
            if (left > 0 && this.width === 1600) {
                left--
                setTimeout(() => callback(null), 0)
                return
            }
            toBlob.call(this, callback, ...rest)
        }
    }, count)

test('a card that fails to encode shows the file error on Download Image, and the next press renders again', async ({
    page,
}) => {
    // The render on opening and the one the first press starts both fail.
    await failEncodes(page, 2)
    await start(page)
    await page.evaluate(async () => {
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        const { commands } = await import('/src/editor/commands/index.ts')
        void runCommand(commands.statistics, 'button')
    })
    await page.locator('[data-statistics-share]').click()
    await expect(shareDialog(page)).toBeVisible()
    await expect(preview(page)).toHaveCount(0)
    await shareDialog(page).locator('[data-share-download]').click()
    await expect(
        page.locator('[data-notice-card], .notification', {
            hasText: '“Brain Rot.png” could not be prepared.',
        }),
    ).toBeVisible()
    const download = page.waitForEvent('download')
    await shareDialog(page).locator('[data-share-download]').click()
    expect((await download).suggestedFilename()).toBe('Brain Rot.png')
    await expect(preview(page)).toBeVisible()
})

test('a card that fails to encode says so on Copy Image, and the next press copies', async ({
    page,
}) => {
    await record(page)
    await failEncodes(page, 2)
    await start(page)
    await page.evaluate(async () => {
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        const { commands } = await import('/src/editor/commands/index.ts')
        void runCommand(commands.statistics, 'button')
    })
    await page.locator('[data-statistics-share]').click()
    await expect(shareDialog(page)).toBeVisible()
    await primary(page).click()
    await expect(shareDialog(page).locator('[data-share-failure]')).toHaveText(
        en.statistics.notCopiedImage,
    )
    await primary(page).click()
    await expect.poll(async () => (await recorded(page)).writes[1]?.size).toBeGreaterThan(0)
    await expect(
        page.locator('.notification', { hasText: en.statistics.copiedImage }),
    ).toBeVisible()
})

test('closing the dialog while the card renders leaves no preview URL behind', async ({ page }) => {
    await page.addInitScript(() => {
        const held: (() => void)[] = []
        const urls = { created: 0, revoked: 0 }
        Object.assign(window, { heldEncodes: held, previewUrls: urls })
        const toBlob = HTMLCanvasElement.prototype.toBlob
        HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
            if (this.width !== 1600) return toBlob.call(this, callback, ...rest)
            held.push(() => toBlob.call(this, callback, ...rest))
        }
        const create = URL.createObjectURL.bind(URL)
        const revoke = URL.revokeObjectURL.bind(URL)
        URL.createObjectURL = (object) => {
            urls.created++
            return create(object)
        }
        URL.revokeObjectURL = (url) => {
            urls.revoked++
            revoke(url)
        }
    })
    await start(page)
    await page.evaluate(async () => {
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        const { commands } = await import('/src/editor/commands/index.ts')
        void runCommand(commands.statistics, 'button')
    })
    await page.locator('[data-statistics-share]').click()
    await expect(shareDialog(page)).toBeVisible()
    const state = () =>
        page.evaluate(() => {
            const { heldEncodes, previewUrls } = window as unknown as {
                heldEncodes: (() => void)[]
                previewUrls: { created: number; revoked: number }
            }
            return { held: heldEncodes.length, ...previewUrls }
        })
    await expect.poll(async () => (await state()).held).toBe(1)
    const before = await state()
    await shareDialog(page).getByRole('button', { name: en.modals.close }).click()
    await expect(shareDialog(page)).toHaveCount(0)
    // The encode finishes after the dialog has gone.
    await page.evaluate(() => {
        for (const finish of (window as unknown as { heldEncodes: (() => void)[] }).heldEncodes)
            finish()
    })
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect((await state()).created).toBe(before.created)
})
