import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const errors = new WeakMap<Page, string[]>()
const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
const elevationBeat = (page: Page) =>
    page.evaluate(
        async () =>
            (
                await window.editorTest.appImport<
                    typeof import('../../src/editor/elevation/state')
                >('/src/editor/elevation/state.ts')
            ).elevationBeat.value,
    )
const setUp = (page: Page, division: number, bpms = [0]) =>
    page.evaluate(
        ({ division, bpms }) => {
            const { fixtures, show, view, settings } = window.editorTest
            show({ ...fixtures.interaction, bpms: bpms.map((beat) => ({ beat, bpm: 120 })) }, 3)
            view.cursorTime = 3
            view.division = division
            settings.elevationEditorSideBySide = 'disallow'
        },
        { division, bpms },
    )

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

// Each case: the beats Next Beat steps to from beat 7, as shown.
for (const { name, division, bpms, shown } of [
    { name: 'thirds', division: 3, bpms: [0], shown: ['7.333', '7.667'] },
    { name: 'twelfths', division: 12, bpms: [0], shown: ['7.083', '7.167'] },
    { name: 'sixteenths', division: 16, bpms: [0], shown: ['7.063', '7.125'] },
    // A tempo change at 6.1 starts a bar there.
    { name: 'a bar grid', division: 3, bpms: [0, 6.1], shown: ['7.1', '7.433', '7.767'] },
])
    test(`the Beat field shows three decimals and keeps grid lines on ${name}`, async ({
        page,
    }) => {
        await setUp(page, division, bpms)
        await page.keyboard.press('t')
        const field = page.getByRole('spinbutton', { name: 'Beat', exact: true })
        await expect(field).toHaveValue('7')
        const next = page.getByRole('button', { name: 'Next Beat', exact: true })
        const values = ['7', ...shown]
        const lines = [await elevationBeat(page)]
        for (const value of shown) {
            await next.click()
            await expect(field).toHaveValue(value)
            lines.push(await elevationBeat(page))
        }
        // Typed as shown, a value stores its line.
        for (const [i, value] of values.entries()) {
            await field.fill(value)
            await field.press('Enter')
            await expect(field).toHaveValue(value)
            expect(await elevationBeat(page), value).toBe(lines[i])
        }
        // Arrows step to the lines beside a shown or typed value, which may round past its line.
        for (let i = 1; i < values.length; i++) {
            await field.fill(values[i]!)
            await field.press('ArrowDown')
            await expect(field).toHaveValue(values[i - 1]!)
            expect(await elevationBeat(page)).toBe(lines[i - 1])
            await field.press('ArrowUp')
            await expect(field).toHaveValue(values[i]!)
            expect(await elevationBeat(page)).toBe(lines[i])
            await field.fill(values[i - 1]!)
            await field.press('ArrowUp')
            await expect(field).toHaveValue(values[i]!)
            expect(await elevationBeat(page)).toBe(lines[i])
        }
    })

test('the Beat field fits a long beat', async ({ page }) => {
    await setUp(page, 16)
    await page.keyboard.press('t')
    const field = page.getByRole('spinbutton', { name: 'Beat', exact: true })
    await field.fill('123.063')
    await field.press('Enter')
    await expect(field).toHaveValue('123.063')
    expect(await elevationBeat(page)).toBe(122.0625)
    for (const width of [1600, 390, 300]) {
        await page.setViewportSize({ width, height: 844 })
        await settle(page)
        // The text fits inside the padding.
        expect(
            await field.evaluate((input: HTMLInputElement) => {
                const style = getComputedStyle(input)
                // The text in the field's own font, tabular digits included.
                const text = document.createElement('span')
                text.textContent = input.value
                for (const key of [
                    'fontFamily',
                    'fontSize',
                    'fontWeight',
                    'fontVariantNumeric',
                ] as const)
                    text.style[key] = style[key]
                document.body.append(text)
                const width = text.getBoundingClientRect().width
                text.remove()
                const room =
                    input.clientWidth -
                    parseFloat(style.paddingLeft) -
                    parseFloat(style.paddingRight)
                return room - width
            }),
            `${width}`,
        ).toBeGreaterThanOrEqual(0)
    }
})
