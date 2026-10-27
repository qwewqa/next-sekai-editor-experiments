import { expect, test, type Page } from '@playwright/test'
import { confirmWhenReady } from './confirmWhenReady'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'
import { confirmReset } from './resetConfirm'

test.beforeEach(async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.keyboard.press(',')
    await expect(page.getByRole('dialog')).toBeVisible()
    // The deferred first-field focus has run, so it can't take a later focus.
    await expect(page.getByRole('dialog').locator('select').first()).toBeFocused()
})

test('shortcut capture preserves the old binding until replaced or cleared', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    const save = dialog
        .locator('label')
        .filter({ has: page.getByText('Save', { exact: true }) })
        .getByRole('button')
    await save.click()
    await expect(save).toHaveText('Press a key or click again to clear')
    expect(await page.evaluate(() => window.editorTest.settings.keyboardShortcuts.save)).toBe('p')
    await dialog.getByRole('button', { name: 'Reset Settings…', exact: true }).focus()
    await expect(save).toHaveText('P')
    await save.click()
    await save.press('l')
    await expect(save).toHaveText('L')
    await save.click()
    await save.click()
    await expect(save).toHaveText('Unassigned')
    // Saved as '' rather than left out, which a later start reads as a new command.
    expect(await page.evaluate(() => window.editorTest.settings.keyboardShortcuts.save)).toBe('')
    expect(
        await page.evaluate(
            () =>
                JSON.parse(
                    localStorage.getItem('sonolus-next-sekai-editor.keyboardShortcuts') ?? '{}',
                ).save,
        ),
    ).toBe('')
    await save.click()
    await save.press('Tab')
    await expect(save).toHaveText('Unassigned')
    await dialog.getByRole('button', { name: 'Reset Shortcuts…', exact: true }).click()
    await confirmReset(page, 'Reset Shortcuts')
    await expect(save).toHaveText('P')
})

test('settings and keybind resets are independent and remove saved overrides', async ({ page }) => {
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.previewNoteSpeed = 9.25
        settings.previewHighlightSelection = false
        settings.keyboardShortcuts = { ...settings.keyboardShortcuts, save: 'l' }
    })
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Reset Shortcuts…', exact: true }).click()
    await confirmReset(page, 'Reset Shortcuts')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    expect(await page.evaluate(() => window.editorTest.settings.previewNoteSpeed)).toBe(9.25)
    expect(await page.evaluate(() => window.editorTest.settings.previewHighlightSelection)).toBe(
        false,
    )
    expect(
        await page.evaluate(() =>
            localStorage.getItem('sonolus-next-sekai-editor.keyboardShortcuts'),
        ),
    ).toBeNull()
    await page.evaluate(() => {
        window.editorTest.settings.keyboardShortcuts = {
            ...window.editorTest.settings.keyboardShortcuts,
            save: 'l',
        }
    })
    await dialog.getByRole('button', { name: 'Reset Settings…', exact: true }).click()
    await confirmReset(page, 'Reset Settings')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    expect(await page.evaluate(() => window.editorTest.settings.keyboardShortcuts.save)).toBe('l')
    expect(await page.evaluate(() => window.editorTest.settings.previewHighlightSelection)).toBe(
        true,
    )
    expect(
        await page.evaluate(() =>
            localStorage.getItem('sonolus-next-sekai-editor.previewNoteSpeed'),
        ),
    ).toBeNull()
    expect(
        await page.evaluate(() =>
            localStorage.getItem('sonolus-next-sekai-editor.previewHighlightSelection'),
        ),
    ).toBeNull()
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
})

test('shortcut capture takes keys when a click does not focus the button', async ({ page }) => {
    const save = page
        .getByRole('dialog')
        .locator('label')
        .filter({ has: page.getByText('Save', { exact: true }) })
        .getByRole('button')
    // Safari and WebKit don't focus a clicked button.
    await save.dispatchEvent('click', { detail: 1 })
    await expect(save).toHaveText('Press a key or click again to clear')
    await page.keyboard.press('l')
    await expect(save).toHaveText('L')
    expect(await page.evaluate(() => window.editorTest.settings.keyboardShortcuts.save)).toBe('l')

    // Pressing it again to clear must not move focus first, which WebKit does.
    await save.click()
    const focusMayMove = await save.evaluate((button) =>
        button.dispatchEvent(new MouseEvent('mousedown', { cancelable: true })),
    )
    expect(focusMayMove).toBe(false)
})

const shortcutField = (page: Page, name: string) =>
    page
        .getByRole('dialog')
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Keyboard Shortcuts' }) })
        .locator('.form-field')
        .filter({ has: page.locator('.form-field-text').getByText(name, { exact: true }) })
const shortcutButton = (page: Page, name: string) =>
    shortcutField(page, name).locator('label').getByRole('button')
/** The refusal under a capturing row; the button keeps its prompt. */
const expectRefused = async (page: Page, name: string, message: string) => {
    await expect(shortcutButton(page, name)).toHaveText('Press a key or click again to clear')
    await expect(shortcutField(page, name).locator('.form-field-notes')).toContainText(message)
    await expect(shortcutField(page, name).getByRole('status')).toContainText(message)
}
const savedShortcut = (page: Page, name: string) =>
    page.evaluate((name) => window.editorTest.settings.keyboardShortcuts[name as 'save'], name)

test('shortcut capture waits past modifiers and records the chord they make', async ({ page }) => {
    const save = shortcutButton(page, 'Save')
    await save.click()
    await page.keyboard.press('Shift')
    await page.keyboard.press('Control')
    await expect(save).toHaveText('Press a key or click again to clear')
    await page.keyboard.press('Control+s')
    await expect(save).toHaveText('Ctrl+S')
    expect(await savedShortcut(page, 'save')).toBe('Mod+s')

    for (const [key, saved, shown] of [
        ['Meta+Shift+KeyS', 'Mod+Shift+s', 'Ctrl+Shift+S'],
        ['Alt+KeyA', 'Alt+a', 'Alt+A'],
        ['Shift+ArrowUp', 'Shift+ArrowUp', 'Shift+↑'],
        ['Control+Space', 'Mod+ ', 'Ctrl+Space'],
        // Shift alone stays part of the character, as before.
        ['Shift+KeyU', 'U', 'Shift+U'],
        ['p', 'p', 'P'],
    ] as const) {
        await save.click()
        await page.keyboard.press(key)
        await expect(save, key).toHaveText(shown)
        expect(await savedShortcut(page, 'save'), key).toBe(saved)
    }

    // AltGr types a character, so it records the plain key.
    await save.click()
    await save.dispatchEvent('keydown', { key: '[', ctrlKey: true, altKey: true })
    await expect(save).toHaveText('[')
    expect(await savedShortcut(page, 'save')).toBe('[')
})

test('shortcut capture refuses chords the browser keeps and waits for another key', async ({
    page,
}) => {
    const save = shortcutButton(page, 'Save')
    await save.click()
    await save.dispatchEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true })
    await expectRefused(
        page,
        'Save',
        'Ctrl+W is reserved by the browser or system. Press another key.',
    )
    expect(await savedShortcut(page, 'save')).toBe('p')
    // Ctrl+H reaches pages off Apple devices, so it can be bound.
    await page.keyboard.press('Control+h')
    await expect(save).toHaveText('Ctrl+H')
    expect(await savedShortcut(page, 'save')).toBe('Mod+h')
    // The refusal goes once capture ends.
    await expect(shortcutField(page, 'Save')).not.toContainText('is reserved')

    // Ctrl+Alt+letter reads as AltGr, so it would record the bare letter.
    await save.click()
    await save.dispatchEvent('keydown', { key: 'k', ctrlKey: true, altKey: true })
    await expectRefused(
        page,
        'Save',
        'Ctrl+Alt+K is used to type characters on many keyboard layouts. Press another key.',
    )
    expect(await savedShortcut(page, 'save')).toBe('Mod+h')

    // So does Ctrl+Alt+digit.
    await save.dispatchEvent('keydown', { key: '1', ctrlKey: true, altKey: true })
    await expectRefused(
        page,
        'Save',
        'Ctrl+Alt+1 is used to type characters on many keyboard layouts. Press another key.',
    )
    expect(await savedShortcut(page, 'save')).toBe('Mod+h')
})

test('shortcut capture waits past IME and dead keys and ignores Caps Lock', async ({ page }) => {
    const save = shortcutButton(page, 'Save')
    await save.click()
    for (const key of ['Process', 'Dead', 'Unidentified'])
        await save.dispatchEvent('keydown', { key, cancelable: true })
    // Chrome's first IME keydown can carry a plain key with keyCode 229.
    await save.evaluate((button) => {
        const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
        Object.defineProperty(event, 'keyCode', { get: () => 229 })
        button.dispatchEvent(event)
    })
    await expect(save).toHaveText('Press a key or click again to clear')
    expect(await savedShortcut(page, 'save')).toBe('p')

    // Caps Lock reports an uppercase letter without Shift.
    await save.dispatchEvent('keydown', { key: 'A', cancelable: true })
    await expect(save).toHaveText('A')
    expect(await savedShortcut(page, 'save')).toBe('a')
    await save.click()
    await save.dispatchEvent('keydown', { key: 'a', shiftKey: true, cancelable: true })
    await expect(save).toHaveText('Shift+A')
    expect(await savedShortcut(page, 'save')).toBe('A')
})

test('shared bindings are named under their rows', async ({ page }) => {
    await shortcutButton(page, 'Save').click()
    await page.keyboard.press('s')
    await expect(shortcutField(page, 'Save')).toContainText('Also runs Slide.')
    await expect(shortcutField(page, 'Slide')).toContainText('Also runs Save.')
    await expect(shortcutButton(page, 'Slide')).toHaveAccessibleDescription(/Also runs Save\./)

    // A binding of Ctrl+R ends the share on r.
    await shortcutButton(page, 'Save').click()
    await page.keyboard.press('Control+r')
    await expect(shortcutField(page, 'Slide')).not.toContainText('Also runs')

    // A command whose title ends in an ellipsis is named without it in the running text.
    await shortcutButton(page, 'Save').click()
    await page.keyboard.press('o')
    await expect(shortcutField(page, 'Save').locator('.form-field-notes')).toHaveText(
        'Also runs Open.',
    )
    await expect(shortcutField(page, 'Open…').locator('.form-field-notes')).toHaveText(
        'Also runs Save.',
    )
})

test.describe('on Apple devices', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
            Object.defineProperty(navigator, 'userAgentData', { get: () => undefined })
        })
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await page.keyboard.press(',')
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(page.getByRole('dialog').locator('select').first()).toBeFocused()
    })

    test('chords show menu symbols and Cmd chords the system keeps are refused', async ({
        page,
    }) => {
        const save = shortcutButton(page, 'Save')
        await save.click()
        await save.dispatchEvent('keydown', { key: 'h', metaKey: true, cancelable: true })
        await expectRefused(
            page,
            'Save',
            '⌘H is reserved by the browser or system. Press another key.',
        )
        await page.keyboard.press('Meta+Shift+KeyS')
        await expect(save).toHaveText('⇧⌘S')
        expect(await savedShortcut(page, 'save')).toBe('Mod+Shift+s')
    })
})

test("visibility toggles list kinds in the tools' order everywhere", async ({ page }) => {
    const kinds = ['Note', 'BPM', 'Time Scale', 'Camera Event', 'Stage Mask Event']
    // The keyboard shortcut list, whose rows mount in the frames after the dialog opens.
    await expect(page.getByRole('dialog').locator('[data-settings-section="about"]')).toBeAttached()
    const names = await page
        .getByRole('dialog')
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Keyboard Shortcuts' }) })
        .locator('.form-field-text')
        .allInnerTexts()
    const toggles = names.flatMap((name) => /^Toggle (.*) Visibility$/.exec(name.trim())?.[1] ?? [])
    expect(toggles.slice(0, kinds.length)).toEqual(kinds)

    const result = await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { settings, view, history, fixtures } = window.editorTest
        const chart = structuredClone(fixtures.notes)
        chart.isDynamicStages = true
        history.resetState(false, chart, 0, { sourceName: 'visibility.json' })
        // The default toolbar's flyout, read upward from its button.
        const group = settings.toolbar.find((names) => names.includes('cycleVisibilities')) ?? []
        // Each cycle shows one kind alone, in order.
        const cycle: string[] = []
        for (let step = 0; step < 4; step++) {
            commands.cycleVisibilities.execute()
            cycle.push(
                Object.entries(view.visibilities)
                    .filter(([, shown]) => shown)
                    .map(([type]) => type)
                    .filter((type) => type !== 'connector' && !type.endsWith('Connection'))
                    .join(),
            )
        }
        return { group: [...group].reverse(), cycle }
    })
    expect(result.group.slice(0, 6)).toEqual([
        'cycleVisibilities',
        'noteVisibility',
        'bpmVisibility',
        'timeScaleVisibility',
        'cameraEventVisibility',
        'stageMaskEventVisibility',
    ])
    expect(result.cycle).toEqual(['note', 'bpm', 'timeScale', 'cameraEventJoint'])
})

for (const locale of ['fr', 'tr', 'en']) {
    test(`${locale} settings values go below their label rather than truncate on a phone`, async ({
        page,
    }) => {
        await page.setViewportSize({ width: 375, height: 812 })
        await page.evaluate(
            (locale) => (window.editorTest.settings.locale = locale as never),
            locale,
        )
        const dialog = page.getByRole('dialog')
        // The last section mounts a few frames after the dialog opens.
        await expect(dialog.locator('[data-settings-section="about"]')).toBeAttached()
        await expect
            .poll(() =>
                dialog.locator('.form-field').evaluateAll((fields) => {
                    const context = document.createElement('canvas').getContext('2d')!
                    return fields.flatMap((field) => {
                        const select = field.querySelector('select')
                        if (!select?.getClientRects().length) return []
                        const style = getComputedStyle(select)
                        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
                        const text = select.selectedOptions[0]?.textContent.trim() ?? ''
                        const room =
                            select.clientWidth -
                            parseFloat(style.paddingLeft) -
                            parseFloat(style.paddingRight)
                        return context.measureText(text).width > room + 0.5 ? [text] : []
                    })
                }),
            )
            .toEqual([])
        // Short values keep their place beside the label.
        const stacked = await dialog
            .locator('.form-field.form-field-value-stacked')
            .evaluateAll((fields) => fields.length)
        expect(stacked).toBeGreaterThan(0)
        expect(stacked).toBeLessThan(12)
    })
}

for (const locale of ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht'])
    for (const width of [1600, 390])
        test(`${locale} the keyboard capture prompt shows in full at ${width}px`, async ({
            page,
        }) => {
            await page.setViewportSize({ width, height: 812 })
            await page.evaluate(
                (locale) => (window.editorTest.settings.locale = locale as never),
                locale,
            )
            const prompt = await page.evaluate(
                async () =>
                    (
                        await window.editorTest.appImport<typeof import('../../src/i18n')>(
                            '/src/i18n/index.ts',
                        )
                    ).i18n.value.modals.form.key.pressCancel,
            )
            const field = page
                .getByRole('dialog')
                .locator('.form-field')
                .filter({ has: page.locator('[data-icon-column]') })
                .first()
            const save = field.getByRole('button')
            await save.scrollIntoViewIfNeeded()
            await save.focus()
            await page.keyboard.press('Enter')
            await expect(save).toHaveText(prompt)
            await expect
                .poll(() =>
                    save.evaluate(
                        (button) =>
                            button.scrollWidth <= button.clientWidth &&
                            button.scrollHeight <= button.clientHeight,
                    ),
                )
                .toBe(true)
            if (process.env.SHOTS)
                await field.screenshot({ path: `${process.env.SHOTS}/f4-${locale}-${width}.png` })
            // Escape ends it, and the binding shows again.
            await page.keyboard.press('Escape')
            await expect(save).toHaveText('O')
        })

for (const locale of ['en', 'fr', 'ja', 'tr']) {
    test(`${locale} the capture prompt shows in full on a phone`, async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 })
        await page.evaluate(
            (locale) => (window.editorTest.settings.locale = locale as never),
            locale,
        )
        const save = page
            .getByRole('dialog')
            .locator('.form-field')
            .filter({ has: page.locator('[data-icon-column]') })
            .first()
            .getByRole('button')
        await save.scrollIntoViewIfNeeded()
        await save.click()
        await expect
            .poll(() =>
                save.evaluate(
                    (button) =>
                        button.scrollWidth <= button.clientWidth &&
                        button.scrollHeight <= button.clientHeight,
                ),
            )
            .toBe(true)
        // It returns beside its name once capture ends.
        await page.keyboard.press('Escape')
    })
}

test('wheeling past the end of the list leaves the dialog in place', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    const box = (await dialog.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 2000)
    await expect
        .poll(() => dialog.evaluate((element) => [element.scrollTop, element.scrollHeight]))
        .toEqual([0, await dialog.evaluate((element) => element.clientHeight)])
})

test('unassigned shortcuts are muted like other placeholder text', async ({ page }) => {
    const unassigned = page
        .getByRole('dialog')
        .locator('button', { hasText: /^Unassigned$/ })
        .first()
    await unassigned.scrollIntoViewIfNeeded()
    const alpha = await unassigned.evaluate((button) => {
        const match = /rgba?\((?:[\d.]+[ ,]+){3}([\d.]+)/.exec(
            getComputedStyle(button).color.replace(/\s*\/\s*/, ' '),
        )
        return match ? Number(match[1]) : 1
    })
    // /50 fell to about 2.5:1 contrast.
    expect(alpha).toBeCloseTo(0.8, 2)
    // Italic tells it from a bound key, as colour alone barely does.
    const fontStyle = (button: typeof unassigned) =>
        button.evaluate((element) => getComputedStyle(element).fontStyle)
    expect(await fontStyle(unassigned)).toBe('italic')
    const bound = page
        .getByRole('dialog')
        .locator('.form-field')
        .filter({ has: page.getByText('Cut', { exact: true }) })
        .getByRole('button')
    await expect(bound).toHaveText('X')
    expect(await fontStyle(bound)).toBe('normal')
})

test('unassigned shortcuts stay upright in CJK, which has no italic', async ({ page }) => {
    const unassigned = page.getByRole('dialog').locator('.key-field-unassigned').first()
    for (const [locale, style] of [
        ['fr', 'italic'],
        ['ja', 'normal'],
        ['ko', 'normal'],
        ['zhs', 'normal'],
        ['zht', 'normal'],
    ] as const) {
        await page.evaluate((locale) => (window.editorTest.settings.locale = locale), locale)
        await expect
            .poll(() => unassigned.evaluate((element) => getComputedStyle(element).fontStyle))
            .toBe(style)
    }
})

for (const width of [1600, 375]) {
    test(`a shortcut's button stays under the pointer while capturing at ${width}px`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height: 812 })
        const field = page
            .getByRole('dialog')
            .locator('.form-field')
            .filter({ has: page.getByText('Save', { exact: true }) })
        const save = field.getByRole('button')
        await save.scrollIntoViewIfNeeded()
        const before = (await save.boundingBox())!
        await save.click()
        await expect(save).toHaveText('Press a key or click again to clear')
        // Measured after the field's refit frame.
        await page.evaluate(() => new Promise(requestAnimationFrame))
        await page.evaluate(() => new Promise(requestAnimationFrame))
        const during = (await save.boundingBox())!
        expect({ x: during.x, y: during.y, width: during.width }).toEqual({
            x: before.x,
            y: before.y,
            width: before.width,
        })
        await expect(field).not.toHaveClass(/form-field-value-stacked/)
        // A refusal goes under the row and leaves the button in place too.
        await save.press('Control+t')
        const refused = (await save.boundingBox())!
        expect({ x: refused.x, y: refused.y }).toEqual({ x: before.x, y: before.y })
    })
}

test('from the keyboard, Escape cancels a capture and Delete or Backspace clears', async ({
    page,
}) => {
    const dialog = page.getByRole('dialog')
    const save = shortcutButton(page, 'Save')
    await save.focus()
    await page.keyboard.press('Enter')
    await expect(save).toHaveText('Press a key, or Esc to cancel')
    await page.keyboard.press('Escape')
    await expect(save).toHaveText('P')
    await expect(save).toBeFocused()
    await expect(dialog).toBeVisible()
    expect(await savedShortcut(page, 'save')).toBe('p')

    for (const key of ['Delete', 'Backspace']) {
        await page.evaluate(() => {
            const { settings } = window.editorTest
            settings.keyboardShortcuts = { ...settings.keyboardShortcuts, save: 'p' }
        })
        await save.focus()
        await page.keyboard.press(key)
        await expect(save, key).toHaveText('Unassigned')
        expect(await savedShortcut(page, 'save'), key).toBe('')
        await expect(dialog).toBeVisible()
    }

    // While capturing, those keys bind like any other.
    for (const [key, shown] of [
        ['Delete', 'Delete'],
        ['Backspace', 'Backspace'],
        ['Enter', 'Enter'],
    ] as const) {
        await save.focus()
        await page.keyboard.press('Enter')
        await expect(save).toHaveText('Press a key, or Esc to cancel')
        await page.keyboard.press(key)
        await expect(save, key).toHaveText(shown)
        expect(await savedShortcut(page, 'save'), key).toBe(key)
    }

    // A capture started with a click still binds Escape, as before.
    await save.click()
    await page.keyboard.press('Escape')
    await expect(save).toHaveText('Esc')
    expect(await savedShortcut(page, 'save')).toBe('Escape')
    await expect(dialog).toBeVisible()
})

test("a shortcut button's name gives its binding and the capture prompt", async ({ page }) => {
    const save = shortcutButton(page, 'Save')
    await expect(save).toHaveAccessibleName('Save P')
    await save.click()
    await expect(save).toHaveAccessibleName('Save Press a key or click again to clear')
    await save.press('l')
    await expect(save).toHaveAccessibleName('Save L')
    await save.click()
    await save.click()
    await expect(save).toHaveAccessibleName('Save Unassigned')
})

test('the capture prompt on an unassigned shortcut offers no clearing', async ({ page }) => {
    const save = shortcutButton(page, 'Save')
    await save.press('Delete')
    await expect(save).toHaveText('Unassigned')
    await save.click()
    await expect(save).toHaveText('Press a key')
    await save.press('l')
    await expect(save).toHaveText('L')
})

test('a punctuation shortcut reads larger and bold, as in the toolbar', async ({ page }) => {
    const style = (name: string) =>
        shortcutButton(page, name).evaluate((button) => {
            const value = getComputedStyle(button.firstElementChild!)
            return {
                text: button.textContent.trim(),
                size: parseFloat(value.fontSize),
                weight: Number(value.fontWeight),
                height: button.getBoundingClientRect().height,
            }
        })
    const letter = await style('Save')
    const punctuation = await style('Utilities')
    expect([letter.text, punctuation.text]).toEqual(['P', '.'])
    expect(punctuation.size).toBeGreaterThan(letter.size)
    expect(punctuation.weight).toBeGreaterThanOrEqual(700)
    expect(letter.weight).toBeLessThan(700)
    // The row keeps its height.
    expect(punctuation.height).toBe(letter.height)
})

test('Name Contrast follows the Show Other rows rather than splitting them', async ({ page }) => {
    const labels = await page.getByRole('dialog').locator('.form-field-text').allTextContents()
    const start = labels.indexOf('Show Group Name')
    expect(labels.slice(start, start + 9)).toEqual([
        'Show Group Name',
        'Hide Group Names When Focusing a Group',
        'Show Other Groups',
        'Show Stage Name',
        'Hide Stage Names When Focusing a Stage',
        'Show Other Stages',
        'Show Other Objects',
        'Name Contrast',
        'Max Scroll X (lanes)',
    ])
})

test('Name Contrast is off by default, persists and outlines whole names in their role colours', async ({
    page,
}) => {
    const key = 'sonolus-next-sekai-editor.nameContrast'
    const toggle = page
        .getByRole('dialog')
        .locator('label')
        .filter({ has: page.getByText('Name Contrast', { exact: true }) })
        .getByRole('switch')
    // Inspect the actual complete name sprites drawn on the chart, including black halo pixels.
    const nameAppearance = () =>
        page.evaluate(async () => {
            const { show, fixtures, history } = window.editorTest
            const drawn: Record<string, { color: string; halo: boolean }[]> = {}
            const record = (
                canvas: unknown,
                text: string | undefined,
                color: string,
                halo: boolean,
            ) => {
                if (
                    canvas instanceof HTMLCanvasElement &&
                    canvas.classList.contains('editor-chart') &&
                    (text === 'Center' || text === 'Other group')
                )
                    (drawn[text] ??= []).push({ color, halo })
            }
            const { WebGLDrawContext } = await window.editorTest.appImport<
                typeof import('../../src/rendering/context')
            >('/src/rendering/context.ts')
            const { drawNameSprite, drawEditorLabel } = WebGLDrawContext.prototype
            WebGLDrawContext.prototype.drawEditorLabel = function (text, x, y, color, ...args) {
                record(this.canvas, text, color, false)
                return drawEditorLabel.call(this, text, x, y, color, ...args)
            }
            // Names draw from their sprites.
            WebGLDrawContext.prototype.drawNameSprite = function (source, x, y) {
                const label = window.editorLabels.get(source)
                if (label && source instanceof HTMLCanvasElement) {
                    const pixels = source
                        .getContext('2d')!
                        .getImageData(0, 0, source.width, source.height).data
                    let halo = false
                    for (let index = 0; index < pixels.length; index += 4) {
                        if (
                            pixels[index + 3] &&
                            !pixels[index] &&
                            !pixels[index + 1] &&
                            !pixels[index + 2]
                        ) {
                            halo = true
                            break
                        }
                    }
                    record(this.canvas, label.text, label.color, halo)
                }
                return drawNameSprite.call(this, source, x, y)
            }
            show(fixtures.connectors, 8)
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
            })
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            )
            Object.assign(WebGLDrawContext.prototype, { drawNameSprite, drawEditorLabel })
            return Object.fromEntries(
                Object.entries(drawn).map(([text, appearances]) => [
                    text,
                    appearances.filter(
                        (appearance, index) =>
                            appearances.findIndex(
                                (other) =>
                                    other.color === appearance.color &&
                                    other.halo === appearance.halo,
                            ) === index,
                    ),
                ]),
            )
        })

    await expect(toggle).toHaveValue('Disabled')
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull()
    // Off, names keep their plain colours over note bodies and connectors.
    expect(await nameAppearance()).toEqual({
        Center: [{ color: '#aa00aa', halo: false }],
        'Other group': [{ color: '#00aaaa', halo: false }],
    })

    await toggle.click()
    await expect(toggle).toHaveValue('Enabled')
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe('true')
    expect(await nameAppearance()).toEqual({
        Center: [{ color: '#ff66ff', halo: true }],
        'Other group': [{ color: '#00aaaa', halo: true }],
    })

    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    expect(await page.evaluate(() => window.editorTest.settings.nameContrast)).toBe(true)
    await page.keyboard.press(',')
    await expect(toggle).toHaveValue('Enabled')
    await toggle.click()
    await expect(toggle).toHaveValue('Disabled')
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull()
    expect(await nameAppearance()).toEqual({
        Center: [{ color: '#aa00aa', halo: false }],
        'Other group': [{ color: '#00aaaa', halo: false }],
    })
})

test('with storage full, a changed setting still applies without an error', async ({ page }) => {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.evaluate(() => {
        const fill = (size: number) => {
            const chunk = 'x'.repeat(size)
            try {
                for (let i = 0; ; i++) localStorage.setItem(`fill-${size}-${i}`, chunk)
            } catch {
                // Full.
            }
        }
        fill(256 * 1024)
        fill(1024)
        fill(1)
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const width = await page.evaluate(() => window.editorTest.settings.width)
    await page.keyboard.press(']')
    expect(await page.evaluate(() => window.editorTest.settings.width)).not.toBe(width)
    expect(errors).toEqual([])
})

test('with storage full, a former dock size still loads and is kept for later', async ({
    page,
}) => {
    await page.evaluate(() => {
        localStorage.setItem('sonolus-next-sekai-editor.previewWidth', '432')
        localStorage.removeItem('sonolus-next-sekai-editor.leftDockWidth')
        const fill = (size: number) => {
            const chunk = 'x'.repeat(size)
            try {
                for (let i = 0; ; i++) localStorage.setItem(`fill-${size}-${i}`, chunk)
            } catch {
                // Full.
            }
        }
        fill(256 * 1024)
        fill(1024)
        fill(1)
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    expect(
        await page.evaluate(async () => {
            const { settings } = await import('/src/settings.ts')
            return {
                width: settings.leftDockWidth,
                legacy: localStorage.getItem('sonolus-next-sekai-editor.previewWidth'),
            }
        }),
    ).toEqual({ width: 432, legacy: '432' })
    expect(errors).toEqual([])
})

test('reduced motion stops sliding and turning, and view scrolls jump', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    // Smooth scrolling defaults off.
    const smooth = await page.evaluate(async () => {
        const url = performance
            .getEntriesByType('resource')
            .find((entry) => new URL(entry.name).pathname === '/src/settings.ts')!.name
        const { settings } = (await import(url)) as typeof import('../../src/settings')
        return settings.mouseSmoothScrolling
    })
    expect(smooth).toBe(false)
    await page.evaluate(installEditorFixture)
    // No transition moves anything; colour changes stay.
    const moving = await page.evaluate(() =>
        [...document.querySelectorAll('*')].flatMap((element) => {
            const { transitionProperty, transitionDuration } = getComputedStyle(element)
            return transitionDuration.split(', ').some((duration) => duration !== '0s') &&
                /all|transform|translate|rotate|scale|left|top|width|height/.test(
                    transitionProperty,
                )
                ? [`${element.className}: ${transitionProperty}`]
                : []
        }),
    )
    expect(moving).toEqual([])
    expect(
        await page.evaluate(
            () => getComputedStyle(document.querySelector('.panel-tab.ghost')!).transitionProperty,
        ),
    ).toContain('background-color')
    // A page scroll lands at once.
    await page.keyboard.press('PageUp')
    await page.evaluate(() => new Promise(requestAnimationFrame))
    await page.evaluate(() => new Promise(requestAnimationFrame))
    expect(await page.evaluate(() => window.editorTest.view.scrollingY)).toBeUndefined()
    expect(await page.evaluate(() => window.editorTest.view.time)).toBeGreaterThan(0)
})

test('the auto save rows are gone, and Beat Display sits with the display rows', async ({
    page,
}) => {
    const labels = await page.getByRole('dialog').locator('.form-field-text').allTextContents()
    const at = (label: string) => labels.indexOf(label)
    // Retired with the auto save: a new visit continues the most recent session.
    expect(labels.filter((label) => label.startsWith('Auto Save'))).toEqual([])
    // The display rows follow Theme, then the navigation rows, Second Deselect and the
    // Elevation editor rows.
    expect(at('Beat Display')).toBe(at('Theme') + 1)
    expect(at('Waveform Visualization')).toBe(at('Beat Display') + 1)
    expect(at('Show Minimap')).toBe(at('Zero-Width Notes') + 1)
    expect(at('Show Edits by Default')).toBe(at('Show Minimap') + 1)
    expect(at('Max Scroll X (lanes)')).toBe(at('Name Contrast') + 1)
    expect(at('Deselect Twice to Switch to Select Tool')).toBe(at('Drag to Pan X') + 1)
    expect(at('Elevation Editor Connector Arrows')).toBe(at('Elevation Editor Side by Side') + 1)
})

test('the retired auto save settings leave localStorage', async ({ page }) => {
    await page.evaluate(() => {
        localStorage.setItem('sonolus-next-sekai-editor.autoSave', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.autoSaveDelay', '3')
    })
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    expect(
        await page.evaluate(() => [
            localStorage.getItem('sonolus-next-sekai-editor.autoSave'),
            localStorage.getItem('sonolus-next-sekai-editor.autoSaveDelay'),
        ]),
    ).toEqual([null, null])
})

test('on/off fields are switches named by their row', async ({ page }) => {
    const arrows = page
        .getByRole('dialog')
        .getByRole('switch', { name: 'Elevation Editor Connector Arrows', exact: true })
    await expect(arrows).toBeChecked()
    await expect(arrows).toHaveValue('Enabled')
    await arrows.click()
    await expect(arrows).not.toBeChecked()
    await expect(arrows).toHaveValue('Disabled')
})

test('a Toolbar tool is named by what pressing it does', async ({ page }) => {
    const name = 'Remove “Save” from Toolbar'
    const tool = page.getByRole('dialog').getByRole('button', { name, exact: true })
    await expect(tool).toHaveAttribute('title', name)
    const has = () =>
        page.evaluate(() => window.editorTest.settings.toolbar.flat().includes('save'))
    expect(await has()).toBe(true)
    await tool.click()
    await expect(tool).toHaveCount(0)
    expect(await has()).toBe(false)
})

test('a Toolbar tool whose title ends in an ellipsis is named without it', async ({ page }) => {
    const name = 'Remove “Open” from Toolbar'
    const tool = page.getByRole('dialog').getByRole('button', { name, exact: true })
    await expect(tool).toHaveAttribute('title', name)
})

test("the dialog fills the viewport at v0.5.22's width, and a mouse sees every section pill", async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 1100 })
    const dialog = page.getByRole('dialog')
    // No 48rem (768 px) cap; 42rem wide, not 40.
    await expect.poll(async () => (await dialog.boundingBox())!.height).toBeGreaterThan(1000)
    expect(Math.round((await dialog.boundingBox())!.width)).toBe(672)
    const nav = page.locator('[data-settings-index]')
    // The pills wrap on a mouse, so none sits beyond the dialog's edge.
    expect(await nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(page.locator('[data-settings-pill="about"]')).toBeInViewport({ ratio: 1 })
})

test('on a short screen the section index scrolls away with the sections', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    const nav = page.locator('[data-settings-index]')
    await expect(nav).toBeVisible()
    const body = page.locator('[data-settings-section="editor"]').locator('xpath=..')
    await expect(body.locator('[data-settings-index]')).toHaveCount(1)
    await page.setViewportSize({ width: 844, height: 700 })
    await expect(body.locator('[data-settings-index]')).toHaveCount(0)
    await expect(nav).toBeVisible()
})

for (const reset of [
    {
        name: 'Reset Settings',
        message: 'Reset settings to their defaults? Keyboard shortcuts will be kept.',
        changed: 'previewNoteSpeed',
    },
    {
        name: 'Reset Shortcuts',
        message: 'Reset keyboard shortcuts to their defaults?',
        changed: 'save',
    },
]) {
    test(`${reset.name} asks first, with Cancel as the safe default`, async ({ page }) => {
        // Time is held, so the first moments of the dialog last as long as the checks need.
        await page.clock.install()
        await page.clock.pauseAt(new Date(Date.now() + 60_000))
        await page.evaluate(() => {
            const { settings } = window.editorTest
            settings.previewNoteSpeed = 9.25
            settings.keyboardShortcuts = { ...settings.keyboardShortcuts, save: 'l' }
        })
        const read = (key: string) =>
            page.evaluate((key) => {
                const { settings } = window.editorTest
                return key === 'save' ? settings.keyboardShortcuts.save : settings.previewNoteSpeed
            }, key)
        const dialog = page.getByRole('dialog')
        const opener = dialog.getByRole('button', { name: reset.name + '…', exact: true })
        const before = await read(reset.changed)
        await opener.click()
        await expect(page.getByRole('dialog')).toHaveCount(2)
        const confirm = page.getByRole('dialog').nth(1)
        await expect(confirm.locator('[data-modal-title]')).toHaveText(reset.name)
        await expect(confirm).toContainText(reset.message)
        // Cancel is the filled, focused default, and the reset is the quiet red choice.
        const cancel = confirm.getByRole('button', { name: 'Cancel', exact: true })
        await expect(cancel).toBeFocused()
        await expect(confirm.getByRole('button', { name: reset.name, exact: true })).toHaveClass(
            /btn-danger-quiet/,
        )
        await expect(cancel).toHaveClass(/btn-primary/)
        // A press in the first moments is not a choice.
        await page.keyboard.press('Enter')
        await page.clock.runFor(100)
        await page.keyboard.press('Enter')
        await expect(page.getByRole('dialog')).toHaveCount(2)
        await expect(cancel).toBeFocused()
        expect(await read(reset.changed)).toBe(before)
        // After that, Enter takes the default: nothing is reset, and focus returns to the button.
        await page.clock.runFor(300)
        await page.keyboard.press('Enter')
        await expect(page.getByRole('dialog')).toHaveCount(1)
        await page.clock.resume()
        expect(await read(reset.changed)).toBe(before)
        await expect(opener).toBeFocused()

        await opener.click()
        await expect(page.getByRole('dialog')).toHaveCount(2)
        await confirmWhenReady(
            page.getByRole('dialog').nth(1).getByRole('button', { name: reset.name, exact: true }),
            page.getByRole('dialog').nth(1),
        )
        await expect(page.getByRole('dialog')).toHaveCount(1)
        expect(await read(reset.changed)).not.toBe(before)
    })
}

test('in safe mode Local Data only reads: no Delete Sessions…, no Discard…, and the line does not say the browser cannot store', async ({
    page,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem('nse.test.storage', '{}')
        // An old auto save this build cannot read: a row that would offer Discard… outside safe mode.
        localStorage.setItem(
            'sonolus-next-sekai-editor.autoSave.unreadable',
            JSON.stringify({ version: 99, levelData: 'xx', filename: 'old.nsld' }),
        )
        StorageManager.prototype.estimate = () =>
            Promise.resolve({ usage: 84_000_000, quota: 2_100_000_000 })
    })
    await page.goto('/?safe')
    await expect(page.locator('[data-safe-bar]')).toBeVisible()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest?.status()?.mode))
        .toBe('readOnly')
    await page.evaluate(async () => {
        const { openSettings } =
            (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
        void openSettings('localData')
    })
    const section = page.locator('#settings-localData')
    await expect(section.locator('[data-storage-line]')).toHaveCount(0)
    // What the browser holds shows; nothing that writes does.
    await expect(section.locator('[data-stored-total]')).toHaveText(
        'Stored in this browser: 84 MB of about 2.1 GB',
    )
    await expect(section.locator('[data-delete-sessions-open]')).toHaveCount(0)
    await expect(section.locator('[data-not-stored-line]')).toHaveCount(0)
    const autoSave = section.locator('[data-recovery-row="autoSave"]')
    await expect(autoSave.getByRole('button')).toHaveText(['Download'])
    await expect(section.locator('[data-recovery-discard]')).toHaveCount(0)
    // Reading is still offered.
    await expect(section.getByRole('button', { name: 'Export Raw Data' })).toBeVisible()
    await expect(section.getByRole('button', { name: 'Open History' })).toBeVisible()
})
