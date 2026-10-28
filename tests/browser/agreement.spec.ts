import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { waitForStartup } from './editorFixture'

// The agreement dialog in the dev build, which has both legal pages at revision 1: due at a load
// without a record that covers them, closed only by Agree, with every load notice waiting under it.

const prefix = 'sonolus-next-sekai-editor.'
const KEY = `${prefix}agreement`
const SENTENCE = en.agreement.sentence

// The config's storageState seeds the record; these pages start without it.
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

/** The startup test flags for this tab's first load. */
const startupFlags = (page: Page, flags: object) =>
    page.addInitScript((flags) => {
        if (!sessionStorage.getItem('agr.flagsSet')) {
            sessionStorage.setItem('agr.flagsSet', '1')
            sessionStorage.setItem('nse.test.startup', JSON.stringify(flags))
        }
    }, flags)

/** A record this tab's first load starts with. */
const startWith = (page: Page, record: unknown) =>
    page.addInitScript(
        ({ key, record }) => {
            if (sessionStorage.getItem('agr.recordSet')) return
            sessionStorage.setItem('agr.recordSet', '1')
            localStorage.setItem(key, JSON.stringify(record))
        },
        { key: KEY, record },
    )

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Next SEKAI Editor' })
const agreeButton = (page: Page) => dialog(page).getByRole('button', { name: 'Agree' })
const agree = (page: Page) => agreeButton(page).click()
const pill = (page: Page) => page.locator('.notification-pill')

const agreementState = (page: Page) =>
    page.evaluate(async () => {
        const { agreementState } =
            (await import('/src/editor/agreement/agreement.ts')) as typeof import('../../src/editor/agreement/agreement')
        return agreementState.value
    })

/** Waits until this load has shown the dialog, or decided not to. */
const decided = (page: Page) =>
    expect.poll(() => agreementState(page), { timeout: 20_000 }).toMatch(/^(open|done|notDue)$/)

const visit = async (page: Page, url = '/') => {
    await page.goto(url)
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page, { agreement: true })
    await decided(page)
}

const record = (page: Page) =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown, KEY)
const forget = (page: Page) => page.evaluate((key) => localStorage.removeItem(key), KEY)

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
    await waitForStartup(page, { agreement: true })
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

const modalCount = (page: Page) =>
    page.evaluate(async () => {
        const { modals } =
            (await import('/src/modals/index.ts')) as typeof import('../../src/modals/index')
        return modals.length
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

/** The page's live region, outside every dialog, as it is added and a moment later. */
const watchPageRegion = (page: Page) =>
    page.evaluate(() => {
        const seen: string[] = []
        Reflect.set(window, 'pageRegion', seen)
        new MutationObserver((records) => {
            for (const added of records.flatMap((record) => [...record.addedNodes]))
                if (
                    added instanceof Element &&
                    added.matches('[data-notice-region]') &&
                    !added.closest('dialog')
                )
                    seen.push(added.textContent)
        }).observe(document.body, { childList: true, subtree: true })
    })

test.describe('a first agreement', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    test('shows the version, the settings and the sentence with both links, Agree focused, and stores nothing while open', async ({
        page,
    }) => {
        await visit(page)
        const shown = dialog(page)
        await expect(shown).toBeVisible()
        expect(await agreementState(page)).toBe('open')
        await expect(shown).toContainText('Version 0.6.0')
        await expect(shown.getByRole('combobox', { name: 'Language' })).toBeVisible()
        await expect(shown.getByRole('combobox', { name: 'Theme' })).toBeVisible()
        await expect(shown.locator('[data-agreement-sentence]')).toHaveText(SENTENCE)
        await expect(shown.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
            'href',
            '/terms/',
        )
        await expect(shown.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute(
            'href',
            '/privacy/',
        )
        await expect(shown.getByRole('link')).toHaveCount(2)
        await expect(shown.locator('[data-agreement-change]')).toHaveCount(0)
        await expect(shown.locator('[data-agreement-intro]')).toHaveText(en.agreement.intro)
        // The line comes first, above the version.
        await expect(shown.locator('.scroll-edges > div').first()).toHaveText(
            new RegExp(`^${en.agreement.intro.replace(/[.]/g, '\\.')}\\s*Version 0\\.6\\.0$`),
        )
        await expect(agreeButton(page)).toBeFocused()
        await expect(shown.getByRole('button', { name: /Close|×/ })).toHaveCount(0)
        await expect(shown.getByRole('button')).toHaveCount(1)
        expect(await record(page)).toBeNull()
    })

    test('a reload while open shows it again; Agree stores both revisions, and the next load shows none', async ({
        page,
    }) => {
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(page, { agreement: true })
        await expect(dialog(page)).toBeVisible()
        expect(await record(page)).toBeNull()
        await agree(page)
        await expect(dialog(page)).toHaveCount(0)
        expect(await agreementState(page)).toBe('done')
        expect(await record(page)).toEqual({ terms: 1, privacy: 1 })
        await visit(page)
        expect(await agreementState(page)).toBe('notDue')
        await expect(dialog(page)).toHaveCount(0)
    })

    test('Escape, a backdrop press and a close by script leave it open, and shortcuts do nothing', async ({
        page,
    }) => {
        await visit(page)
        const shown = dialog(page)
        // Nothing runs in the page between these, which would count as user activation.
        for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
        await shown.getByText('Version 0.6.0').click()
        await page.keyboard.press('Escape')
        await page.mouse.click(5, 5)
        await page.evaluate(() =>
            document.querySelector<HTMLDialogElement>('dialog[open]')!.close(),
        )
        await expect
            .poll(() => page.evaluate(() => !!document.querySelector('dialog[open]')))
            .toBe(true)
        await page.keyboard.press(',')
        await page.keyboard.press('n')
        await expect(shown).toBeVisible()
        await expect(shown).toHaveAttribute('closedby', 'none')
        expect(await modalCount(page)).toBe(1)
        expect(await agreementState(page)).toBe('open')
        expect(await record(page)).toBeNull()
        await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
    })

    test('Theme and Language apply at once, the sentence follows, and Settings agrees', async ({
        page,
    }) => {
        await visit(page)
        const shown = dialog(page)
        await shown.getByRole('combobox', { name: 'Theme' }).selectOption({ label: 'Dark' })
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
        await shown.getByRole('combobox', { name: 'Language' }).selectOption('fr')
        await expect(shown.getByRole('button', { name: 'Accepter' })).toBeVisible()
        await expect(shown.getByRole('link', { name: 'Conditions d’utilisation' })).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('lang', /^fr/)
        await shown.getByRole('button', { name: 'Accepter' }).click()
        await page.keyboard.press(',')
        const settings = page.getByRole('dialog', { name: 'Paramètres' })
        await expect(settings.getByRole('combobox', { name: 'Langue' })).toHaveValue('fr')
        await expect(settings.getByRole('combobox', { name: 'Thème' })).toHaveValue('dark')
    })

    test('its name and description: the title, and the line and the sentence', async ({ page }) => {
        await visit(page)
        await expect(dialog(page)).toHaveAccessibleName('Next SEKAI Editor')
        await expect(dialog(page)).toHaveAccessibleDescription(`${en.agreement.intro} ${SENTENCE}`)
        await expect(dialog(page).locator('[data-modal-title]')).toHaveText('Next SEKAI Editor')
    })

    test('a link opens its page in a new tab, and the dialog stays', async ({ page }) => {
        await visit(page)
        const popup = page.waitForEvent('popup')
        await dialog(page).getByRole('link', { name: 'Terms of Service' }).click()
        const opened = await popup
        expect(new URL(opened.url()).pathname).toBe('/terms/')
        await opened.close()
        await expect(dialog(page)).toBeVisible()
        expect(await record(page)).toBeNull()
    })
})

test.describe('a changed page', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    for (const [stored, line] of [
        [{ terms: 0, privacy: 1 }, en.agreement.updated.terms],
        [{ terms: 1, privacy: 0 }, en.agreement.updated.privacy],
        [{ terms: 0, privacy: 0 }, en.agreement.updated.both],
    ] as const)
        test(`a record of ${JSON.stringify(stored)} asks again, saying ${line}`, async ({
            page,
        }) => {
            await startWith(page, stored)
            await visit(page)
            const shown = dialog(page)
            await expect(shown.locator('[data-agreement-change]')).toHaveText(line)
            // The changed page's line takes the first visit's place.
            await expect(shown.locator('[data-agreement-intro]')).toHaveCount(0)
            await expect(shown).not.toContainText(en.agreement.intro)
            await expect(shown).toHaveAccessibleDescription(`${line} ${SENTENCE}`)
            await agree(page)
            expect(await record(page)).toEqual({ terms: 1, privacy: 1 })
        })

    test('a record from a later build is kept as it is: Agree never lowers a page', async ({
        page,
    }) => {
        await startWith(page, { terms: 5, privacy: 0 })
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await agree(page)
        expect(await record(page)).toEqual({ terms: 5, privacy: 1 })
    })

    test('a record that covers both pages, or a later one, shows nothing', async ({ page }) => {
        await startWith(page, { terms: 1, privacy: 2 })
        await visit(page)
        expect(await agreementState(page)).toBe('notDue')
        await expect(dialog(page)).toHaveCount(0)
    })
})

test.describe('loads that show it, and loads that do not', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    test('where the record cannot be stored, Agree still closes it, and every load asks', async ({
        page,
    }) => {
        await page.addInitScript((key) => {
            const setItem = Storage.prototype.setItem
            Storage.prototype.setItem = function (name, value) {
                if (name === key) throw new DOMException('Full', 'QuotaExceededError')
                setItem.call(this, name, value)
            }
        }, KEY)
        for (let load = 0; load < 2; load++) {
            await visit(page)
            await expect(dialog(page)).toBeVisible()
            await agree(page)
            await expect(dialog(page)).toHaveCount(0)
            expect(await agreementState(page)).toBe('done')
        }
    })

    test('in safe mode it shows, Agree is stored, and Leave Safe Mode shows none', async ({
        page,
    }) => {
        await visit(page, '/?safe')
        await expect(dialog(page)).toBeVisible()
        await agree(page)
        expect(await record(page)).toEqual({ terms: 1, privacy: 1 })
        await page
            .locator('[data-safe-bar]')
            .getByRole('button', { name: 'Leave Safe Mode' })
            .click()
        await expect.poll(() => new URL(page.url()).search).toBe('')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await waitForStartup(page, { agreement: true })
        await decided(page)
        expect(await agreementState(page)).toBe('notDue')
        await expect(dialog(page)).toHaveCount(0)
    })

    test('not over the startup error, where Export Raw Data still downloads', async ({ page }) => {
        await startupFlags(page, { fail: 'Broken on purpose' })
        await page.goto('/')
        const gate = page.locator('dialog[data-startup-gate]')
        await expect(gate).toContainText('Broken on purpose')
        await expect.poll(() => agreementState(page)).toBe('done')
        await expect(dialog(page)).toHaveCount(0)
        const download = page.waitForEvent('download')
        await gate.getByRole('button', { name: 'Export Raw Data' }).click()
        expect((await download).suggestedFilename()).toMatch(/\.zip$/)
        expect(await record(page)).toBeNull()
    })

    test('not while the startup gate holds, and once it lifts', async ({ page }) => {
        await startupFlags(page, { hold: true })
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect
            .poll(() => page.evaluate(() => typeof window.nseStartupRelease))
            .toBe('function')
        await page.waitForTimeout(300)
        expect(await agreementState(page)).toBe('pending')
        await expect(dialog(page)).toHaveCount(0)
        await release(page)
        await expect(dialog(page)).toBeVisible()
    })

    test('Agree in one tab closes it in another', async ({ page, context }) => {
        await visit(page)
        const other = await context.newPage()
        await visit(other)
        await expect(dialog(page)).toBeVisible()
        await expect(dialog(other)).toBeVisible()
        await agree(page)
        await expect(dialog(other)).toHaveCount(0)
        expect(await agreementState(other)).toBe('done')
        expect(await record(other)).toEqual({ terms: 1, privacy: 1 })
    })
})

test.describe('load notices wait under it', () => {
    test.beforeEach(async ({ context }) => {
        await seed(context)
    })

    test("a recovered session's Restore waits 20 s under it, then shows for its full time and works", async ({
        page,
    }) => {
        await page.clock.install()
        await visit(page)
        await agree(page)
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
        await expect(dialog(page)).toBeVisible()
        const restore = pill(page).getByRole('button', { name: 'Restore Session' })
        await expect(restore).toBeAttached()
        await page.clock.runFor(20_000)
        await expect(dialog(page)).toBeVisible()
        await agree(page)
        await expect(restore).toBeVisible()
        // A start-up card stays at least 8 s.
        await page.clock.runFor(7_000)
        await expect(restore).toBeVisible()
        await restore.click()
        await expect.poll(() => lifeOf(page)).toBe(990)
    })

    test('a late notice joins the card 15 s into it, and the card shows it after Agree', async ({
        page,
    }) => {
        await page.clock.install()
        await heldEstimate(page)
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await page.clock.runFor(15_000)
        await releaseEstimate(page)
        const line = pill(page).filter({ hasText: en.load.storageNearlyFull })
        await expect(line).toBeAttached()
        await expect(dialog(page)).toBeVisible()
        await agree(page)
        await expect(line).toBeVisible()
        await expect(line.getByRole('button', { name: 'Local Data' })).toBeVisible()
        await page.clock.runFor(6_000)
        await expect(line).toBeVisible()
    })

    test('13 s after Agree, a late notice is only kept in Local Data', async ({ page }) => {
        await page.clock.install()
        await heldEstimate(page)
        await visit(page)
        await agree(page)
        await page.clock.runFor(13_000)
        await releaseEstimate(page)
        await page.waitForTimeout(500)
        await expect(pill(page)).toHaveCount(0)
        await expect(
            page.locator('.notification').filter({ hasText: en.load.storageNearlyFull }),
        ).toHaveCount(0)
    })

    test('the update line waits 10 s under it, and its card shows after Agree', async ({
        page,
    }) => {
        await page.addInitScript(() => {
            if (!sessionStorage.getItem('agr.older')) {
                sessionStorage.setItem('agr.older', '1')
                localStorage.setItem(
                    'sonolus-next-sekai-editor.lastAppVersion',
                    JSON.stringify('0.5.22'),
                )
            }
        })
        await page.clock.install()
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await expect(pill(page)).toContainText('Updated to version 0.6.0')
        await page.clock.runFor(10_000)
        await agree(page)
        await expect(pill(page)).toContainText('Updated to version 0.6.0')
        await page.clock.runFor(1000)
        await expect(pill(page)).toBeVisible()
    })

    test('a file dropped under it opens nothing and says nothing, so a late notice still joins the card', async ({
        page,
    }) => {
        await heldEstimate(page)
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        const prevented = await page.evaluate(() => {
            const data = new DataTransfer()
            data.items.add(new File(['{"entities":[]}'], 'LevelData.json'))
            const event = new DragEvent('drop', {
                dataTransfer: data,
                bubbles: true,
                cancelable: true,
            })
            document.querySelector('dialog[open]')!.dispatchEvent(event)
            return event.defaultPrevented
        })
        expect(prevented).toBe(true)
        await releaseEstimate(page)
        await agree(page)
        await expect(pill(page).filter({ hasText: en.load.storageNearlyFull })).toBeVisible()
        await expect(page.getByText(en.notice.useOpenFile)).toHaveCount(0)
    })

    test("its live region reads only what is drawn over it; the page's reads the card after Agree", async ({
        page,
    }) => {
        await heldEstimate(page)
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await watchPageRegion(page)
        await releaseEstimate(page)
        await expect(pill(page).filter({ hasText: en.load.storageNearlyFull })).toBeAttached()
        await page.waitForTimeout(300)
        await expect(dialog(page).locator('[data-notice-region]')).not.toContainText(
            en.load.storageNearlyFull,
        )
        await agree(page)
        const region = page.locator('[data-notice-region]')
        await expect(region).toContainText(en.load.storageNearlyFull)
        // Added empty and then filled, so it is announced, not held as already read.
        expect(await page.evaluate(() => Reflect.get(window, 'pageRegion') as string[])).toEqual([
            '',
        ])
    })

    test('the start-up card the page region took just before it opened is read after Agree', async ({
        page,
    }) => {
        await page.addInitScript(() => {
            if (!sessionStorage.getItem('agr.older')) {
                sessionStorage.setItem('agr.older', '1')
                localStorage.setItem(
                    'sonolus-next-sekai-editor.lastAppVersion',
                    JSON.stringify('0.5.22'),
                )
            }
        })
        await visit(page)
        await expect(dialog(page)).toBeVisible()
        await expect(pill(page)).toContainText('Updated to version 0.6.0')
        await watchPageRegion(page)
        await agree(page)
        await expect(page.locator('[data-notice-region]')).toContainText('Updated to version 0.6.0')
        expect(await page.evaluate(() => Reflect.get(window, 'pageRegion') as string[])).toEqual([
            '',
        ])
    })
})

// Within 8 px of the viewport, the sentence and Agree in view without scrolling, and no sideways
// scroll. Where the body scrolls, its end comes into view and Agree stays.
for (const [width, height, locales] of [
    [360, 640, ['fr', 'tr']],
    [390, 844, ['en', 'fr', 'ja']],
    [844, 390, ['en']],
    // A landscape phone with Safari's bars: the body scrolls.
    [844, 300, ['en']],
    [820, 1180, ['en']],
] as const)
    for (const locale of locales)
        test(`${locale} at ${width} x ${height}: it fits, the sentence and Agree show, and nothing scrolls sideways`, async ({
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
            const sentence = shown.locator('[data-agreement-sentence]')
            const agreeAt = shown.locator('[data-modal-footer] button')
            await expect(shown.locator('[data-agreement]')).toBeInViewport({ ratio: 1 })
            await expect(sentence).toBeInViewport({ ratio: 1 })
            await expect(agreeAt).toBeInViewport({ ratio: 1 })
            const sideways = await shown.evaluate((dialog) =>
                [dialog, ...dialog.querySelectorAll('*')]
                    .filter((element) => /auto|scroll/.test(getComputedStyle(element).overflowX))
                    .filter((element) => element.scrollWidth > element.clientWidth + 1)
                    .map((element) => element.className),
            )
            expect(sideways).toEqual([])
            const body = shown.locator('.scroll-edges').first()
            const scrolls = await body.evaluate(
                (element) => element.scrollHeight > element.clientHeight + 1,
            )
            if (height < 390) expect(scrolls).toBe(true)
            await body.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
            await expect(dialog(page).getByRole('switch', { name: /./ })).toBeInViewport()
            await expect(sentence).toBeInViewport({ ratio: 1 })
            await expect(agreeAt).toBeInViewport({ ratio: 1 })
            await context.close()
        })
