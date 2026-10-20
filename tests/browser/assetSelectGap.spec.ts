import { expect, test, type Page } from '@playwright/test'
import { installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

// Choosing a source in the Preview Assets dialog leaves no gap under the chosen row while the
// asset loads. The "Loading…" line used to be in the list from the first frame, invisible for its
// first half second, so the rows below it stood a line lower until it faded in or the load ended.
// It runs in Chromium and, through the compatibility config, Firefox and WebKit.

const KEY = 'sonolus-next-sekai-editor.'
const dialog = (page: Page) => page.locator('dialog[open]')

// Long enough to catch a gap, short of the half second after which "Loading…" belongs.
const WINDOW_MS = 350

type Source = 'default' | 'builtin'
const picks: { type: 'skin' | 'particle'; from: Source; to: Source }[] = []
for (const type of ['skin', 'particle'] as const)
    picks.push({ type, from: 'builtin', to: 'default' }, { type, from: 'default', to: 'builtin' })

type Frame = { top: number; line: boolean; checked: boolean }

for (const { type, from, to } of picks)
    test(`choosing ${to} for the ${type} leaves no gap while it loads (from ${from})`, async ({
        page,
    }) => {
        const other = to === 'default' ? 'builtin' : 'default'
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        const body = resource(type === 'skin' ? 'skins' : 'particles')
        let opened = false
        let held = 0
        for (const source of ['default', 'builtin'] as const)
            await page.route(
                `**/${source === 'default' ? 'resource' : 'builtin'}/${type}.scp*`,
                async (route) => {
                    // Only the load that follows the choice waits; the first paint is not held.
                    if (source === to && opened) {
                        held += 1
                        await gate
                    }
                    await route.fulfill({ body })
                },
            )
        await page.addInitScript(
            ([prefix, from]) => {
                if (sessionStorage.getItem('seeded')) return
                sessionStorage.setItem('seeded', '1')
                const choices = Object.fromEntries(
                    ['skin', 'particle', 'background', 'effect'].map((kind) => [
                        kind,
                        { source: from },
                    ]),
                )
                localStorage.setItem(prefix + 'previewAssets', JSON.stringify(choices))
            },
            [KEY, from] as const,
        )
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await page.evaluate(async () => {
            window.editorTest.settings.showPreview = true
            const { commands } = await import('/src/editor/commands/index.ts')
            await commands.previewAssets.execute()
            await window.editorTest.nextTick()
        })
        await dialog(page).locator(`[data-preview-assets-tab="${type}"]`).click()
        await expect(dialog(page).locator(`[data-asset-row="${from}"] input`)).toBeChecked()
        opened = true

        // Every frame from the click on: where the other row stands, and whether a line sits
        // under the chosen row.
        const { before, frames } = await page.evaluate(
            ([to, other, windowMs]) =>
                new Promise<{ before: number; frames: Frame[] }>((resolve) => {
                    const row = (id: string) =>
                        document.querySelector<HTMLElement>(`[data-asset-row="${id}"]`)!
                    const topOf = (id: string) =>
                        Math.round(row(id).getBoundingClientRect().top * 10) / 10
                    const before = topOf(other)
                    const frames: Frame[] = []
                    const start = performance.now()
                    const tick = () => {
                        frames.push({
                            top: topOf(other),
                            line: !!document.querySelector('[data-asset-loading]'),
                            checked: row(to).querySelector('input')!.checked,
                        })
                        if (performance.now() - start < windowMs) requestAnimationFrame(tick)
                        else resolve({ before, frames })
                    }
                    row(to).click()
                    requestAnimationFrame(tick)
                }),
            [to, other, WINDOW_MS] as const,
        )

        // The choice was made, and the asset was still being fetched all that time.
        expect(held).toBeGreaterThan(0)
        expect(frames.length).toBeGreaterThan(2)
        expect(frames.at(-1)!.checked).toBe(true)
        // The other row never moved, and no line was added under the chosen one.
        for (const frame of frames) expect(frame).toMatchObject({ top: before, line: false })

        release()
        await expect(dialog(page).locator(`[data-asset-row="${to}"] input`)).toBeChecked()
        await expect(dialog(page).locator('[data-asset-loading]')).toHaveCount(0)
        await expect
            .poll(() =>
                dialog(page)
                    .locator(`[data-asset-row="${other}"]`)
                    .evaluate(
                        (element) => Math.round(element.getBoundingClientRect().top * 10) / 10,
                    ),
            )
            .toBe(before)
    })
