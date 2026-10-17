import { expect, test } from '@playwright/test'

declare global {
    interface Window {
        firstBackgroundStyle?: string
    }
}

test('the preview background carries the first-paint image when it is first inserted', async ({
    page,
}) => {
    // Recorded at insertion, before any provider has had a turn to set its own value.
    await page.addInitScript(() => {
        const look = (node: Node) => {
            if (window.firstBackgroundStyle !== undefined || !(node instanceof Element)) return
            const found = node.matches('.preview-background')
                ? node
                : node.querySelector('.preview-background')
            if (found) window.firstBackgroundStyle = found.getAttribute('style') ?? ''
        }
        new MutationObserver((records) => {
            for (const record of records) record.addedNodes.forEach(look)
        }).observe(document, { childList: true, subtree: true })
    })
    await page.goto('/')
    await expect(page.locator('.preview-background')).toBeAttached()
    const style = await page.evaluate(() => window.firstBackgroundStyle)
    expect(style).toMatch(/background-image:\s*url\(["']?[^)]*bg[^)]*\.png/)
})
