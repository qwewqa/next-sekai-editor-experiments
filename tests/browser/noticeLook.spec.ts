import { expect, test, type Locator, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, waitForStartup } from './editorFixture'

// The notice card's look (Part 1 §1.4.1, colour system §5.6): the severity glyph for warnings,
// errors and info and none for neutral notices, and the one-line-or-stacked layout of an action.

type Severity = 'info' | 'warning' | 'error'
type Module = typeof import('../../src/editor/notification')

const boot = async (page: Page, older = false) => {
    await page.addInitScript(installCanvasCounters)
    if (older)
        await page.addInitScript(() => {
            localStorage.setItem(
                'sonolus-next-sekai-editor.lastAppVersion',
                JSON.stringify('0.5.22'),
            )
        })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
}

const card = (page: Page) => page.locator('[data-notice-card]')
const glyphs = (page: Page) => card(page).locator('svg[data-severity]')

/** Raises one card as a producer does, and holds its timer for the checks. */
const raise = (
    page: Page,
    options: { message: string; action?: string; card?: boolean; severity?: Severity },
) =>
    page.evaluate(async ({ message, action, card, severity }) => {
        const n = await window.editorTest.appImport<Module>('/src/editor/notification.ts')
        n.dismissNoticeCard()
        n.notify(() => message, {
            action: action ? { label: () => action, run: () => undefined } : undefined,
            card,
            severity,
        })
        n.holdNotice('hidden', true)
    }, options)

/** The card has come in: its enter transition is over, so its boxes are where they stay. */
const settled = async (page: Page) => {
    await expect(card(page)).toBeVisible()
    await expect
        .poll(() =>
            card(page).evaluate((root) => {
                const style = getComputedStyle(root)
                return [style.transform, style.opacity]
            }),
        )
        .toEqual(['none', '1'])
}

/** Where the message text starts and ends, from the card's left edge, and its line boxes. */
const textOf = (card: Locator, selector: string) =>
    card.evaluate((root, selector) => {
        const p = root.querySelector(selector)!
        const range = document.createRange()
        range.selectNodeContents(p)
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0)
        const c = root.getBoundingClientRect()
        // The first line box's middle, from the paragraph's own box and line height, so that a
        // font still loading does not move it.
        const style = getComputedStyle(p)
        const box = p.getBoundingClientRect()
        return {
            lineMid: box.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2,
            left: Math.round(rects[0]!.left - c.left),
            top: rects[0]!.top,
            bottom: Math.max(...rects.map((rect) => rect.bottom)),
            lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
        }
    }, selector)

test.describe('the severity glyph', () => {
    const cases: { name: string; severity?: Severity; action?: string }[] = [
        { name: 'a neutral card with an action', action: 'Open History' },
        { name: 'a neutral card without an action' },
        { name: 'an info card with an action', severity: 'info', action: 'Restore Session' },
        { name: 'an info card without an action', severity: 'info' },
        { name: 'a warning card with an action', severity: 'warning', action: 'Try Again' },
        { name: 'a warning card without an action', severity: 'warning' },
        { name: 'an error card without an action', severity: 'error' },
        { name: 'an error card with an action', severity: 'error', action: 'Choose Audio…' },
    ]
    for (const { name, severity, action } of cases)
        test(`${name} ${severity ? `shows the ${severity} glyph` : 'has no glyph'}`, async ({
            page,
        }) => {
            await boot(page)
            await raise(page, {
                message: 'Something happened to this file.',
                action,
                card: action ? undefined : true,
                severity,
            })
            await settled(page)
            if (!severity) {
                await expect(glyphs(page)).toHaveCount(0)
                // The text starts at the dialog edge, 16 px in (4 padding and 12 of its own).
                expect((await textOf(card(page), 'p')).left).toBe(16)
                return
            }
            const glyph = glyphs(page)
            await expect(glyph).toHaveCount(1)
            await expect(glyph).toHaveAttribute('data-severity', severity)
            await expect(glyph).toHaveAttribute('aria-hidden', 'true')
            // The token colour, a 16 px glyph on the first line, and the text 40 px in.
            const colour = { info: 'text-info', warning: 'text-warning', error: 'text-danger' }
            await expect(glyph).toHaveClass(new RegExp(colour[severity]))
            const box = (await glyph.boundingBox())!
            expect([box.width, box.height]).toEqual([16, 16])
            const text = await textOf(card(page), 'p')
            expect(text.left).toBe(40)
            expect(Math.abs(box.y + 8 - text.lineMid)).toBeLessThan(1)
            // The glyph is a second cue: the card still names the problem in text.
            await expect(card(page)).toContainText('Something happened to this file.')
        })

    test('the glyphs are not read by the live region and add no text', async ({ page }) => {
        await boot(page)
        await raise(page, {
            message: 'This version is older than your data.',
            card: true,
            severity: 'warning',
        })
        await expect(card(page)).toHaveText(/^\s*This version is older than your data\.\s*$/)
        await expect(page.getByRole('status')).toHaveText('This version is older than your data.')
    })

    test('a card with a severity keeps the strip’s 44 px height, 22 px radius and 36 px controls', async ({
        page,
    }) => {
        await boot(page)
        await raise(page, { message: 'Nothing to undo', action: 'Open History', severity: 'info' })
        await settled(page)
        const shape = await card(page).evaluate((root) => {
            const style = getComputedStyle(root)
            const box = (selector: string) =>
                root.querySelector(selector)!.getBoundingClientRect().height
            return {
                height: root.getBoundingClientRect().height,
                radius: style.borderTopLeftRadius,
                action: box('[data-notice-action]'),
                close: box('[data-notice-close]'),
                weight: getComputedStyle(root.querySelector('[data-notice-action]')!).fontWeight,
            }
        })
        expect(shape).toEqual({ height: 44, radius: '22px', action: 36, close: 36, weight: '400' })
    })
})

test.describe('severity beyond the plain card', () => {
    test('a severity without card or action stays a quick toast, with no glyph', async ({
        page,
    }) => {
        await boot(page)
        await raise(page, { message: 'Quick feedback only.', severity: 'warning' })
        await expect(
            page.locator('.notification', { hasText: 'Quick feedback only.' }),
        ).toBeVisible()
        await expect(card(page)).toHaveCount(0)
        await expect(page.locator('svg[data-severity]')).toHaveCount(0)
    })

    test('a card with a severity drawn over a blocking dialog shows its glyph on the menu surface', async ({
        page,
    }) => {
        await boot(page)
        await page.evaluate(async () => {
            const { showChoice } =
                await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                    '/src/modals/choice.ts',
                )
            void showChoice({
                title: () => 'Blocking',
                choices: [{ value: 'go', label: () => 'Go', default: true }],
            })
        })
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await raise(page, { message: 'Over the dialog.', card: true, severity: 'error' })
        const over = dialog.locator('[data-notice-card]')
        await expect(over).toBeVisible()
        await expect(over).toHaveClass(/bg-popup/)
        const glyph = over.locator('svg[data-severity="error"]')
        await expect(glyph).toHaveCount(1)
        await expect(glyph).toHaveClass(/text-danger/)
        expect((await glyph.boundingBox())!.width).toBe(16)
    })
})

test.describe('the producers’ severities', () => {
    test('a save error is an error card', async ({ page }) => {
        await boot(page)
        await page.evaluate(async () => {
            const { defaultSaveUi } = await window.editorTest.appImport<
                typeof import('../../src/editor/save/dialogs')
            >('/src/editor/save/dialogs.ts')
            defaultSaveUi.error(() => '"coconut.nxsp" could not be downloaded.')
        })
        await expect(card(page)).toContainText('"coconut.nxsp" could not be downloaded.')
        await expect(glyphs(page)).toHaveAttribute('data-severity', 'error')
    })
})

test.describe('the start-up card', () => {
    /** The load notices of real events, as the loader adds them. */
    const raiseLoad = (page: Page, events: unknown[]) =>
        page.evaluate(async (events) => {
            const n = await window.editorTest.appImport<Module>('/src/editor/notification.ts')
            const L = await window.editorTest.appImport<
                typeof import('../../src/editor/loadNotices')
            >('/src/editor/loadNotices.ts')
            for (const event of events) {
                const line = L.lineOf(event as never)
                n.addLoadNotice(line.message, line.action, line.order, line.severity)
            }
            n.holdNotice('hidden', true)
        }, events)

    const name = (text: string) => ({ name: { kind: 'name' as const, text }, at: Date.now() })
    const continued = { kind: 'continued', name: name('Coconut'), from: Date.now() }
    const rows = (page: Page) => card(page).locator('> div:not(.sticky)')

    test('a severity gives its rows a glyph and a neutral row none, on one text edge', async ({
        page,
    }) => {
        await boot(page, true)
        await raiseLoad(page, [
            continued,
            { kind: 'storageCleared' },
            { kind: 'bgmNotLoaded' },
            { kind: 'journalsFull' },
        ])
        await expect(card(page)).toContainText('Work from earlier visits is missing')
        await settled(page)
        const all = rows(page)
        // Updated to version, then the first three load notices in the table's order (Continued,
        // cleared storage, journals full), then "and 1 more in Local Data".
        await expect(all).toHaveCount(5)
        const found = await all.evaluateAll((elements) =>
            elements.map((row) => ({
                severity: row.querySelector('svg[data-severity]')?.getAttribute('data-severity'),
                left: (() => {
                    const range = document.createRange()
                    range.selectNodeContents(row.querySelector('p')!)
                    return Math.round(
                        range.getBoundingClientRect().left -
                            row.closest('[data-notice-card]')!.getBoundingClientRect().left,
                    )
                })(),
            })),
        )
        const severities = found.map((row) => row.severity ?? null)
        expect(severities).toEqual([null, null, 'warning', 'warning', null])
        // One text edge in every row, neutral ones included.
        expect(found.map((row) => row.left)).toEqual([40, 40, 40, 40, 40])
        // The heading has no glyph.
        await expect(card(page).locator('.sticky svg[data-severity]')).toHaveCount(0)
    })

    test('an info row has the info glyph', async ({ page }) => {
        await boot(page, true)
        await raiseLoad(page, [
            { kind: 'openElsewhere', name: name('Melt'), sessionId: 'x' },
            { kind: 'bgmNotLoaded' },
            { kind: 'unsavedRecovered', sessionId: 'y' },
        ])
        await expect(card(page)).toContainText('Choose Audio')
        await expect(rows(page).locator('svg[data-severity="info"]')).toHaveCount(3)
        await expect(glyphs(page)).toHaveCount(3)
    })

    test('with no severity the text starts at 16 px and there is no glyph column', async ({
        page,
    }) => {
        await boot(page)
        await raiseLoad(page, [continued])
        await expect(card(page)).toContainText('Continued')
        await expect(glyphs(page)).toHaveCount(0)
        const left = await card(page).evaluate((root) => {
            const range = document.createRange()
            range.selectNodeContents(root.querySelector('p:not(.truncate)')!)
            return Math.round(
                range.getBoundingClientRect().left - root.getBoundingClientRect().left,
            )
        })
        expect(left).toBe(16)
    })

    test('rows are 40 px, the last 38, with 32 px pills and dividers inset 16 px', async ({
        page,
    }) => {
        await boot(page, true)
        await raiseLoad(page, [continued, { kind: 'storageCleared' }])
        await expect(rows(page)).toHaveCount(3)
        const shape = await card(page).evaluate((root) => {
            const c = root.getBoundingClientRect()
            return [...root.children]
                .filter((child) => !child.classList.contains('sticky'))
                .map((row) => {
                    const box = row.getBoundingClientRect()
                    const line = getComputedStyle(row, '::before')
                    const button = row.querySelector('[data-notice-action]')
                    return {
                        height: box.height,
                        pill: button?.getBoundingClientRect().height,
                        left: Math.round(box.left - c.left + parseFloat(line.left)),
                        right: Math.round(c.right - box.right + parseFloat(line.right)),
                    }
                })
        })
        expect(shape).toEqual([
            { height: 40, pill: 32, left: 16, right: 16 },
            { height: 40, pill: 32, left: 16, right: 16 },
            { height: 38, pill: undefined, left: 16, right: 16 },
        ])
    })
})

test.describe('one line, or stacked', () => {
    const long = 'Opened coconut.nxsp. You have unsaved changes to it from Oct 14.'

    test('an action shares the message’s line when both fit, and sits under it when not', async ({
        page,
    }) => {
        await boot(page)
        // Fits on a desktop pane: one line, the action on it.
        await raise(page, { message: 'Nothing to undo', action: 'Open History' })
        await settled(page)
        const short = await textOf(card(page), 'p')
        const inline = (await card(page).locator('[data-notice-action]').boundingBox())!
        expect(short.lines).toBe(1)
        expect(inline.y).toBeLessThan(short.bottom)
        expect((await card(page).boundingBox())!.height).toBe(44)
        // A message with no room beside the action: one line of text, the action under it.
        await raise(page, { message: long, action: 'Restore Session', severity: 'info' })
        await settled(page)
        const message = await textOf(card(page), 'p')
        const action = (await card(page).locator('[data-notice-action]').boundingBox())!
        const close = (await card(page).locator('[data-notice-close]').boundingBox())!
        const box = (await card(page).boundingBox())!
        expect(message.lines).toBe(1)
        expect(action.y).toBeGreaterThanOrEqual(message.bottom)
        // The pair stays together at the end, and the card is the text, a 4 px gap and the 36 px row.
        expect(Math.abs(action.y - close.y)).toBeLessThan(1)
        expect(Math.round(box.x + box.width - (close.x + close.width))).toBe(4)
        expect(box.height).toBe(4 + 8 + 20 + 8 + 4 + 36 + 4)
    })

    test.describe('on a phone', () => {
        test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

        test('a short message and its action stay on one line, a long one stacks', async ({
            page,
        }) => {
            await boot(page)
            await raise(page, { message: 'Nothing to undo', action: 'Open History' })
            await settled(page)
            const short = await textOf(card(page), 'p')
            expect(short.lines).toBe(1)
            expect((await card(page).boundingBox())!.height).toBe(44)
            await raise(page, { message: long, action: 'Restore Session', severity: 'info' })
            await settled(page)
            const message = await textOf(card(page), 'p')
            const action = (await card(page).locator('[data-notice-action]').boundingBox())!
            expect(message.lines).toBeGreaterThan(1)
            expect(action.y).toBeGreaterThanOrEqual(message.bottom)
            // Inside the 8 px margins.
            const box = (await card(page).boundingBox())!
            expect(box.x).toBeGreaterThanOrEqual(8)
            expect(box.x + box.width).toBeLessThanOrEqual(382)
        })

        test('a card without an action keeps its × at the top right', async ({ page }) => {
            await boot(page)
            await raise(page, { message: long + long, card: true, severity: 'warning' })
            await settled(page)
            const message = await textOf(card(page), 'p')
            const close = (await card(page).locator('[data-notice-close]').boundingBox())!
            const box = (await card(page).boundingBox())!
            expect(message.lines).toBeGreaterThan(2)
            expect(close.y - box.y).toBe(4)
            expect(Math.round(box.x + box.width - (close.x + close.width))).toBe(4)
        })
    })
})
