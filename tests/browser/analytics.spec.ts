import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { isValidEvent } from '../../src/analytics/catalogue'
import type { Item } from '../../src/analytics/sender'
import { confirmWhenReady } from './confirmWhenReady'
import { installCanvasCounters, waitForStartup } from './editorFixture'
import { wav } from './levelInfoFiles'
import { confirmReset } from './resetConfirm'
import { edit, notice, pressSave, readFile, start, submitSave } from './saveFlows'

// Usage statistics against a mock endpoint: a Playwright route that answers as Umami's batch
// route does. The dev server has no analytics target, so each page points the statistics at the
// route with the dev-only test key. No request leaves the machine: anything not to the dev server
// or the mock is aborted and fails the spec.

const ORIGIN = 'https://stats.analytics.test'
const WEBSITE = '11111111-2222-3333-4444-555555555555'
const CLIENT = '/src/analytics/client.ts'
const BEACONS = 'nse.test.beacons'

type Answer = 'ok' | 'abort' | 'error' | 'hang'

/** The batches the mock received, each as its items. */
const mock = async (context: BrowserContext, answer: Answer = 'ok') => {
    const batches: Item[][] = []
    const stray: string[] = []
    const held: Route[] = []
    await context.route(
        (url) => url.hostname !== '127.0.0.1',
        async (route) => {
            const url = new URL(route.request().url())
            if (url.origin !== ORIGIN || url.pathname !== '/api/batch') {
                stray.push(url.href)
                return route.abort()
            }
            const items = JSON.parse(route.request().postData() ?? '[]') as Item[]
            batches.push(items)
            if (answer === 'abort') return route.abort()
            if (answer === 'hang') return void held.push(route)
            await route.fulfill({
                status: answer === 'error' ? 500 : 200,
                contentType: 'application/json',
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify({ size: items.length, processed: items.length, errors: 0 }),
            })
        },
    )
    return { batches, stray }
}

/**
 * The page's own console output and errors. The browser's lines for failed requests and the dev
 * server's connection lines are not the page's.
 */
const watchConsole = (page: Page) => {
    const messages: string[] = []
    page.on('console', (message) => {
        if (!/^(?:Failed to load resource|\[vite\])/.test(message.text()))
            messages.push(message.text())
    })
    page.on('pageerror', (error) => messages.push(String(error)))
    return messages
}

type Boot = { signal?: 'gpc' | 'dnt'; holdStartup?: boolean }

/** Points the statistics at the mock, and records beacons; before the page loads. */
const installAnalytics = (page: Page, { signal, holdStartup }: Boot = {}) =>
    page.addInitScript(
        ({ origin, website, signal, holdStartup, BEACONS }) => {
            localStorage.setItem('nse.test.analytics', JSON.stringify({ origin, website }))
            // Playwright sees no beacon sent as a page goes away, so each is kept here too,
            // for the next page to read (`leave`).
            const sendBeacon = Navigator.prototype.sendBeacon
            Navigator.prototype.sendBeacon = function (url, body) {
                if (String(url).startsWith(origin)) {
                    const sent = JSON.parse(localStorage.getItem(BEACONS) ?? '[]') as unknown[]
                    localStorage.setItem(BEACONS, JSON.stringify([...sent, String(body)]))
                }
                return sendBeacon.call(this, url, body)
            }
            if (holdStartup) sessionStorage.setItem('nse.test.startup', '{"hold":true}')
            if (signal === 'gpc')
                Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
                    get: () => true,
                })
            if (signal === 'dnt')
                Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => '1' })
        },
        { origin: ORIGIN, website: WEBSITE, signal, holdStartup, BEACONS },
    )

const boot = async (page: Page, { signal, holdStartup }: Boot = {}) => {
    await page.addInitScript(installCanvasCounters)
    await installAnalytics(page, { signal, holdStartup })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    if (!holdStartup) await waitForStartup(page)
}

/** How many of the client and the modules only it imports have loaded: 3 once it is in. */
const clientLoaded = (page: Page) =>
    page.evaluate(
        (modules) => {
            const loaded = new Set(
                performance
                    .getEntriesByType('resource')
                    .map((entry) => new URL(entry.name).pathname),
            )
            return modules.filter((module) => loaded.has(module)).length
        },
        [CLIENT, '/src/analytics/catalogue.ts', '/src/analytics/sender.ts'],
    )

/** The page as hidden for one `visibilitychange`, as when the user switches tabs. */
const hide = (page: Page) =>
    page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        delete (document as { visibilityState?: unknown }).visibilityState
    })

/** A trusted input: it arms the visit. */
const interact = (page: Page) => page.keyboard.press('Shift')

/** Hides the page until the client, once loaded, sends its first batch. */
const firstSend = async (page: Page, batches: Item[][]) => {
    const before = batches.length
    await expect
        .poll(async () => {
            await hide(page)
            return batches.length
        })
        .toBe(before + 1)
}

/** Goes to another page, so this one fires pagehide; gives the beacons sent so far. */
const leave = async (page: Page) => {
    await page.goto('/privacy/')
    const sent = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as string[],
        BEACONS,
    )
    return sent.map((body) => JSON.parse(body) as Item[])
}

const names = (items: Item[]) => items.map((item) => item.payload.name ?? '(pageview)')

const settingsSwitch = async (page: Page) => {
    await page.keyboard.press(',')
    const field = page.locator('[data-about-usage-statistics]')
    await field.scrollIntoViewIfNeeded()
    return field
}

test('an armed visit sends its pageview and visit at the first hide, and its edits at pagehide', async ({
    page,
    context,
}) => {
    const { batches, stray } = await mock(context)
    const messages = watchConsole(page)
    await boot(page, { holdStartup: true })
    // Nothing loads while startup is open.
    await interact(page)
    expect(await clientLoaded(page)).toBe(0)
    await page.evaluate(() => (window as { nseStartupRelease?: () => void }).nseStartupRelease?.())
    await waitForStartup(page)
    await interact(page)
    await firstSend(page, batches)
    const [first = []] = batches
    expect(names(first)).toEqual(['(pageview)', 'visit'])
    for (const { type, payload } of first) {
        expect(type).toBe('event')
        expect(payload).toMatchObject({
            website: WEBSITE,
            hostname: '127.0.0.1',
            url: '/',
            title: '',
            referrer: '',
            language: 'en',
        })
        expect(payload.screen).toMatch(/^\d+x\d+$/)
        expect(Math.abs(payload.timestamp - Date.now() / 1000)).toBeLessThan(120)
    }
    expect(first[1]?.payload.data).toMatchObject({ site: 'production', version: '0.6.0' })
    expect(isValidEvent('visit', first[1]?.payload.data ?? {})).toBe(true)

    // Within the minute a hide sends nothing; pagehide sends what is left, by beacon.
    await edit(page, 1)
    await edit(page, 2)
    await hide(page)
    const beacons = await leave(page)
    expect(batches.length).toBe(1)
    expect(
        beacons.map((items) => items.map((item) => [item.payload.name, item.payload.data])),
    ).toEqual([[['edits', { 'object.add': 2 }]]])

    expect(stray).toEqual([])
    expect(messages).toEqual([])
})

test('a visit with no input sends nothing; the first key press sends what waited', async ({
    page,
    context,
}) => {
    const { batches } = await mock(context)
    await boot(page)
    await expect.poll(() => clientLoaded(page)).toBe(3)
    await edit(page, 1)
    for (let i = 0; i < 3; i++) await hide(page)
    expect(await leave(page)).toEqual([])
    expect(batches).toEqual([])

    await page.goto('/')
    await waitForStartup(page)
    await expect.poll(() => clientLoaded(page)).toBe(3)
    await interact(page)
    await firstSend(page, batches)
    expect(names(batches[0] ?? [])).toEqual(['(pageview)', 'visit'])
})

test('turning the switch off stops at once, pagehide included, and Reset Settings keeps it off', async ({
    page,
    context,
}) => {
    const { batches } = await mock(context)
    await boot(page)
    await interact(page)
    await expect.poll(() => clientLoaded(page)).toBe(3)
    await edit(page, 1)
    const field = await settingsSwitch(page)
    const toggle = field.getByRole('switch', { name: 'Send Usage Statistics' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(field).toContainText('Counts of the tools, settings and files you use')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await hide(page)
    expect(await leave(page)).toEqual([])
    expect(batches).toEqual([])

    await page.goto('/')
    await waitForStartup(page)
    await page.keyboard.press(',')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const reset = dialog.getByRole('button', { name: 'Reset Settings', exact: true })
    await expect(reset).toHaveAttribute(
        'title',
        'Restore default settings, keeping keyboard shortcuts and Send Usage Statistics.',
    )
    await reset.click()
    await expect(page.getByRole('dialog').nth(1)).toContainText(
        'Restore default settings, keeping keyboard shortcuts and Send Usage Statistics?',
    )
    await confirmReset(page, 'Reset Settings')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    // The reset happened: a setting it does not keep is back to its default.
    await expect
        .poll(() =>
            page.evaluate(() => localStorage.getItem('sonolus-next-sekai-editor.showPreview')),
        )
        .toBe(null)
    await expect(page.locator('[data-about-usage-statistics]').getByRole('switch')).toHaveAttribute(
        'aria-checked',
        'false',
    )
    expect(
        await page.evaluate(() =>
            localStorage.getItem('sonolus-next-sekai-editor.usageStatistics'),
        ),
    ).toBe('false')
    expect(await clientLoaded(page)).toBe(0)
})

test('turned off in one tab, another tab sends nothing more', async ({ context }) => {
    const { batches } = await mock(context)
    const [first, second] = [await context.newPage(), await context.newPage()]
    for (const page of [first, second]) await boot(page)
    await interact(second)
    await firstSend(second, batches)
    await edit(second, 1)

    await interact(first)
    const toggle = (await settingsSwitch(first)).getByRole('switch')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    // The other tab follows the storage event: its switch shows off, and pagehide sends nothing.
    await second.keyboard.press(',')
    await expect(
        second.locator('[data-about-usage-statistics]').getByRole('switch'),
    ).toHaveAttribute('aria-checked', 'false')
    expect(await leave(second)).toEqual([])
    expect(batches.length).toBe(1)
})

for (const signal of ['gpc', 'dnt'] as const)
    test(`with ${signal === 'gpc' ? 'Global Privacy Control' : 'Do Not Track'}, nothing loads until the user turns it on`, async ({
        page,
        context,
    }) => {
        const { batches } = await mock(context)
        await boot(page, { signal })
        await interact(page)
        const field = await settingsSwitch(page)
        const toggle = field.getByRole('switch')
        await expect(toggle).toHaveAttribute('aria-checked', 'false')
        await expect(field).toContainText(
            'Off because this browser sends Do Not Track or Global Privacy Control.',
        )
        expect(await clientLoaded(page)).toBe(0)
        await toggle.click()
        await expect(field).toContainText('Counts of the tools')
        await expect.poll(() => clientLoaded(page)).toBe(3)
        await page.keyboard.press('Escape')
        await interact(page)
        await firstSend(page, batches)
        expect(names(batches[0] ?? [])).toEqual(['(pageview)', 'visit'])
    })

for (const answer of ['abort', 'error', 'hang'] as const)
    test(`an endpoint that ${{ abort: 'is blocked', error: 'fails', hang: 'never answers' }[answer]} gets one request, and the editor shows nothing`, async ({
        page,
        context,
    }) => {
        const { batches } = await mock(context, answer)
        const messages = watchConsole(page)
        await boot(page)
        await interact(page)
        // The first request ends, except at the hanging endpoint, before the edit pagehide would send.
        const ended =
            answer === 'hang'
                ? undefined
                : page.waitForEvent(answer === 'abort' ? 'requestfailed' : 'requestfinished', {
                      predicate: (request) => request.url().startsWith(ORIGIN),
                  })
        await firstSend(page, batches)
        await ended
        await edit(page, 1)
        // The startup pill aside, no notice.
        await expect(
            page
                .locator('.notification, .notification-pill')
                .filter({ hasNotText: 'Version 0.6.0' }),
        ).toHaveCount(0)
        expect(await leave(page)).toEqual([])
        expect(batches.length).toBe(1)
        expect(messages).toEqual([])
    })

test('offline, the batch waits for the next hide', async ({ page, context }) => {
    const { batches } = await mock(context)
    await boot(page)
    await interact(page)
    await expect.poll(() => clientLoaded(page)).toBe(3)
    await context.setOffline(true)
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    for (let i = 0; i < 3; i++) await hide(page)
    expect(batches).toEqual([])
    await context.setOffline(false)
    await firstSend(page, batches)
    expect(names(batches[0] ?? [])).toEqual(['(pageview)', 'visit'])
})

test('a client chunk that cannot load leaves the editor as it is', async ({ page, context }) => {
    const { batches } = await mock(context)
    const messages = watchConsole(page)
    let requested = false
    await context.route(`**${CLIENT}*`, (route) => {
        requested = true
        return route.fulfill({ status: 404, body: '' })
    })
    await boot(page)
    await interact(page)
    await expect.poll(() => requested).toBe(true)
    await edit(page, 1)
    await hide(page)
    expect(await leave(page)).toEqual([])
    expect(batches).toEqual([])
    expect(messages).toEqual([])
})

test('no request names the chart, its files or the saved file’s size, and every key is in the catalogue', async ({
    page,
    context,
}) => {
    const CANARY = 'CANARY7731'
    const { batches, stray } = await mock(context)
    await installAnalytics(page)
    await start(page)
    await interact(page)
    await firstSend(page, batches)

    await page.locator('[data-status-label]').click()
    const form = page.getByRole('dialog', { name: 'Level Info', exact: true })
    for (const name of ['Title', 'Artists']) {
        const input = form.getByRole('textbox', { name, exact: true })
        await input.fill(`${CANARY} ${name}`)
        await input.press('Tab')
    }
    await confirmWhenReady(form.getByRole('button', { name: 'Confirm', exact: true }), form)
    await expect(form).toHaveCount(0)
    await page.evaluate(
        async ({ name, base64 }) => {
            const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
            const { changeBgm } =
                (await import('/src/editor/commands/bgm/index.ts')) as typeof import('../../src/editor/commands/bgm')
            void changeBgm(new File([bytes], name, { type: 'audio/wav' }))
        },
        { name: `${CANARY}.wav`, base64: wav(1).toString('base64') },
    )
    const bgm = page.getByRole('dialog', { name: 'BGM', exact: true })
    await expect(bgm.locator('input[type="button"]')).toHaveValue(/\d/)
    await bgm.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(bgm).toHaveCount(0)

    await pressSave(page)
    await submitSave(page, CANARY)
    await expect(
        notice(page)
            .filter({ hasText: `Saved to ${CANARY}.nxsp` })
            .first(),
    ).toBeVisible()
    const size = (await readFile(page, `${CANARY}.nxsp`))!.length
    const sent = [...batches, ...(await leave(page))]

    expect(sent.length).toBe(2)
    const text = JSON.stringify(sent)
    expect(text).not.toContain(CANARY)
    expect(text).not.toMatch(new RegExp(`\\b${size}\\b`))
    const events = sent.flat().filter((item) => item.payload.name)
    expect(events.map((item) => item.payload.name)).toContain('edits')
    for (const { payload } of events)
        expect(isValidEvent(payload.name!, payload.data ?? {}), payload.name).toBe(true)
    expect(stray).toEqual([])
})
