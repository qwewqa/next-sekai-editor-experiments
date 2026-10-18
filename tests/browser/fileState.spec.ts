import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Step 6's file state (Part 1 §1.3.4, §1.4.9): the label's "•" and title, the one chip slot and
// its dialogs, "Download not confirmed", the close prompts and their setting, and Help's file lines.

const prefix = 'sonolus-next-sekai-editor.'

/** Seeds every page of the context: the storage hooks, a fixed version, the panels away. */
const seed = (context: BrowserContext, platform?: object, extra: Record<string, string> = {}) =>
    context.addInitScript(
        ({ platform, extra }) => {
            localStorage.setItem('nse.test.storage', '{}')
            localStorage.setItem(
                'nse.test.version',
                JSON.stringify({ appVersion: '0.6.0', atTag: true }),
            )
            localStorage.setItem(
                'sonolus-next-sekai-editor.lastAppVersion',
                JSON.stringify('0.6.0'),
            )
            localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
            localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
            if (platform) localStorage.setItem('nse.test.platform', JSON.stringify(platform))
            for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value)
        },
        { platform, extra },
    )

const visit = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const { startupGate } =
                        (await import('/src/startup/gate.ts')) as typeof import('../../src/startup/gate')
                    return startupGate.phase
                }),
            { timeout: 20_000 },
        )
        .toBe('done')
    // The pill is out of the way of the status bar's clicks.
    await page.keyboard.press('Escape')
}

const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(() => {
                const flusher = window.nseFlushTest!.flusher
                return !flusher.hasPending && !!flusher.session?.stored
            }),
        )
        .toBe(true)

/** A dialog ignores presses in its first moments (§1.4.1). */
const afterGuard = (page: Page) => page.waitForTimeout(400)

const label = (page: Page) => page.locator('[data-status-text]')
const button = (page: Page) => page.locator('[data-status-label]')
const chip = (page: Page) => page.locator('[data-file-chip]')
/** The chip's text as shown: its full string, or on a phone the short label. */
const chipShown = (page: Page) => chip(page).locator('span:visible')

/** Binds the open session to a file at a file event, with the live state as the file's. */
const bindFile = (
    page: Page,
    file: { name: string; event: 'saved' | 'downloaded' | 'opened'; at?: number },
) =>
    page.evaluate(async (file) => {
        const { bindFile } =
            (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
        const { liveState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        bindFile({ ...file, at: file.at ?? Date.now() }, liveState.value)
    }, file)

const edit = (page: Page, initialLife: number) =>
    page.evaluate(async (initialLife) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        pushState(() => `Life ${initialLife}`, { ...state.value, initialLife })
    }, initialLife)

const undo = (page: Page) =>
    page.evaluate(async () => {
        const { undoState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        undoState()
    })

const finding = (page: Page, kind: 'changed' | 'newer' | 'missing' | undefined) =>
    page.evaluate(async (kind) => {
        const { setDiskFinding } =
            (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
        setDiskFinding(kind)
    }, kind)

/** Whether closing the page now would raise the browser's prompt (the handler held the event). */
const prompts = (page: Page) =>
    page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
    })

test.describe('the label and the title', () => {
    test('a bound session shows a bullet while its content differs from the file event', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await expect(label(page)).toHaveText('coconut.nxsp')
        await expect(page).toHaveTitle('coconut.nxsp – Next SEKAI Editor')

        await edit(page, 990)
        await expect(label(page)).toHaveText('coconut.nxsp •')
        await expect(page).toHaveTitle('coconut.nxsp • – Next SEKAI Editor')
        await expect(button(page)).toHaveAccessibleName(
            'coconut, changed since saved to coconut.nxsp',
        )

        // The same content reached another way is unchanged.
        await undo(page)
        await expect(label(page)).toHaveText('coconut.nxsp')
        await edit(page, 990)
        await edit(page, 1000)
        await expect(label(page)).toHaveText('coconut.nxsp')
    })

    test('a selection change is no change', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await page.evaluate(async () => {
            const { replaceState, state } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            replaceState({ ...state.value, selectedEntities: [] })
        })
        await expect(label(page)).toHaveText('coconut.nxsp')
    })

    test('a named session shows its name before the file, and the bullet after', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await page.evaluate(async () => {
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            session.value = { ...session.value, name: 'Coconut (Master)' }
        })
        await edit(page, 990)
        await expect(label(page)).toHaveText('Coconut (Master) · coconut.nxsp •')
        await expect(page).toHaveTitle('Coconut (Master) · coconut.nxsp • – Next SEKAI Editor')
        await expect(button(page)).toHaveAccessibleName(
            'Coconut (Master), changed since saved to coconut.nxsp',
        )
    })

    test('the file name shows once when the name is its stem, as in every file the apps save', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        // An unnamed session saved as coconut-v2.nxsp shows the file name alone.
        await bindFile(page, { name: 'coconut-v2.nxsp', event: 'saved' })
        await expect(label(page)).toHaveText('coconut-v2.nxsp')
        await expect(page).toHaveTitle('coconut-v2.nxsp – Next SEKAI Editor')
        // A Name equal to the bound file's stem is the same name.
        await page.evaluate(async () => {
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            session.value = { ...session.value, name: 'coconut-v2' }
        })
        await expect(label(page)).toHaveText('coconut-v2.nxsp')
    })

    test('a download browser adds the state, and a download reads "since download"', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false }, { [`${prefix}downloadConfirmed`]: 'true' })
        await visit(page)
        // Not today, and in this year: a date reads without its year.
        const at = new Date(new Date().getFullYear(), 2, 3, 12).getTime()
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded', at })
        await expect(label(page)).toHaveText('coconut.nxsp · downloaded Mar 3')
        await edit(page, 990)
        await expect(label(page)).toHaveText('coconut.nxsp · downloaded Mar 3 •')
        await expect(button(page)).toHaveAccessibleName(
            'coconut, changed since download of coconut.nxsp',
        )
    })

    test.describe('on a phone', () => {
        test.use({ viewport: { width: 360, height: 700 } })

        test('the download state is left out, and the bullet stays', async ({ page, context }) => {
            await seed(
                context,
                { fileSystemAccess: false },
                { [`${prefix}downloadConfirmed`]: 'true' },
            )
            await visit(page)
            await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
            await edit(page, 990)
            await expect(page.locator('[data-status-state]')).toBeHidden()
            await expect(page.locator('[data-status-changed]')).toBeVisible()
        })
    })
})

test.describe('the chip', () => {
    test('a download not yet confirmed in this browser shows the chip, and I Have the File clears it', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        await expect(chipShown(page)).toHaveText('Download not confirmed')
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notConfirmed')
        await expect(chip(page)).toHaveAccessibleName(
            /^Check that coconut\.nxsp finished downloading \(.+\)\.$/,
        )
        // Not a change: no bullet.
        await expect(label(page)).not.toContainText('•')

        await chip(page).click()
        const dialog = page.getByRole('dialog', { name: 'Download Not Confirmed' })
        await expect(dialog).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Download Again' })).toBeFocused()
        await afterGuard(page)
        await dialog.getByRole('button', { name: 'I Have the File' }).click()
        await expect(chip(page)).toBeHidden()
        expect(
            await page.evaluate((key) => localStorage.getItem(key), `${prefix}downloadConfirmed`),
        ).toBe('true')

        // Later downloads in this browser need no confirming.
        await bindFile(page, { name: 'melt.nxsp', event: 'downloaded' })
        await expect(chip(page)).toBeHidden()
    })

    test('every download on an iPhone or iPad is unconfirmed, whatever the flag says', async ({
        page,
        context,
    }) => {
        await seed(
            context,
            { fileSystemAccess: false, os: 'ios', engine: 'webkit' },
            { [`${prefix}downloadConfirmed`]: 'true' },
        )
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notConfirmed')
        await chip(page).click()
        await afterGuard(page)
        await page
            .getByRole('dialog', { name: 'Download Not Confirmed' })
            .getByRole('button', { name: 'I Have the File' })
            .click()
        await expect(chip(page)).toBeHidden()
        // I Have the File is for this session's file only.
        await bindFile(page, { name: 'melt.nxsp', event: 'downloaded' })
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notConfirmed')
    })

    test('an edit moves a download from the chip to "changed since download"', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        await expect(chip(page)).toBeVisible()
        await edit(page, 990)
        await expect(chip(page)).toBeHidden()
        await expect(label(page)).toContainText('•')
    })

    test('the first state by priority is the chip, and the others are lines in its dialog', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        await finding(page, 'changed')
        await expect(chipShown(page)).toHaveText('Changed on disk')
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'changedOnDisk')
        await expect(label(page)).toContainText('changed on disk')
        await chip(page).click()
        const dialog = page.getByRole('dialog', { name: '"coconut.nxsp" Changed' })
        await expect(dialog).toContainText(
            '"coconut.nxsp" changed since you opened or saved it here.',
        )
        await expect(dialog).toContainText('Check that coconut.nxsp finished downloading')
        // Keep Editing is the safe default, in Cancel's place.
        await expect(dialog.getByRole('button', { name: 'Keep Editing' })).toBeFocused()
        await expect(dialog.getByRole('button', { name: 'Open the Other Version' })).toBeVisible()
        await expect(dialog.getByText('Your changes stay unsaved.')).toBeVisible()
        await afterGuard(page)
        await dialog.getByRole('button', { name: 'Keep Editing' }).click()

        await finding(page, 'missing')
        await expect(chipShown(page)).toHaveText('File missing')
        await finding(page, 'newer')
        await expect(chipShown(page)).toHaveText('Newer on disk')
        await finding(page, undefined)
        await expect(chipShown(page)).toHaveText('Download not confirmed')
    })

    test('a missing file opens the not-found dialog, which offers Save As…', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await finding(page, 'missing')
        await chip(page).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText('"coconut.nxsp" cannot be found.')
        await expect(dialog.getByRole('button', { name: 'Save As…' })).toBeFocused()
    })

    test('a finding about another session is no state of this one', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await finding(page, 'changed')
        await expect(chip(page)).toBeVisible()
        await page.evaluate(async () => {
            const { resetState } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            resetState(false)
        })
        await expect(chip(page)).toBeHidden()
    })

    test.describe('on a phone', () => {
        test.use({ viewport: { width: 360, height: 700 } })

        test('the short label shows, with the full sentence as its name', async ({
            page,
            context,
        }) => {
            await seed(context)
            await visit(page)
            await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
            await finding(page, 'changed')
            await expect(chipShown(page)).toHaveText('Changed')
            await expect(chip(page)).toHaveAccessibleName(
                '"coconut.nxsp": changed on disk since you opened or saved it here.',
            )
            const box = (await chip(page).boundingBox())!
            const bar = (await page.locator('.status-chip').first().boundingBox())!
            expect(box.x + box.width).toBeLessThanOrEqual(360)
            expect(bar.x + bar.width).toBeLessThanOrEqual(360)
        })
    })
})

test.describe('the close prompts', () => {
    test('a bound session prompts once changed, not while unchanged', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        expect(await prompts(page)).toBe(false)
        await edit(page, 990)
        await settled(page)
        expect(await prompts(page)).toBe(true)
        await undo(page)
        await settled(page)
        expect(await prompts(page)).toBe(false)
    })

    test('the setting turns the prompt off', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await edit(page, 990)
        await settled(page)
        expect(await prompts(page)).toBe(true)
        await page.evaluate(async () => {
            const { settings } =
                (await import('/src/settings.ts')) as typeof import('../../src/settings')
            settings.confirmCloseUnsavedFile = false
        })
        expect(await prompts(page)).toBe(false)
    })

    test('an unbound session prompts after an edit, not before', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        expect(await prompts(page)).toBe(false)
        await edit(page, 990)
        expect(await prompts(page)).toBe(true)
    })

    test('an unconfirmed download prompts until I Have the File', async ({ page, context }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        expect(await prompts(page)).toBe(true)
        await chip(page).click()
        await afterGuard(page)
        await page
            .getByRole('dialog', { name: 'Download Not Confirmed' })
            .getByRole('button', { name: 'I Have the File' })
            .click()
        expect(await prompts(page)).toBe(false)
    })

    test('Settings › Local Data holds the setting, and iPhone and iPad hide it', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await page.evaluate(async () => {
            const { openSettings } =
                (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
            openSettings('localData')
        })
        const row = page.getByRole('switch', { name: 'Ask Before Closing with Unsaved Changes' })
        await expect(row).toHaveAttribute('aria-checked', 'true')
        await row.click()
        await expect(row).toHaveAttribute('aria-checked', 'false')

        const ios = await context.newPage()
        await seed(context, { os: 'ios', engine: 'webkit' })
        await visit(ios)
        await ios.evaluate(async () => {
            const { openSettings } =
                (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
            openSettings('localData')
        })
        await expect(ios.locator('[data-open-history]')).toBeVisible()
        await expect(
            ios.getByRole('switch', { name: 'Ask Before Closing with Unsaved Changes' }),
        ).toHaveCount(0)
    })
})

test.describe('Help', () => {
    const help = async (page: Page) => {
        await page.evaluate(async () => {
            const { commands } =
                (await import('/src/editor/commands/index.ts')) as typeof import('../../src/editor/commands')
            const { runCommand } =
                (await import('/src/editor/commands/runCommand.ts')) as typeof import('../../src/editor/commands/runCommand')
            await runCommand(commands.help)
        })
        return page.getByRole('dialog', { name: 'Help' })
    }

    test('the file section says how to move work, and the .crswap line shows where files are written in place', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        const dialog = await help(page)
        await expect(dialog).toContainText(
            'To move work to another device, save it as a .nxsp file, then open the file there.',
        )
        await expect(dialog).toContainText(
            'A crash while saving can leave a .crswap file next to the project file. It is safe to delete.',
        )
    })

    test('a download browser leaves the .crswap line out', async ({ page, context }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        const dialog = await help(page)
        await expect(dialog).toContainText('To move work to another device')
        await expect(dialog).not.toContainText('.crswap')
    })
})
