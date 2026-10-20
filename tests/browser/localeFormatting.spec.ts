import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

// Counts, decimals and sentence joins in notices and names follow the interface language.

test.beforeEach(async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const setLocale = (page: Page, locale: string) =>
    page.evaluate((locale) => {
        window.editorTest.settings.locale = locale as 'fr'
    }, locale)

test('the playback speed notice uses the language’s decimal mark', async ({ page }) => {
    await setLocale(page, 'fr')
    await page.evaluate(async () => {
        const player =
            await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                '/src/editor/player.ts',
            )
        player.changePlayerSpeed(-1)
    })
    await expect(page.getByRole('status').filter({ hasText: '0,75' })).toBeVisible()
})

test('the transport step titles join their sentences and write the hold rate in the language', async ({
    page,
}) => {
    await page.getByRole('tab', { name: 'Preview', exact: true }).click()
    // A step of 1 ms holds at 0.1×.
    await setLocale(page, 'ja')
    const japanese = page.getByRole('button', { name: '1ミリ秒戻る', exact: true })
    await expect(japanese).toHaveAttribute('title', '1ミリ秒戻る。長押しで0.1倍速で巻き戻し')
    await setLocale(page, 'fr')
    const french = page.getByRole('button', { name: 'Reculer de 1 ms', exact: true })
    await expect(french).toHaveAttribute('title', 'Reculer de 1 ms. Maintenir pour reculer à 0,1×')
})
