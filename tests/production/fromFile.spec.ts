import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

// From a File in the release build under its exact policy (Part 0 §0.9.2; Part 2, 2.5.2): a
// package is checked, repacked and stored (the storage worker, a Blob in IndexedDB, an object URL
// for each picture), and is chosen again after a reload, with no policy violation on the way.

const violations = (page: Page) => page.evaluate(() => (window as unknown as { csp: string[] }).csp)

const openAssets = async (page: Page) => {
    await page.keyboard.press(',')
    const settings = page.locator('dialog[open]')
    await expect(settings).toHaveAccessibleName('Settings')
    await settings
        .locator('.form-field')
        .filter({ hasText: 'Assets' })
        .first()
        .getByRole('button', { name: 'Preview Assets…' })
        .click()
    await expect(page.locator('dialog[open]')).toHaveAccessibleName('Preview Assets')
}

const importBuiltin = async (page: Page, type: 'skin' | 'effect', tab: string) => {
    const dialog = page.locator('dialog[open]')
    await dialog.getByRole('tab', { name: tab }).click()
    await dialog.locator('[data-asset-choose]').click()
    const chosen = page.waitForEvent('filechooser')
    await dialog.locator('[data-chooser-select-file]').click()
    await (
        await chosen
    ).setFiles({
        name: `${type}.scp`,
        mimeType: 'application/octet-stream',
        buffer: readFileSync(`public/builtin/${type}.scp`),
    })
    await expect(dialog.locator('[data-chooser-item]')).toHaveCount(1)
    await dialog.locator('[data-chooser-use]').click()
    await expect(dialog.locator('[data-asset-chooser]')).toHaveCount(0)
    await expect(dialog.locator('[data-asset-row^="file:"] input')).toBeChecked()
}

test('a package is picked, stored and chosen again after a reload, under the release policy', async ({
    page,
}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
        // The fixture hook (Part 1 §1.4.2): a blank start, at once.
        localStorage.setItem('nse.test.startBlank', 'true')
        const seen: string[] = []
        ;(window as unknown as { csp: string[] }).csp = seen
        document.addEventListener(
            'securitypolicyviolation',
            (event) => seen.push(`${event.effectiveDirective} ${event.blockedURI}`),
            true,
        )
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()

    await openAssets(page)
    await importBuiltin(page, 'skin', 'Skin')
    // Decoding the clips takes the audio context the dialog makes for itself.
    await importBuiltin(page, 'effect', 'Sound Effects')
    await expect(page.locator('dialog[open] [data-stored-line]')).toHaveText(/^Stored: 2 items, /)
    await page.keyboard.press('Escape')

    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await openAssets(page)
    const dialog = page.locator('dialog[open]')
    await dialog.getByRole('tab', { name: 'Skin' }).click()
    await expect(dialog.locator('[data-asset-row^="file:"] input')).toBeChecked()
    // Both are read from storage, so neither fell back.
    await expect(dialog.locator('[data-asset-note]')).toHaveCount(0)
    await expect(page.locator('[data-asset-fallbacks]')).toHaveCount(0)
    await dialog.getByRole('tab', { name: 'Stored' }).click()
    await expect(dialog.locator('[data-stored-item]')).toHaveCount(2)

    expect(await violations(page)).toEqual([])
    expect(errors).toEqual([])
})
