import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

// The Preview Assets dialog with Default and Built-in (Part 2, 2.6; the A2 tests of 2.11). With
// A2_SHOTS_DIR set, each state is also saved there as a screenshot.
const shotsDir = process.env.A2_SHOTS_DIR
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const KEY = 'sonolus-next-sekai-editor.'
const dialog = (page: Page) => page.locator('dialog[open]')
const fallbackLine = (page: Page, type: string) => page.locator(`[data-asset-fallback="${type}"]`)

type Options = {
    /** localStorage values to seed, by setting name. */
    seed?: Record<string, unknown>
    /** Makes the Default skin and particle fail, or the Default and Built-in ones. */
    fail?: ('default-skin' | 'default-particle' | 'builtin-skin' | 'builtin-particle')[]
    /** Routes the Default background to a missing image. */
    query?: string
}

const start = async (page: Page, { seed = {}, fail = [], query = '' }: Options = {}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/resource/skin.scp*', (route) =>
        fail.includes('default-skin')
            ? route.fulfill({ status: 404 })
            : route.fulfill({ body: resource('skins') }),
    )
    await page.route('**/resource/particle.scp*', (route) =>
        fail.includes('default-particle')
            ? route.fulfill({ status: 404 })
            : route.fulfill({ body: resource('particles') }),
    )
    if (fail.includes('builtin-skin'))
        await page.route('**/builtin/skin.scp*', (route) => route.fulfill({ status: 404 }))
    if (fail.includes('builtin-particle'))
        await page.route('**/builtin/particle.scp*', (route) => route.fulfill({ status: 404 }))
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
    await page.goto('/' + query)
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        window.editorTest.settings.showPreview = true
        window.editorTest.settings.previewControls = 'collapsed'
    })
    return errors
}

const run = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const { commands } = await import('/src/editor/commands/index.ts')
        await commands[name as keyof typeof commands].execute()
        await window.editorTest.nextTick()
    }, name)

const open = async (page: Page, command = 'previewAssets') => {
    await run(page, command)
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page)).toHaveAccessibleName('Preview Assets')
    await expect(dialog(page).locator('[data-asset-sources]')).toBeVisible()
}

const shot = async (page: Page, name: string, target?: Locator) => {
    if (!shotsDir) return
    // Let the thumbnails and the fonts settle.
    await page.waitForTimeout(400)
    await (target ?? page).screenshot({ path: `${shotsDir}/${name}.png` })
}

const selectedTab = (page: Page) => dialog(page).getByRole('tab', { selected: true })
const tabOf = (page: Page, type: string) =>
    dialog(page).locator(`[data-preview-assets-tab="${type}"]`)
const setting = <T>(page: Page, key: string) =>
    page.evaluate((key) => (window.editorTest.settings as unknown as Record<string, T>)[key], key)
const requests = (page: Page) => {
    const urls: string[] = []
    page.on('request', (request) => urls.push(new URL(request.url()).pathname))
    return urls
}
const skinTitle = (page: Page) =>
    page.evaluate(async () => {
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        return assetSession.slots.skin.value.value?.title
    })
const slotStatus = (page: Page, type: string) =>
    page.evaluate(async (type) => {
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        const slots = assetSession.slots as unknown as Record<
            string,
            { value: { state: string; status?: unknown } }
        >
        return { state: slots[type]!.value.state, status: slots[type]!.value.status }
    }, type)

const builtinAll = Object.fromEntries(
    ['skin', 'particle', 'background', 'effect'].map((type) => [type, { source: 'builtin' }]),
)
const fileChoice = {
    source: 'file',
    key: 'abc',
    name: 'neon',
    title: 'Neon Skin',
    author: 'Someone',
    origin: 'neon.scp',
}

test.describe('ways in', () => {
    test('the command opens the dialog on Skin, with five tabs', async ({ page }) => {
        // With no fallback anywhere it opens on Skin.
        await start(page)
        await open(page)
        await expect(selectedTab(page)).toHaveText('Skin')
        await expect(dialog(page).getByRole('tab')).toHaveCount(5)
        await expect(dialog(page).getByRole('tablist')).toHaveText(
            /^\s*Skin\s*Particle\s*Background\s*Sound Effects\s*Stored\s*$/,
        )
    })

    test('the toolbar keeps it first in the playback group’s flyout', async ({ page }) => {
        await start(page)
        const toolbar = await page.evaluate(() => window.editorTest.settings.toolbar)
        const group = toolbar.find((group) => group.includes('play'))!
        expect(group.slice(0, 2)).toEqual(['previewAssets', 'offset'])
        expect(group.at(-1)).toBe('play')

        const bar = page.locator('[data-editor-toolbar]')
        await bar
            .locator(':scope > div > div > button')
            .and(page.getByTitle('Play', { exact: true }))
            .hover()
        const flyout = bar.locator(':scope > div > div > div button')
        await expect(flyout.first()).toBeVisible()
        const item = flyout.and(page.getByTitle('Preview Assets…', { exact: true }))
        await expect(item).toHaveCount(1)
        await item.click()
        await expect(dialog(page)).toHaveAccessibleName('Preview Assets')
    })

    test('Settings › Preview has one Assets row that closes Settings and opens it', async ({
        page,
    }) => {
        await start(page, { fail: ['default-particle'] })
        await page.keyboard.press(',')
        const settings = dialog(page)
        await expect(settings).toHaveAccessibleName('Settings')
        const row = settings.locator('.form-field').filter({ hasText: 'Assets' }).first()
        await expect(row).toContainText(
            'Skin, particle, background and sound effects for the preview and playback.',
        )
        await row.getByRole('button', { name: 'Preview Assets…' }).click()
        await expect(dialog(page)).toHaveAccessibleName('Preview Assets')
        await expect(dialog(page)).toHaveCount(1)
        // The first type that fell back, as with the command.
        await expect(selectedTab(page)).toContainText('Particle')
    })

    test('the Preview panel’s tab menu opens it', async ({ page }) => {
        await start(page)
        await page.locator('[data-panel-tab="preview"]').click({ button: 'right' })
        const menu = page.getByRole('menu')
        await expect(menu).toBeVisible()
        await menu.getByRole('menuitem', { name: 'Preview Assets…' }).click()
        await expect(dialog(page)).toHaveAccessibleName('Preview Assets')
        // Other panels' menus do not have it.
        await page.keyboard.press('Escape')
        await page.locator('[data-panel-tab="properties"]').click({ button: 'right' })
        await expect(page.getByRole('menu')).toBeVisible()
        await expect(page.getByRole('menuitem', { name: 'Preview Assets…' })).toHaveCount(0)
    })

    test('the panel’s fallback line opens it on that type’s tab', async ({ page }) => {
        await start(page, { fail: ['default-particle'] })
        const line = fallbackLine(page, 'particle')
        await expect(line).toContainText('Particle: using Built-in. Default could not be loaded.')
        await line.getByRole('button', { name: 'Preview Assets…' }).click()
        await expect(dialog(page)).toHaveAccessibleName('Preview Assets')
        await expect(selectedTab(page)).toContainText('Particle')
        // With no tab given, a fallback elsewhere also picks the tab.
        await page.keyboard.press('Escape')
        await open(page)
        await expect(selectedTab(page)).toContainText('Particle')
    })
})

test.describe('Default and Built-in', () => {
    test('the source list has Default and Built-in, with Default selected', async ({ page }) => {
        await start(page)
        await open(page)
        const rows = dialog(page).locator('[data-asset-row]')
        await expect(rows).toHaveCount(2)
        await expect(rows.nth(0)).toContainText('Default: Next SEKAI 01')
        await expect(rows.nth(1)).toContainText('Built-in')
        await expect(rows.nth(1)).toContainText('Next SEKAI Editor contributors')
        await expect(rows.nth(0).getByRole('radio')).toBeChecked()
        for (const [tab, label] of [
            ['particle', 'Default: Next SEKAI'],
            ['background', 'Default'],
            ['effect', 'Default'],
        ] as const) {
            await tabOf(page, tab).click()
            await expect(rows.nth(0)).toHaveText(new RegExp(`^\\s*${label}\\s*$`))
        }
        await expect(dialog(page).locator('[data-effect-hint]')).toHaveText(
            'Used by the preview and playback.',
        )
        // The Built-in thumbnails come from the package once the tab shows.
        await tabOf(page, 'skin').click()
        await expect(rows.nth(1).locator('img')).toHaveCount(1)
        await shot(page, 'skin')
    })

    test('selecting a row applies it at once, and the preview loads that package', async ({
        page,
    }) => {
        await start(page)
        await expect.poll(() => skinTitle(page)).toBe('Fixture')
        const urls = requests(page)
        await open(page)
        await dialog(page)
            .getByRole('radio', { name: /^Built-in/ })
            .check()
        expect(await setting<{ skin: { source: string } }>(page, 'previewAssets')).toMatchObject({
            skin: { source: 'builtin' },
            particle: { source: 'default' },
        })
        await expect.poll(() => skinTitle(page)).toBe('Editor')
        expect(urls).toContain('/builtin/skin.scp')
        // Only that type moves; the preview shows the Built-in skin without a reload.
        expect(urls).not.toContain('/builtin/particle.scp')
        await expect(page.locator('.preview canvas').first()).toBeVisible()

        await dialog(page)
            .getByRole('radio', { name: /^Default/ })
            .check()
        await expect.poll(() => skinTitle(page)).toBe('Fixture')
        // Back at the default, nothing is stored.
        expect(
            await page.evaluate((key) => localStorage.getItem(key), `${KEY}previewAssets`),
        ).toBeNull()
    })

    test('arrowing through a source list switches the choice and opens no dialog', async ({
        page,
    }) => {
        await start(page)
        await open(page)
        const first = dialog(page).getByRole('radio').first()
        await first.focus()
        await page.keyboard.press('ArrowDown')
        await expect(dialog(page).getByRole('radio', { name: /^Built-in/ })).toBeChecked()
        await page.keyboard.press('ArrowUp')
        await expect(first).toBeChecked()
        await expect(dialog(page)).toHaveCount(1)
        await expect(dialog(page).getByRole('dialog')).toHaveCount(0)
    })

    test('Use Built-in for All and Reset to Default set every type', async ({ page }) => {
        await start(page)
        await open(page)
        const useAll = dialog(page).getByRole('button', { name: 'Use Built-in for All' })
        const reset = dialog(page).getByRole('button', { name: 'Reset to Default' })
        await expect(reset).toBeDisabled()
        await useAll.click()
        expect(await setting(page, 'previewAssets')).toEqual(builtinAll)
        await expect(useAll).toBeDisabled()
        await expect(reset).toBeEnabled()
        for (const tab of ['Skin', 'Particle', 'Background', 'Sound Effects']) {
            await dialog(page).getByRole('tab', { name: tab, exact: true }).click()
            await expect(dialog(page).getByRole('radio', { name: /^Built-in/ })).toBeChecked()
        }
        await reset.click()
        expect((await setting<Record<string, unknown>>(page, 'previewAssets'))?.['skin']).toEqual({
            source: 'default',
        })
        await expect(reset).toBeDisabled()
        await expect.poll(() => skinTitle(page)).toBe('Fixture')
    })

    test('a saved Built-in choice loads Built-in at start and never asks for Default', async ({
        page,
    }) => {
        const urls = requests(page)
        await start(page, { seed: { previewAssets: builtinAll } })
        await expect.poll(() => skinTitle(page)).toBe('Editor')
        await expect
            .poll(() => slotStatus(page, 'background'))
            .toMatchObject({ state: 'ready', status: { active: 'builtin' } })
        expect(urls.filter((url) => url.startsWith('/resource/'))).toEqual([])
        expect(urls).toEqual(
            expect.arrayContaining(['/builtin/skin.scp', '/builtin/background.scp']),
        )
        await open(page)
        await expect(dialog(page).getByRole('radio', { name: /^Built-in/ })).toBeChecked()
        await expect(dialog(page).locator('[data-asset-note]')).toHaveCount(0)
    })

    test('the footer says nothing of storage while nothing is stored, and has no Manage… button', async ({
        page,
    }) => {
        await start(page)
        await open(page)
        const footer = dialog(page).locator('[data-preview-assets-footer]')
        await expect(footer.locator('[data-stored-line]')).toHaveCount(0)
        await expect(footer).not.toContainText('Stored')
        await expect(footer.getByRole('button')).toHaveText([
            'Use Built-in for All',
            'Reset to Default',
        ])
        await expect(dialog(page).getByRole('button', { name: /Manage/ })).toHaveCount(0)
        await tabOf(page, 'stored').click()
        await expect(dialog(page).locator('[data-stored-empty]')).toHaveText('No stored items')
        await shot(page, 'stored')
    })
})

test.describe('fallbacks', () => {
    test('when resource/skin.scp is gone, Built-in shows the skin, with its line and its row', async ({
        page,
    }) => {
        await start(page, { fail: ['default-skin'] })
        await expect.poll(() => skinTitle(page)).toBe('Editor')
        await expect(page.getByText('The preview skin could not be loaded.')).toHaveCount(0)
        await expect(page.locator('.preview canvas').first()).toBeVisible()
        const line = fallbackLine(page, 'skin')
        await expect(line).toContainText('Skin: using Built-in. Default could not be loaded.')
        expect(await slotStatus(page, 'skin')).toMatchObject({
            state: 'ready',
            status: { active: 'builtin', reason: 'missing' },
        })
        // The setting is unchanged.
        expect(
            await page.evaluate((key) => localStorage.getItem(key), `${KEY}previewAssets`),
        ).toBeNull()

        await open(page)
        // The dialog opens on the type that fell back; its tab carries the mark and the reason.
        await expect(selectedTab(page)).toContainText('Skin')
        await expect(selectedTab(page).locator('[data-tab-warning]')).toBeVisible()
        await expect(selectedTab(page)).toHaveAccessibleName('Skin. Default could not be loaded.')
        await expect(tabOf(page, 'particle')).toBeVisible()
        // The chosen row stays selected, with the reason under it.
        await expect(dialog(page).getByRole('radio', { name: /^Default/ })).toBeChecked()
        await expect(dialog(page).locator('[data-asset-note]')).toHaveText(
            'Using Built-in. Default could not be loaded.',
        )
        await shot(page, 'fallback-skin')
        await tabOf(page, 'particle').click()
        await expect(dialog(page).locator('[data-asset-note]')).toHaveCount(0)
    })

    test('the panel’s line and the dialog’s row give one reason for each case', async ({
        browser,
    }) => {
        const cases = [
            {
                seed: { previewAssets: { skin: { ...fileChoice, source: 'file' } } },
                reason: 'The skin file is no longer stored in this browser.',
                using: 'Default',
            },
            {
                seed: {
                    previewAssets: {
                        skin: { ...fileChoice, source: 'server', origin: 'https://example.com' },
                    },
                },
                reason: 'The skin could not be downloaded again from example.com.',
                using: 'Default',
            },
            {
                seed: { previewAssets: { skin: { source: 'builtin' } } },
                fail: ['builtin-skin' as const],
                reason: 'Built-in could not be loaded.',
                using: 'Default',
            },
            {
                seed: {},
                fail: ['default-skin' as const],
                reason: 'Default could not be loaded.',
                using: 'Built-in',
            },
        ]
        for (const [index, item] of cases.entries()) {
            const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
            // A server choice is downloaded again at load: the server is not there.
            await context.route('https://example.com/**', (route) => route.abort('failed'))
            const tab = await context.newPage()
            await start(tab, { seed: item.seed, fail: item.fail })
            const line = fallbackLine(tab, 'skin')
            await expect(line).toHaveText(
                new RegExp(
                    `^\\s*Skin: using ${item.using}\\. ${item.reason.replace(/\./g, '\\.')}`,
                ),
            )
            await open(tab)
            await expect(dialog(tab).locator('[data-asset-note]')).toHaveText(
                `Using ${item.using}. ${item.reason}`,
            )
            await shot(tab, `reason-${index}`)
            // The setting is never overwritten by the failure.
            expect(
                JSON.parse(
                    (await tab.evaluate(
                        (key) => localStorage.getItem(key),
                        `${KEY}previewAssets`,
                    )) ?? '{}',
                ),
            ).toEqual(item.seed.previewAssets ?? {})
            await context.close()
        }
    })

    test('a dismissed line stays dismissed for that choice, and the dialog keeps its row', async ({
        page,
    }) => {
        await start(page, { fail: ['default-skin'] })
        const line = fallbackLine(page, 'skin')
        await expect(line).toBeVisible()
        await line.getByRole('button', { name: 'Close' }).click()
        await expect(line).toHaveCount(0)
        expect(await setting(page, 'dismissedAssetNotices')).toEqual(['skin|default|defaultFailed'])

        // A reload shows no line; the dialog's tab and row still say why.
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await page.evaluate(() => (window.editorTest.settings.showPreview = true))
        await expect.poll(() => skinTitle(page)).toBe('Editor')
        await expect(fallbackLine(page, 'skin')).toHaveCount(0)
        await open(page)
        await expect(dialog(page).locator('[data-asset-note]')).toHaveText(
            'Using Built-in. Default could not be loaded.',
        )
        await expect(selectedTab(page).locator('[data-tab-warning]')).toBeVisible()

        // Choosing Built-in clears the row: nothing failed.
        await dialog(page)
            .getByRole('radio', { name: /^Built-in/ })
            .check()
        await expect(dialog(page).locator('[data-asset-note]')).toHaveCount(0)
    })

    test('a different failed choice shows its line again', async ({ page }) => {
        await start(page, {
            seed: {
                previewAssets: { skin: { ...fileChoice } },
                dismissedAssetNotices: ['skin|default|defaultFailed', 'skin|file:other|fileGone'],
            },
        })
        await expect(fallbackLine(page, 'skin')).toContainText(
            'Skin: using Default. The skin file is no longer stored in this browser.',
        )
        // The same choice failing for a new reason shows it again too, and a dismissal is kept once.
        await fallbackLine(page, 'skin').getByRole('button', { name: 'Close' }).click()
        await expect(fallbackLine(page, 'skin')).toHaveCount(0)
        expect(await setting(page, 'dismissedAssetNotices')).toEqual([
            'skin|default|defaultFailed',
            'skin|file:other|fileGone',
            'skin|file:abc|fileGone',
        ])
    })

    test('with both Default and Built-in down, the screen and its retry stay, and offline says so', async ({
        page,
    }) => {
        await start(page, { fail: ['default-skin', 'builtin-skin'] })
        const preview = page.locator('.preview')
        await expect(preview.getByText('The preview skin could not be loaded.')).toBeVisible()
        await expect(preview.getByRole('button', { name: 'Reload', exact: true })).toBeVisible()
        await expect(preview.getByText('You are offline.')).toHaveCount(0)
        await page.context().setOffline(true)
        await expect(preview.getByText('You are offline.')).toBeVisible()
        await shot(page, 'offline', preview)
        await page.context().setOffline(false)
        await page.unroute('**/resource/skin.scp*')
        await page.route('**/resource/skin.scp*', (route) =>
            route.fulfill({ body: resource('skins') }),
        )
        await preview.getByRole('button', { name: 'Reload', exact: true }).click()
        await expect.poll(() => skinTitle(page)).toBe('Fixture')
    })

    test('safe mode ignores the choices and says so in place of a reason', async ({ page }) => {
        const urls = requests(page)
        await start(page, { seed: { previewAssets: builtinAll }, query: '?safe' })
        await expect.poll(() => skinTitle(page)).toBe('Fixture')
        expect(urls.filter((url) => url.startsWith('/builtin/'))).toEqual([])
        await expect(page.locator('[data-asset-fallbacks]')).toHaveCount(0)
        await open(page)
        const note = dialog(page).locator('[data-asset-note]')
        await expect(note).toHaveText('Safe mode uses Default.')
        await expect(selectedTab(page).locator('[data-tab-warning]')).toHaveCount(0)
        // The choice itself is kept.
        await expect(dialog(page).getByRole('radio', { name: /^Built-in/ })).toBeChecked()
        await shot(page, 'safe-mode')
    })
})

test.describe('narrow', () => {
    test.use({ viewport: { width: 360, height: 740 } })

    test('five tabs scroll sideways at 360 px, and the footer stacks', async ({ page }) => {
        await start(page, { fail: ['default-skin'] })
        await open(page)
        const strip = dialog(page).getByRole('tablist')
        const metrics = () =>
            strip.evaluate((element) => ({
                scrolls: element.scrollWidth > element.clientWidth,
                left: element.scrollLeft,
            }))
        expect((await metrics()).scrolls).toBe(true)
        await shot(page, 'narrow-skin')

        // Keys move between tabs and keep the shown tab in view.
        await selectedTab(page).focus()
        await page.keyboard.press('End')
        await expect(selectedTab(page)).toHaveText('Stored')
        const stored = tabOf(page, 'stored')
        await expect(stored).toBeInViewport({ ratio: 0.98 })
        expect((await metrics()).left).toBeGreaterThan(0)
        await shot(page, 'narrow-stored')
        await page.keyboard.press('Home')
        await expect(selectedTab(page)).toContainText('Skin')

        // The helpers take the full width, one above the other.
        const buttons = await dialog(page)
            .locator('[data-preview-assets-footer] button')
            .evaluateAll((elements) =>
                elements.map((element) => {
                    const { y, width, height } = element.getBoundingClientRect()
                    return { y, width, height, label: element.textContent?.trim() }
                }),
            )
        expect(buttons.map((button) => button.label)).toEqual([
            'Use Built-in for All',
            'Reset to Default',
        ])
        expect(buttons[1]!.y).toBeGreaterThan(buttons[0]!.y + buttons[0]!.height - 1)
        expect(buttons[0]!.width).toBeGreaterThan(300)
        expect(buttons[1]!.width).toBeCloseTo(buttons[0]!.width, 0)
        // Whole labels, not cut short.
        for (const button of await dialog(page)
            .locator('[data-preview-assets-footer] button')
            .all())
            expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        const box = await dialog(page).boundingBox()
        expect(box!.x + box!.width).toBeLessThanOrEqual(360)
    })
})

test.describe('looks', () => {
    for (const theme of ['light', 'dark'] as const)
        for (const [size, viewport] of [
            ['wide', { width: 1600, height: 1000 }],
            ['narrow', { width: 360, height: 740 }],
        ] as const)
            test(`every tab, ${size}, in the ${theme} theme`, async ({ page }) => {
                await page.setViewportSize(viewport)
                await start(page, {
                    fail: ['default-skin'],
                    seed: {
                        previewAssets: {
                            background: {
                                ...fileChoice,
                                title: 'Night Sky',
                                origin: 'sky.scp',
                            },
                        },
                    },
                })
                await page.evaluate((theme) => (window.editorTest.settings.theme = theme), theme)
                await open(page)
                for (const name of ['skin', 'particle', 'background', 'effect', 'stored']) {
                    await tabOf(page, name).click()
                    await expect(tabOf(page, name)).toHaveAttribute('aria-selected', 'true')
                    await shot(page, `tab-${name}-${size}-${theme}`)
                }
            })
})

test('the toolbar migration adds the command to an unchanged playback group, once', async ({
    page,
}) => {
    const former = [
        'offset',
        'bgm',
        'toggleSfxVolume',
        'toggleBgmVolume',
        'speedUp',
        'speedDown',
        'stop',
        'play',
    ]
    await page.addInitScript((former) => {
        if (sessionStorage.getItem('seeded')) return
        sessionStorage.setItem('seeded', '1')
        localStorage.setItem(
            'sonolus-next-sekai-editor.toolbar',
            JSON.stringify([['undo', 'save'], former, ['bgm', 'play']]),
        )
        localStorage.removeItem('sonolus-next-sekai-editor.toolbarPreviewAssetsMigrated')
        // The earlier steps are done, so only this one is seen.
        for (const flag of ['toolbarEditorLayoutMigrated', 'toolbarExportMigrated'])
            localStorage.setItem(`sonolus-next-sekai-editor.${flag}`, 'true')
    }, former)
    await start(page)
    const toolbar = () => page.evaluate(() => window.editorTest.settings.toolbar)
    expect(await toolbar()).toEqual([
        ['undo', 'save'],
        ['previewAssets', ...former],
        ['bgm', 'play'],
    ])
    expect(
        await page.evaluate(
            (key) => localStorage.getItem(key),
            `${KEY}toolbarPreviewAssetsMigrated`,
        ),
    ).toBe('true')

    // Removing it afterwards is a customisation, kept across a reload.
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.toolbar = settings.toolbar.map((group) =>
            group.filter((name) => name !== 'previewAssets'),
        )
    })
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    expect((await toolbar())[1]).toEqual(former)
})

test('a background’s colour, blur, mask, aspect ratio and fit are drawn', async ({ page }) => {
    await start(page)
    await expect.poll(() => skinTitle(page)).toBe('Fixture')
    const viewport = page.locator('.preview-viewport').first()
    const background = page.locator('.preview-background')
    const widths = async () => ({
        image: (await background.boundingBox())!.width,
        screen: (await viewport.boundingBox())!.width,
    })
    await expect.poll(async () => (await widths()).image).toBeGreaterThan(0)
    const plain = await widths()
    // The default fills the screen.
    expect(plain.image).toBeGreaterThanOrEqual(plain.screen - 1)

    const png =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='
    await page.evaluate(async (png) => {
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        const slot = assetSession.slots.background
        slot.value = {
            ...slot.value,
            value: {
                url: png,
                aspectRatio: 1,
                fit: 'contain',
                color: '#223344',
                blur: 6,
                mask: '#ff000080',
            },
        }
    }, png)
    await expect(background).toHaveCSS('filter', 'blur(6px)')
    await expect(viewport).toHaveCSS('background-color', 'rgb(34, 51, 68)')
    await expect(page.locator('[data-background-mask]')).toHaveCSS(
        'background-color',
        'rgba(255, 0, 0, 0.5)',
    )
    // A square image contained in a wide screen is narrower than the screen.
    await expect.poll(async () => (await widths()).image).toBeLessThan(plain.screen * 0.8)
    await shot(page, 'background-configured', viewport)

    // Without a mask no overlay is drawn.
    await page.evaluate(async () => {
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        const slot = assetSession.slots.background
        slot.value = { ...slot.value, value: { ...slot.value.value!, mask: undefined, blur: 0 } }
    })
    await expect(page.locator('[data-background-mask]')).toHaveCount(0)
    await expect(background).toHaveCSS('filter', 'none')
})

test.describe('the review fixes', () => {
    test('the panel’s lines sit under the image and leave its settings button clickable', async ({
        page,
    }) => {
        await start(page, { fail: ['default-skin', 'default-particle'] })
        await expect(fallbackLine(page, 'skin')).toBeVisible()
        await expect(fallbackLine(page, 'particle')).toBeVisible()
        const viewport = (await page.locator('.preview-viewport').boundingBox())!
        const lines = (await page.locator('[data-asset-fallbacks]').boundingBox())!
        expect(lines.y).toBeGreaterThanOrEqual(viewport.y + viewport.height - 1)
        const toggle = page.locator('.preview-settings-toggle')
        await expect(toggle).toBeVisible()
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    })

    test('a row without a picture shows a neutral glyph, not an empty square', async ({ page }) => {
        await start(page)
        await open(page)
        const rows = dialog(page).locator('[data-asset-row]')
        for (const tab of ['skin', 'particle', 'effect'])
            if (tab !== 'skin') {
                await tabOf(page, tab).click()
                await expect(rows.nth(0).locator('svg')).toHaveCount(1)
            } else await expect(rows.nth(0).locator('svg')).toHaveCount(1)
        // A row with a picture has none.
        await expect(rows.nth(1).locator('svg')).toHaveCount(0)
    })

    test('keyboard open focuses the checked row, and a click never changes the choice', async ({
        page,
    }) => {
        await start(page, { seed: { previewAssets: builtinAll } })
        await open(page)
        await expect(dialog(page).getByRole('radio', { name: /^Built-in/ })).toBeFocused()
        await expect(dialog(page).getByRole('radio', { name: /^Default/ })).not.toBeFocused()
    })

    test('a reason is not shown under a row just selected while it loads', async ({ page }) => {
        await start(page, { fail: ['default-skin'] })
        await expect.poll(() => skinTitle(page)).toBe('Editor')
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        await page.unroute('**/builtin/skin.scp*')
        await page.route('**/builtin/skin.scp*', async (route) => {
            await gate
            await route.continue()
        })
        await open(page)
        await expect(dialog(page).locator('[data-asset-note]')).toHaveCount(1)
        await dialog(page)
            .getByRole('radio', { name: /^Built-in/ })
            .check()
        await expect(dialog(page).locator('[data-asset-note]')).toHaveCount(0)
        await expect(selectedTab(page).locator('[data-tab-warning]')).toHaveCount(0)
        release()
        await expect
            .poll(() => slotStatus(page, 'skin'))
            .toMatchObject({
                status: { active: 'builtin' },
            })
        await expect(dialog(page).locator('[data-asset-note]')).toHaveCount(0)
    })

    test('a switch that fails everywhere keeps the shown skin and says why', async ({ page }) => {
        await start(page)
        await expect.poll(() => skinTitle(page)).toBe('Fixture')
        await open(page)
        await page.route('**/resource/skin.scp*', (route) => route.fulfill({ status: 503 }))
        await page.route('**/builtin/skin.scp*', (route) => route.fulfill({ status: 503 }))
        await dialog(page)
            .getByRole('radio', { name: /^Built-in/ })
            .check()
        await expect(dialog(page).locator('[data-asset-note]')).toHaveText(
            'Using Default. Built-in could not be loaded.',
        )
        expect(await skinTitle(page)).toBe('Fixture')
        await expect(fallbackLine(page, 'skin')).toContainText('Built-in could not be loaded.')
    })

    test('Built-in for all never downloads the Default background', async ({ page }) => {
        const images: string[] = []
        page.on('request', (request) => {
            if (request.resourceType() === 'image') images.push(new URL(request.url()).pathname)
        })
        await start(page, { seed: { previewAssets: builtinAll } })
        await expect.poll(() => skinTitle(page)).toBe('Editor')
        await page.waitForTimeout(500)
        expect(images.filter((url) => /\/bg[^/]*\.png$/.test(url))).toEqual([])
    })

    test('the dialog reads the Built-in pictures by ranges, not whole packages', async ({
        page,
    }) => {
        const packages: { url: string; status: number }[] = []
        page.on('response', (response) => {
            const { pathname } = new URL(response.url())
            if (pathname.startsWith('/builtin/'))
                packages.push({ url: pathname, status: response.status() })
        })
        await start(page)
        await open(page)
        await expect(dialog(page).locator('[data-asset-row]').nth(1).locator('img')).toHaveCount(1)
        expect(packages.length).toBeGreaterThan(0)
        for (const { url, status } of packages) expect(status, url).toBe(206)
    })

    test('safe mode shows no panel line, and the row names the fallback', async ({ page }) => {
        await start(page, { fail: ['default-skin'], query: '?safe' })
        await expect.poll(() => skinTitle(page)).toBe('Editor')
        await expect(page.locator('[data-asset-fallbacks]')).toHaveCount(0)
        await open(page)
        await expect(dialog(page).locator('[data-asset-note]')).toHaveText(
            'Using Built-in. Default could not be loaded.',
        )
    })
})

test.describe('the review fixes, narrow', () => {
    test.use({ viewport: { width: 360, height: 740 } })

    test('the reason’s lines align with the row’s name, and the tab strip shows it scrolls', async ({
        page,
    }) => {
        await start(page, { fail: ['default-skin'] })
        await open(page)
        const left = (selector: string) =>
            dialog(page)
                .locator(selector)
                .first()
                .evaluate((element) => {
                    const style = getComputedStyle(element)
                    return element.getBoundingClientRect().left + parseFloat(style.paddingLeft)
                })
        const name = await dialog(page)
            .locator('[data-asset-row] .block.truncate')
            .first()
            .evaluate((element) => element.getBoundingClientRect().left)
        expect(await left('[data-asset-note]')).toBeCloseTo(name, 0)

        const strip = dialog(page).getByRole('tablist')
        await expect(strip).toHaveClass(/preview-assets-tabs-more-after/)
        await expect(strip).not.toHaveClass(/preview-assets-tabs-more-before/)
        await selectedTab(page).focus()
        await page.keyboard.press('End')
        await expect(strip).toHaveClass(/preview-assets-tabs-more-before/)
        await expect(strip).not.toHaveClass(/preview-assets-tabs-more-after/)
    })
})

test.describe('native mode', () => {
    test('the apps have one Built-in row, store it as Default, and have no Reset', async ({
        page,
    }) => {
        await start(page, { seed: { previewAssets: { skin: { ...fileChoice } } } })
        // The apps' capabilities: Default is Built-in, and nothing lives in the browser.
        await page.evaluate(async () => {
            const module =
                await window.editorTest.appImport<typeof import('../../src/platform')>(
                    '/src/platform/index.ts',
                )
            const { platform } = module
            module.setPlatformForTests(
                Object.create(platform, {
                    capabilities: {
                        value: {
                            ...platform.capabilities,
                            defaultAssets: false,
                            browserStorage: false,
                        },
                    },
                }) as typeof platform,
            )
        })
        await open(page)
        const rows = dialog(page).locator('[data-asset-row]')
        await expect(rows).toHaveCount(2)
        await expect(rows.nth(0)).toContainText('Built-in')
        await expect(rows.nth(0)).not.toContainText('Default')
        await expect(rows.nth(1)).toContainText('Neon Skin (File)')
        const footer = dialog(page).locator('[data-preview-assets-footer]')
        await expect(footer.getByRole('button')).toHaveText(['Use Built-in for All'])
        await expect(dialog(page).locator('[data-reset-default]')).toHaveCount(0)

        await footer.getByRole('button', { name: 'Use Built-in for All' }).click()
        expect(await setting(page, 'previewAssets')).toEqual({
            skin: { source: 'default' },
            particle: { source: 'default' },
            background: { source: 'default' },
            effect: { source: 'default' },
        })
        await expect(rows).toHaveCount(1)
        await expect(rows.nth(0).getByRole('radio')).toBeChecked()
        await expect(footer.getByRole('button', { name: 'Use Built-in for All' })).toBeDisabled()
    })
})

test.describe('the Settings row and the Preview tab menu', () => {
    for (const theme of ['light', 'dark'] as const)
        test(`look right in the ${theme} theme`, async ({ page }) => {
            await start(page)
            await page.evaluate((theme) => (window.editorTest.settings.theme = theme), theme)
            await page.locator('[data-panel-tab="preview"]').click({ button: 'right' })
            const menu = page.getByRole('menu')
            await expect(menu).toBeVisible()
            // Close Preview stays in its own group, after Preview Assets….
            const items = await menu
                .locator('[role="menuitem"], [role="separator"], hr')
                .evaluateAll((elements) =>
                    elements.map((element) => element.getAttribute('role') ?? element.tagName),
                )
            expect(items.at(-2)).toBe('separator')
            await shot(page, `preview-menu-${theme}`)
            await page.keyboard.press('Escape')
            await expect(menu).toHaveCount(0)

            await run(page, 'settings')
            const row = dialog(page).locator('[data-settings-assets]')
            await expect(row).toBeVisible()
            // A button at its own width, not a select pill across the row.
            const box = (await row.boundingBox())!
            const field = (await row
                .locator('xpath=ancestor::*[contains(@class,"form-field")][1]')
                .boundingBox())!
            expect(box.width).toBeLessThan(field.width - 40)
            expect(box.height).toBeGreaterThanOrEqual(36)
            await row.scrollIntoViewIfNeeded()
            await shot(page, `settings-row-${theme}`, dialog(page))
        })
})
