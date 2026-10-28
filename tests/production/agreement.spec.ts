import { expect, test } from '@playwright/test'
import { editorReady } from './fixtures'

// The agreement dialog in the release build, which has both legal pages: a profile without the
// record agrees once.

// Without the record the config's storageState seeds.
test.use({ storageState: { cookies: [], origins: [] } })

test('a fresh profile sees the dialog, each link opens its page, and after Agree a reload shows nothing', async ({
    page,
}) => {
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: 'Next SEKAI Editor' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/^Version \d/)).toBeVisible()
    const agree = dialog.getByRole('button', { name: 'Agree' })
    await expect(agree).toBeFocused()
    for (const [name, path, heading] of [
        ['Terms of Service', '/terms/', 'Terms of Service'],
        ['Privacy Notice', '/privacy/', 'Privacy Notice'],
    ] as const) {
        const opening = page.waitForEvent('popup')
        await dialog.getByRole('link', { name }).click()
        const opened = await opening
        await expect(opened).toHaveURL(new RegExp(`${path}$`))
        await expect(opened.getByRole('heading', { level: 1 })).toHaveText(heading)
        await opened.close()
    }
    await expect(dialog).toBeVisible()
    await agree.click()
    await expect(dialog).toHaveCount(0)
    expect(
        await page.evaluate(() => localStorage.getItem('sonolus-next-sekai-editor.agreement')),
    ).toMatch(/^\{"terms":\d+,"privacy":\d+\}$/)
    await page.reload()
    await editorReady(page)
})
