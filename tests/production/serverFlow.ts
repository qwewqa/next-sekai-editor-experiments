import { expect, type Page } from '@playwright/test'

// The steps of using the Built-in server's skin through the chooser, shared by the CSP smoke
// spec (a routed https address over the preview) and the post-deploy smoke test (the live site).

/** Opens Preview Assets… from Settings, as a user does. */
export const openAssets = async (page: Page) => {
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

/** Connects the Skin tab's chooser to a server and lists its items. */
export const connectSkinChooser = async (page: Page, address: string) => {
    const dialog = page.locator('dialog[open]')
    await dialog.getByRole('tab', { name: 'Skin' }).click()
    await dialog.locator('[data-asset-choose]').click()
    await dialog.locator('[data-chooser-mode-option="server"]').check()
    await dialog.locator('[data-server-address]').fill(address)
    await dialog.locator('[data-server-connect]').click()
}

/** Uses the Built-in server's skin: lists it, uses it, and finds it stored and chosen. */
export const useBuiltinServerSkin = async (page: Page, address: string) => {
    const dialog = page.locator('dialog[open]')
    await connectSkinChooser(page, address)
    await expect(dialog.locator('[data-server-title]')).toHaveText('Built-in Items')
    const item = dialog.locator('[data-chooser-item="nse-builtin"]')
    await expect(item).toContainText('Editor')
    // The thumbnail is fetched from the server's address like the rest.
    await expect
        .poll(() => item.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0)
    await expect(item.locator('input')).toBeChecked()
    await dialog.locator('[data-chooser-use]').click()
    await expect(dialog.locator('[data-asset-chooser]')).toHaveCount(0)
    await expect(dialog.locator('[data-asset-row^="server:"] input')).toBeChecked()
    await expect(dialog.locator('[data-asset-row^="server:"]')).toContainText('Editor (Server)')
    await expect(dialog.locator('[data-asset-note]')).toHaveCount(0)
    await expect(dialog.locator('[data-stored-line]')).toHaveText(/^Stored: \d+ items?, /)
}
