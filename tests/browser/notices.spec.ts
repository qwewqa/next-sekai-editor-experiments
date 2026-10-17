import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Notices with an action, the live region and Alt+N (Part 1 §1.4.1, §1.4.3).

const boot = async (page: Page, before?: () => void) => {
    await page.addInitScript(installCanvasCounters)
    if (before) await page.addInitScript(before)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

/** Shows a notice with an action; the action counts its runs in `window.noticeRuns`. */
const notifyWithAction = (page: Page, message: string, announcement?: string) =>
    page.evaluate(
        async ({ message, announcement }) => {
            const { notify } = await window.editorTest.appImport<
                typeof import('../../src/editor/notification')
            >('/src/editor/notification.ts')
            Reflect.set(window, 'noticeRuns', 0)
            notify(() => message, {
                action: {
                    label: () => 'Open History',
                    run: () =>
                        Reflect.set(
                            window,
                            'noticeRuns',
                            Number(Reflect.get(window, 'noticeRuns')) + 1,
                        ),
                },
                announcement: announcement ? () => announcement : undefined,
            })
        },
        { message, announcement },
    )

const runs = (page: Page) => page.evaluate(() => Number(Reflect.get(window, 'noticeRuns')))

const pill = (page: Page) => page.locator('.notification-pill')

test('the fixture seeds lastAppVersion, so the start-up pill is the plain version', async ({
    page,
}) => {
    await boot(page)
    await expect(page.locator('.notification')).toHaveText('Next SEKAI Editor\nVersion 0.6.0')
    await expect(page.locator('[data-notice-action]')).toHaveCount(0)
    expect(
        await page.evaluate(() => localStorage.getItem('sonolus-next-sekai-editor.lastAppVersion')),
    ).toBe('"0.6.0"')
})

test('a notice with an action sits above the toolbar and runs on click', async ({ page }) => {
    await boot(page)
    await notifyWithAction(page, 'Nothing to undo')
    await expect(pill(page)).toBeVisible()
    await expect(pill(page)).toContainText('Nothing to undo')
    const box = (await pill(page).boundingBox())!
    const toolbar = (await page.locator('[data-editor-toolbar] > div').boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(toolbar.y)
    // Pointer events are on the pill alone.
    const events = await pill(page).evaluate((element) => ({
        pill: getComputedStyle(element).pointerEvents,
        host: getComputedStyle(element.parentElement!).pointerEvents,
    }))
    expect(events).toEqual({ pill: 'auto', host: 'none' })
    await pill(page).getByRole('button', { name: 'Open History' }).click()
    expect(await runs(page)).toBe(1)
})

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('the action button is at least 44 px', async ({ page }) => {
        await boot(page)
        await notifyWithAction(page, 'Nothing to undo')
        const button = pill(page).getByRole('button')
        await expect(button).toBeVisible()
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    })
})

test('every notice is announced once by the page’s one live region', async ({ page }) => {
    await boot(page)
    const region = page.getByRole('status')
    await expect(region).toHaveCount(1)
    await notifyWithAction(page, 'Nothing to undo', 'Nothing to undo. To go back, open History.')
    await expect(region).toHaveText('Nothing to undo. To go back, open History.')
    // A plain notice is announced the same way.
    await page.keyboard.press('a')
    await expect(region).toHaveCount(1)
    await expect(region).toHaveText(/\S/)
    await expect(region).not.toHaveText(/Nothing to undo/)
})

for (const sideBySide of ['allow', 'disallow'] as const)
    test(`a split layout (${sideBySide}) announces a notice once`, async ({ page }) => {
        await boot(page)
        await page.evaluate((sideBySide) => {
            window.editorTest.settings.elevationEditorSideBySide = sideBySide
        }, sideBySide)
        await page.keyboard.press('t')
        await expect(page.locator('.elevation-editor')).toBeVisible()
        await notifyWithAction(page, 'Nothing to undo')
        await expect(pill(page)).toHaveCount(1)
        await expect(page.getByRole('status')).toHaveCount(1)
        await expect(page.getByText('Nothing to undo')).toHaveCount(2)
        // One in the pill, one in the live region (visually hidden).
        expect(await page.getByRole('status').getByText('Nothing to undo').count()).toBe(1)
    })

test('a notice with an action stays about 6 s and pauses while hovered', async ({ page }) => {
    await boot(page)
    await page.clock.install()
    await notifyWithAction(page, 'Nothing to undo')
    await expect(pill(page)).toBeVisible()
    await pill(page).hover()
    await page.clock.runFor(10_000)
    await expect(pill(page)).toBeVisible()
    await page.mouse.move(5, 5)
    await page.clock.runFor(1_000)
    await expect(pill(page)).toBeVisible()
    await page.clock.runFor(6_000)
    await expect(pill(page)).toHaveCount(0)
    // A notice nobody touches goes after about 6 s.
    await notifyWithAction(page, 'Nothing to redo')
    await page.clock.runFor(5_000)
    await expect(pill(page)).toBeVisible()
    await page.clock.runFor(1_500)
    await expect(pill(page)).toHaveCount(0)
})

test('Alt+N focuses the action, which does not time out while focused, and Escape returns focus', async ({
    page,
}) => {
    await boot(page)
    await page.clock.install()
    await page.locator('.chart-pane').focus()
    await notifyWithAction(page, 'Nothing to undo')
    await expect(pill(page)).toBeVisible()
    await page.keyboard.press('Alt+KeyN')
    const button = pill(page).getByRole('button', { name: 'Open History' })
    await expect(button).toBeFocused()
    await page.clock.runFor(20_000)
    await expect(pill(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.chart-pane')).toBeFocused()
    await page.clock.runFor(7_000)
    await expect(pill(page)).toHaveCount(0)
})

test('Alt+N does nothing without an action notice', async ({ page }) => {
    await boot(page)
    await page.locator('.chart-pane').focus()
    await page.keyboard.press('Alt+KeyN')
    await expect(page.locator('.chart-pane')).toBeFocused()
})

test('Alt+N is ignored in a text field and in a contenteditable element', async ({ page }) => {
    await boot(page)
    await notifyWithAction(page, 'Nothing to undo')
    await expect(pill(page)).toBeVisible()
    await page.evaluate(() => {
        const input = document.createElement('input')
        input.id = 'probe-input'
        const editable = document.createElement('div')
        editable.id = 'probe-editable'
        editable.contentEditable = 'true'
        editable.textContent = 'x'
        document.body.append(input, editable)
        // Whether the page cancelled the key: it must not, so "ñ" still types.
        Reflect.set(window, 'altNPrevented', [])
        addEventListener('keydown', (event) => {
            if (event.code === 'KeyN')
                (Reflect.get(window, 'altNPrevented') as boolean[]).push(event.defaultPrevented)
        })
    })
    for (const id of ['#probe-input', '#probe-editable']) {
        await page.locator(id).focus()
        await page.keyboard.press('Alt+KeyN')
        await expect(page.locator(id)).toBeFocused()
    }
    expect(await page.evaluate(() => Reflect.get(window, 'altNPrevented'))).toEqual([false, false])
})

test('Alt+N is ignored during IME composition', async ({ page }) => {
    await boot(page)
    await notifyWithAction(page, 'Nothing to undo')
    await expect(pill(page)).toBeVisible()
    await page.locator('.chart-pane').focus()
    await page.evaluate(() => {
        for (const init of [{ isComposing: true }, { keyCode: 229 }])
            document.activeElement?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    code: 'KeyN',
                    key: 'Process',
                    altKey: true,
                    bubbles: true,
                    cancelable: true,
                    ...init,
                }),
            )
    })
    await expect(page.locator('.chart-pane')).toBeFocused()
    await expect(pill(page).getByRole('button')).not.toBeFocused()
})

test('Option+N on macOS (a dead key, matched by code) focuses the action', async ({ page }) => {
    await boot(page)
    await notifyWithAction(page, 'Nothing to undo')
    await expect(pill(page)).toBeVisible()
    await page.locator('.chart-pane').focus()
    await page.evaluate(() => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', {
                code: 'KeyN',
                key: 'Dead',
                altKey: true,
                bubbles: true,
                cancelable: true,
            }),
        )
    })
    await expect(pill(page).getByRole('button')).toBeFocused()
})

test('Help lists Alt+N', async ({ page }) => {
    await boot(page)
    await page.keyboard.press('Escape')
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { showModal } =
            await appImport<typeof import('../../src/modals')>('/src/modals/index.ts')
        const { default: HelpModal } = await appImport<{
            default: typeof import('../../src/editor/help/HelpModal.vue').default
        }>('/src/editor/help/HelpModal.vue')
        void showModal(HelpModal, {})
    })
    await expect(
        page.getByText('Alt+N (Option+N on macOS) moves focus to the latest notice’s button.'),
    ).toBeVisible()
})

test.describe('the update line', () => {
    const older = () => {
        // Only on the first load of the page, so a reload sees what the first one stored.
        if (!sessionStorage.getItem('probe.seeded')) {
            sessionStorage.setItem('probe.seeded', '1')
            localStorage.setItem(
                'sonolus-next-sekai-editor.lastAppVersion',
                JSON.stringify('0.5.22'),
            )
        }
    }

    test('an existing user sees Updated to version with What’s New at the bottom', async ({
        page,
        context,
    }) => {
        await context.route('https://github.com/**', (route) =>
            route.fulfill({ body: 'release notes', contentType: 'text/html' }),
        )
        await boot(page, older)
        await expect(pill(page)).toContainText('Next SEKAI Editor')
        await expect(pill(page)).toContainText('Updated to version 0.6.0')
        const box = (await pill(page).boundingBox())!
        const toolbar = (await page.locator('[data-editor-toolbar] > div').boundingBox())!
        expect(box.y + box.height).toBeLessThanOrEqual(toolbar.y)
        const popup = page.waitForEvent('popup')
        await pill(page).getByRole('button', { name: 'What’s New' }).click()
        expect((await popup).url()).toBe(
            'https://github.com/qwewqa/next-sekai-editor-experiments/blob/main/CHANGELOG.md',
        )
        // Seen once: the next load is the plain version again.
        await page.reload()
        await expect(page.locator('.notification')).toHaveText('Next SEKAI Editor\nVersion 0.6.0')
    })

    test('the pill with an action goes at the first edit', async ({ page }) => {
        await boot(page, older)
        await expect(pill(page)).toBeVisible()
        await page.evaluate(() => {
            const { history, fixtures, show } = window.editorTest
            show(fixtures.interaction, 3)
            history.pushState(() => 'Edit', { ...history.state.value, selectedEntities: [] })
        })
        await expect(pill(page)).toHaveCount(0)
    })

    test('a first visit sees only the version, and so does a build between tags', async ({
        page,
    }) => {
        await page.addInitScript(() => {
            localStorage.setItem(
                'nse.test.version',
                JSON.stringify({ appVersion: '0.6.0+abcd1234', atTag: false }),
            )
        })
        await page.goto('/')
        await expect(page.locator('.notification')).toHaveText(
            'Next SEKAI Editor\nVersion 0.6.0+abcd1234',
        )
        expect(
            await page.evaluate(() =>
                localStorage.getItem('sonolus-next-sekai-editor.lastAppVersion'),
            ),
        ).toBe('"0.6.0"')
    })

    test('a commit change on the same release shows nothing new', async ({ page }) => {
        await boot(page, () => {
            localStorage.setItem(
                'nse.test.version',
                JSON.stringify({ appVersion: '0.6.0+abcd1234', atTag: false }),
            )
        })
        await expect(page.locator('.notification')).toHaveText(
            'Next SEKAI Editor\nVersion 0.6.0+abcd1234',
        )
    })
})

test.describe('load order', () => {
    test('stored settings and no lastAppVersion read as an existing user, so the line says Updated', async ({
        page,
    }) => {
        // The fixture stores settings; an earlier version stored no lastAppVersion.
        await boot(page, () => {
            localStorage.removeItem('sonolus-next-sekai-editor.lastAppVersion')
        })
        await expect(pill(page)).toContainText('Updated to version 0.6.0')
    })
})

const clearNow = (page: Page) =>
    page.evaluate(async () => {
        const { clearNotification } = await window.editorTest.appImport<
            typeof import('../../src/editor/notification')
        >('/src/editor/notification.ts')
        clearNotification()
    })

test('an unrelated no-op does not clear a notice with an action, but does clear a plain one', async ({
    page,
}) => {
    await boot(page)
    await notifyWithAction(page, 'Nothing to undo')
    await expect(pill(page)).toBeVisible()
    await clearNow(page)
    await expect(pill(page)).toBeVisible()
    await page.keyboard.press('a')
    await expect(page.locator('.notification:not(.notification-pill)')).toHaveCount(1)
    await clearNow(page)
    await expect(page.locator('.notification')).toHaveCount(0)
})

test('the update line survives a no-op tool tap', async ({ page }) => {
    await boot(page, () => {
        localStorage.setItem('sonolus-next-sekai-editor.lastAppVersion', JSON.stringify('0.5.22'))
    })
    await expect(pill(page)).toContainText('Updated to version 0.6.0')
    await clearNow(page)
    await expect(pill(page)).toBeVisible()
})

test('a new notice under a stationary pointer is held from the start', async ({ page }) => {
    await boot(page)
    await page.clock.install()
    await notifyWithAction(page, 'First')
    await pill(page).hover()
    // A second notice appears where the pointer already is; the pointer does not move.
    await notifyWithAction(page, 'Second')
    await expect(pill(page)).toContainText('Second')
    await page.clock.runFor(20_000)
    await expect(pill(page)).toBeVisible()
    await page.mouse.move(5, 5)
    await page.clock.runFor(7_000)
    await expect(pill(page)).toHaveCount(0)
})

test('Escape on the button does not return focus to an element from an earlier Alt+N', async ({
    page,
}) => {
    await boot(page)
    await page.locator('.chart-pane').focus()
    await notifyWithAction(page, 'Nothing to undo')
    await page.keyboard.press('Alt+KeyN')
    const button = pill(page).getByRole('button', { name: 'Open History' })
    await expect(button).toBeFocused()
    // Focus leaves another way, to an element elsewhere.
    await page.evaluate(() => {
        const input = document.createElement('input')
        input.id = 'elsewhere'
        document.body.append(input)
        input.focus()
    })
    // The user comes back to the button by Tab and presses Escape.
    await button.focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('.chart-pane')).not.toBeFocused()
    await expect(button).not.toBeFocused()
})

test('Alt+N is ignored in a select and while a blocking dialog is open', async ({ page }) => {
    await boot(page)
    await notifyWithAction(page, 'Nothing to undo')
    await expect(pill(page)).toBeVisible()
    await page.evaluate(() => {
        const select = document.createElement('select')
        select.id = 'probe-select'
        select.innerHTML = '<option>One</option><option>Nine</option>'
        document.body.append(select)
    })
    await page.locator('#probe-select').focus()
    await page.keyboard.press('Alt+KeyN')
    await expect(page.locator('#probe-select')).toBeFocused()
    await page.locator('#probe-select').blur()

    await page.evaluate(async () => {
        const { showChoice } =
            await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                '/src/modals/choice.ts',
            )
        void showChoice({
            title: () => 'Blocking',
            choices: [{ value: 'go', label: () => 'Go', default: true }],
        })
    })
    const go = page.getByRole('dialog').getByRole('button', { name: 'Go' })
    await expect(go).toBeFocused()
    await page.keyboard.press('Alt+KeyN')
    await expect(go).toBeFocused()
})

test('the start-up text is put into the live region after it is mounted', async ({ page }) => {
    await page.addInitScript(() => {
        const seen: string[] = []
        Reflect.set(window, 'regionTexts', seen)
        const look = () => {
            const region = document.querySelector('[data-notice-region]')
            if (!region) return
            const text = region.textContent
            if (seen.at(-1) !== text) seen.push(text)
        }
        new MutationObserver(look).observe(document, {
            subtree: true,
            childList: true,
            characterData: true,
        })
    })
    await boot(page)
    await expect(page.getByRole('status')).toHaveText(/Version 0\.6\.0/)
    const seen = await page.evaluate(() => Reflect.get(window, 'regionTexts') as string[])
    // First seen empty, as a live region announces changes and not what it starts with.
    expect(seen[0]).toBe('')
    expect(seen.at(-1)).toMatch(/Version 0\.6\.0/)
})

test('a notice raised while a dialog is open is announced by the dialog', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const { showChoice } =
            await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                '/src/modals/choice.ts',
            )
        void showChoice({
            title: () => 'Blocking',
            choices: [{ value: 'go', label: () => 'Go', default: true }],
        })
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Still one region on the page, now inside the dialog and empty until a notice.
    await expect(page.getByRole('status')).toHaveCount(1)
    await expect(dialog.getByRole('status')).toHaveText('')
    await page.evaluate(async () => {
        const { notify } = await window.editorTest.appImport<
            typeof import('../../src/editor/notification')
        >('/src/editor/notification.ts')
        notify(() => 'Saved behind the dialog')
    })
    await expect(dialog.getByRole('status')).toHaveText('Saved behind the dialog')
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('status')).toHaveCount(1)
})

type RegionEntry = { added: number; texts: { text: string; at: number }[] }

/** Records when each live region is added and each text it takes, in `window.regionLog`. */
const watchRegions = () => {
    const log: RegionEntry[] = []
    Reflect.set(window, 'regionLog', log)
    const tracked = new WeakMap<Element, RegionEntry>()
    const look = () => {
        for (const region of document.querySelectorAll('[data-notice-region]')) {
            let entry = tracked.get(region)
            if (!entry) {
                entry = { added: performance.now(), texts: [] }
                tracked.set(region, entry)
                log.push(entry)
            }
            const text = region.textContent ?? ''
            if (text && entry.texts.at(-1)?.text !== text)
                entry.texts.push({ text, at: performance.now() })
        }
    }
    new MutationObserver(look).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
    })
}

/** How long after its region was added a text first appeared in it. */
const delayOf = async (page: Page, text: string) => {
    const log = await page.evaluate(() => Reflect.get(window, 'regionLog') as RegionEntry[])
    const entry = log.find((e) => e.texts.some((t) => t.text === text))
    expect(entry, text).toBeDefined()
    return entry!.texts.find((t) => t.text === text)!.at - entry!.added
}

const openBlocking = (page: Page, notice?: string) =>
    page.evaluate(async (notice) => {
        const { showChoice } =
            await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                '/src/modals/choice.ts',
            )
        const { notify } = await window.editorTest.appImport<
            typeof import('../../src/editor/notification')
        >('/src/editor/notification.ts')
        // The notice comes first in the same tick, with no region on the page yet to hold it.
        if (notice) notify(() => notice)
        void showChoice({
            title: () => 'Blocking',
            choices: [{ value: 'go', label: () => 'Go', default: true }],
        })
    }, notice)

test('a notice raised just before a dialog opens is announced by the dialog’s region, after it is ready', async ({
    page,
}) => {
    await boot(page, watchRegions)
    await expect(page.getByRole('status')).toHaveText(/Version 0\.6\.0/)
    await openBlocking(page, 'Raised just before')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('status')).toHaveText('Raised just before')
    // Not written as the region was added: a live region may miss that.
    expect(await delayOf(page, 'Raised just before')).toBeGreaterThanOrEqual(80)
})

test('a notice raised right after a page region is put back is not written as it is added', async ({
    page,
}) => {
    await boot(page, watchRegions)
    await expect(page.getByRole('status')).toHaveText(/Version 0\.6\.0/)
    await openBlocking(page)
    // A press right after opening is ignored, so press until it closes.
    await expect(async () => {
        await page.getByRole('dialog').getByRole('button', { name: 'Go' }).click({ timeout: 500 })
        await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 500 })
    }).toPass()
    await page.evaluate(async () => {
        const { notify } = await window.editorTest.appImport<
            typeof import('../../src/editor/notification')
        >('/src/editor/notification.ts')
        notify(() => 'Raised after closing')
    })
    await expect(page.getByRole('status')).toHaveText('Raised after closing')
    expect(await delayOf(page, 'Raised after closing')).toBeGreaterThanOrEqual(80)
})

test('a dialog opened before the start-up line is put in announces it', async ({ page }) => {
    // Hold the region's 100 ms wait, so the dialog opens before it.
    await boot(page, () => {
        const held: (() => void)[] = []
        Reflect.set(window, 'releaseHeld', () => held.splice(0).forEach((run) => run()))
        const original = window.setTimeout
        window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
            delay === 100 && typeof handler === 'function'
                ? (held.push(() => handler(...args)), 0)
                : original(handler, delay, ...args)) as typeof window.setTimeout
    })
    await expect(page.getByRole('status')).toHaveText('')
    await openBlocking(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('status')).toHaveText('')
    await page.evaluate(() => (Reflect.get(window, 'releaseHeld') as () => void)())
    await expect(dialog.getByRole('status')).toHaveText(/Version 0.6.0/)
})
