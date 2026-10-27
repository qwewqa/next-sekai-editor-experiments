import { expect, test } from '@playwright/test'
import type { PlatformOverride } from '../../src/platform/detect'
import { installCanvasCounters, installTestPlatform } from './editorFixture'

type PlatformModule = typeof import('../../src/platform')
type DetectModule = typeof import('../../src/platform/detect')

const ios: PlatformOverride = { engine: 'webkit', os: 'ios' }

const readPlatform = () =>
    Promise.all([
        import('/src/platform/index.ts') as Promise<PlatformModule>,
        import('/src/platform/detect.ts') as Promise<DetectModule>,
    ]).then(([{ platform }, { detection }]) => ({
        engine: detection().engine,
        os: platform.os,
        diagnostics: platform.diagnostics().engine,
        closePrompt: platform.capabilities.closePrompt,
    }))

test('nse.test.platform overrides engine and OS', async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(installTestPlatform, ios)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()

    expect(await page.evaluate(readPlatform)).toEqual({
        engine: 'webkit',
        os: 'ios',
        diagnostics: 'webkit',
        closePrompt: false,
    })
})

test('without the override, detection reads the browser', async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()

    const detected = await page.evaluate(readPlatform)
    expect(detected).not.toMatchObject({ engine: 'webkit', os: 'ios' })
})

test("the fixture's version override sets the shown version", async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')

    await expect(
        page.getByRole('status').filter({ hasText: 'Version 0.6.0' }).first(),
    ).toBeAttached()
})

test('another version override shows that version', async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        localStorage.setItem(
            'nse.test.version',
            JSON.stringify({ appVersion: '0.7.1+0123abcd', atTag: false }),
        )
        // The release already seen, so the pill says "Version", not "Updated to version".
        localStorage.setItem('sonolus-next-sekai-editor.lastAppVersion', JSON.stringify('0.7.1'))
    })
    await page.goto('/')

    await expect(
        page.getByRole('status').filter({ hasText: 'Version 0.7.1+0123abcd' }).first(),
    ).toBeAttached()
    expect(
        await page.evaluate(async () => {
            const { appVersion } = (await import('/src/platform/index.ts')) as PlatformModule
            return appVersion()
        }),
    ).toEqual({ appVersion: '0.7.1+0123abcd', atTag: false })
})
