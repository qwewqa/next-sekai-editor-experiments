import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

type DialogOptions = Parameters<
    (typeof import('../../src/editor/exportVideo/test'))['openExportVideoTest']
>[0]

const boot = async (page: Page) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    // Counts the export workers still running, to find any the dialog leaves behind.
    await page.addInitScript(() => {
        const Native = window.Worker
        const live = new Set<Worker>()
        Reflect.set(window, 'liveExportWorkers', live)
        window.Worker = class extends Native {
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options)
                if (options?.name === 'nse-export-test') live.add(this)
            }
            override terminate() {
                live.delete(this)
                super.terminate()
            }
        }
    })
    await page.goto('/')
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
}

const open = async (page: Page, options: DialogOptions = {}) => {
    await page.evaluate(async (options) => {
        const { openExportVideoTest } = await window.editorTest.appImport<
            typeof import('../../src/editor/exportVideo/test')
        >('/src/editor/exportVideo/test.ts')
        await openExportVideoTest(options)
    }, options)
    // Found by its content, so it is found in every language.
    const dialog = page.locator('dialog:has([data-export-form])')
    await expect(dialog).toBeVisible()
    return dialog
}

/** A short clip at 720p, so an export takes a moment. */
const shortClip = async (page: Page) => {
    const dialog = page.getByRole('dialog', { name: 'Export Video' })
    await dialog.getByRole('combobox', { name: 'Resolution' }).selectOption({ label: '720p' })
    const inField = dialog.getByRole('textbox', { name: 'In' })
    await inField.fill('0')
    await inField.press('Enter')
    const outField = dialog.getByRole('textbox', { name: 'Out' })
    await outField.fill('1')
    await outField.press('Enter')
    await expect(dialog.locator('[data-export-summary]')).toContainText('00:01.000')
}

const liveWorkers = (page: Page) =>
    page.evaluate(() => (Reflect.get(window, 'liveExportWorkers') as Set<Worker>).size)

const phase = (page: Page) => page.locator('[data-export-phase]').getAttribute('data-export-phase')

const exportButton = (page: Page) => page.locator('[data-export-start]')

test.beforeEach(async ({ page }) => {
    await boot(page)
})

test('the everyday path reaches Ready, downloads and closes', async ({ page }) => {
    const dialog = await open(page)
    // The frame view takes the first focus, and a frame arrives.
    await expect(dialog.locator('[data-export-frame]')).toBeFocused()
    await expect
        .poll(() =>
            dialog
                .locator('[data-export-frame] canvas')
                .evaluate((c: HTMLCanvasElement) => c.width),
        )
        .toBeGreaterThan(0)
    // Automatic makes MP4 where the runner can encode it, else WebM.
    await expect(dialog.locator('[data-export-summary]')).toContainText(/ · (MP4|WebM) · /)
    await shortClip(page)
    await expect(exportButton(page)).toHaveText('Export')
    await expect(exportButton(page)).toBeEnabled()
    await exportButton(page).click()
    // Focus moves to the one control the export offers.
    await expect(dialog.locator('[data-export-cancel]')).toBeFocused()
    await expect(dialog.locator('[data-export-slot]')).toContainText('Keep this tab open')
    await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('ready')
    await expect(dialog.locator('[data-export-ready]')).toContainText('Ready ·')
    const download = dialog.locator('[data-export-download]')
    await expect(download).toBeFocused()
    // Ready is persistent: Escape does nothing.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    const downloaded = page.waitForEvent('download')
    await download.click()
    await downloaded
    // A delivery again: each reports Ready, which must not end the attempt again.
    const again = page.waitForEvent('download')
    await download.click()
    await again
    // A delivered file closes at once.
    await dialog.locator('[data-export-close]').click()
    await expect(dialog).toHaveCount(0)
    // Every export worker ends with the dialog.
    await expect.poll(() => liveWorkers(page)).toBe(0)
    // The choices written as the export started are remembered.
    expect(await page.evaluate(() => window.editorTest.settings.exportVideoResolution)).toBe(720)
})

test('Close in Ready asks before discarding a video that was not downloaded', async ({ page }) => {
    const dialog = await open(page)
    await shortClip(page)
    await exportButton(page).click()
    await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('ready')
    await dialog.locator('[data-export-close]').click()
    const ask = page.getByRole('dialog', { name: 'Discard this video?' })
    await expect(ask).toBeVisible()
    // A choice dialog ignores presses in its first 300 ms.
    await page.waitForTimeout(350)
    await ask.getByRole('button', { name: 'Cancel' }).click()
    await expect(ask).toHaveCount(0)
    expect(await phase(page)).toBe('ready')
    await dialog.locator('[data-export-close]').click()
    await expect(ask).toBeVisible()
    await page.waitForTimeout(350)
    await ask.getByRole('button', { name: 'Discard Video' }).click()
    await expect(dialog).toHaveCount(0)
})

test('Escape mid-export cancels, and a second Escape closes', async ({ page }) => {
    const dialog = await open(page, { faults: { hold: 'drain' } })
    await shortClip(page)
    await exportButton(page).click()
    await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('exporting')
    // The dialog keys do nothing while busy.
    const out = dialog.locator('[data-clip-handle="out"]')
    const before = await out.getAttribute('aria-valuetext')
    await page.keyboard.press('o')
    await expect(out).toHaveAttribute('aria-valuetext', before!)
    await page.keyboard.press('Escape')
    await expect.poll(() => phase(page)).toBe('setup')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-export-summary]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
})

test('a finished picked file says where it went, and a change returns to the summary', async ({
    page,
}) => {
    const dialog = await open(page, { route: 'done', picker: true })
    await shortClip(page)
    await expect(exportButton(page)).toHaveText('Export…')
    await exportButton(page).click()
    await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('done')
    await expect(dialog.locator('[data-export-done]')).toContainText('Exported to')
    await expect(dialog.locator('[data-export-close]')).toBeFocused()
    await dialog.getByRole('switch', { name: 'SFX' }).click()
    await expect(dialog.locator('[data-export-summary]')).toBeVisible()
    await expect(dialog.getByRole('switch', { name: 'SFX' })).toBeFocused()
})

test('a failed export shows why, and its Close takes focus', async ({ page }) => {
    const dialog = await open(page, { faults: { failWrite: true } })
    await shortClip(page)
    await exportButton(page).click()
    await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('failed')
    await expect(dialog.locator('[data-export-slot]')).toContainText(/./)
    await expect(dialog.locator('[data-export-close]')).toBeFocused()
    await expect(exportButton(page)).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
})

test('the strip: a handle drags, its keys step, and Escape puts a drag back', async ({ page }) => {
    const dialog = await open(page)
    const handle = dialog.locator('[data-clip-handle="in"]')
    const strip = dialog.locator('[data-clip-strip]')
    await expect(handle).toHaveAttribute('aria-valuetext', '00:00.000')
    const box = (await strip.boundingBox())!
    const at = (await handle.boundingBox())!
    // The 44 px target: a press 15 px beside the 10 px face still takes the handle.
    await page.mouse.move(at.x + at.width / 2 + 15, at.y + at.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, at.y + at.height / 2, { steps: 4 })
    await page.mouse.up()
    const dragged = await handle.getAttribute('aria-valuetext')
    expect(dragged).not.toBe('00:00.000')
    // The playhead followed the handle.
    await expect(dialog.locator('[data-export-readout]')).toHaveText(dragged!)

    await handle.focus()
    await page.keyboard.press('Shift+ArrowRight')
    const stepped = await handle.getAttribute('aria-valuetext')
    expect(stepped).not.toBe(dragged)
    await page.keyboard.press('Home')
    await expect(handle).toHaveAttribute('aria-valuetext', '00:00.000')

    // Escape during a drag puts the handle back with its range kind, and the dialog stays.
    await dialog.locator('[data-export-range]').click()
    await page.getByRole('menuitemradio', { name: 'Whole Chart' }).click()
    const out = dialog.locator('[data-clip-handle="out"]')
    const outBefore = await out.getAttribute('aria-valuetext')
    const outBox = (await out.boundingBox())!
    await page.mouse.move(outBox.x + outBox.width / 2, outBox.y + outBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 3, outBox.y + outBox.height / 2, { steps: 4 })
    await expect(out).not.toHaveAttribute('aria-valuetext', outBefore!)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(out).toHaveAttribute('aria-valuetext', outBefore!)
    await expect(dialog).toBeVisible()
    // Still Whole Chart, which the next open recomputes for the chart as it is then.
    await dialog.locator('[data-export-range]').click()
    await expect(page.getByRole('menuitemradio', { name: 'Whole Chart' })).toHaveAttribute(
        'aria-checked',
        'true',
    )
})

test('the strip takes a touch drag', async ({ page }) => {
    const dialog = await open(page)
    const knob = dialog.locator('[data-clip-playhead]')
    const box = (await dialog.locator('[data-clip-strip]').boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    const y = box.y + box.height - 20
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) =>
        cdp.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
        })
    await touch('touchStart', box.x + 20)
    await touch('touchMove', box.x + box.width / 4)
    await touch('touchMove', box.x + box.width / 2)
    await touch('touchEnd', box.x + box.width / 2)
    await cdp.detach()
    const value = Number(await knob.getAttribute('aria-valuenow'))
    const end = Number(await knob.getAttribute('aria-valuemax'))
    expect(value).toBeGreaterThan(end * 0.4)
    expect(value).toBeLessThan(end * 0.6)
})

test('I, O and the arrows work after a click on a button, and Space plays', async ({ page }) => {
    // The playhead starts at the editor's cursor.
    await page.evaluate(() => (window.editorTest.view.cursorTime = 0))
    const dialog = await open(page)
    await dialog.locator('[data-export-next]').click()
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('ArrowRight')
    // One frame, one second and one frame at 30 fps.
    await expect(dialog.locator('[data-export-readout]')).toHaveText('00:01.067')
    await page.keyboard.press('i')
    await expect(dialog.locator('[data-clip-handle="in"]')).toHaveAttribute(
        'aria-valuetext',
        '00:01.067',
    )
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('o')
    await expect(dialog.locator('[data-clip-handle="out"]')).toHaveAttribute(
        'aria-valuetext',
        '00:01.100',
    )
    await expect(dialog.locator('[data-export-summary]')).toContainText('00:00.033')
    // A field keeps its keys.
    const inField = dialog.getByRole('textbox', { name: 'In' })
    await inField.focus()
    await page.keyboard.press('o')
    await expect(inField).toHaveValue(/o/)
    await page.keyboard.press('Escape')
    await expect(inField).toHaveValue('00:01.067')
    await expect(dialog).toBeVisible()
    await dialog.locator('[data-export-frame]').focus()
    await page.keyboard.press('Space')
    await expect(dialog.locator('[data-export-play]')).toHaveAttribute('aria-label', 'Pause')
    await page.keyboard.press('Space')
    await expect(dialog.locator('[data-export-play]')).toHaveAttribute('aria-label', 'Play')
})

test('a time that cannot be read is not applied', async ({ page }) => {
    const dialog = await open(page)
    const outField = dialog.getByRole('textbox', { name: 'Out' })
    const before = await outField.inputValue()
    await outField.fill('1:2:3:4')
    await outField.press('Enter')
    await expect(outField).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByRole('alert')).toBeVisible()
    await outField.press('Escape')
    await expect(outField).toHaveValue(before)
})

test('sizes this device is not qualified for are not offered', async ({ page }) => {
    const dialog = await open(page, { unqualified: true })
    await expect(
        dialog.locator('.form-field-notes', {
            hasText: 'Unavailable on this device with these settings: 720p, 1080p',
        }),
    ).toBeVisible()
    await expect(exportButton(page)).toBeDisabled()
})

test('while peeking, the line names the step as the peek bar does', async ({ page }) => {
    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { peekedSession } = await appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        history.peek.value = { source: 'test', state: history.liveState.value }
        peekedSession.value = {
            name: 'coconut',
            time: Date.UTC(2024, 9, 31, 14, 2, 5),
        } as typeof peekedSession.value
    })
    const dialog = await open(page)
    await expect(dialog.locator('[data-export-peek]')).toHaveText(
        'Viewing “coconut” · Oct 31, 2024, 2:02:05 PM',
    )
})

for (const { name, width, height, form, fit } of [
    { name: 'phone portrait', width: 390, height: 844, form: 'one', fit: 'icons' },
    { name: 'a small phone', width: 360, height: 640, form: 'short', fit: 'menu' },
    { name: 'phone landscape', width: 844, height: 390, form: 'land', fit: 'names' },
    { name: 'a narrow landscape phone', width: 740, height: 360, form: 'land', fit: 'icons' },
    { name: 'tablet portrait', width: 768, height: 1024, form: 'one', fit: 'names' },
] as const)
    test(`${name} uses its form, with the time whole and the targets 44 px`, async ({ page }) => {
        await page.setViewportSize({ width, height })
        const dialog = await open(page)
        await expect(dialog.locator('[data-export-form]')).toHaveAttribute('data-export-form', form)
        const setIn = dialog.locator('[data-export-set-in]')
        if (fit === 'names') await expect(setIn).toHaveText('Set In')
        else if (fit === 'icons') await expect(setIn).toHaveAttribute('aria-label', 'Set In')
        else {
            // Set In and Set Out are in the Range menu only.
            await expect(setIn).toHaveCount(0)
            await dialog.locator('[data-export-range]').click()
            await expect(page.getByRole('menuitem', { name: 'Set In' })).toBeVisible()
            await page.keyboard.press('Escape')
        }
        const readout = dialog.locator('[data-export-readout]')
        expect(await readout.evaluate((e) => e.scrollWidth <= e.clientWidth + 0.5)).toBe(true)
        // Nothing reaches past the dialog's sides.
        const edge = (await dialog.boundingBox())!
        for (const part of await dialog.locator('[data-export-transport] button').all()) {
            const box = await part.boundingBox()
            if (!box) continue
            expect(box.x).toBeGreaterThanOrEqual(edge.x)
            expect(box.x + box.width).toBeLessThanOrEqual(edge.x + edge.width + 0.5)
        }
        if (form === 'land') await expect(dialog.locator('[data-clip-chip="In"]')).toBeVisible()
        if (form === 'short') {
            // The body scrolls as one column, and the frame view keeps at least 120 px.
            const frame = (await dialog.locator('[data-export-frame]').boundingBox())!
            expect(frame.height).toBeGreaterThanOrEqual(119)
        }
    })

test('the landscape chip opens a field that applies on a press outside', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    const dialog = await open(page)
    await dialog.locator('[data-clip-chip="In"]').click()
    const field = dialog.getByRole('group', { name: 'In' }).getByRole('textbox')
    await expect(field).toBeFocused()
    await field.fill('2')
    await dialog.locator('[data-export-transport]').click({ position: { x: 200, y: 5 } })
    await expect(dialog.locator('[data-clip-chip="In"]')).toContainText('00:02.000')
})

test('an export waits for the sound effects, which it takes as it starts', async ({ page }) => {
    // The page again, with its sound effects still loading when the dialog opens.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route('**/resource/effect.scp*', async (route) => {
        await held
        await route.continue()
    })
    await boot(page)
    const dialog = await open(page)
    await shortClip(page)
    await expect(dialog.locator('[data-export-summary]')).toBeVisible()
    await expect(exportButton(page)).toBeDisabled()
    // With SFX off, nothing waits.
    await dialog.getByRole('switch', { name: 'SFX' }).click()
    await expect(exportButton(page)).toBeEnabled()
    await dialog.getByRole('switch', { name: 'SFX' }).click()
    await expect(exportButton(page)).toBeDisabled()
    release()
    await expect(exportButton(page)).toBeEnabled()
    await exportButton(page).click()
    await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('ready')
})

test('the fades shown are those the export uses, together at most the clip', async ({ page }) => {
    const dialog = await open(page)
    const setTime = async (name: 'In' | 'Out', value: string) => {
        const field = dialog.getByRole('textbox', { name, exact: true })
        await field.fill(value)
        await field.press('Enter')
    }
    await setTime('In', '0')
    await setTime('Out', '5')
    await dialog.locator('[data-export-advanced]').click()
    const fadeIn = dialog.getByRole('spinbutton', { name: 'Fade In (s)' })
    const fadeOut = dialog.getByRole('spinbutton', { name: 'Fade Out (s)' })
    await fadeIn.fill('4')
    await fadeIn.press('Enter')
    await expect(fadeOut).toHaveAttribute('max', '1')
    // A shorter clip shortens Fade Out first, then Fade In.
    await setTime('Out', '3')
    await expect(fadeIn).toHaveValue('3')
    await expect(fadeOut).toHaveValue('0')
    const used = await page.evaluate(() => {
        const settings = (
            Reflect.get(window, 'exportVideoDialog') as {
                exportSettings(): { fadeIn: number; fadeOut: number }
            }
        ).exportSettings()
        return [settings.fadeIn, settings.fadeOut]
    })
    expect(used).toEqual([3, 0])
})

test('a staged export warns first when storage would pass the cleanup line', async ({ page }) => {
    // The page again, with storage just under the line before the video.
    await page.addInitScript(() => {
        navigator.storage.estimate = () => Promise.resolve({ usage: 795_000_000, quota: 1e9 })
    })
    await boot(page)
    const dialog = await open(page)
    const slot = dialog.locator('[data-export-slot]')
    await expect(slot).toContainText('Browser storage is almost full.')
    // A short clip stays under it, and the export is allowed either way.
    await shortClip(page)
    await expect(slot).not.toContainText('Browser storage is almost full.')
    await expect(exportButton(page)).toBeEnabled()
})

for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
])
    test(`at ${size.width} px, no Japanese setting label breaks inside a phrase`, async ({
        page,
    }) => {
        await page.setViewportSize(size)
        await page.evaluate(() => {
            Object.assign(window.editorTest.settings, { locale: 'ja', exportVideoAdvanced: true })
        })
        await open(page)
        const settings = page.locator('[data-export-settings]')
        await expect(settings.locator('.form-field-text').first()).toBeVisible()
        // Each label's lines, as it wraps.
        const lines = () =>
            settings.locator('.form-field-text').evaluateAll((elements) =>
                elements.map((element) => {
                    const range = document.createRange()
                    const result: string[] = []
                    let top: number | undefined
                    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
                    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                        const text = node.textContent!
                        for (let index = 0; index < text.length; index++) {
                            range.setStart(node, index)
                            range.setEnd(node, index + 1)
                            const rect = range.getClientRects()[0]
                            if (!rect) continue
                            const character = text.charAt(index)
                            if (top === undefined || rect.top > top + 2) result.push(character)
                            else result.push(`${result.pop() ?? ''}${character}`)
                            top = rect.top
                        }
                    }
                    return result.map((line) => line.trim())
                }),
            )
        // Not "アンチエイリ / アス" or "フェードイ / ン (秒)": each phrase stays on one line.
        for (const phrase of [
            '動画ビットレート',
            'アンチエイリアス',
            'フェードイン',
            'フェードアウト',
            '音声ビットレート',
        ])
            await expect
                .poll(async () =>
                    (await lines()).some((label) => label.some((line) => line.includes(phrase))),
                )
                .toBe(true)
    })

test('Escape after a strip drag puts back the fades the shorter clip trimmed', async ({ page }) => {
    const dialog = await open(page)
    const setTime = async (name: 'In' | 'Out', value: string) => {
        const field = dialog.getByRole('textbox', { name, exact: true })
        await field.fill(value)
        await field.press('Enter')
    }
    await setTime('In', '0')
    await setTime('Out', '10')
    await dialog.locator('[data-export-advanced]').click()
    for (const name of ['Fade In (s)', 'Fade Out (s)']) {
        const field = dialog.getByRole('spinbutton', { name })
        await field.fill('3')
        await field.press('Enter')
    }
    // Out dragged to about 2 s trims the fades while the drag lasts.
    const out = dialog.locator('[data-clip-handle="out"]')
    const end = Number(await out.getAttribute('aria-valuemax'))
    const strip = (await dialog.locator('[data-clip-strip]').boundingBox())!
    const handle = (await out.boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(strip.x + (strip.width * 2) / end, handle.y + handle.height / 2, {
        steps: 4,
    })
    await expect(dialog.getByRole('spinbutton', { name: 'Fade Out (s)' })).toHaveValue('0')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(out).toHaveAttribute('aria-valuetext', '00:10.000')
    await expect(dialog.getByRole('spinbutton', { name: 'Fade In (s)' })).toHaveValue('3')
    await expect(dialog.getByRole('spinbutton', { name: 'Fade Out (s)' })).toHaveValue('3')
})

test('playback pauses when the tab is hidden, so it never plays past Out', async ({ page }) => {
    await page.evaluate(() => (window.editorTest.view.cursorTime = 0))
    const dialog = await open(page)
    const play = dialog.locator('[data-export-play]')
    await play.click()
    await expect(play).toHaveAttribute('aria-label', 'Pause')
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
        })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(play).toHaveAttribute('aria-label', 'Play')
})
