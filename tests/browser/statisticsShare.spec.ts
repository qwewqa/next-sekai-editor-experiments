import { expect, test, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Share Image: the card's size, its buttons on each kind of device, and the press flow: the
// clipboard write and the share run within the press, for the card with the link just typed.

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

/** Opens Statistics, then Share Image by a click or a tap, without waiting for the preview. */
const openShareNow = async (page: Page, press: 'click' | 'tap' = 'click') => {
    await page.evaluate(async () => {
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        const { commands } = await import('/src/editor/commands/index.ts')
        void runCommand(commands.statistics, 'button')
    })
    await page.locator('[data-statistics-share]')[press]()
    await expect(shareDialog(page)).toBeVisible()
}

/** Opens Share Image and waits for the preview. */
const openShare = async (page: Page) => {
    await openShareNow(page)
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

type Shared = { active: boolean; at: number; size: number; name: string; text?: string }

/**
 * Stubs the share sheet: `navigator.canShare` takes files, and `navigator.share` records each call
 * (whether the press's activation was still active, when, and what it carried), then settles as
 * `outcome` says after 300 ms, or once `releaseShares` is called when `held`.
 */
const stubShare = (
    page: Page,
    outcome: 'shared' | 'dismissed' | 'refused' = 'shared',
    held = false,
) =>
    page.addInitScript(
        ({ outcome, held }) => {
            const shares: Shared[] = []
            const pressed = { at: 0 }
            const settlers: (() => void)[] = []
            Object.assign(window, { shares, pressed, settlers })
            window.addEventListener('pointerdown', () => (pressed.at = performance.now()), true)
            window.addEventListener('keydown', () => (pressed.at = performance.now()), true)
            navigator.canShare = (data?: ShareData) => !!data?.files?.length
            navigator.share = (data?: ShareData) => {
                const file = data?.files?.[0]
                shares.push({
                    active: navigator.userActivation.isActive,
                    at: performance.now(),
                    size: file?.size ?? 0,
                    name: file?.name ?? '',
                    text: data?.text,
                })
                return new Promise((resolve, reject) => {
                    const settle = () => {
                        if (outcome === 'shared') resolve()
                        else
                            reject(
                                new DOMException(
                                    'stubbed',
                                    outcome === 'dismissed' ? 'AbortError' : 'NotAllowedError',
                                ),
                            )
                    }
                    if (held) settlers.push(settle)
                    else setTimeout(settle, 300)
                })
            }
        },
        { outcome, held },
    )

const releaseShares = (page: Page) =>
    page.evaluate(() => {
        for (const settle of (window as unknown as { settlers: (() => void)[] }).settlers) settle()
    })

const shares = (page: Page) =>
    page.evaluate(() => {
        const { shares, pressed } = window as unknown as {
            shares: Shared[]
            pressed: { at: number }
        }
        return { shares, pressedAt: pressed.at }
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

test('a desktop that can share files still shows Copy Image, and no Share', async ({ page }) => {
    await stubShare(page)
    await start(page)
    await openShare(page)
    await expect(primary(page)).toHaveText(en.statistics.copyImage)
    await expect(shareDialog(page).getByRole('button', { name: en.statistics.share })).toHaveCount(
        0,
    )
})

/** Makes the next `count` card encodes fail, as `toBlob` giving null does, and counts them. */
const failEncodes = (page: Page, count: number) =>
    page.addInitScript((count) => {
        let left = count
        const failed = { count: 0 }
        Object.assign(window, { failedEncodes: failed })
        const toBlob = HTMLCanvasElement.prototype.toBlob
        HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
            if (left > 0 && this.width === 1600) {
                left--
                setTimeout(() => {
                    callback(null)
                    failed.count++
                }, 0)
                return
            }
            toBlob.call(this, callback, ...rest)
        }
    }, count)

/** Waits until this many encodes have failed and their rejections have been handled. */
const failed = (page: Page, count: number) =>
    expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as unknown as { failedEncodes: { count: number } }).failedEncodes.count,
            ),
        )
        .toBe(count)

test('a card that fails to encode shows the file error on Download Image, and the next press renders again', async ({
    page,
}) => {
    // The render on opening and the one the first press starts both fail.
    await failEncodes(page, 2)
    await start(page)
    await openShareNow(page)
    // The render on opening has failed before the first press.
    await failed(page, 1)
    await expect(preview(page)).toHaveCount(0)
    await shareDialog(page).locator('[data-share-download]').click()
    await expect(shareDialog(page).locator('[data-share-failure]')).toHaveText(
        '“Brain Rot.png” could not be prepared.',
    )
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
    await openShareNow(page)
    await failed(page, 1)
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

/** Holds each card encode until `finishEncodes`, and counts the object URLs made and revoked. */
const holdEncodes = (page: Page) =>
    page.addInitScript(() => {
        const held: (() => Promise<void>)[] = []
        const urls = { created: 0, revoked: 0 }
        Object.assign(window, { heldEncodes: held, previewUrls: urls })
        const toBlob = HTMLCanvasElement.prototype.toBlob
        HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
            if (this.width !== 1600) return toBlob.call(this, callback, ...rest)
            // Finishing it resolves once the card's own callback has run.
            held.push(
                () =>
                    new Promise((resolve) => {
                        toBlob.call(
                            this,
                            (blob) => {
                                callback(blob)
                                resolve()
                            },
                            ...rest,
                        )
                    }),
            )
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

const encodes = (page: Page) =>
    page.evaluate(() => {
        const { heldEncodes, previewUrls } = window as unknown as {
            heldEncodes: (() => Promise<void>)[]
            previewUrls: { created: number; revoked: number }
        }
        return { held: heldEncodes.length, ...previewUrls }
    })

/** Finishes the held encodes, then drains the card's own handlers, which run after them. */
const finishEncodes = (page: Page) =>
    page.evaluate(async () => {
        const { heldEncodes } = window as unknown as { heldEncodes: (() => Promise<void>)[] }
        await Promise.all(heldEncodes.map((finish) => finish()))
        await new Promise((resolve) => setTimeout(resolve, 0))
    })

test('closing the dialog while the card renders leaves no preview URL behind', async ({ page }) => {
    await holdEncodes(page)
    await start(page)
    await openShareNow(page)
    await expect.poll(async () => (await encodes(page)).held).toBe(1)
    const before = await encodes(page)
    await shareDialog(page).getByRole('button', { name: en.modals.close }).click()
    await expect(shareDialog(page)).toHaveCount(0)
    // The encode finishes after the dialog has gone.
    await finishEncodes(page)
    expect((await encodes(page)).created).toBe(before.created)
})

test.describe('on a phone that shares files', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    test('Share replaces Copy Image beside Download Image, and shares the card alone within the press', async ({
        page,
    }) => {
        await stubShare(page, 'shared', true)
        await start(page)
        await openShare(page)
        await expect(primary(page)).toHaveText(en.statistics.share)
        await expect(primary(page)).toBeFocused()
        const download = await shareDialog(page).locator('[data-share-download]').boundingBox()
        const share = await primary(page).boundingBox()
        expect(download && share && Math.abs(download.y - share.y) < 1).toBe(true)
        // The press comes before the card for the new link has rendered: it waits for it.
        await shareDialog(page).locator('[data-share-link]').fill('https://example.com/x')
        await primary(page).tap()
        // A second tap while the sheet is open shares nothing more.
        await primary(page).tap()
        await expect.poll(async () => (await shares(page)).shares.length).toBe(1)
        await releaseShares(page)
        const {
            shares: [shared],
        } = await shares(page)
        expect(shared?.active).toBe(true)
        expect(shared?.size).toBeGreaterThan(0)
        expect(shared?.name).toBe('Brain Rot.png')
        // The link is on the card; the sheet gets the file alone.
        expect(shared?.text).toBeUndefined()
        await expect(shareDialog(page).locator('[data-share-failure]')).toHaveCount(0)
    })

    test('closing the dialog while a press waits for the card shares nothing', async ({ page }) => {
        await stubShare(page, 'refused')
        await holdEncodes(page)
        await start(page)
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await openShareNow(page, 'tap')
        await expect.poll(async () => (await encodes(page)).held).toBe(1)
        // The press waits for the render in flight; the dialog closes before it finishes.
        await primary(page).tap()
        await shareDialog(page).getByRole('button', { name: en.modals.close }).tap()
        await expect(shareDialog(page)).toHaveCount(0)
        await finishEncodes(page)
        expect((await shares(page)).shares).toHaveLength(0)
        expect(errors).toEqual([])
    })

    test('dismissing the share sheet says nothing', async ({ page }) => {
        await stubShare(page, 'dismissed')
        await start(page)
        await openShare(page)
        await primary(page).tap()
        await expect.poll(async () => (await shares(page)).shares.length).toBe(1)
        // The stub settles 300 ms after the call; the line would show by then.
        await expect
            .poll(() => page.evaluate(() => performance.now()))
            .toBeGreaterThan((await shares(page)).shares[0]!.at + 400)
        await expect(shareDialog(page).locator('[data-share-failure]')).toHaveCount(0)
    })

    test('a share that fails says so, and the next press shares again', async ({ page }) => {
        await stubShare(page, 'refused')
        await start(page)
        await openShare(page)
        await primary(page).tap()
        await expect(shareDialog(page).locator('[data-share-failure]')).toHaveText(
            en.statistics.notSharedImage,
        )
        await primary(page).tap()
        await expect.poll(async () => (await shares(page)).shares.length).toBe(2)
    })

    test('after a failed render, Share renders again and shares within the press', async ({
        page,
    }) => {
        await stubShare(page)
        await failEncodes(page, 1)
        await start(page)
        await openShareNow(page, 'tap')
        await failed(page, 1)
        await primary(page).tap()
        await expect.poll(async () => (await shares(page)).shares.length).toBe(1)
        const {
            shares: [shared],
        } = await shares(page)
        expect(shared?.active).toBe(true)
        expect(shared?.size).toBeGreaterThan(0)
    })
})
