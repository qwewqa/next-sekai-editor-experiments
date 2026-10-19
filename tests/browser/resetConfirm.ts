import { expect, type Page } from '@playwright/test'
import { pastGuard } from './pastGuard'

/** Confirms the dialog a Reset button opens over Settings, once its 300 ms guard has passed. */
export const confirmReset = async (page: Page, name: 'Reset Settings' | 'Reset Shortcuts') => {
    const confirm = page.getByRole('dialog').last()
    await expect(page.getByRole('dialog')).toHaveCount(2)
    await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await pastGuard(page)
    await confirm.getByRole('button', { name, exact: true }).click()
}
