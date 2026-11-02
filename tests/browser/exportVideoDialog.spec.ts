import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import {
    videoExportButton as exportButton,
    holdVideoBgm,
    openVideoDialog as open,
    videoPhase as phase,
    releaseVideoBgm,
    requestVideoDialog,
    shortVideoClip as shortClip,
    videoDialog,
} from './exportVideoDialog'
import { resource } from './previewResourceFixture'

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

const liveWorkers = (page: Page) =>
    page.evaluate(() => (Reflect.get(window, 'liveExportWorkers') as Set<Worker>).size)

test.beforeEach(async ({ page }) => {
    await boot(page)
})

for (const width of [1600, 360])
    test(`Whole BGM is the default and both presets set Out at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 })
        await page.evaluate(() => window.editorTest.addWaveform())
        const dialog = await open(page)
        const out = dialog.getByRole('textbox', { name: 'Out', exact: true })
        await expect(out).toHaveValue('00:11.767')
        await dialog.locator('[data-export-range]').click()
        await expect(dialog.getByRole('menuitemradio')).toHaveText([
            'Whole BGM',
            'Whole Chart',
            'Selection',
        ])
        await expect(dialog.getByRole('menuitemradio', { name: 'Whole BGM' })).toHaveAttribute(
            'aria-checked',
            'true',
        )
        await dialog.getByRole('menuitemradio', { name: 'Whole Chart' }).click()
        await expect(out).toHaveValue('00:09.500')
        await dialog.locator('[data-export-range]').click()
        await dialog.getByRole('menuitemradio', { name: 'Whole BGM' }).click()
        await expect(out).toHaveValue('00:11.767')
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.replaceState({ ...history.state.value, bgm: { offset: 0 } })
        })
        const reopened = await open(page)
        await expect(reopened.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue(
            '00:09.500',
        )
        await reopened.locator('[data-export-range]').click()
        await expect(reopened.getByRole('menuitemradio', { name: 'Whole BGM' })).toHaveCount(0)
        await expect(reopened.getByRole('menuitemradio', { name: 'Whole Chart' })).toHaveAttribute(
            'aria-checked',
            'true',
        )
    })

for (const outcome of ['default', 'wholeChart', 'failed'] as const)
    test(`opening during BGM decoding waits for the result: ${outcome}`, async ({ page }) => {
        if (outcome === 'wholeChart') {
            const dialog = await open(page)
            await dialog.locator('[data-export-range]').click()
            await dialog.getByRole('menuitemradio', { name: 'Whole Chart' }).click()
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
        }
        await holdVideoBgm(page, outcome === 'failed')
        expect(await requestVideoDialog(page)).toBe(0)
        await releaseVideoBgm(page)
        const dialog = videoDialog(page)
        await expect(dialog).toBeVisible()
        const out = dialog.getByRole('textbox', { name: 'Out', exact: true })
        await expect(out).toHaveValue(outcome === 'default' ? '00:11.767' : '00:09.500')
        const bgm = dialog.getByRole('switch', { name: 'BGM', exact: true })
        if (outcome === 'failed') {
            await expect(bgm).toBeDisabled()
            await expect(bgm).not.toBeChecked()
        } else {
            await expect(bgm).toBeEnabled()
            await expect(bgm).toBeChecked()
        }
        await dialog.locator('[data-export-range]').click()
        await expect(dialog.getByRole('menuitemradio')).toHaveText(
            outcome === 'failed'
                ? ['Whole Chart', 'Selection']
                : ['Whole BGM', 'Whole Chart', 'Selection'],
        )
        await expect(
            dialog.getByRole('menuitemradio', {
                name: outcome === 'default' ? 'Whole BGM' : 'Whole Chart',
            }),
        ).toHaveAttribute('aria-checked', 'true')
        if (outcome !== 'failed') {
            await dialog.getByRole('menuitemradio', { name: 'Whole BGM' }).click()
            await expect(out).toHaveValue('00:11.767')
        }
    })

test('pressing Export Video twice during decoding opens one dialog', async ({ page }) => {
    await holdVideoBgm(page)
    expect(await requestVideoDialog(page, 2)).toBe(0)
    await releaseVideoBgm(page)
    const dialog = videoDialog(page)
    await expect(dialog).toHaveCount(1)
    await expect(dialog).toBeVisible()
    expect(await requestVideoDialog(page)).toBe(1)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await open(page)
})

test('switching chart during the BGM wait cancels Export Video', async ({ page }) => {
    await holdVideoBgm(page)
    expect(await requestVideoDialog(page)).toBe(0)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.interaction))
    await releaseVideoBgm(page)
    await expect(videoDialog(page)).toHaveCount(0)
    await page.evaluate(() => Reflect.get(window, 'videoOpenCalls') as Promise<unknown>)
    await open(page)
})

test('a stuck BGM decode opens Export Video after the timeout without BGM', async ({ page }) => {
    await holdVideoBgm(page)
    await requestVideoDialog(page, 1, 50)
    const dialog = videoDialog(page)
    await expect(dialog).toBeVisible()
    const bgm = dialog.getByRole('switch', { name: 'BGM', exact: true })
    await expect(bgm).toBeDisabled()
    await expect(bgm).not.toBeChecked()
    await expect(bgm).toHaveAccessibleDescription('BGM not loaded')
    await expect(dialog.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue('00:09.500')
    await dialog.locator('[data-export-range]').click()
    await expect(dialog.getByRole('menuitemradio')).toHaveText(['Whole Chart', 'Selection'])
    await releaseVideoBgm(page)
    await expect(bgm).toBeDisabled()
})

for (const change of ['replace', 'remove'] as const)
    test(`${change === 'replace' ? 'replacing' : 'removing'} the BGM ends the wait for its decode`, async ({
        page,
    }) => {
        await holdVideoBgm(page)
        expect(await requestVideoDialog(page)).toBe(0)
        await page.evaluate((change) => {
            const { history, addWaveform } = window.editorTest
            if (change === 'replace') return addWaveform()
            else history.replaceState({ ...history.state.value, bgm: { offset: 0 } })
        }, change)
        const dialog = videoDialog(page)
        await expect(dialog).toBeVisible()
        const bgm = dialog.getByRole('switch', { name: 'BGM', exact: true })
        if (change === 'replace') await expect(bgm).toBeEnabled()
        else await expect(bgm).toBeDisabled()
    })

test('replacing the BGM keeps the open clip and uses the new length on reopening', async ({
    page,
}) => {
    await page.evaluate(() => window.editorTest.addWaveform())
    const dialog = await open(page)
    const out = dialog.getByRole('textbox', { name: 'Out', exact: true })
    await expect(out).toHaveValue('00:11.767')
    await dialog.locator('[data-export-range]').click()
    await dialog.getByRole('menuitemradio', { name: 'Whole BGM' }).click()

    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            bgm: {
                offset: 0.5,
                buffer: new AudioBuffer({
                    length: 20 * 8000,
                    sampleRate: 8000,
                    numberOfChannels: 1,
                }),
            },
        })
    })
    // An open export uses the chart and BGM captured when it opened.
    await expect(out).toHaveValue('00:11.767')
    await dialog.locator('[data-export-range]').click()
    await dialog.getByRole('menuitemradio', { name: 'Whole Chart' }).click()
    await expect(out).toHaveValue('00:09.500')
    await dialog.locator('[data-export-range]').click()
    await dialog.getByRole('menuitemradio', { name: 'Whole BGM' }).click()
    await expect(out).toHaveValue('00:11.767')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    const reopened = await open(page)
    await expect(reopened.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue(
        '00:19.500',
    )
    await reopened.locator('[data-export-range]').click()
    await expect(reopened.getByRole('menuitemradio', { name: 'Whole BGM' })).toHaveAttribute(
        'aria-checked',
        'true',
    )
})

test('reopening remembers the chosen range kind and falls back after BGM removal', async ({
    page,
}) => {
    await page.evaluate(() => window.editorTest.addWaveform())
    let dialog = await open(page)
    await dialog.locator('[data-export-range]').click()
    await dialog.getByRole('menuitemradio', { name: 'Whole Chart' }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    dialog = await open(page)
    await expect(dialog.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue('00:09.500')
    await dialog.locator('[data-export-range]').click()
    await expect(dialog.getByRole('menuitemradio', { name: 'Whole Chart' })).toHaveAttribute(
        'aria-checked',
        'true',
    )
    await dialog.getByRole('menuitemradio', { name: 'Whole BGM' }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    dialog = await open(page)
    await expect(dialog.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue('00:11.767')
    await dialog.locator('[data-export-range]').click()
    await expect(dialog.getByRole('menuitemradio', { name: 'Whole BGM' })).toHaveAttribute(
        'aria-checked',
        'true',
    )
    await dialog.getByRole('menuitemradio', { name: 'Whole BGM' }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({ ...history.state.value, bgm: { offset: 0 } })
    })
    dialog = await open(page)
    await expect(dialog.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue('00:09.500')
    await dialog.locator('[data-export-range]').click()
    await expect(dialog.getByRole('menuitemradio')).toHaveText(['Whole Chart', 'Selection'])
    await expect(dialog.getByRole('menuitemradio', { name: 'Whole Chart' })).toHaveAttribute(
        'aria-checked',
        'true',
    )
})

test('closing before the first view frame does not log an abort', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
    })
    await page.evaluate(() => {
        const Native = window.Worker
        window.Worker = class extends Native {
            override postMessage(
                message: unknown,
                transfer: Transferable[] | StructuredSerializeOptions = [],
            ) {
                if ((message as { type: string }).type === 'prepare') {
                    Reflect.set(window, 'heldExportPrepare', true)
                    return
                }
                if (Array.isArray(transfer)) super.postMessage(message, transfer)
                else super.postMessage(message, transfer)
            }
        }
    })
    const dialog = await open(page)
    await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'heldExportPrepare') as boolean))
        .toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => liveWorkers(page)).toBe(0)
    expect(errors.filter((message) => message.includes('AbortError'))).toEqual([])
})

test('the everyday path reaches Ready, downloads and closes', async ({ page }) => {
    await page.evaluate(() => {
        window.editorTest.settings.exportVideoStops = {
            counts: { '2160:2': 1 },
            last: { resolution: 2160, renderScale: 2 },
        }
    })
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
    expect(
        await page.evaluate(() => window.editorTest.settings.exportVideoLastFinished?.resolution),
    ).toBe(720)
    expect(await page.evaluate(() => window.editorTest.settings.exportVideoStops)).toEqual({
        counts: {},
        last: null,
    })
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
    expect(await page.evaluate(() => window.editorTest.settings.exportVideoLastFinished)).toBeNull()
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-export-summary]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
})

test('a finished picked file says where it went, and a change returns to the summary', async ({
    page,
}) => {
    test.setTimeout(60_000)
    const dialog = await open(page, { route: 'done', picker: true })
    await shortClip(page)
    await expect(exportButton(page)).toHaveText('Export…')
    await exportButton(page).click()
    await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('done')
    expect(
        await page.evaluate(() => window.editorTest.settings.exportVideoLastFinished?.resolution),
    ).toBe(720)
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
    expect(await page.evaluate(() => window.editorTest.settings.exportVideoLastFinished)).toBeNull()
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

test('4K at 2x is offered within the GPU limits', async ({ page }) => {
    const dialog = await open(page)
    const resolution = dialog.getByRole('combobox', { name: 'Resolution' })
    await expect(resolution.locator('option', { hasText: '2160p' })).toBeEnabled()
    await resolution.selectOption({ label: '2160p' })
    await dialog.getByRole('button', { name: 'Advanced', exact: true }).click()
    const scale = dialog.getByRole('radio', { name: '2x', exact: true })
    await expect(scale).toBeEnabled()
    await scale.click()
    await expect(dialog.getByRole('switch', { name: 'Antialiasing' })).toBeChecked()
    await expect(resolution.locator('option:disabled')).toHaveCount(0)
})

for (const finished of [true, false])
    test(`a stopped export restores ${finished ? 'the last finished choices' : 'defaults'} without disabling sizes`, async ({
        page,
    }) => {
        await page.evaluate((finished) => {
            const settings = window.editorTest.settings
            settings.exportVideoResolution = 2160
            settings.exportVideoRenderScale = 2
            settings.exportVideoFrameRate = 60
            if (finished)
                settings.exportVideoLastFinished = {
                    resolution: 720,
                    renderScale: 1.5,
                    frameRate: 30,
                    quality: 'high',
                    format: 'webm',
                    antialias: false,
                    audioBitrate: 128_000,
                }
            localStorage.setItem(
                'exportVideoRunning.abandoned',
                JSON.stringify({
                    resolution: 2160,
                    renderScale: 2,
                    pixels: 7680 * 4320,
                }),
            )
        }, finished)
        for (let opening = 0; opening < 2; opening++) {
            const dialog = await open(page)
            await expect(dialog.locator('[data-export-slot]')).toHaveText(
                'The last export at 2160p with 2x Render Scale did not finish.',
            )
            const resolution = dialog.getByRole('combobox', { name: 'Resolution' })
            await expect(resolution.locator('option:checked')).toHaveText(
                finished ? '720p' : '1080p',
            )
            await expect(resolution.locator('option:disabled')).toHaveCount(0)
            if (opening === 0)
                await dialog.getByRole('button', { name: 'Advanced', exact: true }).click()
            await expect(
                dialog.getByRole('radio', { name: finished ? '1.5x' : '1x', exact: true }),
            ).toBeChecked()
            for (const name of ['1x', '1.5x', '2x'])
                await expect(dialog.getByRole('radio', { name, exact: true })).toBeEnabled()
            await expect(dialog.getByRole('switch', { name: 'Antialiasing' })).toBeChecked({
                checked: !finished,
            })
            await expect(
                dialog
                    .getByRole('combobox', { name: 'Quality', exact: true })
                    .locator('option:checked'),
            ).toHaveText(finished ? 'High' : 'Standard')
            await resolution.selectOption({ label: '2160p' })
            await dialog.getByRole('radio', { name: '2x', exact: true }).click()
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
        }
        expect(
            await page.evaluate(() => localStorage.getItem('exportVideoRunning.abandoned')),
        ).toBeNull()
        expect(await page.evaluate(() => window.editorTest.settings.exportVideoStops)).toEqual({
            counts: { '2160:2': 1 },
            last: { resolution: 2160, renderScale: 2 },
        })
    })

for (const action of ['finish', 'reset', 'stop'] as const)
    test(`the dialog reads current recovery records after ${action} in another tab`, async ({
        page,
        context,
    }) => {
        await page.evaluate(() => {
            const settings = window.editorTest.settings
            settings.exportVideoResolution = 2160
            settings.exportVideoRenderScale = 2
            settings.exportVideoLastFinished = {
                resolution: 1440,
                renderScale: 1,
                frameRate: 30,
                quality: 'standard',
                format: 'webm',
                antialias: true,
                audioBitrate: 192_000,
            }
            settings.exportVideoStops = {
                counts: { '2160:2': 1 },
                last: { resolution: 2160, renderScale: 2 },
            }
        })
        const other = await context.newPage()
        await boot(other)
        let dialog = await open(other)
        await expect(dialog.locator('[data-export-slot]')).toContainText('did not finish')
        await other.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)

        await page.evaluate(async (action) => {
            const { settings, resetSettings } =
                await window.editorTest.appImport<typeof import('../../src/settings')>(
                    '/src/settings.ts',
                )
            const { finishedVideoExport, rememberedVideoChoices } =
                await window.editorTest.appImport<
                    typeof import('../../src/editor/exportVideo/recovery')
                >('/src/editor/exportVideo/recovery.ts')
            if (action === 'reset') await resetSettings()
            else {
                settings.exportVideoResolution = 720
                settings.exportVideoRenderScale = 1
                finishedVideoExport(rememberedVideoChoices())
                if (action === 'stop') {
                    settings.exportVideoResolution = 2160
                    settings.exportVideoRenderScale = 2
                    localStorage.setItem(
                        'exportVideoRunning.abandoned',
                        JSON.stringify({ resolution: 2160, renderScale: 2, pixels: 7680 * 4320 }),
                    )
                }
            }
        }, action)

        dialog = await open(other)
        const slot = dialog.locator('[data-export-slot]')
        if (action === 'stop') await expect(slot).toContainText('did not finish')
        else await expect(slot).not.toContainText('did not finish')
        await expect(dialog.getByRole('combobox', { name: 'Resolution' })).toHaveValue(
            action === 'reset' ? '1080' : '720',
        )
        expect(await other.evaluate(() => window.editorTest.settings.exportVideoStops)).toEqual(
            action === 'stop'
                ? { counts: { '2160:2': 1 }, last: { resolution: 2160, renderScale: 2 } }
                : { counts: {}, last: null },
        )
        await other.close()
    })

for (const reset of ['defaults', 'settings'])
    test(`${reset === 'defaults' ? 'Reset to Defaults' : 'Reset Settings'} clears recovery and abandoned markers, leaving active jobs alone`, async ({
        page,
    }) => {
        await page.evaluate(async () => {
            const settings = window.editorTest.settings
            settings.exportVideoResolution = 2160
            settings.exportVideoRenderScale = 2
            settings.exportVideoLastFinished = {
                resolution: 720,
                renderScale: 1,
                frameRate: 60,
                quality: 'high',
                format: 'webm',
                antialias: false,
                audioBitrate: 128_000,
            }
            settings.exportVideoStops = {
                counts: { '2160:2': 2 },
                last: { resolution: 2160, renderScale: 2 },
            }
            await new Promise<void>((resolve) => {
                void navigator.locks.request('nse-export-video:active', async () => {
                    await new Promise<void>((release) => {
                        Reflect.set(window, 'releaseVideoLock', release)
                        resolve()
                    })
                })
            })
        })
        const dialog = await open(page)
        await page.evaluate(() => {
            for (const id of ['active', 'abandoned'])
                localStorage.setItem(
                    `exportVideoRunning.${id}`,
                    JSON.stringify({ resolution: 2160, renderScale: 2, pixels: 7680 * 4320 }),
                )
        })
        if (reset === 'defaults') {
            await dialog.getByRole('button', { name: 'Advanced', exact: true }).click()
            await dialog.getByRole('button', { name: 'Reset to Defaults', exact: true }).click()
        } else {
            await page.evaluate(async () => {
                const { resetSettings } =
                    await window.editorTest.appImport<typeof import('../../src/settings')>(
                        '/src/settings.ts',
                    )
                await resetSettings()
            })
        }
        await expect(dialog.locator('[data-export-slot]')).toBeEmpty()
        await expect
            .poll(() => page.evaluate(() => localStorage.getItem('exportVideoRunning.abandoned')))
            .toBeNull()
        expect(
            await page.evaluate(() => window.editorTest.settings.exportVideoLastFinished),
        ).toBeNull()
        expect(await page.evaluate(() => window.editorTest.settings.exportVideoStops)).toEqual({
            counts: {},
            last: null,
        })
        expect(await page.evaluate(() => window.editorTest.settings.exportVideoResolution)).toBe(
            1080,
        )
        expect(
            await page.evaluate(() => localStorage.getItem('exportVideoRunning.active')),
        ).not.toBeNull()
        await page.evaluate(() => {
            localStorage.removeItem('exportVideoRunning.active')
            ;(Reflect.get(window, 'releaseVideoLock') as () => void)()
        })
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        const reopened = await open(page)
        await expect(reopened.locator('[data-export-slot]')).toBeEmpty()
        await expect(
            reopened.getByRole('combobox', { name: 'Resolution' }).locator('option:checked'),
        ).toHaveText('1080p')
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
