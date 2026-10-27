import { expect, test } from '@playwright/test'

// On CI the layout specs rely on the container drawing the app's text in Selawik, which has the
// metrics of Segoe UI (tests/fonts/README.md). If the fonts are not installed, every layout spec
// that measures text fails on its own; this one says why.
test.skip(!process.env.CI, 'the development machines draw Segoe UI')

test('the container draws the app’s text in Selawik', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => {
        const probe = document.createElement('span')
        probe.id = 'font-probe'
        probe.textContent = 'Hamburgefonstiv'
        document.body.append(probe)
    })
    const session = await page.context().newCDPSession(page)
    await session.send('DOM.enable')
    await session.send('CSS.enable')
    const { root } = await session.send('DOM.getDocument')
    const { nodeId } = await session.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '#font-probe',
    })
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId })
    expect(fonts.map((font) => font.familyName)).toContain('Selawik')
})
