import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Notice cards, quick feedback, the live region and Alt+N (Part 1 §1.4.1, §1.4.3).

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

    test('the action button keeps its ordinary 32 px height', async ({ page }) => {
        await boot(page)
        await notifyWithAction(page, 'Nothing to undo')
        const button = pill(page).getByRole('button', { name: 'Open History' })
        await expect(button).toBeVisible()
        expect((await button.boundingBox())!.height).toBe(32)
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
    await expect(pill(page).getByRole('button', { name: 'Open History' })).not.toBeFocused()
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
    await expect(pill(page).getByRole('button', { name: 'Open History' })).toBeFocused()
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
        page.getByText(
            'Alt+N (Option+N on macOS) moves focus to the latest notice. Esc then closes it.',
        ),
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
    // Escape closes the card as well.
    await expect(pill(page)).toHaveCount(0)
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
    // The key must not run New either.
    await expect(
        page.locator('.notification, [data-notice-card]').filter({ hasText: 'New level' }),
    ).toHaveCount(0)

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

// Notice cards: dismissing, timing, the two slots and the dialog layer (Part 1 §1.4.1, §1.4.3).

type Notification = typeof import('../../src/editor/notification')
const notificationPath = '/src/editor/notification.ts'

/** Shows a card with no action. */
const notifyCard = (page: Page, message: string) =>
    page.evaluate(
        async ({ message, notificationPath }) => {
            const { notify } = await window.editorTest.appImport<Notification>(notificationPath)
            notify(() => message, { card: true })
        },
        { message, notificationPath },
    )

const closeButton = (page: Page) => page.locator('[data-notice-card] [data-notice-close]')
const quick = (page: Page) => page.locator('.notification:not(.notification-pill)')

/** A touch drag along the card, one step every `ms / 4` milliseconds. */
const swipe = (page: Page, fraction: number, ms: number) =>
    page.locator('[data-notice-card]').evaluate(
        async (card, { fraction, ms }) => {
            const box = card.getBoundingClientRect()
            const x0 = box.left + box.width / 2
            const y = box.top + box.height / 2
            const dx = box.width * fraction
            const fire = (type: string, x: number) =>
                card.dispatchEvent(
                    new PointerEvent(type, {
                        pointerType: 'touch',
                        pointerId: 7,
                        isPrimary: true,
                        clientX: x,
                        clientY: y,
                        bubbles: true,
                        cancelable: true,
                    }),
                )
            fire('pointerdown', x0)
            for (let i = 1; i <= 4; i++) {
                await new Promise((resolve) => setTimeout(resolve, ms / 4))
                fire('pointermove', x0 + (dx * i) / 4)
            }
            fire('pointerup', x0 + dx)
        },
        { fraction, ms },
    )

test.describe('dismissing a card', () => {
    test('the × closes a card with an action without running it, and one without', async ({
        page,
    }) => {
        await boot(page)
        await notifyWithAction(page, 'Nothing to undo')
        await expect(pill(page)).toBeVisible()
        await closeButton(page).click()
        await expect(pill(page)).toHaveCount(0)
        expect(await runs(page)).toBe(0)
        await notifyCard(page, 'This version is older than your data.')
        await expect(pill(page)).toContainText('older than your data')
        await expect(pill(page).getByRole('button')).toHaveCount(1)
        await closeButton(page).click()
        await expect(pill(page)).toHaveCount(0)
    })

    test('the × is labelled and describes itself by the message', async ({ page }) => {
        await boot(page)
        await notifyWithAction(page, 'Nothing to undo')
        const button = pill(page).getByRole('button', { name: 'Close' })
        await expect(button).toHaveAccessibleDescription('Nothing to undo')
    })

    test('Esc with focus in the card closes it and returns focus; Esc elsewhere leaves it', async ({
        page,
    }) => {
        await boot(page)
        await page.locator('.chart-pane').focus()
        await notifyWithAction(page, 'Nothing to undo')
        await expect(pill(page)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(pill(page)).toBeVisible()
        await page.keyboard.press('Alt+KeyN')
        await expect(pill(page).getByRole('button', { name: 'Open History' })).toBeFocused()
        // Tab reaches the ×, which Esc closes the same way.
        await page.keyboard.press('Tab')
        await expect(closeButton(page)).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(pill(page)).toHaveCount(0)
        await expect(page.locator('.chart-pane')).toBeFocused()
    })

    test('Alt+N focuses the × of a card without an action', async ({ page }) => {
        await boot(page)
        await page.locator('.chart-pane').focus()
        await notifyCard(page, 'Something to read')
        await page.keyboard.press('Alt+KeyN')
        await expect(closeButton(page)).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(pill(page)).toHaveCount(0)
    })

    test.describe('on a phone', () => {
        test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

        test('the × stays 32 px and a tap on it closes the card', async ({ page }) => {
            await boot(page)
            await notifyWithAction(page, 'Nothing to undo')
            const box = (await closeButton(page).boundingBox())!
            expect(box.width).toBe(32)
            expect(box.height).toBe(32)
            await closeButton(page).tap()
            await expect(pill(page)).toHaveCount(0)
            expect(await runs(page)).toBe(0)
        })

        test('a swipe past 30% dismisses the card and does not press a button', async ({
            page,
        }) => {
            await boot(page)
            await notifyWithAction(page, 'Nothing to undo')
            await expect(pill(page)).toBeVisible()
            await swipe(page, 0.5, 400)
            await expect(pill(page)).toHaveCount(0)
            expect(await runs(page)).toBe(0)
        })

        test('a swipe to the left dismisses it too, and a flick needs only a short drag', async ({
            page,
        }) => {
            await boot(page)
            await notifyWithAction(page, 'Nothing to undo')
            await swipe(page, -0.5, 400)
            await expect(pill(page)).toHaveCount(0)
            await notifyWithAction(page, 'Nothing to redo')
            await swipe(page, 0.2, 20)
            await expect(pill(page)).toHaveCount(0)
        })

        test('a short slow drag springs back', async ({ page }) => {
            await boot(page)
            await notifyWithAction(page, 'Nothing to undo')
            await expect(pill(page)).toBeVisible()
            await swipe(page, 0.15, 800)
            await page.waitForTimeout(400)
            await expect(pill(page)).toBeVisible()
            await expect
                .poll(() => pill(page).evaluate((card) => getComputedStyle(card).transform))
                .toBe('none')
            // The card works as before.
            await pill(page).getByRole('button', { name: 'Open History' }).tap()
            expect(await runs(page)).toBe(1)
        })
    })
})

test.describe('timing', () => {
    test('a long message stays longer, up to 12 s', async ({ page }) => {
        await boot(page)
        await page.clock.install()
        await notifyCard(page, 'x'.repeat(150))
        await expect(pill(page)).toBeVisible()
        // 2 s and 60 ms a character is 11 s.
        await page.clock.runFor(10_500)
        await expect(pill(page)).toBeVisible()
        await page.clock.runFor(1_000)
        await expect(pill(page)).toHaveCount(0)
        await notifyCard(page, 'x'.repeat(400))
        await page.clock.runFor(11_500)
        await expect(pill(page)).toBeVisible()
        await page.clock.runFor(1_000)
        await expect(pill(page)).toHaveCount(0)
    })

    test('the timer waits while the page is hidden, then leaves at least 1.5 s', async ({
        page,
    }) => {
        await boot(page)
        await page.clock.install()
        const visibility = (state: 'hidden' | 'visible') =>
            page.evaluate((state) => {
                Object.defineProperty(document, 'visibilityState', {
                    configurable: true,
                    value: state,
                })
                document.dispatchEvent(new Event('visibilitychange'))
            }, state)
        await visibility('hidden')
        await notifyWithAction(page, 'Nothing to undo')
        await page.clock.runFor(10_000)
        await expect(pill(page)).toBeVisible()
        await visibility('visible')
        await page.clock.runFor(5_000)
        await expect(pill(page)).toBeVisible()
        await page.clock.runFor(1_500)
        await expect(pill(page)).toHaveCount(0)
        // Hidden partway: the rest of the time is kept.
        await notifyWithAction(page, 'Nothing to redo')
        await page.clock.runFor(4_000)
        await visibility('hidden')
        await page.clock.runFor(10_000)
        await expect(pill(page)).toBeVisible()
        await visibility('visible')
        await page.clock.runFor(1_000)
        await expect(pill(page)).toBeVisible()
        await page.clock.runFor(1_000)
        await expect(pill(page)).toHaveCount(0)
    })

    test('the timer waits while a blocking dialog covers the card', async ({ page }) => {
        await boot(page)
        await page.clock.install()
        await notifyWithAction(page, 'Nothing to undo')
        await page.clock.runFor(2_000)
        await openBlocking(page)
        await expect(page.getByRole('dialog')).toBeVisible()
        await page.clock.runFor(8_000)
        await expect(pill(page)).toHaveCount(1)
        // The fake clock holds the dialog's brief ignore of presses, so it is closed directly.
        await page.evaluate(async () => {
            const { closeModal, modals } =
                await window.editorTest.appImport<typeof import('../../src/modals')>(
                    '/src/modals/index.ts',
                )
            for (const modal of [...modals]) closeModal(modal)
        })
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(pill(page)).toBeVisible()
        await page.clock.runFor(3_500)
        await expect(pill(page)).toBeVisible()
        await page.clock.runFor(1_000)
        await expect(pill(page)).toHaveCount(0)
    })
})

test.describe('the two slots', () => {
    test('quick feedback leaves a card in place and shows centred above it', async ({ page }) => {
        await boot(page)
        await notifyWithAction(page, 'Nothing to undo')
        await expect(pill(page)).toBeVisible()
        await expect(pill(page)).not.toHaveClass(/notice-card-enter-(from|active|to)/)
        await expect(pill(page)).toHaveCSS('transform', 'none')
        const before = (await pill(page).boundingBox())!
        await page.keyboard.press('a')
        await expect(quick(page)).toHaveCount(1)
        await expect(pill(page)).toBeVisible()
        await expect(pill(page)).toContainText('Nothing to undo')
        const after = (await pill(page).boundingBox())!
        expect(after).toEqual(before)
        const toast = (await quick(page).boundingBox())!
        expect(toast.y + toast.height).toBeLessThanOrEqual(after.y)
        // The toast fades by itself and the card stays.
        await expect(quick(page)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(pill(page)).toBeVisible()
    })

    test('a later card replaces the card', async ({ page }) => {
        await boot(page)
        await notifyWithAction(page, 'First')
        await notifyWithAction(page, 'Second')
        await expect(pill(page)).toHaveCount(1)
        await expect(pill(page)).toContainText('Second')
    })

    test('both are read by the one live region, in the order they were raised', async ({
        page,
    }) => {
        await boot(page)
        await notifyWithAction(page, 'Nothing to undo', 'Nothing to undo. Open History.')
        await expect(page.getByRole('status')).toHaveText('Nothing to undo. Open History.')
        await page.keyboard.press('a')
        await expect(page.getByRole('status')).toHaveCount(1)
        await expect(page.getByRole('status')).not.toHaveText(/Nothing to undo/)
        await expect(pill(page)).toBeVisible()
    })
})

test.describe('when a card goes by itself', () => {
    const prepare = (page: Page) =>
        page.evaluate(() => {
            const { fixtures, show } = window.editorTest
            show(fixtures.interaction, 3)
        })

    test('the next edit dismisses a card raised before it', async ({ page }) => {
        await boot(page)
        await prepare(page)
        await notifyWithAction(page, 'Nothing to undo')
        await expect(pill(page)).toBeVisible()
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.pushState(() => 'Edit', { ...history.state.value, selectedEntities: [] })
        })
        await expect(pill(page)).toHaveCount(0)
    })

    test('a card the edit raised stays, before or after the step', async ({ page }) => {
        await boot(page)
        await prepare(page)
        await page.evaluate(async (path) => {
            const { notify } = await window.editorTest.appImport<Notification>(path)
            const { history } = window.editorTest
            const raise = (message: string) =>
                notify(() => message, { action: { label: () => 'Undo', run: () => undefined } })
            const push = () =>
                history.pushState(() => 'Edit', { ...history.state.value, selectedEntities: [] })
            raise('Older')
            push()
            raise('Raised after the step')
        }, notificationPath)
        await expect(pill(page)).toContainText('Raised after the step')
        await page.evaluate(async (path) => {
            const { notify } = await window.editorTest.appImport<Notification>(path)
            const { history } = window.editorTest
            notify(() => 'Raised before the step', {
                action: { label: () => 'Undo', run: () => undefined },
            })
            history.pushState(() => 'Edit', { ...history.state.value, selectedEntities: [] })
        }, notificationPath)
        await expect(pill(page)).toContainText('Raised before the step')
        // The next step, in a task of its own, dismisses it.
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.pushState(() => 'Edit', { ...history.state.value, selectedEntities: [] })
        })
        await expect(pill(page)).toHaveCount(0)
    })

    test('quick feedback does not dismiss a card', async ({ page }) => {
        await boot(page)
        await prepare(page)
        await notifyWithAction(page, 'Nothing to undo')
        await page.keyboard.press('a')
        await expect(pill(page)).toBeVisible()
    })

    test('a session switch dismisses every card before its own notice', async ({ page }) => {
        await boot(page)
        await notifyWithAction(page, 'Nothing to undo')
        await expect(pill(page)).toBeVisible()
        await page.evaluate(async () => {
            const { notifyLeft } =
                await window.editorTest.appImport<typeof import('../../src/editor/switch')>(
                    '/src/editor/switch.ts',
                )
            notifyLeft(() => 'New level')
        })
        await expect(pill(page)).toHaveCount(0)
        await expect(quick(page)).toHaveText('New level')
    })

    test('saving and exporting leave a card alone', async ({ page }) => {
        await boot(page)
        await prepare(page)
        await notifyWithAction(page, 'Nothing to undo')
        await page.evaluate(async () => {
            const { emitHistoryAction } =
                await window.editorTest.appImport<typeof import('../../src/history/actions')>(
                    '/src/history/actions.ts',
                )
            const { history } = window.editorTest
            emitHistoryAction({
                kind: 'save',
                state: history.state.value,
                name: () => 'Save',
                isDirty: false,
            })
        })
        await expect(pill(page)).toBeVisible()
    })
})

test.describe('over a blocking dialog', () => {
    const raiseOver = async (page: Page, message: string) => {
        await boot(page)
        await openBlocking(page)
        await expect(page.getByRole('dialog')).toBeVisible()
        await notifyWithAction(page, message)
    }

    test('a card raised with a dialog open shows over it, at the bottom, and moves to the pane when it closes', async ({
        page,
    }) => {
        await raiseOver(page, 'Raised over the dialog')
        const dialog = page.getByRole('dialog')
        const card = dialog.locator('[data-notice-card]')
        await expect(card).toBeVisible()
        await expect(card).toContainText('Raised over the dialog')
        const box = (await card.boundingBox())!
        const viewport = page.viewportSize()!
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8)
        expect(box.y + box.height).toBeGreaterThan(viewport.height - 40)
        // On the menus' surface.
        await expect(card).toHaveClass(/bg-popup/)
        // Alt+N reaches it, and its action runs.
        await page.keyboard.press('Alt+KeyN')
        await expect(card.getByRole('button', { name: 'Open History' })).toBeFocused()
        await card.getByRole('button', { name: 'Open History' }).click()
        expect(await runs(page)).toBe(1)
        // Closing the dialog leaves the card in the pane.
        await expect(async () => {
            await dialog.getByRole('button', { name: 'Go' }).click({ timeout: 500 })
            await expect(dialog).toHaveCount(0, { timeout: 500 })
        }).toPass()
        await expect(page.locator('[data-notice-card]')).toHaveCount(1)
        await expect(page.locator('[data-notice-card]')).not.toHaveClass(/bg-popup/)
    })

    test('Esc in the card closes the card, not the dialog', async ({ page }) => {
        await raiseOver(page, 'Raised over the dialog')
        await page.keyboard.press('Alt+KeyN')
        await page.keyboard.press('Escape')
        await expect(page.locator('[data-notice-card]')).toHaveCount(0)
        await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('a card raised before a dialog opens waits under it, and a quick toast raised in it shows in it', async ({
        page,
    }) => {
        await boot(page)
        await notifyWithAction(page, 'Before the dialog')
        await openBlocking(page)
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.locator('[data-notice-card]')).toHaveCount(0)
        await page.evaluate(async (path) => {
            const { notify } = await window.editorTest.appImport<Notification>(path)
            notify(() => 'Copied')
        }, notificationPath)
        await expect(dialog.locator('.notification')).toHaveText('Copied')
        await expect(page.locator('.notification')).toHaveCount(1)
    })
})
