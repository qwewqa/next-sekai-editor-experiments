import {
    expect,
    test,
    type BrowserContext,
    type Page,
    type Request,
    type Route,
} from '@playwright/test'
import { isValidEvent } from '../../src/analytics/catalogue'
import type { Item } from '../../src/analytics/sender'
import { confirmWhenReady } from './confirmWhenReady'
import { installCanvasCounters, installEditorFixture, waitForStartup } from './editorFixture'
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

/** What the first batch of a visit holds, besides what the visit did. */
const START = ['(pageview)', 'visit', 'settings', 'startup'] as const
const startOf = (items: Item[]) => names(items).slice(0, START.length)

/** The data of the named event in a batch. */
const dataOf = (items: Item[], name: string) =>
    items.find((item) => item.payload.name === name)?.payload.data

/** The built-in command names, as the page knows them. */
const builtInCommandNames = async (page: Page) =>
    new Set(
        await page.evaluate(async () => {
            const names =
                (await import('/src/editor/commands/names.ts')) as typeof import('../../src/editor/commands/names')
            return [...names.builtInCommandNames]
        }),
    )

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
    expect(startOf(first)).toEqual([...START])
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
    expect(beacons.length).toBe(1)
    expect(dataOf(beacons[0] ?? [], 'edits')).toEqual({ 'object.add': 2 })

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
    expect(startOf(batches[0] ?? [])).toEqual([...START])
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
    await expect(field).toContainText('They include which tools you use, some editor settings')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await hide(page)
    expect(await leave(page)).toEqual([])
    expect(batches).toEqual([])

    await page.goto('/')
    await waitForStartup(page)
    await page.keyboard.press(',')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const reset = dialog.getByRole('button', { name: 'Reset Settings…', exact: true })
    await reset.click()
    await expect(page.getByRole('dialog').nth(1)).toContainText(
        'Reset settings to their defaults? Keyboard shortcuts and the Send Usage Statistics setting will be kept.',
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
            'Off by default because this browser sends a Do Not Track or Global Privacy Control signal.',
        )
        expect(await clientLoaded(page)).toBe(0)
        await toggle.click()
        await expect(field).toContainText('They include which tools you use')
        await expect.poll(() => clientLoaded(page)).toBe(3)
        await page.keyboard.press('Escape')
        await interact(page)
        await firstSend(page, batches)
        expect(startOf(batches[0] ?? []).slice(0, 3)).toEqual(START.slice(0, 3))
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
        const batch = { predicate: (request: Request) => request.url().startsWith(ORIGIN) }
        const ended =
            answer === 'hang'
                ? undefined
                : answer === 'abort'
                  ? page.waitForEvent('requestfailed', batch)
                  : page.waitForEvent('requestfinished', batch)
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
    expect(startOf(batches[0] ?? [])).toEqual([...START])
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

test("no request names the chart, its files or the saved file's size, and every key is in the catalogue", async ({
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
    const commandNames = await builtInCommandNames(page)
    const size = (await readFile(page, `${CANARY}.nxsp`))!.length
    const sent = [...batches, ...(await leave(page))]

    expect(sent.length).toBe(2)
    const text = JSON.stringify(sent)
    expect(text).not.toContain(CANARY)
    expect(text).not.toMatch(new RegExp(`\\b${size}\\b`))
    const events = sent.flat().filter((item) => item.payload.name)
    expect(events.map((item) => item.payload.name)).toContain('edits')
    for (const { payload } of events)
        expect(isValidEvent(payload.name!, payload.data ?? {}, commandNames), payload.name).toBe(
            true,
        )
    expect(stray).toEqual([])
})

test('a scripted visit counts each press once by name and source, and sends the start events', async ({
    page,
    context,
}) => {
    const { batches, stray } = await mock(context)
    const messages = watchConsole(page)
    await installAnalytics(page)
    await start(page)
    await interact(page)
    await page
        .locator('[data-editor-toolbar]')
        .first()
        .getByRole('button', { name: 'Select', exact: true })
        .click()
    // A held key repeats; only the press counts.
    await page.locator('canvas.editor-chart').focus()
    for (let i = 0; i < 4; i++) await page.keyboard.down('ArrowDown')
    await page.keyboard.up('ArrowDown')
    // A wheel zoom counts once however many ticks.
    const box = (await page.locator('canvas.editor-chart').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.down('Control')
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await firstSend(page, batches)

    const [first = []] = batches
    expect(startOf(first)).toEqual([...START])
    const commandNames = await builtInCommandNames(page)
    for (const { payload } of first)
        if (payload.name)
            expect(isValidEvent(payload.name, payload.data ?? {}, commandNames), payload.name).toBe(
                true,
            )
    expect(dataOf(first, 'usage')).toEqual({
        'select.toolbar': 1,
        'scrollDown.key': 1,
        'zoomYIn.wheel': 1,
    })
    // The desktop snapshot: the 23 settings, 25 keys, and no touch options.
    const settings = dataOf(first, 'settings') ?? {}
    expect(Object.keys(settings)).toHaveLength(25)
    expect(settings).not.toHaveProperty('touchQuickScrollShow')
    expect(dataOf(first, 'startup')).toMatchObject({ start: 'blank', outcome: 'done' })
    expect(dataOf(first, 'storage')).toMatchObject({ mode: 'stored' })
    expect(dataOf(first, 'perf')).toMatchObject({ loafSupported: true, playSeconds: 0 })
    // How much of a frame the browser attributes depends on the browser build, not on this visit.
    expect(['full', 'partial']).toContain(dataOf(first, 'perf')?.frameAttribution)
    expect(['main', 'worker', 'none']).toContain(dataOf(first, 'perf')?.previewHost)
    expect(dataOf(first, 'perf')).toHaveProperty('viewport')
    expect(dataOf(first, 'perf')).toHaveProperty('viewportHeight')
    expect(dataOf(first, 'perf')).toHaveProperty('viewportAspect')
    expect(dataOf(first, 'perf')).toHaveProperty('previewRenderScale')
    expect(stray).toEqual([])
    expect(messages).toEqual([])
})

test('a Save records its outcome, and a chart with objects is counted once saved', async ({
    page,
    context,
}) => {
    const { batches } = await mock(context)
    await installAnalytics(page)
    await start(page)
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show } = window.editorTest
        show(fixtures.interaction)
    })
    await interact(page)
    await pressSave(page)
    await submitSave(page, 'Tracked')
    await expect(notice(page).filter({ hasText: 'Saved to Tracked.nxsp' }).first()).toBeVisible()
    // The Save has ended (the tally is no longer busy) and the client has counted the chart (the
    // tally has none left to count): only then does the first hide carry it. A later hide would
    // fall under the minute rule.
    await expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const tally =
                        (await import('/src/analytics/tally.ts')) as typeof import('../../src/analytics/tally')
                    return !tally.isBusy() && !tally.hasCharts()
                }),
            { timeout: 60_000 },
        )
        .toBe(true)
    await firstSend(page, batches)
    const sent = [...batches.flat(), ...(await leave(page)).flat()]
    const data = (name: string) => sent.find((item) => item.payload.name === name)?.payload.data
    expect(data('save')).toMatchObject({
        action: 'save',
        target: 'picker',
        history: true,
        bgm: true,
        outcome: 'done',
    })
    expect(data('chart')).toMatchObject({ trigger: 'save', bgm: 'none' })
    for (const name of ['save', 'chart'])
        expect(isValidEvent(name, data(name) ?? {}), name).toBe(true)
})

test('a startup that ends in an error is reported once the error page is used', async ({
    page,
    context,
}) => {
    const { batches } = await mock(context)
    await installAnalytics(page)
    await page.addInitScript(() =>
        sessionStorage.setItem('nse.test.startup', '{"fail":"A row could not be read"}'),
    )
    await page.goto('/')
    const gate = page.locator('dialog[data-startup-gate]')
    await expect(gate.getByRole('alert')).toBeVisible()
    // Keys are swallowed while the error shows; a press in the page itself arms nothing.
    await page.keyboard.press('Shift')
    await gate.getByRole('alert').click()
    // The client loads when the page goes idle, within 10 s; it sends at the first hide.
    await expect
        .poll(
            async () => {
                await hide(page)
                return batches.length
            },
            { timeout: 60_000 },
        )
        .toBe(1)
    const [first = []] = batches
    // A failed startup has no time; the device details and the load facts come with it.
    const startup = dataOf(first, 'startup')
    expect(startup).toMatchObject({ start: 'blank', outcome: 'error', hidden: false })
    expect(startup).not.toHaveProperty('ready')
    expect(startup).toHaveProperty('navigation')
    expect(startup).toHaveProperty('viewport')
    expect(startup).toHaveProperty('viewportHeight')
    expect(startup).toHaveProperty('viewportAspect')
})

test('opening History and its Recent Sessions tab are counted as features', async ({
    page,
    context,
}) => {
    const { batches } = await mock(context)
    await installAnalytics(page)
    await start(page)
    await interact(page)
    await page.keyboard.press('Shift+H')
    const dialog = page.locator('[data-history-surface="dialog"]')
    await expect(dialog).toBeVisible()
    await page.getByRole('tab', { name: /Sessions/ }).click()
    await expect(dialog.getByText('Recent Sessions').first()).toBeVisible()
    // Wait for the list's count, then for the browser's storage answers, which the client asked
    // for first: its second `storage` event is queued by then.
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { recentSessionCount } =
                    (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
                return recentSessionCount.value !== undefined
            }),
        )
        .toBe(true)
    await page.evaluate(async () => {
        await navigator.storage.estimate()
        await navigator.storage.persisted()
    })
    await firstSend(page, batches)
    expect(dataOf(batches[0] ?? [], 'features')).toEqual({ historyDialog: 1, recentTab: 1 })
    // The sessions count is known once Recent Sessions has read its list: `storage` goes again with it.
    const storage = (batches[0] ?? [])
        .filter((item) => item.payload.name === 'storage')
        .map((item) => item.payload.data)
    expect(storage).toHaveLength(2)
    expect(storage[0]).not.toHaveProperty('sessions')
    expect(storage[1]).toHaveProperty('sessions')
})

test('a preview host or render scale that changed and came back within one tick is mixed', async ({
    page,
}) => {
    await start(page)
    const { first, mixed, steady } = await page.evaluate(async () => {
        const { startField } =
            (await import('/src/analytics/field.ts')) as typeof import('../../src/analytics/field')
        const { settings } =
            (await import('/src/settings.ts')) as typeof import('../../src/settings')
        const field = startField()
        field.measures()
        // Everything below runs in one task, so Vue's queued watchers have not run yet.
        const scale = settings.previewRenderScale
        settings.showPreview = true
        settings.showPreview = false
        settings.previewRenderScale = scale === 1 ? 2 : 1
        settings.previewRenderScale = scale
        const mixed = field.measures()
        const steady = field.measures()
        field.stop()
        return { first: scale, mixed, steady }
    })
    expect(first).toBeGreaterThan(0)
    expect(mixed).toMatchObject({ previewHost: 'mixed', previewRenderScale: 'mixed' })
    // The next interval begins from the value then, and nothing changed in it.
    expect(steady).toMatchObject({ previewHost: 'none' })
    expect(steady.previewRenderScale).not.toBe('mixed')
})

test.describe('with the agreement dialog', () => {
    // These pages start without the record the config's storageState seeds, so agreement is due.
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

    const KEY = 'sonolus-next-sekai-editor.agreement'
    const gateDialog = (page: Page) => page.getByRole('dialog', { name: 'Next SEKAI Editor' })
    const agree = (page: Page) => gateDialog(page).getByRole('button', { name: 'Agree' }).click()

    /** The pages of the context: a fixed version and the panels away, without the record. */
    const seed = (context: BrowserContext) =>
        context.addInitScript(() => {
            // The client's modules are found in the resource timing entries.
            performance.setResourceTimingBufferSize(5000)
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
        })

    /** The startup test flags for the tab's first load. */
    const startupFlags = (page: Page, flags: object) =>
        page.addInitScript((flags) => {
            if (sessionStorage.getItem('agr.flagsSet')) return
            sessionStorage.setItem('agr.flagsSet', '1')
            sessionStorage.setItem('nse.test.startup', JSON.stringify(flags))
        }, flags)

    const agreementState = (page: Page) =>
        page.evaluate(async () => {
            const { agreementState } =
                (await import('/src/editor/agreement/agreement.ts')) as typeof import('../../src/editor/agreement/agreement')
            return agreementState.value
        })

    /** A real pointer press on the chart. */
    const clickChart = async (page: Page) => {
        const box = (await page.locator('canvas.editor-chart').boundingBox())!
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }

    const shownVisit = async (page: Page) => {
        await page.goto('/')
        await expect(gateDialog(page)).toBeVisible()
        await expect.poll(() => clientLoaded(page), { timeout: 15_000 }).toBe(3)
    }

    /** Hides the page until the first batch arrives: up to 60 s for the client to load. */
    const sends = (page: Page, batches: Item[][]) =>
        expect
            .poll(
                async () => {
                    await hide(page)
                    return batches.length
                },
                { timeout: 60_000 },
            )
            .toBe(1)

    test.beforeEach(async ({ page, context }) => {
        await seed(context)
        await installAnalytics(page)
    })

    test('nothing under the gate arms or sends: a Start Blank press, the links, a hide, pagehide and the minute; after Agree the next input does', async ({
        page,
        context,
    }) => {
        const { batches, stray } = await mock(context)
        await startupFlags(page, { hold: true, slowMs: 50 })
        await page.clock.install()
        await page.goto('/')
        const gate = page.locator('dialog[data-startup-gate]')
        await gate.getByRole('button', { name: 'Start Blank' }).click()
        await expect(gateDialog(page)).toBeVisible()
        // Each link opens in a new tab; the page is then hidden, and goes away.
        for (const name of ['Terms of Service', 'Privacy Notice']) {
            const popup = page.waitForEvent('popup')
            await gateDialog(page).getByRole('link', { name }).click()
            await (await popup).close()
        }
        await hide(page)
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
        // The client has loaded, and its minute passes with the dialog open. The fake clock
        // replaces getEntriesByType, so the entries are read through an observer.
        await page.clock.runFor(15_000)
        await expect
            .poll(() =>
                page.evaluate(
                    (client) =>
                        new Promise<boolean>((resolve) => {
                            new PerformanceObserver((list, observer) => {
                                observer.disconnect()
                                resolve(
                                    list
                                        .getEntries()
                                        .some((entry) => new URL(entry.name).pathname === client),
                                )
                            }).observe({ type: 'resource', buffered: true })
                        }),
                    CLIENT,
                ),
            )
            .toBe(true)
        await page.clock.runFor(61_000)
        await hide(page)
        expect(batches).toEqual([])
        expect(
            await page.evaluate(
                (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[],
                BEACONS,
            ),
        ).toEqual([])
        await agree(page)
        await clickChart(page)
        await sends(page, batches)
        expect(startOf(batches[0] ?? [])).toEqual([...START])
        expect(stray).toEqual([])
    })

    test('a press on a field in the dialog arms nothing', async ({ page, context }) => {
        const { batches } = await mock(context)
        await shownVisit(page)
        await gateDialog(page).getByRole('combobox', { name: 'Theme' }).click()
        await page.keyboard.press('Escape')
        for (let i = 0; i < 3; i++) await hide(page)
        await page.waitForTimeout(500)
        expect(batches).toEqual([])
    })

    test('turned off in the dialog, nothing is ever sent', async ({ page, context }) => {
        const { batches } = await mock(context)
        await shownVisit(page)
        const toggle = gateDialog(page).getByRole('switch', { name: 'Send Usage Statistics' })
        await expect(toggle).toHaveAttribute('aria-checked', 'true')
        await expect(gateDialog(page)).toContainText(
            'They include which tools you use, some editor settings',
        )
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-checked', 'false')
        await agree(page)
        await interact(page)
        await clickChart(page)
        for (let i = 0; i < 3; i++) await hide(page)
        expect(await leave(page)).toEqual([])
        expect(batches).toEqual([])
    })

    test('a startup that fails where agreement is due is never reported, as nothing arms', async ({
        page,
        context,
    }) => {
        const { batches } = await mock(context)
        await startupFlags(page, { fail: 'A row could not be read' })
        await page.goto('/')
        const gate = page.locator('dialog[data-startup-gate]')
        await expect(gate.getByRole('alert')).toBeVisible()
        await expect.poll(() => agreementState(page)).toBe('done')
        await expect.poll(() => clientLoaded(page), { timeout: 15_000 }).toBe(3)
        await gate.getByRole('alert').click()
        for (let i = 0; i < 3; i++) await hide(page)
        await page.waitForTimeout(500)
        expect(batches).toEqual([])
        expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull()
    })

    test('a startup that fails with a current record is reported once the error page is used', async ({
        page,
        context,
    }) => {
        const { batches } = await mock(context)
        await page.addInitScript(
            (key) => localStorage.setItem(key, '{"terms":999,"privacy":999}'),
            KEY,
        )
        await startupFlags(page, { fail: 'A row could not be read' })
        await page.goto('/')
        const gate = page.locator('dialog[data-startup-gate]')
        await expect(gate.getByRole('alert')).toBeVisible()
        expect(await agreementState(page)).toBe('notDue')
        await gate.getByRole('alert').click()
        await sends(page, batches)
        expect(dataOf(batches[0] ?? [], 'startup')).toMatchObject({ outcome: 'error' })
    })

    test('where the record cannot be stored, Agree still lets the next input arm', async ({
        page,
        context,
    }) => {
        const { batches } = await mock(context)
        await page.addInitScript((key) => {
            const setItem = Storage.prototype.setItem
            Storage.prototype.setItem = function (name, value) {
                if (name === key) throw new DOMException('Full', 'QuotaExceededError')
                setItem.call(this, name, value)
            }
        }, KEY)
        await shownVisit(page)
        await agree(page)
        await clickChart(page)
        await sends(page, batches)
    })

    test('Agree in another tab lets the next input here arm', async ({ page, context }) => {
        const { batches } = await mock(context)
        await shownVisit(page)
        const other = await context.newPage()
        await other.goto('/')
        await expect(gateDialog(other)).toBeVisible()
        await agree(other)
        await other.close()
        await expect(gateDialog(page)).toHaveCount(0)
        await expect.poll(() => agreementState(page)).toBe('done')
        await clickChart(page)
        await sends(page, batches)
    })

    test('a hidden page holds it too, and the visit arms after Agree', async ({
        page,
        context,
    }) => {
        const { batches } = await mock(context)
        await page.addInitScript(() => {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'hidden',
            })
        })
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect.poll(() => clientLoaded(page), { timeout: 15_000 }).toBe(3)
        // The dialog opens in a hidden page too: nothing is stored before Agree.
        await expect.poll(() => agreementState(page)).toBe('open')
        await page.evaluate(() => {
            delete (document as { visibilityState?: unknown }).visibilityState
            document.dispatchEvent(new Event('visibilitychange'))
        })
        await expect(gateDialog(page)).toBeVisible()
        await interact(page)
        for (let i = 0; i < 3; i++) await hide(page)
        expect(batches).toEqual([])
        await agree(page)
        await clickChart(page)
        await sends(page, batches)
    })
})
