import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { confirmKeyWhenReady, confirmWhenReady } from './confirmWhenReady'
import { submitSave } from './saveFlows'

// The Not stored state (Part 1 §1.6.7): raised from the storage status after it has held for a
// moment, the chip's dialog by cause, Try Again, and the iOS bar that holds the chart still.

/** Seeds every page of the context: the storage hooks (with the worker's flags), the panels away. */
const seed = (context: BrowserContext, storage: object = {}, platform?: object) =>
    context.addInitScript(
        ({ storage, platform }) => {
            localStorage.setItem('nse.test.storage', JSON.stringify(storage))
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
        },
        { storage, platform },
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
    await expect.poll(() => page.evaluate(() => window.nseStorageTest?.status())).toBeTruthy()
    // The pill is out of the way of the status bar's clicks.
    await page.keyboard.press('Escape')
}

const edit = (page: Page, initialLife: number) =>
    page.evaluate(async (initialLife) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        const { initialLife: operation } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        pushState(operation(state.value.initialLife, initialLife), { ...state.value, initialLife })
    }, initialLife)

/** Sets the status the page follows, as the worker's status event does. */
const setStatus = (page: Page, status: object | undefined) =>
    page.evaluate(async (status) => {
        const { storageStatus } =
            (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
        storageStatus.value = status as typeof storageStatus.value
    }, status)

const chip = (page: Page) => page.locator('[data-file-chip]')
const label = (page: Page) => page.locator('[data-status-label]')
const bar = (page: Page) => page.locator('[data-not-stored-bar]')
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Changes Not Stored' })

/** The card a pressed Try Again raises when storing still fails. */
const stillFailing = (page: Page) =>
    page
        .locator('[data-notice-card]')
        .filter({ hasText: 'Changes are not being stored in this browser.' })

/** Presses a button of the dialog; the dialog ignores presses in its first moments (§1.4.1). */
const press = (page: Page, name: string) =>
    confirmWhenReady(dialog(page).getByRole('button', { name, exact: true }), dialog(page))

/** The dialog's buttons left to right, without the × that closes it. */
const buttons = (page: Page) =>
    dialog(page)
        .getByRole('button')
        .evaluateAll((all) =>
            all
                .map((each) => each.getAttribute('aria-label') ?? each.textContent.trim())
                .filter((name) => name !== 'Close'),
        )

const pausedFull = { mode: 'stored', reason: 'full' }

test.describe('a full browser', () => {
    test('shows the chip only after the pause has held, and its dialog leads to Local Data', async ({
        page,
        context,
    }) => {
        await seed(context, { forceQuota: true })
        await visit(page)
        await expect(chip(page)).toHaveCount(0)
        await edit(page, 990)
        // The flush fails and pauses storing; the chip waits about 3 s before it says so.
        await expect
            .poll(() => page.evaluate(() => window.nseStorageTest?.status()))
            .toEqual(pausedFull)
        // The 3 s delay itself is covered by the unit test, which has a clock to move.
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored', { timeout: 8000 })
        await expect(label(page)).toHaveClass(/text-warning/)
        // Not the iOS bar: it belongs to iOS and iPadOS.
        await expect(bar(page)).toHaveCount(0)

        await chip(page).click()
        await expect(dialog(page)).toContainText('Changes are not being stored in this browser.')
        await expect(dialog(page)).toContainText('Browser storage is full.')
        expect(await buttons(page)).toEqual(['Cancel', 'Local Data', 'Try Again', 'Save'])
        await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toBeFocused()

        // Try Again with the browser still full says so, and leaves the chip.
        await press(page, 'Try Again')
        await expect(stillFailing(page)).toBeVisible()
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored')

        await chip(page).click()
        await press(page, 'Local Data')
        await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Local Data' })).toBeFocused()
    })

    test('Try Again in the dialog runs against the worker, and the chip goes once storing is back', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await edit(page, 990)
        await setStatus(page, pausedFull)
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored', { timeout: 8000 })
        // Storing works (nothing forces a quota): Try Again flushes and the worker's status
        // clears the pause, which the page follows.
        await chip(page).click()
        await press(page, 'Try Again')
        await setStatus(page, { mode: 'stored' })
        await expect(chip(page)).toHaveCount(0)
        await expect(label(page)).not.toHaveClass(/text-warning/)
    })
})

test('a change of cause while shown keeps the chip, and the dialog follows the cause', async ({
    page,
    context,
}) => {
    await seed(context)
    await visit(page)
    await setStatus(page, pausedFull)
    await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored', { timeout: 8000 })
    const causes: [object, string | undefined, string[]][] = [
        [
            { mode: 'stored', reason: 'failed' },
            'The browser stopped storing changes.',
            ['Cancel', 'Try Again', 'Save'],
        ],
        [
            { mode: 'memory', reason: 'olderTabs' },
            'Close other Next SEKAI Editor tabs to keep storing changes.',
            ['Cancel', 'Try Again', 'Save'],
        ],
        [
            { mode: 'stored', reason: 'upgrading' },
            'Another tab is upgrading the editor.',
            ['Cancel', 'Reload', 'Save'],
        ],
        [
            { mode: 'readOnly' },
            'This version is older than your data.',
            ['Cancel', 'Reload', 'Save'],
        ],
        [{ mode: 'memory' }, undefined, ['Cancel', 'Save']],
    ]
    for (const [status, line, names] of causes) {
        await setStatus(page, status)
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored')
        await chip(page).click()
        await expect(dialog(page)).toContainText('Changes are not being stored in this browser.')
        if (line) await expect(dialog(page)).toContainText(line)
        expect(await buttons(page)).toEqual(names)
        await confirmKeyWhenReady(page, 'Escape', dialog(page))
    }
})

test('Reload in the dialog reloads the page', async ({ page, context }) => {
    await seed(context)
    await visit(page)
    await setStatus(page, { mode: 'stored', reason: 'upgrading' })
    await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored', { timeout: 8000 })
    await chip(page).click()
    await Promise.all([page.waitForEvent('load'), press(page, 'Reload')])
})

// iOS shows no leave prompt of its own, so unstored work is asked about before the reload
// (final review R2 #2).
test('Reload with work that is stored nowhere asks first, and Cancel keeps the page', async ({
    page,
    context,
}) => {
    await seed(context)
    // The edit is in no store, as when an upgrade holds the database.
    await context.addInitScript(() => localStorage.setItem('nse.test.noStorage', 'true'))
    await visit(page)
    await edit(page, 990)
    await setStatus(page, { mode: 'stored', reason: 'upgrading' })
    await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored', { timeout: 8000 })
    await chip(page).click()
    const leave = page.getByRole('button', { name: 'Leave Anyway' })
    await expect(async () => {
        await dialog(page)
            .getByRole('button', { name: 'Reload', exact: true })
            .click({ timeout: 1000 })
        await expect(leave).toBeVisible({ timeout: 2000 })
    }).toPass({ timeout: 10_000 })
    let loaded = false
    page.on('load', () => (loaded = true))
    await confirmWhenReady(
        page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }),
        page.getByRole('dialog'),
    )
    await expect(dialog(page)).toHaveCount(0)
    expect(loaded).toBe(false)
    await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored')
})

const ios = { os: 'ios', engine: 'webkit', fileSystemAccess: false }

test.describe('the iOS bar', () => {
    test('shows while work is only here, holds the chart still, and goes with the work saved', async ({
        page,
        context,
    }) => {
        await seed(context, {}, ios)
        await visit(page)
        // Pointer positions are in the page; time 20 s is well above the clamp at 0.
        await page.evaluate(async () => {
            const { view } =
                (await import('/src/editor/view.ts')) as typeof import('../../src/editor/view')
            view.time = 20
        })
        const hovered = async () => {
            await page.mouse.move(100, 200)
            await page.mouse.move(120, 220)
            return page.evaluate(async () => {
                const { view } =
                    (await import('/src/editor/view.ts')) as typeof import('../../src/editor/view')
                return { hover: view.hoverTime, time: view.time, y: view.y, h: view.h }
            })
        }
        // No work to lose: the chip comes, the bar does not.
        await setStatus(page, pausedFull)
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored', { timeout: 8000 })
        await expect(bar(page)).toHaveCount(0)

        const before = await hovered()
        await edit(page, 990)
        await expect(bar(page)).toBeVisible()
        await expect(bar(page)).toContainText('Changes are not being stored in this browser.')
        const barHeight = (await bar(page).boundingBox())!.height
        await expect.poll(async () => (await hovered()).y - before.y).toBeCloseTo(barHeight, 0)
        const during = await hovered()
        // The chart moved down by the bar, and what is under the pointer is the same time.
        expect(during.h).toBeCloseTo(before.h - barHeight, 0)
        expect(during.hover).toBeCloseTo(before.hover, 3)
        expect(during.time).toBeLessThan(before.time)

        // Undoing the only change leaves nothing to lose: the bar goes and the chart stays put.
        await page.evaluate(async () => {
            const { undoState } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            undoState()
        })
        await expect(bar(page)).toHaveCount(0)
        await expect.poll(async () => (await hovered()).y).toBeCloseTo(before.y, 0)
        const after = await hovered()
        expect(after.hover).toBeCloseTo(before.hover, 3)
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored')
    })

    test('an unconfirmed download is settled from the Not stored dialog with I Have the File', async ({
        page,
        context,
    }) => {
        await seed(context, {}, ios)
        await visit(page)
        await edit(page, 990)
        await setStatus(page, pausedFull)
        await expect(bar(page)).toBeVisible({ timeout: 8000 })
        await bar(page).getByRole('button', { name: 'Save', exact: true }).click()
        await submitSave(page, 'coconut')
        await expect(bar(page)).toHaveCount(0)
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored')

        await chip(page).click()
        await expect(dialog(page)).toContainText('finished downloading')
        expect(await buttons(page)).toEqual([
            'Cancel',
            'Local Data',
            'Try Again',
            'I Have the File',
            'Save',
        ])
        await press(page, 'I Have the File')

        // The download line and its button are gone.
        await chip(page).click()
        await expect(dialog(page)).toBeVisible()
        await expect(dialog(page)).not.toContainText('finished downloading')
        expect(await buttons(page)).toEqual(['Cancel', 'Local Data', 'Try Again', 'Save'])
    })

    test('Save in the bar saves the work, and the bar goes', async ({ page, context }) => {
        await seed(context, {}, ios)
        await visit(page)
        await edit(page, 990)
        await setStatus(page, pausedFull)
        await expect(bar(page)).toBeVisible({ timeout: 8000 })
        await bar(page).getByRole('button', { name: 'Save', exact: true }).click()
        // A download browser's first Save asks for the name.
        await submitSave(page, 'coconut')
        await expect(bar(page)).toHaveCount(0)
        await expect(chip(page)).toHaveAttribute('data-file-chip', /notStored|notConfirmed/)
    })
})
