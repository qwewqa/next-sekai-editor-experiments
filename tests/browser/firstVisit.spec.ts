import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { closePage, waitForStartup } from './editorFixture'

// The first-visit dialog in the dev build, which has the privacy page: shown once per browser at
// the first load that can show it, never over a load notice that needs the user, and closing
// itself when such a notice comes while it is open.

const prefix = 'sonolus-next-sekai-editor.'
const MARK = `${prefix}firstVisitShown`

// The config's storageState marks the dialog as shown; these pages start without the mark.
test.use({
    storageState: {
        cookies: [],
        origins: [
            {
                origin: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '5210'}`,
                localStorage: [
                    { name: 'nse.test.previewHost', value: 'main' },
                    { name: 'nse.test.noOpeningGuard', value: 'true' },
                ],
            },
        ],
    },
})

/** Seeds every page of the context: the storage hooks, a fixed version, the panels away. */
const seed = (context: BrowserContext, extra: Record<string, string> = {}) =>
    context.addInitScript((extra) => {
        if (location.href === 'about:blank') return
        performance.setResourceTimingBufferSize(5000)
        localStorage.setItem('nse.test.storage', '{}')
        localStorage.setItem(
            'nse.test.version',
            JSON.stringify({ appVersion: '0.6.0', atTag: true }),
        )
        if (!localStorage.getItem('sonolus-next-sekai-editor.lastAppVersion'))
            localStorage.setItem(
                'sonolus-next-sekai-editor.lastAppVersion',
                JSON.stringify('0.6.0'),
            )
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value)
    }, extra)

/** The startup test flags for this tab's next loads. */
const startupFlags = (page: Page, flags: object) =>
    page.addInitScript((flags) => {
        if (!sessionStorage.getItem('fv.flagsSet')) {
            sessionStorage.setItem('fv.flagsSet', '1')
            sessionStorage.setItem('nse.test.startup', JSON.stringify(flags))
        }
    }, flags)

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Next SEKAI Editor' })
const footerClose = (page: Page) => dialog(page).locator('[data-modal-footer] button')
const pill = (page: Page) => page.locator('.notification-pill')

const firstVisitState = (page: Page) =>
    page.evaluate(async () => {
        const { firstVisitState } =
            (await import('/src/editor/firstVisit/firstVisit.ts')) as typeof import('../../src/editor/firstVisit/firstVisit')
        return firstVisitState.value
    })

/** Waits until this load has decided, and shown the dialog or not. */
const decided = (page: Page) =>
    expect.poll(() => firstVisitState(page), { timeout: 20_000 }).toMatch(/^(open|done|notDue)$/)

const visit = async (page: Page, url = '/') => {
    await page.goto(url)
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page, { firstVisit: true })
    await decided(page)
}

const mark = (page: Page) => page.evaluate((key) => localStorage.getItem(key), MARK)
const forget = (page: Page) => page.evaluate((key) => localStorage.removeItem(key), MARK)

const addEvent = (page: Page, event: object) =>
    page.evaluate(async (event) => {
        const { addLoadEvent } =
            (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
        addLoadEvent(event as never)
    }, event)

const release = (page: Page) => page.evaluate(() => window.nseStartupRelease?.())

/** A load held at the gate, given these load events before it lifts. */
const heldVisit = async (page: Page, events: object[]) => {
    await page.evaluate(() => sessionStorage.setItem('nse.test.startup', '{"hold":true}'))
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect.poll(() => page.evaluate(() => typeof window.nseStartupRelease)).toBe('function')
    for (const event of events) await addEvent(page, event)
    await page.evaluate(() => sessionStorage.removeItem('nse.test.startup'))
    await release(page)
    await waitForStartup(page, { firstVisit: true })
    await decided(page)
}

const lifeOf = (page: Page) =>
    page.evaluate(async () => {
        const { state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        return state.value.initialLife
    })

const edit = (page: Page, initialLife: number) =>
    page.evaluate(async (initialLife) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        const { initialLife: operation } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        pushState(operation(state.value.initialLife, initialLife), { ...state.value, initialLife })
    }, initialLife)

const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(() => {
                const flusher = window.nseFlushTest!.flusher
                return !flusher.hasPending && !!flusher.session?.stored
            }),
        )
        .toBe(true)

test.describe('a first visit', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    test('shows the dialog once, with Close focused, and a reload with it open counts as shown', async ({
        page,
    }) => {
        await visit(page)
        const shown = dialog(page)
        await expect(shown).toBeVisible()
        await expect(shown).toContainText('Version 0.6.0')
        await expect(shown.getByRole('combobox', { name: 'Language' })).toBeVisible()
        await expect(shown.getByRole('combobox', { name: 'Theme' })).toBeVisible()
        await expect(shown.getByRole('link', { name: 'Privacy' })).toHaveAttribute(
            'href',
            '/privacy/',
        )
        await expect(shown.locator('[data-about-link]')).toHaveCount(1)
        await expect(shown.getByRole('combobox')).toHaveCount(2)
        await expect(footerClose(page)).toHaveText('Close')
        await expect(footerClose(page)).toBeFocused()
        expect(await mark(page)).toBe('1')
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(page)
        await expect(dialog(page)).toHaveCount(0)
    })

    for (const how of ['Close', '×', 'Escape', 'the backdrop'] as const)
        test(`${how} closes it, and the next load shows nothing`, async ({ page }) => {
            await visit(page)
            await expect(dialog(page)).toBeVisible()
            if (how === 'Close') await footerClose(page).click()
            else if (how === '×')
                await dialog(page).getByRole('button', { name: 'Close' }).first().click()
            else if (how === 'Escape') await page.keyboard.press('Escape')
            else await page.mouse.click(5, 5)
            await expect(dialog(page)).toHaveCount(0)
            expect(await firstVisitState(page)).toBe('done')
            await visit(page)
            await expect(dialog(page)).toHaveCount(0)
        })

    test('Theme and Language apply at once, and Settings agrees', async ({ page }) => {
        await visit(page)
        const shown = dialog(page)
        await shown.getByRole('combobox', { name: 'Theme' }).selectOption({ label: 'Dark' })
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
        await shown.getByRole('combobox', { name: 'Language' }).selectOption('fr')
        await expect(footerClose(page)).toHaveText('Fermer')
        await expect(page.locator('html')).toHaveAttribute('lang', /^fr/)
        await footerClose(page).click()
        await page.keyboard.press(',')
        const settings = page.getByRole('dialog', { name: 'Paramètres' })
        await expect(settings.getByRole('combobox', { name: 'Langue' })).toHaveValue('fr')
        await expect(settings.getByRole('combobox', { name: 'Thème' })).toHaveValue('dark')
    })

    test('its name and description', async ({ page }) => {
        await visit(page)
        await expect(dialog(page)).toHaveAccessibleName('Next SEKAI Editor')
        await expect(dialog(page)).toHaveAccessibleDescription('Version 0.6.0')
        await expect(dialog(page).locator('[data-modal-title]')).toHaveText('Next SEKAI Editor')
    })
})

test.describe('it does not show', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    test('in safe mode', async ({ page }) => {
        await visit(page, '/?safe')
        expect(await firstVisitState(page)).toBe('notDue')
        await expect(dialog(page)).toHaveCount(0)
    })

    test('where the mark cannot be stored, at any load', async ({ page }) => {
        await page.addInitScript((key) => {
            const setItem = Storage.prototype.setItem
            Storage.prototype.setItem = function (name, value) {
                if (name === key) throw new DOMException('Full', 'QuotaExceededError')
                setItem.call(this, name, value)
            }
        }, MARK)
        for (let load = 0; load < 2; load++) {
            await visit(page)
            expect(await firstVisitState(page)).toBe('done')
            await expect(dialog(page)).toHaveCount(0)
        }
    })

    test('over the gate’s error', async ({ page }) => {
        await startupFlags(page, { fail: 'Broken on purpose' })
        await page.goto('/')
        await expect(page.locator('[data-startup-error]')).toContainText('Broken on purpose')
        await expect.poll(() => firstVisitState(page)).toBe('done')
        await expect(dialog(page)).toHaveCount(0)
        expect(await mark(page)).toBeNull()
    })

    test('while the gate holds, and shows once it lifts', async ({ page }) => {
        await startupFlags(page, { hold: true })
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect
            .poll(() => page.evaluate(() => typeof window.nseStartupRelease))
            .toBe('function')
        await page.waitForTimeout(300)
        expect(await firstVisitState(page)).toBe('pending')
        await expect(dialog(page)).toHaveCount(0)
        await release(page)
        await expect(dialog(page)).toBeVisible()
    })
})

test.describe('the load notices it may sit over', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    test('a recovered session’s Restore defers it, works, and the next clean load shows it', async ({
        page,
    }) => {
        await visit(page)
        await footerClose(page).click()
        await edit(page, 990)
        await settled(page)
        const sessionId = await page.evaluate(() => window.nseFlushTest!.flusher.session!.id)
        // The session is left behind, stored and not open anywhere.
        await page.evaluate(async () => {
            const { resetState } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            resetState(false)
        })
        await forget(page)
        await heldVisit(page, [{ kind: 'unsavedRecovered', sessionId }])
        await expect(dialog(page)).toHaveCount(0)
        expect(await mark(page)).toBeNull()
        await pill(page).getByRole('button', { name: 'Restore Session' }).click()
        await expect.poll(() => lifeOf(page)).toBe(990)
        await visit(page)
        await expect(dialog(page)).toBeVisible()
    })

    test('the update load’s migrated line defers it to the next load', async ({ page }) => {
        await visit(page)
        await footerClose(page).click()
        await forget(page)
        const name = { name: { kind: 'name', text: 'Coconut (Master)' }, at: Date.now() }
        await heldVisit(page, [{ kind: 'migrated', name, sessionId: 'a', opened: true }])
        await expect(pill(page)).toContainText(
            'Continued “Coconut (Master)” from the old auto save.',
        )
        await expect(dialog(page)).toHaveCount(0)
        await visit(page)
        await expect(dialog(page)).toBeVisible()
    })

    test('a warning defers it', async ({ page }) => {
        await visit(page)
        await footerClose(page).click()
        await forget(page)
        await heldVisit(page, [{ kind: 'storageCleared' }])
        await expect(pill(page)).toContainText('Work from earlier visits is missing.')
        await expect(dialog(page)).toHaveCount(0)
        expect(await firstVisitState(page)).toBe('done')
    })

    test('Continued alone sits under it, and the card shows after Close', async ({
        page,
        context,
    }) => {
        await visit(page)
        await footerClose(page).click()
        await edit(page, 990)
        await settled(page)
        await forget(page)
        await closePage(page, { runBeforeUnload: false })
        const next = await context.newPage()
        await visit(next)
        await expect(dialog(next)).toBeVisible()
        await expect(pill(next)).toContainText('Continued your session from')
        await footerClose(next).click()
        await expect(pill(next)).toContainText('Continued your session from')
        await expect(pill(next)).toBeVisible()
    })

    test('the in-app browser line sits under it, and shows after Close', async ({
        page,
        context,
    }) => {
        await context.addInitScript(() => {
            if (location.href === 'about:blank') return
            localStorage.setItem('nse.test.platform', JSON.stringify({ inAppBrowser: true }))
        })
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await footerClose(page).click()
        await expect(pill(page)).toContainText(en.load.inAppBrowser)
    })

    test('the update line’s card waits under it: 10 s open, and the card is still there', async ({
        page,
    }) => {
        await page.addInitScript(() => {
            if (!sessionStorage.getItem('fv.older')) {
                sessionStorage.setItem('fv.older', '1')
                localStorage.setItem(
                    'sonolus-next-sekai-editor.lastAppVersion',
                    JSON.stringify('0.5.22'),
                )
            }
        })
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await expect(pill(page)).toContainText('Updated to version 0.6.0')
        await page.waitForTimeout(10_000)
        await footerClose(page).click()
        await expect(pill(page)).toContainText('Updated to version 0.6.0')
        await page.waitForTimeout(1000)
        await expect(pill(page)).toBeVisible()
    })
})

/** The storage estimate held until the spec releases it, so the load's run says "almost full" late. */
const heldEstimate = (page: Page) =>
    page.addInitScript(() => {
        let open: () => void = () => undefined
        const gate = new Promise<void>((resolve) => (open = resolve))
        ;(window as unknown as { releaseEstimate: () => void }).releaseEstimate = () => open()
        StorageManager.prototype.estimate = async () => {
            await gate
            return { usage: 900_000_000, quota: 1_000_000_000 }
        }
    })
const releaseEstimate = (page: Page) =>
    page.evaluate(() => (window as unknown as { releaseEstimate: () => void }).releaseEstimate())

test.describe('a late load notice', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    test('closes the dialog, and the card shows it for its full time; the mark stays', async ({
        page,
    }) => {
        await heldEstimate(page)
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await releaseEstimate(page)
        await expect(dialog(page)).toHaveCount(0)
        const line = pill(page).filter({ hasText: en.load.storageNearlyFull })
        await expect(line).toBeVisible()
        await expect(line.getByRole('button', { name: 'Local Data' })).toBeVisible()
        expect(await firstVisitState(page)).toBe('done')
        // The start-up card stays at least 8 s.
        await page.waitForTimeout(6000)
        await expect(line).toBeVisible()
        expect(await mark(page)).toBe('1')
        await visit(page)
        await expect(dialog(page)).toHaveCount(0)
    })

    test('still closes it after 15 s open on a clean first visit', async ({ page }) => {
        await page.clock.install()
        await heldEstimate(page)
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await page.clock.runFor(15_000)
        await releaseEstimate(page)
        await expect(dialog(page)).toHaveCount(0)
        await expect(pill(page)).toContainText(en.load.storageNearlyFull)
    })

    test('13 s after the dialog closed, it is only kept in Local Data', async ({ page }) => {
        await page.clock.install()
        await heldEstimate(page)
        await visit(page)
        await footerClose(page).click()
        await page.clock.runFor(13_000)
        await releaseEstimate(page)
        await page.waitForTimeout(500)
        await expect(pill(page)).toHaveCount(0)
        await expect(
            page.locator('.notification').filter({ hasText: en.load.storageNearlyFull }),
        ).toHaveCount(0)
    })
})

test.describe('visibility and tabs', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    test('a hidden page waits, and shows it when it becomes visible', async ({ page }) => {
        await page.addInitScript(() => {
            if (sessionStorage.getItem('fv.shown')) return
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'hidden',
            })
        })
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect.poll(() => firstVisitState(page)).toBe('waiting')
        await expect(dialog(page)).toHaveCount(0)
        expect(await mark(page)).toBeNull()
        await page.evaluate(() => {
            delete (document as { visibilityState?: unknown }).visibilityState
            document.dispatchEvent(new Event('visibilitychange'))
        })
        await expect(dialog(page)).toBeVisible()
    })

    test('a second tab shows none once the first has shown it', async ({ page, context }) => {
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        const other = await context.newPage()
        await visit(other)
        await expect(dialog(other)).toHaveCount(0)
    })
})

// Within 8 px of the viewport, Close in view without scrolling, and no sideways scroll.
for (const [width, height] of [
    [360, 640],
    [390, 844],
    [844, 390],
    [820, 1180],
] as const)
    for (const locale of ['en', 'fr', 'tr'])
        test(`${locale} at ${width} x ${height}: it fits, Close shows, and nothing scrolls sideways`, async ({
            browser,
        }) => {
            const context = await browser.newContext({
                hasTouch: true,
                isMobile: true,
                viewport: { width, height },
            })
            // With somewhere to send statistics, as the release, so the switch and its note show.
            await context.route(
                (url) => url.hostname !== '127.0.0.1',
                (route) => route.abort(),
            )
            await seed(context, {
                [`${prefix}locale`]: JSON.stringify(locale),
                'nse.test.analytics': JSON.stringify({
                    origin: 'https://stats.analytics.test',
                    website: '11111111-2222-3333-4444-555555555555',
                }),
            })
            const page = await context.newPage()
            await visit(page)
            const shown = page.locator('dialog[open]')
            await expect(dialog(page)).toBeVisible()
            await expect(dialog(page).getByRole('switch', { name: /./ })).toBeVisible()
            const box = (await shown.boundingBox())!
            expect(box.x).toBeGreaterThanOrEqual(8 - 0.5)
            expect(box.y).toBeGreaterThanOrEqual(8 - 0.5)
            expect(box.x + box.width).toBeLessThanOrEqual(width - 8 + 0.5)
            expect(box.y + box.height).toBeLessThanOrEqual(height - 8 + 0.5)
            // Close is in view with the body at its top, as it opens.
            await expect(shown.locator('[data-first-visit]')).toBeInViewport({ ratio: 1 })
            await expect(footerClose(page)).toBeInViewport({ ratio: 1 })
            const sideways = await shown.evaluate((dialog) =>
                [dialog, ...dialog.querySelectorAll('*')]
                    .filter((element) => /auto|scroll/.test(getComputedStyle(element).overflowX))
                    .filter((element) => element.scrollWidth > element.clientWidth + 1)
                    .map((element) => element.className),
            )
            expect(sideways).toEqual([])
            // Where the body scrolls, its end comes into view and Close stays.
            const body = shown.locator('.scroll-edges').first()
            await body.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
            await expect(shown.locator('[data-about-link="privacy"]')).toBeInViewport()
            await expect(footerClose(page)).toBeInViewport({ ratio: 1 })
            await context.close()
        })
