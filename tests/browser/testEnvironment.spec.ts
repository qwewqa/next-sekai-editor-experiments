import { expect, test } from '@playwright/test'

// Layout specs measure text, so every page draws the app's sans text in Selawik, which has the
// metrics of Segoe UI (tests/fonts/README.md). If that fails, every spec that measures text fails
// for its own reason; this one says why.
test('every page draws the sans text of the app in Selawik, whatever fonts the machine has', async ({
    page,
}) => {
    await page.goto('/')
    await page.evaluate(() => document.fonts.ready)
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
    expect(fonts.map((font) => font.familyName)).toEqual(['Selawik'])
    // The canvases read the same family from the page.
    expect(
        await page.evaluate(() => getComputedStyle(document.body).fontFamily.startsWith('Selawik')),
    ).toBe(true)
})

test('every page and every spec run in en-US and UTC, whatever the machine uses', async ({
    page,
}) => {
    await page.goto('/')
    expect(
        await page.evaluate(() => ({
            language: navigator.language,
            languages: navigator.languages,
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })),
    ).toEqual({ language: 'en-US', languages: ['en-US'], zone: 'UTC' })
    expect(new Date().getTimezoneOffset()).toBe(0)
})
