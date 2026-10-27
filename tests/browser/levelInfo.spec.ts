import { expect, test, type Locator, type Page } from '@playwright/test'
import { confirmWhenReady } from './confirmWhenReady'
import { waitForStartup } from './editorFixture'
import { png, wav } from './levelInfoFiles'
import {
    flushed,
    notice,
    pressSave,
    queuePicks,
    readFile,
    rows,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// Level Info: the form, its draft and the one step a Confirm
// makes, the discard confirm, the utilities that return their result to it, the "not loaded" rows,
// and a picked cover and preview reaching storage and a saved file.

const label = (page: Page) => page.locator('[data-status-label]')
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Level Info', exact: true })

const openLevelInfo = async (page: Page) => {
    await label(page).click()
    await expect(dialog(page)).toBeVisible()
    return dialog(page)
}

const field = (form: Locator, name: string) => form.getByRole('textbox', { name, exact: true })

/** Types into a text field and leaves it, which commits the value to the draft. */
const type = async (input: Locator, value: string) => {
    await input.fill(value)
    await input.press('Tab')
}

const confirm = (form: Locator) => form.getByRole('button', { name: 'Confirm', exact: true })

/** Presses a button that opens the file chooser, and gives it a file. */
const pick = async (
    page: Page,
    button: Locator,
    file: { name: string; mimeType: string; buffer: Buffer },
) => {
    const chooser = page.waitForEvent('filechooser')
    await button.click()
    await (await chooser).setFiles(file)
}

const levelInfoOf = (page: Page) =>
    page.evaluate(async () => {
        const { liveState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        const { levelInfo, initialLife } = liveState.value
        return JSON.parse(JSON.stringify({ ...levelInfo, initialLife })) as Record<string, unknown>
    })

/** The live state's BGM, picked as the BGM dialog does. */
const pickBgm = async (page: Page, buffer: Buffer) => {
    await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
        const { changeBgm } =
            (await import('/src/editor/commands/bgm/index.ts')) as typeof import('../../src/editor/commands/bgm')
        void changeBgm(new File([bytes], 'bgm.wav', { type: 'audio/wav' }))
    }, buffer.toString('base64'))
    const bgmDialog = page.getByRole('dialog', { name: 'BGM', exact: true })
    await expect(bgmDialog.locator('input[type="button"]')).toHaveValue(/\d/)
    await bgmDialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(bgmDialog).toHaveCount(0)
}

/** Steps the stack holds: Undo reaches each one. */
const undoable = (page: Page) =>
    page.evaluate(async () => {
        const { canUndo } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        return canUndo.value
    })

/** Whether this tab holds the bytes of a file, as a pick keeps them. */
const holds = (page: Page, file: Buffer) =>
    page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
        const { captureMedia } =
            (await import('/src/local/media.ts')) as typeof import('../../src/local/media')
        const { heldItem } =
            (await import('/src/local/heldMedia.ts')) as typeof import('../../src/local/heldMedia')
        const { meta } = await captureMedia(
            bytes.buffer,
            { name: 'any.png', type: 'image/png' },
            'image',
        )
        return heldItem(meta.hash) !== undefined
    }, file.toString('base64'))

const cover = png(64, 64, [40, 120, 200])
const clip = wav(1)

test.beforeEach(async ({ page }) => {
    await start(page)
})

test('every field, a cover and a preview survive Apply, Save and opening the file in a fresh profile', async ({
    page,
    browser,
}) => {
    test.slow()
    const form = await openLevelInfo(page)
    await type(field(form, 'Title'), 'Coconut (Master)')
    await type(field(form, 'Artists'), 'Camellia')
    await type(field(form, 'Author'), 'qwewqa')
    await type(form.getByRole('spinbutton', { name: 'Rating', exact: true }), '29')
    await type(field(form, 'Tags'), 'Fan-made,  Expert')
    await type(field(form, 'Description'), 'A long chart.\nSecond line.')
    await form.getByRole('spinbutton', { name: 'Initial Life', exact: true }).fill('777')
    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'cover.png',
        mimeType: 'image/png',
        buffer: cover,
    })
    await expect(form.locator('[data-level-info-thumbnail]')).toBeVisible()
    await pick(page, form.locator('[data-level-info-preview-choose]'), {
        name: 'preview.wav',
        mimeType: 'audio/wav',
        buffer: clip,
    })
    await expect(form.locator('[data-level-info-preview-play]')).toBeVisible()
    await confirm(form).click()
    await expect(dialog(page)).toHaveCount(0)

    const expected = {
        title: 'Coconut (Master)',
        artists: 'Camellia',
        author: 'qwewqa',
        description: 'A long chart.\nSecond line.',
        rating: 29,
        tags: [{ title: 'Fan-made' }, { title: 'Expert' }],
        cover: { filename: 'cover.png', size: cover.length, type: 'image/png' },
        preview: { filename: 'preview.wav', size: clip.length, type: 'audio/wav' },
        initialLife: 777,
    }
    expect(await levelInfoOf(page)).toMatchObject(expected)

    // Both pictures reached storage with the step that names them.
    await flushed(page)
    const { media } = await rows(page, ['media'])
    expect(media!.map((row) => row.value.kind).sort()).toEqual(['cover', 'preview'])

    await pressSave(page)
    await submitSave(page, 'level')
    await expect(notice(page).filter({ hasText: 'Saved to level.nxsp' }).first()).toBeVisible()
    const bytes = await readFile(page, 'level.nxsp')

    // A fresh profile holds nothing: the file alone brings everything back.
    const context = await browser.newContext()
    try {
        const other = await context.newPage()
        await start(other)
        await writeFile(other, 'level.nxsp', bytes!)
        await queuePicks(other, ['level.nxsp'])
        await other.keyboard.press('o')
        await expect(notice(other).filter({ hasText: 'level.nxsp' }).first()).toBeVisible()
        await expect.poll(() => levelInfoOf(other)).toMatchObject(expected)

        const reopened = await openLevelInfo(other)
        await expect(field(reopened, 'Title')).toHaveValue('Coconut (Master)')
        await expect(field(reopened, 'Tags')).toHaveValue('Fan-made, Expert')
        await expect(field(reopened, 'Description')).toHaveValue('A long chart.\nSecond line.')
        await expect(reopened.getByRole('spinbutton', { name: 'Initial Life' })).toHaveValue('777')
        const thumbnail = reopened.locator('[data-level-info-thumbnail]')
        await expect(thumbnail).toBeVisible()
        expect(await thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64)
        await expect(reopened.locator('[data-level-info-preview-play]')).toBeVisible()
        await expect(reopened).not.toContainText('not loaded')
    } finally {
        await context.close()
    }
})

test('Escape with changes asks, Keep Editing keeps them, and without changes it closes', async ({
    page,
}) => {
    const form = await openLevelInfo(page)
    // Nothing changed: Escape closes at once.
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    await openLevelInfo(page)
    await type(field(form, 'Title'), 'Changed')
    const ask = page.getByRole('dialog', { name: 'Discard changes to Level Info?', exact: true })
    for (const leave of ['Escape', 'Close']) {
        if (leave === 'Escape') await page.keyboard.press('Escape')
        else await form.getByRole('button', { name: leave, exact: true }).click()
        await expect(ask).toBeVisible()
        // Keep Editing is the focused default.
        await expect(ask.getByRole('button', { name: 'Keep Editing', exact: true })).toBeFocused()
        await confirmWhenReady(ask.getByRole('button', { name: 'Keep Editing', exact: true }), ask)
        await expect(field(form, 'Title')).toHaveValue('Changed')
    }

    await page.keyboard.press('Escape')
    await confirmWhenReady(ask.getByRole('button', { name: 'Discard', exact: true }), ask)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await levelInfoOf(page)).title).toBe('')
    expect(await undoable(page)).toBe(false)
})

test('one Apply that changes the title and Initial Life is one step, and Undo reverts both', async ({
    page,
}) => {
    const form = await openLevelInfo(page)
    await type(field(form, 'Title'), 'Coconut')
    await form.getByRole('spinbutton', { name: 'Initial Life', exact: true }).fill('700')
    await confirm(form).click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await levelInfoOf(page)).toMatchObject({ title: 'Coconut', initialLife: 700 })
    const operation = await page.evaluate(async () => {
        const { headStep } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        return (headStep.value?.operation as { id: string } | undefined)?.id
    })
    expect(operation).toBe('nse.levelInfo.set')

    await page.evaluate(async () => {
        const { undoState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        undoState()
    })
    await expect.poll(() => levelInfoOf(page)).toMatchObject({ title: '', initialLife: 1000 })
    expect(await undoable(page)).toBe(false)
})

test('Play on the Preview Audio stops the chart’s playback and keeps its position', async ({
    page,
}) => {
    await pickBgm(page, wav(2))
    await page.evaluate(async () => {
        const { settings } =
            (await import('/src/settings.ts')) as typeof import('../../src/settings')
        const { view } =
            (await import('/src/editor/view.ts')) as typeof import('../../src/editor/view')
        const { startOrStopPlayer } =
            (await import('/src/editor/player.ts')) as typeof import('../../src/editor/player')
        settings.playStartPosition = 'cursor'
        settings.playFollow = false
        view.cursorTime = 0
        startOrStopPlayer()
    })
    const playing = () =>
        page.evaluate(async () => {
            const { isPlaying } =
                (await import('/src/player.ts')) as typeof import('../../src/player')
            return isPlaying.value
        })
    const cursor = () =>
        page.evaluate(
            async () =>
                ((await import('/src/editor/view.ts')) as typeof import('../../src/editor/view'))
                    .view.cursorTime,
        )
    await expect.poll(playing).toBe(true)
    await expect.poll(cursor).toBeGreaterThan(0)

    const form = await openLevelInfo(page)
    await pick(page, form.locator('[data-level-info-preview-choose]'), {
        name: 'preview.wav',
        mimeType: 'audio/wav',
        buffer: clip,
    })
    await form.locator('[data-level-info-preview-play]').click()
    await expect.poll(playing).toBe(false)
    // Stopped where it was, not returned to where it started.
    const stoppedAt = await cursor()
    expect(stoppedAt).toBeGreaterThan(0)
    await page.waitForTimeout(300)
    expect(await cursor()).toBe(stoppedAt)
})

test('Escape in the description asks before it throws the typed text away', async ({ page }) => {
    const form = await openLevelInfo(page)
    const description = field(form, 'Description')
    // Typed, not left: the text is already part of what the dialog guards.
    await description.fill('Typed but not left')
    await page.keyboard.press('Escape')
    const ask = page.getByRole('dialog', { name: 'Discard changes to Level Info?', exact: true })
    await expect(ask).toBeVisible()
    await confirmWhenReady(ask.getByRole('button', { name: 'Keep Editing', exact: true }), ask)
    await expect(description).toHaveValue('Typed but not left')
    await confirm(form).click()
    await expect(dialog(page)).toHaveCount(0)
    expect((await levelInfoOf(page)).description).toBe('Typed but not left')
})

/** The page's console errors and uncaught errors from now on. */
const collectConsole = (page: Page) => {
    const logged: string[] = []
    page.on('console', (message) => {
        if (message.type() === 'error') logged.push(`console.error: ${message.text()}`)
    })
    page.on('pageerror', (error) => logged.push(`pageerror: ${error.message}`))
    return logged
}

/**
 * Waits for Generate to hand the result back and close the editor. When it does not, the failure
 * says what stayed on screen (a loading dialog still working, or its failure message) and what the
 * page logged, so one run on a slow runner shows whether Generate is slow or has failed.
 */
const closesAfterGenerate = async (page: Page, editor: Locator, logged: string[]) => {
    try {
        await expect(editor).toHaveCount(0)
    } catch (error) {
        const open = await page.getByRole('dialog').evaluateAll((dialogs) =>
            dialogs.map((element) => ({
                text: (element as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
                working: element.querySelector('.wait-bar-slide, [role="progressbar"]') !== null,
            })),
        )
        throw new Error(
            `Generate did not close the Cover Editor. Open dialogs: ${JSON.stringify(open)}. Logged: ${JSON.stringify(logged)}`,
            { cause: error },
        )
    }
}

test('Make from BGM… and Edit in Cover Editor return their result with the typed fields kept', async ({
    page,
}) => {
    const form = await openLevelInfo(page)
    // Always offered, with no BGM loaded.
    await expect(form.locator('[data-level-info-preview-make]')).toBeEnabled()
    await expect(form.locator('[data-level-info-cover-edit]')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await pickBgm(page, wav(2))

    await openLevelInfo(page)
    await type(field(form, 'Title'), 'Typed before')
    await form.locator('[data-level-info-preview-make]').click()
    const preview = page.getByRole('dialog', { name: 'Preview Editor', exact: true })
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect(preview).toHaveCount(0)
    await expect(form.locator('[data-level-info-preview]')).toContainText('preview.mp3')
    await expect(form.locator('[data-level-info-preview-play]')).toBeVisible()
    await expect(field(form, 'Title')).toHaveValue('Typed before')

    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'picked.png',
        mimeType: 'image/png',
        buffer: cover,
    })
    await expect(form.locator('[data-level-info-cover]')).toContainText('picked.png')
    await form.locator('[data-level-info-cover-edit]').click()
    // The loading dialog over it has the same title.
    const editor = page.getByRole('dialog', { name: 'Cover Editor', exact: true }).first()
    // It starts from the cover in the form.
    await expect(editor.getByRole('button', { name: '64×64', exact: true })).toBeVisible()
    const logged = collectConsole(page)
    await editor.getByRole('button', { name: 'Generate', exact: true }).click()
    await closesAfterGenerate(page, editor, logged)
    await expect(form.locator('[data-level-info-cover]')).toContainText('cover.png')
    await expect(field(form, 'Title')).toHaveValue('Typed before')

    // Closing a utility without Generate changes nothing.
    await form.locator('[data-level-info-cover-edit]').click()
    await expect(editor.getByRole('button', { name: '400×400', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(form.locator('[data-level-info-cover]')).toContainText('cover.png')

    await confirm(form).click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await levelInfoOf(page)).toMatchObject({
        title: 'Typed before',
        cover: { filename: 'cover.png', type: 'image/png' },
        preview: { filename: 'preview.mp3' },
    })
})

test('a cover that is not loaded says so, and the same file brings it back without an edit', async ({
    page,
}) => {
    // A state that names a cover nothing holds, as after the bytes were cleared elsewhere.
    await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
        const { captureMedia } =
            (await import('/src/local/media.ts')) as typeof import('../../src/local/media')
        const { liveState, replaceState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        const { meta } = await captureMedia(
            bytes.buffer,
            { name: 'cover.png', type: 'image/png' },
            'image',
        )
        replaceState({
            ...liveState.value,
            levelInfo: {
                ...liveState.value.levelInfo,
                cover: { hash: meta.hash, filename: 'cover.png', size: meta.size, type: meta.type },
            },
        })
    }, cover.toString('base64'))

    let form = await openLevelInfo(page)
    await expect(form.locator('[data-level-info-cover]')).toContainText('cover.png')
    await expect(form.locator('[data-level-info-cover-tile]')).toHaveText('not loaded')
    await expect(form.locator('[data-level-info-thumbnail]')).toHaveCount(0)
    await expect(form.locator('[data-level-info-cover-edit]')).toBeDisabled()

    // Another file is an ordinary change of the draft.
    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'other.png',
        mimeType: 'image/png',
        buffer: png(32, 32, [200, 40, 40]),
    })
    await expect(form.locator('[data-level-info-cover]')).toContainText('other.png')
    await page.keyboard.press('Escape')
    const ask = page.getByRole('dialog', { name: 'Discard changes to Level Info?' })
    await confirmWhenReady(ask.getByRole('button', { name: 'Discard', exact: true }), ask)
    await expect(dialog(page)).toHaveCount(0)

    // The same file: stored at once, shown, and the draft is as it opened.
    form = await openLevelInfo(page)
    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'copy of cover.png',
        mimeType: 'image/png',
        buffer: cover,
    })
    await expect(form.locator('[data-level-info-thumbnail]')).toBeVisible()
    await expect(form.locator('[data-level-info-cover]')).toContainText('cover.png')
    await expect
        .poll(async () => (await rows(page, ['media'])).media!.map((row) => row.value.kind))
        .toEqual(['cover'])
    expect(await undoable(page)).toBe(false)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
})

test('a cover the dialog replaces or discards is released, and one it applies is kept', async ({
    page,
}) => {
    const second = png(32, 32, [200, 40, 40])
    const third = png(16, 16, [40, 200, 40])
    let form = await openLevelInfo(page)
    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'one.png',
        mimeType: 'image/png',
        buffer: cover,
    })
    await expect(form.locator('[data-level-info-cover]')).toContainText('one.png')
    expect(await holds(page, cover)).toBe(true)

    // Replaced inside the dialog: the first is released at once, the second held.
    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'two.png',
        mimeType: 'image/png',
        buffer: second,
    })
    await expect(form.locator('[data-level-info-cover]')).toContainText('two.png')
    await expect.poll(() => holds(page, cover)).toBe(false)
    expect(await holds(page, second)).toBe(true)

    // Discarded: nothing the dialog picked stays.
    await page.keyboard.press('Escape')
    const ask = page.getByRole('dialog', { name: 'Discard changes to Level Info?' })
    await confirmWhenReady(ask.getByRole('button', { name: 'Discard', exact: true }), ask)
    await expect(dialog(page)).toHaveCount(0)
    expect(await holds(page, second)).toBe(false)
    expect(await holds(page, cover)).toBe(false)

    // Applied: kept, and a later dialog that discards another pick leaves it.
    form = await openLevelInfo(page)
    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'two.png',
        mimeType: 'image/png',
        buffer: second,
    })
    await expect(form.locator('[data-level-info-cover]')).toContainText('two.png')
    await confirm(form).click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await holds(page, second)).toBe(true)

    form = await openLevelInfo(page)
    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'three.png',
        mimeType: 'image/png',
        buffer: third,
    })
    await expect(form.locator('[data-level-info-cover]')).toContainText('three.png')
    await page.keyboard.press('Escape')
    await confirmWhenReady(ask.getByRole('button', { name: 'Discard', exact: true }), ask)
    await expect(dialog(page)).toHaveCount(0)
    expect(await holds(page, third)).toBe(false)
    expect(await holds(page, second)).toBe(true)
})

test('a cover that was applied, reloaded and saved is in the file', async ({ page, browser }) => {
    test.slow()
    const form = await openLevelInfo(page)
    await pick(page, form.locator('[data-level-info-cover-choose]'), {
        name: 'cover.png',
        mimeType: 'image/png',
        buffer: cover,
    })
    await expect(form.locator('[data-level-info-thumbnail]')).toBeVisible()
    await confirm(form).click()
    await expect(dialog(page)).toHaveCount(0)
    await flushed(page)

    // The reload empties the held media: the stored cover alone carries to the file.
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    expect(await holds(page, cover)).toBe(false)
    await expect.poll(() => levelInfoOf(page)).toMatchObject({ cover: { filename: 'cover.png' } })
    await pressSave(page)
    await submitSave(page, 'level')
    await expect(notice(page).filter({ hasText: 'Saved to level.nxsp' }).first()).toBeVisible()
    const bytes = await readFile(page, 'level.nxsp')

    const context = await browser.newContext()
    try {
        const other = await context.newPage()
        await start(other)
        await writeFile(other, 'level.nxsp', bytes!)
        await queuePicks(other, ['level.nxsp'])
        await other.keyboard.press('o')
        await expect(notice(other).filter({ hasText: 'level.nxsp' }).first()).toBeVisible()
        const reopened = await openLevelInfo(other)
        const thumbnail = reopened.locator('[data-level-info-thumbnail]')
        await expect(thumbnail).toBeVisible()
        expect(await thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64)
    } finally {
        await context.close()
    }
})

test('Check on the file line runs Check File and History', async ({ page }) => {
    const form = await openLevelInfo(page)
    await form.getByRole('button', { name: 'Check', exact: true }).click()
    const report = page.getByRole('dialog', { name: 'Check File and History', exact: true })
    await expect(report).toContainText('No damage found.')
    await report.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect(report).toHaveCount(0)
    await expect(dialog(page)).toBeVisible()
})
