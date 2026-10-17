import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Settings › About (Part 1 §1.4.16, Part 5 5.7.5). The dev server serves no LICENSE.txt, so
// the links are checked by href and never fetched.

const REPOSITORY = 'qwewqa/next-sekai-editor-experiments'

const boot = async (page: Page, version?: { appVersion: string; atTag: boolean }) => {
    await page.addInitScript(installCanvasCounters)
    if (version)
        await page.addInitScript((version) => {
            localStorage.setItem('nse.test.version', JSON.stringify(version))
        }, version)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.keyboard.press(',')
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
}

const about = (page: Page) =>
    page.locator('section').filter({ has: page.getByRole('heading', { name: 'About' }) })

test('About is the last section, with the name, the version and the links in order', async ({
    page,
}) => {
    await boot(page)
    const sections = page.getByRole('dialog').locator('section')
    await expect(sections.last().getByRole('heading')).toHaveText('About')
    await expect(about(page).locator('[data-about-name]')).toHaveText('Next SEKAI Editor')
    await expect(about(page).locator('[data-about-version]')).toHaveText('Version 0.6.0')
    const links = about(page).locator('[data-about-link]')
    expect(
        await links.evaluateAll((all) =>
            all.map((link) => link.textContent.replace('↗', '').trim()),
        ),
    ).toEqual(['Release Notes', 'Source Code', 'License', 'Third-Party Notices'])
    expect(await links.evaluateAll((all) => all.map((link) => link.getAttribute('href')))).toEqual([
        `https://github.com/${REPOSITORY}/blob/main/CHANGELOG.md`,
        `https://github.com/${REPOSITORY}`,
        '/LICENSE.txt',
        '/THIRD_PARTY_NOTICES.txt',
    ])
    for (const link of await links.all()) {
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toHaveAttribute('rel', /noopener/)
    }
    // No app row before Stage 2, and nothing else links to the apps.
    await expect(about(page)).not.toContainText('Apps for')
    await expect(about(page)).not.toContainText('Get the App')
    await expect(about(page)).not.toContainText('This is the test site')
})

test('Release Notes keeps its link for a build between tags and is absent without a release tag', async ({
    page,
}) => {
    await boot(page, { appVersion: '0.6.0+abcd1234', atTag: false })
    await expect(about(page).locator('[data-about-version]')).toHaveText('Version 0.6.0+abcd1234')
    await expect(about(page).locator('[data-about-link="releaseNotes"]')).toHaveAttribute(
        'href',
        `https://github.com/${REPOSITORY}/blob/main/CHANGELOG.md`,
    )
})

test('a build with no tag behind its version has no Release Notes', async ({ page }) => {
    await boot(page, { appVersion: '0.5.22', atTag: false })
    await expect(about(page).locator('[data-about-link="releaseNotes"]')).toHaveCount(0)
    await expect(about(page).locator('[data-about-link="source"]')).toBeVisible()
})

test('a link opens in a new page and leaves the editor where it was', async ({ page, context }) => {
    await context.route('https://github.com/**', (route) =>
        route.fulfill({ body: 'ok', contentType: 'text/html' }),
    )
    await boot(page)
    const popup = page.waitForEvent('popup')
    await about(page).locator('[data-about-link="source"]').click()
    expect((await popup).url()).toBe(`https://github.com/${REPOSITORY}`)
    expect(page.url()).toMatch(/127\.0\.0\.1/)
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
})

test.describe('Copy Diagnostic Info…', () => {
    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    })

    test('shows the text read-only with its note, and copies it on Copy', async ({ page }) => {
        await boot(page)
        // A caught error and a CSP violation are in the ring.
        await page.evaluate(async () => {
            const { recordError, recordDiagnostic } =
                await window.editorTest.appImport<typeof import('../../src/diagnostics')>(
                    '/src/diagnostics.ts',
                )
            recordError(new Error('Probe failure'))
            recordDiagnostic('csp', 'script-src blocked inline')
        })
        await about(page).getByRole('button', { name: 'Copy Diagnostic Info…' }).click()
        const dialog = page.getByRole('dialog', { name: 'Diagnostic Info' })
        await expect(dialog).toBeVisible()
        await expect(dialog).toContainText(
            'Error messages in it can include file and folder names. Check it before posting it publicly.',
        )
        const field = dialog.getByRole('textbox')
        await expect(field).toHaveAttribute('readonly', '')
        const text = await field.inputValue()
        expect(text).toContain('Next SEKAI Editor 0.6.0')
        expect(text).toMatch(/^Engine: chromium$/m)
        expect(text).toMatch(/^OS: \w+$/m)
        expect(text).toMatch(/^Standalone: (yes|no)$/m)
        expect(text).toMatch(/^Storage: .*used of about/m)
        expect(text).toContain('error: Error: Probe failure')
        expect(text).toContain('csp: script-src blocked inline')
        // Cancel first, Copy last and focused.
        const buttons = dialog.getByRole('button')
        await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeFocused()
        await expect(buttons.filter({ hasText: 'Cancel' })).toBeVisible()
        await dialog.getByRole('button', { name: 'Copy', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Diagnostic Info' })).toHaveCount(0)
        await expect(page.locator('[data-notice-region]')).toHaveText('Copied')
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text)
    })

    test('Cancel copies nothing', async ({ page }) => {
        await boot(page)
        await page.evaluate(() => navigator.clipboard.writeText('before'))
        await about(page).getByRole('button', { name: 'Copy Diagnostic Info…' }).click()
        await page
            .getByRole('dialog', { name: 'Diagnostic Info' })
            .getByRole('button', { name: 'Cancel' })
            .click()
        await expect(page.getByRole('dialog', { name: 'Diagnostic Info' })).toHaveCount(0)
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('before')
    })

    test('keeps the last 20 entries in localStorage across a reload', async ({ page }) => {
        await boot(page)
        await page.evaluate(async () => {
            const { recordError } =
                await window.editorTest.appImport<typeof import('../../src/diagnostics')>(
                    '/src/diagnostics.ts',
                )
            for (let i = 0; i < 25; i++) recordError(`failure ${i}`)
        })
        const stored = await page.evaluate(
            () =>
                JSON.parse(
                    localStorage.getItem('sonolus-next-sekai-editor.diagnostics') ?? '[]',
                ) as { text: string }[],
        )
        expect(stored).toHaveLength(20)
        expect(stored[0]!.text).toBe('failure 5')
        expect(stored[19]!.text).toBe('failure 24')
    })
})
