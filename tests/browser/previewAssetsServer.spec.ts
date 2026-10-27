import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { collection, patched, type Type } from './previewAssetsPackages'
import { BASE, filesOf, ORIGIN, serve } from './previewAssetsServers'
import { resource } from './previewResourceFixture'

// The Preview Assets dialog with From a Server, which
// only the apps have: the page gets their capability from a test platform whose fetch asks fake
// servers in Node (previewAssetsServers.ts). The web, with no servers, is tested too. With
// SHOTS_DIR set, each state is also saved there as a screenshot.
const shotsDir = process.env.SHOTS_DIR
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const KEY = 'sonolus-next-sekai-editor.'
const dialog = (page: Page) => page.locator('dialog[open]')
const chooser = (page: Page) => dialog(page).locator('[data-asset-chooser]')
const fallbackLine = (page: Page, type: string) => page.locator(`[data-asset-fallback="${type}"]`)

const start = async (page: Page, seed: Record<string, unknown> = {}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(
        ([prefix, seed]) => {
            if (sessionStorage.getItem('seeded')) return
            sessionStorage.setItem('seeded', '1')
            for (const [key, value] of Object.entries(seed as Record<string, unknown>))
                localStorage.setItem(prefix + key, JSON.stringify(value))
        },
        [KEY, seed] as const,
    )
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        window.editorTest.settings.showPreview = true
        window.editorTest.settings.previewControls = 'collapsed'
    })
    return errors
}

const open = async (page: Page, tab?: Type | 'stored') => {
    await page.evaluate(async (tab) => {
        const { showPreviewAssets } = await import('/src/editor/commands/previewAssets/modal.ts')
        await showPreviewAssets(tab)
        await window.editorTest.nextTick()
    }, tab)
    await expect(dialog(page)).toHaveAccessibleName('Preview Assets')
    await expect(
        dialog(page)
            .locator('[data-asset-sources], [data-stored-list], [data-stored-empty]')
            .first(),
    ).toBeVisible()
}

const tabOf = (page: Page, type: string) =>
    dialog(page).locator(`[data-preview-assets-tab="${type}"]`)
const selectedTab = (page: Page) => dialog(page).getByRole('tab', { selected: true })

type Choice = { source: string; title?: string; name?: string; origin?: string; key?: string }
const choices = (page: Page) =>
    page.evaluate(
        () => window.editorTest.settings.previewAssets as unknown as Record<string, Choice>,
    )
const recentServers = (page: Page) =>
    page.evaluate(
        () => (window.editorTest.settings as unknown as { recentServers: string[] }).recentServers,
    )

const shot = async (page: Page, name: string, target?: Locator) => {
    if (!shotsDir) return
    // Let the thumbnails and the fonts settle.
    await page.waitForTimeout(400)
    await (target ?? page).screenshot({ path: `${shotsDir}/${name}.png` })
}

const slot = (page: Page, type: string) =>
    page.evaluate(async (type) => {
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        const slots = assetSession.slots as unknown as Record<
            string,
            { value: { state: string; status?: unknown; value?: { title?: string } } }
        >
        const { state, status, value } = slots[type]?.value ?? { state: 'none' }
        return { state, status, title: value?.title }
    }, type)

const stored = (page: Page) =>
    page.evaluate(async () => {
        const { workerStore } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets/files/store')
        >('/src/preview/assets/files/store.ts')
        return await workerStore.list()
    })

/** A server holding the given items, each type's from the Built-in set with new names. */
const files = async (
    parts: Partial<Record<Type, { name: string; title?: string; author?: string }[]>>,
) => filesOf(await collection(parts))

const field = (page: Page) => chooser(page).locator('[data-server-address]')
const connectButton = (page: Page) => chooser(page).locator('[data-server-connect]')
const useButton = (page: Page) => chooser(page).locator('[data-chooser-use]')
const errorOf = (page: Page) => chooser(page).locator('[data-server-error]')
// A failed Use shows next to Use.
const useErrorOf = (page: Page) =>
    chooser(page).locator('[data-chooser-actions] [data-chooser-error]')

const choose = async (page: Page) => {
    await dialog(page).locator('[data-asset-choose]').click()
    await expect(chooser(page)).toBeVisible()
}

/** Opens the chooser on the server view of the shown tab. */
const chooseServer = async (page: Page) => {
    await choose(page)
    await chooser(page).locator('[data-chooser-mode-option="server"]').check()
    await expect(field(page)).toBeVisible()
}

/** Types an address and connects, the way a user does. */
const connect = async (page: Page, address: string) => {
    await field(page).fill(address)
    await connectButton(page).click()
}

const SKIN = { skin: [{ name: 'neon', title: 'Neon Skin', author: 'Someone' }] }

/** A server choice whose package is not stored. */
const serverChoice = (title = 'Neon Skin') => ({
    source: 'server',
    key: 'f'.repeat(64),
    name: 'neon',
    title,
    author: 'Someone',
    origin: BASE,
})

/** Chooses an item as if elsewhere, so the loader takes the choice from the setting. */
const setChoice = (page: Page, type: string, choice: unknown) =>
    page.evaluate(
        ([type, choice]) => {
            const settings = window.editorTest.settings as unknown as {
                previewAssets: Record<string, unknown>
            }
            settings.previewAssets = { ...settings.previewAssets, [type as string]: choice }
        },
        [type, choice] as const,
    )

test.describe('From a Server', () => {
    test('the address field, off while connecting, takes focus back after a failed connection', async ({
        page,
    }) => {
        await start(page)
        await serve(page, { delay: () => 400, status: () => 503 })
        await open(page, 'skin')
        await chooseServer(page)
        await field(page).fill(BASE)
        await field(page).press('Enter')
        await expect(chooser(page).locator('[data-chooser-progress]')).toHaveText(/Connecting…/)
        await expect(errorOf(page)).toBeVisible()
        await expect(field(page)).toBeEnabled()
        await expect(field(page)).toBeFocused()
    })

    test('a skin is connected, listed, used, stored and shown, and loads again after a reload', async ({
        page,
    }) => {
        const errors = await start(page)
        const server = await serve(page, { title: 'Neon Server', files: await files(SKIN) })
        await open(page)
        await choose(page)
        // The chooser starts on a file; the switch has both.
        await expect(chooser(page).locator('[data-chooser-mode-option="file"]')).toBeChecked()
        await expect(chooser(page).locator('[data-chooser-select-file]')).toBeVisible()
        await chooser(page).locator('[data-chooser-mode-option="server"]').check()
        await expect(chooser(page).locator('[data-chooser-select-file]')).toHaveCount(0)
        await expect(field(page)).toHaveAttribute('placeholder', 'https://example.com/server')
        await expect(field(page)).toHaveValue('')
        await expect(useButton(page)).toBeDisabled()

        await connect(page, BASE)
        await expect(chooser(page).locator('[data-server-title]')).toHaveText('Neon Server')
        const item = chooser(page).locator('[data-chooser-item="neon"]')
        await expect(item).toContainText('Neon Skin')
        await expect(item).toContainText('Someone')
        // A lone item is selected already, and Use has focus.
        await expect(item.locator('input')).toBeChecked()
        await expect(useButton(page)).toBeFocused()
        // Its thumbnail is fetched from the server like the rest, and shown from a blob.
        const picture = item.locator('img')
        await expect(picture).toHaveAttribute('src', /^blob:/)
        expect(server.state.requests.some((url) => url.includes('/sonolus/repository/'))).toBe(true)
        await expect
            .poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth))
            .toBeGreaterThan(0)
        // The list was asked for with the interface language and the first page.
        expect(server.state.requests).toContain('/api/sonolus/info')
        expect(
            server.state.requests.some((url) => /skins\/list\?localization=en&page=0$/.test(url)),
        ).toBe(true)

        await useButton(page).click()
        await expect(chooser(page)).toHaveCount(0)
        const row = dialog(page).locator('[data-asset-row^="server:"]')
        await expect(row).toContainText('Neon Skin')
        await expect(row).toContainText('Someone · server.test/api')
        await expect(row.locator('input')).toBeChecked()
        expect((await choices(page)).skin).toMatchObject({
            source: 'server',
            title: 'Neon Skin',
            name: 'neon',
            origin: BASE,
        })
        expect(await recentServers(page)).toEqual([BASE])
        expect(await stored(page)).toHaveLength(1)
        await expect(dialog(page).locator('[data-stored-line]')).toHaveText(/^Stored: 1 item, /)
        await expect
            .poll(() => slot(page, 'skin'))
            .toMatchObject({ state: 'ready', status: { active: 'chosen' }, title: 'Neon Skin' })

        // The item is stored, so it loads again with the server gone.
        server.state.down = true
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await page.evaluate(() => {
            window.editorTest.settings.showPreview = true
        })
        await expect
            .poll(() => slot(page, 'skin'), { timeout: 15_000 })
            .toMatchObject({ state: 'ready', status: { active: 'chosen' }, title: 'Neon Skin' })
        expect(errors).toEqual([])
    })

    test('Enter in the address field connects, and a link, a bare host and a trailing slash all work', async ({
        page,
    }) => {
        await start(page)
        await serve(page, { files: await files(SKIN) })
        await open(page)
        await chooseServer(page)
        await field(page).fill(`${BASE}/`)
        await field(page).press('Enter')
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        // The field shows the server’s address once it is connected.
        await expect(field(page)).toHaveValue(BASE)
        await chooser(page).locator('[data-chooser-cancel]').click()

        // The deep-link form is rewritten to https.
        await choose(page)
        await chooser(page).locator('[data-chooser-mode-option="server"]').check()
        await field(page).fill('sonolus://server.test/api')
        await field(page).press('Enter')
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await expect(field(page)).toHaveValue(BASE)
    })

    test('other types of the same name are offered when a row is selected, and Use applies the ticked ones', async ({
        page,
    }) => {
        await start(page)
        await serve(page, {
            files: await files({
                skin: [{ name: 'neon', title: 'Neon Skin' }],
                particle: [{ name: 'neon', title: 'Neon Particle' }],
                background: [{ name: 'night', title: 'Night Sky' }],
                effect: [{ name: 'neon', title: 'Neon Sounds' }],
            }),
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        const also = chooser(page).locator('[data-chooser-also]')
        // One checkbox for the particle and one for the sound effects; the background has another name.
        await expect(also.locator('label')).toHaveCount(2)
        await expect(also).toContainText('Also use the particle “Neon Particle” from this server')
        await expect(also).toContainText(
            'Also use the sound effects “Neon Sounds” from this server',
        )
        await expect(also.locator('input:checked')).toHaveCount(0)
        // They sit between the list and the footer, before Use.
        const order = await chooser(page).evaluate((element) => {
            const position = (selector: string) =>
                [...element.querySelectorAll('*')].indexOf(element.querySelector(selector)!)
            return [
                position('[data-chooser-list]'),
                position('[data-chooser-also]'),
                position('[data-chooser-use]'),
            ]
        })
        expect(order[0]).toBeLessThan(order[1]!)
        expect(order[1]).toBeLessThan(order[2]!)

        await also.locator('[data-chooser-also-type="particle"]').check()
        await useButton(page).click()
        await expect(chooser(page)).toHaveCount(0)

        const now = await choices(page)
        expect(now.skin).toMatchObject({ source: 'server', title: 'Neon Skin' })
        expect(now.particle).toMatchObject({ source: 'server', title: 'Neon Particle' })
        // Unticked types stay as they were.
        expect(now.effect).toEqual({ source: 'default' })
        expect(now.background).toEqual({ source: 'default' })
        expect(await stored(page)).toHaveLength(2)
        await tabOf(page, 'particle').click()
        await expect(dialog(page).locator('[data-asset-row^="server:"]')).toContainText(
            'Neon Particle',
        )
    })

    test('a type whose lookup fails or finds nothing shows no checkbox', async ({ page }) => {
        await start(page)
        await serve(page, {
            files: await files({
                skin: [{ name: 'neon', title: 'Neon Skin' }],
                particle: [{ name: 'neon', title: 'Neon Particle' }],
                effect: [{ name: 'neon', title: 'Neon Sounds' }],
            }),
            status: (path) => (path.endsWith('/effects/neon') ? 500 : undefined),
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await expect(chooser(page).locator('[data-chooser-also] label')).toHaveCount(1)
        await expect(chooser(page).locator('[data-chooser-also]')).toContainText('particle')
    })

    test('the next chooser opens on the last server, and a link to another type’s item goes to that tab', async ({
        page,
    }) => {
        await start(page)
        await serve(page, {
            files: await files({
                skin: [{ name: 'neon', title: 'Neon Skin' }],
                particle: [
                    { name: 'neon', title: 'Neon Particle' },
                    { name: 'spark', title: 'Spark Particle' },
                ],
            }),
        })
        await open(page, 'skin')
        await chooseServer(page)
        await connect(page, BASE)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await useButton(page).click()
        await expect(chooser(page)).toHaveCount(0)

        // The particle chooser prefills the server, and waits for Connect.
        await tabOf(page, 'particle').click()
        await choose(page)
        await chooser(page).locator('[data-chooser-mode-option="server"]').check()
        await expect(field(page)).toHaveValue(BASE)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(0)
        await chooser(page).locator('[data-chooser-cancel]').click()

        // A share link to a particle, typed in the Skin tab, opens the Particle tab on that item.
        await tabOf(page, 'skin').click()
        await choose(page)
        await chooser(page).locator('[data-chooser-mode-option="server"]').check()
        await connect(page, `${BASE}/particles/spark`)
        await expect(selectedTab(page)).toHaveText('Particle')
        await expect(chooser(page).locator('[data-chooser-title]')).toHaveText('Choose a Particle')
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(2)
        // The linked item is first and selected.
        await expect(chooser(page).locator('[data-chooser-item]').first()).toContainText(
            'Spark Particle',
        )
        await expect(chooser(page).locator('[data-chooser-item="spark"] input')).toBeChecked()
        await expect(field(page)).toHaveValue(BASE)
    })

    test('a share link to an item of the tab’s type selects it, and one the server lacks says so', async ({
        page,
    }) => {
        await start(page)
        await serve(page, {
            files: await files({
                skin: [
                    { name: 'a', title: 'First Skin' },
                    { name: 'b', title: 'Second Skin' },
                ],
            }),
        })
        await open(page, 'skin')
        await chooseServer(page)
        await connect(page, `${BASE}/skins/b`)
        await expect(chooser(page).locator('[data-chooser-item="b"] input')).toBeChecked()
        await expect(errorOf(page)).toHaveCount(0)
        await chooser(page).locator('[data-chooser-cancel]').click()

        await choose(page)
        await chooser(page).locator('[data-chooser-mode-option="server"]').check()
        await connect(page, `${BASE}/skins/gone`)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(2)
        await expect(errorOf(page)).toContainText('This server does not have that item.')
    })

    test('paging and quick search', async ({ page }) => {
        await start(page)
        const names = ['alpha', 'beta', 'gamma', 'delta']
        const server = await serve(page, {
            files: await files({
                skin: names.map((name) => ({ name, title: name.toUpperCase() })),
            }),
            list: (category, query) => {
                if (category !== 'skins') return undefined
                const keywords = query.get('keywords')
                if (keywords !== null) {
                    expect(query.get('type')).toBe('quick')
                    return {
                        pageCount: 1,
                        items: names
                            .filter((name) => name.includes(keywords))
                            .map((name) => ({ name, title: name.toUpperCase() })),
                    }
                }
                const page = Number(query.get('page'))
                return {
                    pageCount: 2,
                    items: names
                        .slice(page * 2, page * 2 + 2)
                        .map((name) => ({ name, title: name.toUpperCase() })),
                }
            },
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        const items = chooser(page).locator('[data-chooser-item]')
        await expect(items).toHaveCount(2)
        await expect(chooser(page).locator('[data-server-more]')).toHaveText('More')
        await chooser(page).locator('[data-server-more]').click()
        await expect(items).toHaveCount(4)
        // The last page has no More.
        await expect(chooser(page).locator('[data-server-more]')).toHaveCount(0)
        expect(server.state.requests.filter((url) => url.includes('skins/list'))).toEqual([
            '/api/sonolus/skins/list?localization=en&page=0',
            '/api/sonolus/skins/list?localization=en&page=1',
        ])

        // A search runs a moment after typing stops.
        await items.nth(2).locator('input').check()
        const search = chooser(page).locator('[data-server-search]')
        await expect(search).toHaveAttribute('placeholder', 'Search…')
        await search.fill('lta')
        await expect(items).toHaveCount(1)
        await expect(items.first()).toContainText('DELTA')
        expect(server.state.requests.at(-1)).toMatch(/type=quick&keywords=lta&page=0$/)
        // The selection it dropped is gone with it, and Use waits for another.
        await expect(useButton(page)).toBeDisabled()
        // Emptying the search lists everything again.
        await search.fill('')
        await expect(items).toHaveCount(2)
    })

    test('a server with a cursor lists page after page', async ({ page }) => {
        await start(page)
        await serve(page, {
            files: await files({ skin: [{ name: 'only', title: 'Only' }] }),
            list: (category, query) => {
                if (category !== 'skins') return undefined
                const cursor = query.get('cursor')
                return cursor === null
                    ? { pageCount: -1, cursor: 'c1', items: [{ name: 'first', title: 'First' }] }
                    : { pageCount: -1, items: [{ name: 'second', title: 'Second' }] }
            },
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        const items = chooser(page).locator('[data-chooser-item]')
        await expect(items).toHaveCount(1)
        await chooser(page).locator('[data-server-more]').click()
        await expect(items).toHaveCount(2)
        await expect(chooser(page).locator('[data-server-more]')).toHaveCount(0)
    })

    test('a server with no items of the type says so', async ({ page }) => {
        await start(page)
        await serve(page, { files: await files({ particle: [{ name: 'neon', title: 'Neon' }] }) })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await expect(chooser(page).locator('[data-chooser-empty]')).toHaveText('No items found')
        await expect(useButton(page)).toBeDisabled()
    })
})

test.describe('on the web', () => {
    test('the chooser offers a file only, with no switch', async ({ page }) => {
        const errors = await start(page)
        await open(page)
        await choose(page)
        await expect(chooser(page).locator('[data-chooser-mode]')).toHaveCount(0)
        await expect(chooser(page).locator('[data-chooser-select-file]')).toBeVisible()
        await expect(chooser(page).locator('[data-server-address]')).toHaveCount(0)
        expect(errors).toEqual([])
    })

    test('a server choice whose package is gone falls back to Default, asks nothing, and is kept', async ({
        page,
    }) => {
        const requests: string[] = []
        page.on('request', (request) => requests.push(request.url()))
        await start(page, { previewAssets: { skin: serverChoice() } })
        await expect
            .poll(() => slot(page, 'skin'), { timeout: 15_000 })
            .toMatchObject({ state: 'ready', status: { active: 'default', reason: 'missing' } })
        expect(requests.filter((url) => !url.startsWith(new URL(page.url()).origin))).toEqual([])
        expect((await choices(page)).skin).toMatchObject({ source: 'server', name: 'neon' })
        await open(page, 'skin')
        await expect(dialog(page).locator('[data-asset-note]')).toHaveText(
            'Using Next SEKAI 01. The skin could not be downloaded again from server.test/api.',
        )
    })
})

test.describe('when a server cannot be used', () => {
    test('a server that cannot be reached says so', async ({ page }) => {
        await start(page)
        const server = await serve(page, { files: await files(SKIN) })
        server.state.down = true
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await expect(errorOf(page).locator('[data-server-error-text]')).toHaveText(
            'Could not reach this server. Check the address, or try again later.',
        )
        // It can be tried again, and works once the server is back.
        server.state.down = false
        await connectButton(page).click()
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await expect(errorOf(page)).toHaveCount(0)
    })

    test('offline, the chooser says so and asks nothing', async ({ page, context }) => {
        await start(page)
        const server = await serve(page, { files: await files(SKIN) })
        await open(page)
        await chooseServer(page)
        await context.setOffline(true)
        await connect(page, BASE)
        await expect(errorOf(page).locator('[data-server-error-text]')).toHaveText(
            'You are offline.',
        )
        expect(server.state.requests).toEqual([])
        // Everything else keeps working: a file can still be chosen.
        await chooser(page).locator('[data-chooser-mode-option="file"]').check()
        await expect(chooser(page).locator('[data-chooser-select-file]')).toBeEnabled()
        await context.setOffline(false)
    })

    test('a server that needs a sign-in says so', async ({ page }) => {
        await start(page)
        await serve(page, { files: await files(SKIN), status: () => 401 })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await expect(errorOf(page).locator('[data-server-error-text]')).toHaveText(
            'The editor cannot use servers that require signing in.',
        )
    })

    test('an http address is refused before anything is fetched', async ({ page }) => {
        await start(page)
        const server = await serve(page, { files: await files(SKIN) })
        await open(page)
        await chooseServer(page)
        await connect(page, 'http://server.test/api')
        await expect(errorOf(page).locator('[data-server-error-text]')).toHaveText(
            'HTTP server addresses are not supported.',
        )
        expect(server.state.requests).toEqual([])
        await field(page).fill('')
        await connectButton(page).click()
        await expect(errorOf(page)).toContainText('Enter a server address.')
        await field(page).fill('https://user:secret@server.test/api')
        await connectButton(page).click()
        await expect(errorOf(page)).toContainText('cannot contain a user name or password')
        expect(server.state.requests).toEqual([])
    })

    test('an address with no Sonolus server behind it, and a server error, are told apart', async ({
        page,
    }) => {
        await start(page)
        await serve(page, {
            files: await files(SKIN),
            status: (path) => (path.endsWith('/broken/sonolus/info') ? 503 : undefined),
        })
        await open(page)
        await chooseServer(page)
        await connect(page, `${BASE}/elsewhere`)
        await expect(errorOf(page)).toContainText(
            'The server returned data that the editor could not read.',
        )
        await connect(page, `${BASE}/broken`)
        await expect(errorOf(page)).toContainText('This server returned an error (503).')
    })

    test('an item with a wrong checksum is refused in the server’s words, and nothing is stored', async ({
        page,
    }) => {
        await start(page)
        await serve(page, {
            files: await filesOf(await patched('skin', { hashes: 'bad' })),
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await useButton(page).click()
        await expect(useErrorOf(page)).toContainText(
            'The downloaded content does not match the server’s checksum.',
        )
        await expect(chooser(page)).toBeVisible()
        expect(await stored(page)).toHaveLength(0)
        expect((await choices(page)).skin).toEqual({ source: 'default' })
    })

    test('a Use that cannot fetch the files from another host names that host, next to Use', async ({
        page,
    }) => {
        await start(page)
        const skin = await files(SKIN)
        const details = JSON.parse(Buffer.from(skin.get('sonolus/skins/neon')!).toString()) as {
            item: { texture: { url: string } }
        }
        details.item.texture.url = 'https://cdn.test/texture.png'
        skin.set('sonolus/skins/neon', Buffer.from(JSON.stringify(details)))
        await serve(page, { files: skin })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await useButton(page).click()
        await expect(useErrorOf(page)).toHaveText(
            'Could not download this item’s files from cdn.test.',
        )
        await expect(useButton(page)).toBeEnabled()
        expect(await stored(page)).toHaveLength(0)
    })

    test('an item the checks refuse is worded as the server’s item', async ({ page }) => {
        await start(page)
        const { pngHeader } = await import('../preview/files/fixtures')
        await serve(page, {
            files: await filesOf(
                await patched('skin', { resources: { texture: pngHeader(8192, 8192) } }),
            ),
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await useButton(page).click()
        await expect(useErrorOf(page)).toContainText(
            'This item’s skin texture is 8192 × 8192. The limit is 4096 × 4096.',
        )
        expect(await stored(page)).toHaveLength(0)
    })
})

test.describe('a server item that left storage', () => {
    test('is downloaded again at load, stored, and chosen under its new key', async ({ page }) => {
        await start(page)
        const served = await serve(page, { files: await files(SKIN) })
        await setChoice(page, 'skin', serverChoice())
        await expect
            .poll(() => slot(page, 'skin'), { timeout: 15_000 })
            .toMatchObject({ state: 'ready', status: { active: 'chosen' }, title: 'Neon Skin' })
        expect(served.state.requests).toContain('/api/sonolus/info')
        // Stored again, and the setting follows the key it came back under.
        await expect.poll(async () => (await stored(page)).length).toBe(1)
        const [meta] = await stored(page)
        await expect.poll(async () => (await choices(page)).skin?.key).toBe(meta!.key)
        await expect(fallbackLine(page, 'skin')).toHaveCount(0)
    })

    test('falls back to Default when the server cannot be reached, and says why', async ({
        page,
    }) => {
        await start(page)
        const server = await serve(page, { files: await files(SKIN) })
        server.state.down = true
        await setChoice(page, 'skin', serverChoice())
        await expect
            .poll(() => slot(page, 'skin'), { timeout: 15_000 })
            .toMatchObject({ state: 'ready', status: { active: 'default', reason: 'unavailable' } })
        // The choice is kept for later, and the dialog says what happened.
        expect((await choices(page)).skin).toMatchObject({ source: 'server', name: 'neon' })
        await open(page, 'skin')
        await expect(dialog(page).locator('[data-asset-note]')).toHaveText(
            'Using Next SEKAI 01. The skin could not be downloaded again from server.test/api.',
        )
        await expect(dialog(page).locator('[data-asset-choose-again]')).toHaveCount(0)
        await expect(tabOf(page, 'skin').locator('[data-tab-warning]')).toBeVisible()
        await page.keyboard.press('Escape')

        // Once the server is back, the next load finds the item again.
        server.state.down = false
        await setChoice(page, 'skin', { source: 'default' })
        await setChoice(page, 'skin', serverChoice())
        await expect
            .poll(() => slot(page, 'skin'), { timeout: 15_000 })
            .toMatchObject({ state: 'ready', status: { active: 'chosen' } })
    })

    test('falls back to Default when offline, asks nothing, and says so', async ({ page }) => {
        // The page itself loads from the dev server, so only what the browser reports is offline.
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'onLine', { get: () => false })
        })
        await start(page)
        const server = await serve(page, { files: await files(SKIN) })
        await setChoice(page, 'skin', serverChoice())
        await expect
            .poll(() => slot(page, 'skin'), { timeout: 15_000 })
            .toMatchObject({ state: 'ready', status: { active: 'default', reason: 'offline' } })
        expect(server.state.requests).toEqual([])
        expect((await choices(page)).skin).toMatchObject({ source: 'server', name: 'neon' })
        await open(page, 'skin')
        await expect(dialog(page).locator('[data-asset-note]')).toHaveText(
            'Using Next SEKAI 01. You are offline.',
        )
    })
})

test.describe('the chooser keeps its state', () => {
    test('switching tabs during a download keeps it going, and closing the dialog stops it and stores nothing', async ({
        page,
    }) => {
        await start(page)
        // The resources are slow, so the download is under way for a while.
        await serve(page, {
            files: await files(SKIN),
            delay: (path) => (path.includes('/repository/') ? 30_000 : 0),
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await useButton(page).click()
        await expect(chooser(page).locator('[data-chooser-progress]')).toHaveText(/Downloading…/)
        await expect(chooser(page).locator('[data-server-address]')).toBeDisabled()

        // Another tab, and back: the download is still shown.
        await tabOf(page, 'particle').click()
        await expect(dialog(page).locator('[data-asset-sources]')).toBeVisible()
        await tabOf(page, 'skin').click()
        await expect(chooser(page).locator('[data-chooser-progress]')).toHaveText(/Downloading…/)
        await expect(chooser(page).locator('[data-chooser-mode-option="file"]')).toBeDisabled()

        // Closing the dialog stops it.
        await page.keyboard.press('Escape')
        await expect(dialog(page)).toHaveCount(0)
        await page.waitForTimeout(300)
        expect(await stored(page)).toHaveLength(0)
        expect((await choices(page)).skin).toEqual({ source: 'default' })
        await open(page)
        await expect(chooser(page)).toHaveCount(0)
    })

    test('each tab keeps its connected server, and Cancel leaves the previous choice', async ({
        page,
    }) => {
        await start(page, { previewAssets: { skin: { source: 'builtin' } } })
        await serve(page, {
            files: await files({
                skin: [{ name: 'neon', title: 'Neon Skin' }],
                particle: [{ name: 'neon', title: 'Neon Particle' }],
            }),
        })
        await open(page, 'skin')
        await chooseServer(page)
        await connect(page, BASE)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await tabOf(page, 'particle').click()
        await expect(chooser(page)).toHaveCount(0)
        await tabOf(page, 'skin').click()
        // Still connected, in the server view.
        await expect(chooser(page).locator('[data-chooser-mode-option="server"]')).toBeChecked()
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)

        // Each view keeps its own state when the switch is used.
        await chooser(page).locator('[data-chooser-mode-option="file"]').check()
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(0)
        await chooser(page).locator('[data-chooser-mode-option="server"]').check()
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)

        await chooser(page).locator('[data-chooser-cancel]').click()
        await expect(chooser(page)).toHaveCount(0)
        await expect(dialog(page).locator('[data-asset-row="builtin"] input')).toBeChecked()
        expect(await stored(page)).toHaveLength(0)
        // Opened again, the chooser is as new, with the server in the field.
        await choose(page)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(0)
    })

    test('Choose Again opens the chooser on a file, whatever it showed before', async ({
        page,
    }) => {
        const fileChoice = {
            source: 'file',
            key: 'abc',
            name: 'neon',
            title: 'Neon Skin',
            author: 'Someone',
            origin: 'neon.scp',
        }
        await start(page, { previewAssets: { background: fileChoice } })
        await serve(page)
        await open(page, 'skin')
        await chooseServer(page)
        await chooser(page).locator('[data-chooser-cancel]').click()
        await tabOf(page, 'background').click()
        await dialog(page).locator('[data-asset-choose-again]').click()
        await expect(chooser(page).locator('[data-chooser-mode-option="file"]')).toBeChecked()
        await expect(chooser(page).locator('[data-chooser-select-file]')).toBeVisible()
    })

    test('arrowing through the source list never opens the chooser', async ({ page }) => {
        await start(page)
        await open(page)
        await dialog(page).locator('[data-asset-row="default"] input').focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowUp')
        await expect(chooser(page)).toHaveCount(0)
    })
})

test.describe('narrow', () => {
    test.use({ viewport: { width: 360, height: 740 } })

    test('the server view fits 360 px without sideways scrolling', async ({ page }) => {
        await start(page)
        await serve(page, {
            title: 'A server with a title that is much too long to fit on one line at all',
            files: await files({
                skin: [
                    {
                        name: 'neon',
                        title: 'A skin with a very long title that has to be cut somewhere',
                        author: 'An author with a long name',
                    },
                ],
                particle: [{ name: 'neon', title: 'Neon Particle with a rather long title too' }],
            }),
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        const fits = (target: Locator) =>
            target.evaluate((element) => ({
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
            }))
        const width = await fits(chooser(page))
        expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth)
        const box = await dialog(page).boundingBox()
        expect(box!.x + box!.width).toBeLessThanOrEqual(360)
        for (const selector of [
            '[data-server-address]',
            '[data-server-connect]',
            '[data-server-search]',
        ]) {
            const control = await chooser(page).locator(selector).boundingBox()
            expect(control!.x + control!.width).toBeLessThanOrEqual(360)
        }
    })
})

test.describe('narrow, downloading', () => {
    test.use({ viewport: { width: 360, height: 740 } })

    test('“Downloading…” takes only the room it needs', async ({ page }) => {
        await start(page)
        await serve(page, {
            files: await files(SKIN),
            delay: (path) => (path.includes('/repository/') ? 30_000 : 0),
        })
        await open(page)
        await chooseServer(page)
        await connect(page, BASE)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await useButton(page).click()
        const progress = chooser(page).locator('[data-chooser-actions] [data-chooser-progress]')
        await expect(progress).toHaveText(/Downloading…/)
        const box = await progress.boundingBox()
        expect(box!.height).toBeLessThan(60)
        await chooser(page).locator('[data-chooser-cancel]').click()
    })
})

// Every state of the server chooser, wide (1280 px) and narrow (360 px), light and dark, as the
// whole page.
test.describe('looks', () => {
    for (const theme of ['light', 'dark'] as const)
        for (const [size, viewport] of [
            ['wide', { width: 1280, height: 800 }],
            ['narrow', { width: 360, height: 740 }],
        ] as const)
            test(`the server chooser, ${size}, in the ${theme} theme`, async ({
                page,
                context,
            }) => {
                test.setTimeout(180_000)
                await page.setViewportSize(viewport)
                await start(page)
                await page.evaluate((theme) => (window.editorTest.settings.theme = theme), theme)
                const skins = Array.from({ length: 3 }, (_, index) => ({
                    name: `more${index}`,
                    title: `More Skin ${index + 1}`,
                    author: 'Someone',
                }))
                const serverFiles = await files({
                    skin: [
                        { name: 'neon', title: 'Neon Skin', author: 'Someone' },
                        { name: 'night', title: 'Night Skin', author: 'Someone Else' },
                        {
                            name: 'long',
                            title: 'A skin with a very long title that has to be cut somewhere',
                            author: 'An author with a long name',
                        },
                        ...skins,
                    ],
                    particle: [{ name: 'neon', title: 'Neon Particle' }],
                    effect: [{ name: 'neon', title: 'Neon Sounds' }],
                })
                const listOf = (names: string[]) =>
                    names.map((name) => {
                        const details = JSON.parse(
                            Buffer.from(serverFiles.get(`sonolus/skins/${name}`)!).toString(),
                        ) as { item: unknown }
                        return details.item
                    })
                let holdMore = false
                const server = await serve(page, {
                    title: 'Neon Server',
                    files: serverFiles,
                    // Two pages; every search finds nothing.
                    list: (category, query) => {
                        if (category !== 'skins') return undefined
                        if (query.get('keywords')) return { pageCount: 1, items: [] }
                        return Number(query.get('page')) === 0
                            ? { pageCount: 2, items: listOf(['neon', 'night', 'long']) }
                            : { pageCount: 2, items: listOf(skins.map((skin) => skin.name)) }
                    },
                    delay: (path, query) =>
                        holdMore && path.endsWith('/skins/list') && query.get('page') === '1'
                            ? 60_000
                            : 0,
                    status: (path) =>
                        path.startsWith('/auth/')
                            ? 401
                            : path.startsWith('/broken/')
                              ? 503
                              : undefined,
                })
                await open(page, 'skin')
                const name = (state: string) => `server-${state}-${size}-${theme}`
                const again = async () => {
                    await choose(page)
                    await chooser(page).locator('[data-chooser-mode-option="server"]').check()
                }

                // The chooser on a file, with the switch.
                await choose(page)
                await shot(page, name('file'))

                // The server view, empty.
                await chooser(page).locator('[data-chooser-mode-option="server"]').check()
                await shot(page, name('empty'))

                // Connecting: the answer is held back.
                const slow = await serve(page, { origin: 'https://slow.test', delay: () => 60_000 })
                await field(page).fill('https://slow.test/api')
                await connectButton(page).click()
                await expect(chooser(page).locator('[data-chooser-progress]')).toHaveText(
                    /Connecting…/,
                )
                await shot(page, name('connecting'))
                await chooser(page).locator('[data-chooser-cancel]').click()
                expect(slow.state.requests.length).toBeGreaterThan(0)

                // Listed, several items, none selected, with More.
                await again()
                await connect(page, BASE)
                await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(3)
                await expect(chooser(page).locator('[data-chooser-item] img')).toHaveCount(3)
                await shot(page, name('listed-many'))

                // More, while the next page loads.
                holdMore = true
                await chooser(page).locator('[data-server-more]').click()
                await expect(chooser(page).locator('[data-server-loading]')).toBeVisible()
                await shot(page, name('more-loading'))
                await chooser(page).locator('[data-chooser-cancel]').click()
                holdMore = false

                // One selected, with the other types offered.
                await again()
                await connect(page, BASE)
                await chooser(page).locator('[data-chooser-item="neon"] input').check()
                await expect(chooser(page).locator('[data-chooser-also] label')).toHaveCount(2)
                await chooser(page).locator('[data-chooser-also-type="particle"]').check()
                await shot(page, name('listed-selected'))

                // A search with no result.
                await chooser(page).locator('[data-server-search]').fill('zzz')
                await expect(chooser(page).locator('[data-chooser-empty]')).toBeVisible()
                await shot(page, name('searched'))
                await chooser(page).locator('[data-chooser-cancel]').click()

                // A share link to an item the server lacks: the list, and why.
                await again()
                await connect(page, `${BASE}/skins/gone`)
                await expect(errorOf(page)).toContainText('This server does not have that item.')
                await shot(page, name('not-found'))
                await chooser(page).locator('[data-chooser-cancel]').click()

                // A server without items of the type.
                await tabOf(page, 'background').click()
                await again()
                await connect(page, BASE)
                await expect(chooser(page).locator('[data-chooser-empty]')).toBeVisible()
                await shot(page, name('none'))
                await chooser(page).locator('[data-chooser-cancel]').click()

                // Failures under the field.
                await tabOf(page, 'skin').click()
                await again()
                server.state.down = true
                await connect(page, BASE)
                await expect(errorOf(page)).toContainText('Could not reach this server')
                await shot(page, name('error-unreachable'))
                server.state.down = false
                await connect(page, `${ORIGIN}/auth`)
                await expect(errorOf(page)).toContainText('require signing in')
                await shot(page, name('error-auth'))
                await connect(page, `${ORIGIN}/broken`)
                await expect(errorOf(page)).toContainText('returned an error (503)')
                await shot(page, name('error-status'))
                await connect(page, 'http://server.test/api')
                await expect(errorOf(page)).toContainText('HTTP server addresses')
                await shot(page, name('error-http'))
                await context.setOffline(true)
                await connect(page, BASE)
                await expect(errorOf(page)).toContainText('You are offline.')
                await shot(page, name('error-offline'))
                await context.setOffline(false)

                // A Use that fails, next to Use.
                server.state.down = false
                await connect(page, BASE)
                await chooser(page).locator('[data-chooser-item="neon"] input').check()
                server.state.down = true
                await useButton(page).click()
                await expect(useErrorOf(page)).toBeVisible()
                await shot(page, name('use-failed'))
                server.state.down = false

                // Downloading: the resources are held back.
                const held = await serve(page, {
                    title: 'Neon Server',
                    files: serverFiles,
                    delay: (path) => (path.includes('/repository/') ? 60_000 : 0),
                })
                await useButton(page).click()
                await expect(chooser(page).locator('[data-chooser-progress]')).toHaveText(
                    /Downloading…/,
                )
                await shot(page, name('downloading'))
                expect(held.state.requests.length).toBeGreaterThan(0)
                await chooser(page).locator('[data-chooser-cancel]').click()

                // Used: the list shows the server item, and the Stored tab lists it with its origin.
                await serve(page, { title: 'Neon Server', files: serverFiles })
                await again()
                await connect(page, BASE)
                await chooser(page).locator('[data-chooser-item="night"] input').check()
                await useButton(page).click()
                await expect(chooser(page)).toHaveCount(0)
                await shot(page, name('sources-server'))
                await tabOf(page, 'stored').click()
                await expect(dialog(page).locator('[data-stored-item]')).toHaveCount(1)
                await shot(page, name('stored'))

                // A server choice that could not be downloaded again: the reason under its row.
                const gone = await serve(page, { title: 'Neon Server', files: serverFiles })
                gone.state.down = true
                await setChoice(page, 'particle', {
                    ...serverChoice('Neon Particle'),
                    key: 'e'.repeat(64),
                })
                await expect
                    .poll(() => slot(page, 'particle'), { timeout: 15_000 })
                    .toMatchObject({ status: { reason: 'unavailable' } })
                await tabOf(page, 'particle').click()
                await expect(dialog(page).locator('[data-asset-note]')).toContainText(
                    'could not be downloaded again',
                )
                await shot(page, name('server-failed'))
            })

    for (const theme of ['light', 'dark'] as const)
        for (const [size, viewport] of [
            ['wide', { width: 1280, height: 800 }],
            ['narrow', { width: 360, height: 740 }],
        ] as const)
            test(`the web chooser, ${size}, in the ${theme} theme`, async ({ page }) => {
                await page.setViewportSize(viewport)
                await start(page)
                await page.evaluate((theme) => (window.editorTest.settings.theme = theme), theme)
                await open(page, 'skin')
                await shot(page, `web-sources-${size}-${theme}`)
                await choose(page)
                await expect(chooser(page).locator('[data-chooser-mode]')).toHaveCount(0)
                await shot(page, `web-file-${size}-${theme}`)
            })
})
