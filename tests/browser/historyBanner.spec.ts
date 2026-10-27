import { expect, test, type Page } from '@playwright/test'
import { installEditorFixture, waitForStartup } from './editorFixture'

// The Edits Here banner keeps its range readable in a narrow dock, in every locale.

const prefix = 'sonolus-next-sekai-editor.'

test.beforeEach(async ({ page }) => {
    await page.addInitScript((prefix) => {
        localStorage.setItem(`${prefix}showPreview`, 'false')
        localStorage.setItem(`${prefix}showSidebar`, 'false')
        localStorage.setItem('nse.test.storage', '{}')
    }, prefix)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
})

const surface = (page: Page) => page.locator('[data-history-surface="panel"]')

const openEditsHere = async (page: Page, locale: string, width: number) => {
    await page.evaluate(
        ({ locale, width }) => {
            const { settings, view } = window.editorTest
            settings.locale = locale as never
            settings.rightDockWidth = width
            view.scrollingY = undefined
            view.time = 6 / 2
            const { history, historySteps } = window.editorTest
            history.pushState(
                historySteps.futureInitialLife(
                    history.state.value.initialLife,
                    history.state.value.initialLife + 1,
                    'Step',
                ),
                { ...history.state.value, initialLife: history.state.value.initialLife + 1 },
            )
        },
        { locale, width },
    )
    await page
        .locator('[data-workspace-dock="right"]')
        .getByRole('tab', { name: /^(History|Historique|Geçmiş)$/ })
        .click()
    await expect(surface(page)).toBeVisible()
    await surface(page).locator('[data-history-goto-button]').click()
    await page.locator('[data-goto-filter="here"]').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-history-filter-banner]')).toContainText(/\d/)
}

for (const locale of ['en', 'fr', 'tr']) {
    for (const width of [220, 260]) {
        test(`the Edits Here range is not clipped at ${width} px in ${locale}`, async ({
            page,
        }) => {
            await openEditsHere(page, locale, width)
            const banner = page.locator('[data-history-filter-banner]')
            const bannerWidth = await banner.evaluate((element) => element.clientWidth)
            expect(Math.abs(bannerWidth - width)).toBeLessThan(40)
            await expect(banner.locator('[data-banner-range]')).toBeVisible()
            const clipped = await banner.evaluate((element) =>
                [...element.querySelectorAll('[data-banner-range]')]
                    .filter((span) => span.scrollWidth > span.clientWidth)
                    .map((span) => span.textContent),
            )
            expect(clipped).toEqual([])
        })
    }
}
