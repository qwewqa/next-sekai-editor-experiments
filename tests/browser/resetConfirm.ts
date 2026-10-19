import { expect, type Page } from '@playwright/test'
import { confirmWhenReady } from './confirmWhenReady'

/** Confirms the dialog a Reset button opens over Settings, pressing again until its 300 ms guard has passed. */
export const confirmReset = async (page: Page, name: 'Reset Settings' | 'Reset Shortcuts') => {
    // The second dialog, for good: after it closes this still names it, not Settings beneath.
    const confirm = page.getByRole('dialog').nth(1)
    await expect(page.getByRole('dialog')).toHaveCount(2)
    await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await confirmWhenReady(confirm.getByRole('button', { name, exact: true }), confirm)
}
