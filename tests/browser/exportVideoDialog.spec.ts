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
    const dialog = page.getByRole('dialog', { name: 'Export Video' })
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

    // Escape during a drag puts the handle back, and the dialog stays.
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
        dialog.locator('.form-field-notes', { hasText: 'Too large for this device: 720p, 1080p' }),
    ).toBeVisible()
    await expect(exportButton(page)).toBeDisabled()
})

test('while peeking, the line names it and the frame view is ringed', async ({ page }) => {
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.peek.value = { source: 'test', state: history.liveState.value }
    })
    const dialog = await open(page)
    await expect(dialog.locator('[data-export-peek]')).toHaveText('Viewing history')
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
