import type { Page } from '@playwright/test'

/** Past the 300 ms accidental-activation guard that a Confirm or Choice dialog opens with (with margin). */
export const pastGuard = (page: Page) => page.waitForTimeout(400)
