import { expect, test } from '@playwright/test'
import { editorReady } from './fixtures'

// The first-visit dialog in the release build, which has the privacy page: a profile without the
// mark sees it once.

// Without the mark the config's storageState seeds.
test.use({ storageState: { cookies: [], origins: [] } })

test('a fresh profile sees the dialog, Privacy opens the privacy page, and after Close a reload shows nothing', async ({
    page,
}) => {
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: 'Next SEKAI Editor' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/^Version \d/)).toBeVisible()
    const close = dialog.locator('[data-modal-footer] button')
    await expect(close).toBeFocused()
    const opening = page.waitForEvent('popup')
    await dialog.getByRole('link', { name: 'Privacy' }).click()
    const privacy = await opening
    await expect(privacy).toHaveURL(/\/privacy\/$/)
    await expect(privacy.locator('h1')).toHaveCount(1)
    await privacy.close()
    await close.click()
    await expect(dialog).toHaveCount(0)
    await page.reload()
    await editorReady(page)
})
