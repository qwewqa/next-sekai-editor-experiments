import type { Page } from '@playwright/test'

/** The build's usage statistics target, from its manifest; null when it has none. */
export const analyticsOf = async (page: Page) => {
    const manifest = (await (await page.request.get('/release-manifest.json')).json()) as {
        analytics?: { origin: string; website: string } | null
    }
    return manifest.analytics ?? null
}
