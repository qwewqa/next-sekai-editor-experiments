import { expect, test, type Locator, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

// Controls that sit together take input up to each other: a pointer moving
// between neighbours is always over one of them.

test.beforeEach(async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { history, fixtures, settings } = window.editorTest
        history.resetState(false, structuredClone(fixtures.interaction), 0, 'hits.json')
        Object.assign(settings, { showPreview: true, showGroups: true })
    })
})

/**
 * What each point hits on lines from the centre of `a` to the centre of `b`,
 * across their shared extent: 'a', 'b', or what else is there. Each line
 * collapses repeats, so neighbours that meet read 'a b'.
 */
const sweep = async (a: Locator, b: Locator) => {
    const handles = [await a.elementHandle(), await b.elementHandle()]
    return a.page().evaluate(([a, b]) => {
        const ra = a!.getBoundingClientRect()
        const rb = b!.getBoundingClientRect()
        const across = rb.left >= ra.right - 0.5
        const [lo, hi] = across
            ? [Math.max(ra.top, rb.top), Math.min(ra.bottom, rb.bottom)]
            : [Math.max(ra.left, rb.left), Math.min(ra.right, rb.right)]
        const [from, to] = across
            ? [ra.left + ra.width / 2, rb.left + rb.width / 2]
            : [ra.top + ra.height / 2, rb.top + rb.height / 2]
        return [0.05, 0.5, 0.95].map((f) => {
            const along = lo + (hi - lo) * f
            const seen: string[] = []
            for (let t = from; t <= to; t += 0.25) {
                const element = across
                    ? document.elementFromPoint(t, along)
                    : document.elementFromPoint(along, t)
                const owner = a!.contains(element)
                    ? 'a'
                    : b!.contains(element)
                      ? 'b'
                      : `${element?.tagName}.${element?.className}`
                if (seen.at(-1) !== owner) seen.push(owner)
            }
            return seen.join(' ')
        })
    }, handles)
}

const meet = async (a: Locator, b: Locator) =>
    expect(await sweep(a, b)).toEqual(['a b', 'a b', 'a b'])

/**
 * Whole-pixel lines from `a` to `b`: across their shared extent, and up to `beyond`
 * px past it at each side, as at the corners of a gap. Each line gives what it
 * hits ('a b' when they meet), the first coordinate on `b`, and the middle of
 * the gap between their faces.
 */
const switches = async (a: Locator, b: Locator, beyond = 0) => {
    const args = { a: await a.elementHandle(), b: await b.elementHandle(), beyond }
    return a.page().evaluate(({ a, b, beyond }) => {
        const ra = a!.getBoundingClientRect()
        const rb = b!.getBoundingClientRect()
        const across = rb.left >= ra.right - 0.5
        const [lo, hi] = across
            ? [Math.max(ra.top, rb.top), Math.min(ra.bottom, rb.bottom)]
            : [Math.max(ra.left, rb.left), Math.min(ra.right, rb.right)]
        const [from, to] = across
            ? [ra.left + ra.width / 2, rb.left + rb.width / 2]
            : [ra.top + ra.height / 2, rb.top + rb.height / 2]
        const middle = across ? (ra.right + rb.left) / 2 : (ra.bottom + rb.top) / 2
        const lines = [lo + 1, (lo + hi) / 2, hi - 1]
        // The farthest whole pixels whose 1px probe box stays within the reach.
        if (beyond) lines.push(Math.ceil(lo - beyond), Math.floor(hi + beyond - 1))
        return lines.map((along) => {
            const seen: string[] = []
            let at: number | undefined
            for (let t = Math.ceil(from); t <= to; t++) {
                const element = across
                    ? document.elementFromPoint(t, Math.round(along))
                    : document.elementFromPoint(Math.round(along), t)
                const owner = a!.contains(element)
                    ? 'a'
                    : b!.contains(element)
                      ? 'b'
                      : `${element?.tagName}.${element?.className}`
                if (owner === 'b') at ??= t
                if (seen.at(-1) !== owner) seen.push(owner)
            }
            return { hits: seen.join(' '), at: at!, middle }
        })
    }, args)
}

/**
 * Neighbours meet halfway across the gap between their faces, or at the edge
 * they share. Chromium hit tests the 1px box at a point, so `b` takes over
 * within 1px before the middle.
 */
const meetHalfway = async (a: Locator, b: Locator, beyond = 0) => {
    for (const { hits, at, middle } of await switches(a, b, beyond)) {
        expect(hits).toBe('a b')
        expect(at).toBeGreaterThan(middle - 1)
        expect(at).toBeLessThanOrEqual(middle + 0.01)
    }
}

/** Sets the root font size, as a browser's default font size setting does. */
const setRootFontSize = (page: Page, size: number) =>
    page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`
    }, size)

test('rail tabs meet', async ({ page }) => {
    const tabs = page.locator('[data-workspace-dock="left"] [data-panel-tab]')
    await expect(tabs.nth(1)).toBeVisible()
    await meet(tabs.nth(0), tabs.nth(1))
})

test('preview steppers meet', async ({ page }) => {
    const steps = page.locator('.transport-step')
    await expect(steps).toHaveCount(6)
    for (let i = 0; i < 5; i++) await meet(steps.nth(i), steps.nth(i + 1))
})

test('manager rows and their buttons meet', async ({ page }) => {
    const rows = page.locator('#workspace-panel-groups .manager-entry')
    await expect(rows).toHaveCount(2)
    const [first, second] = [rows.nth(0), rows.nth(1)]
    // Round buttons beside each other, and each column down the list.
    await meet(first.locator('.manager-eye'), first.locator('.manager-name'))
    await meet(first.locator('.manager-name'), second.locator('.manager-name'))
    await meet(first.locator('.manager-eye'), second.locator('.manager-eye'))
    await meet(first.locator('.manager-more'), second.locator('.manager-more'))
    // Between them, the row takes the gap's half beside it, and shows as hovered.
    const [top, bottom] = await Promise.all([first.boundingBox(), second.boundingBox()])
    const x = top!.x + top!.width - 60
    await page.mouse.move(x, top!.y + top!.height + 1)
    expect(await first.evaluate((row) => row.matches(':hover'))).toBe(true)
    await page.mouse.move(x, bottom!.y - 1)
    expect(await second.evaluate((row) => row.matches(':hover'))).toBe(true)
})

test('collapsed properties headers meet across their dividers', async ({ page }) => {
    await page.evaluate(() => Object.assign(window.editorTest.settings, { showSidebar: true }))
    const headers = page.locator('[id^="properties-section-"][id$="-header"]')
    await expect(headers).toHaveCount(3)
    for (let i = 0; i < 3; i++)
        if ((await headers.nth(i).getAttribute('aria-expanded')) === 'true')
            await headers.nth(i).click()
    await page.mouse.move(5, 5)
    await meet(headers.nth(0), headers.nth(1))
    await meet(headers.nth(1), headers.nth(2))
})

const toolbarPairs = (page: Page) =>
    page.getByRole('dialog').evaluate((dialog) => {
        // Neighbours down a column, and across the gap between columns.
        const columns = [...dialog.querySelectorAll('.flex-wrap > .flex-col')]
        const index = (element: Element) =>
            [...dialog.querySelectorAll('button')].indexOf(element as HTMLButtonElement)
        const down = [...columns[0]!.children].slice(0, 2).map(index)
        // The last tool, whose reach below differs, and the tool above it.
        const end = [...columns[0]!.children].slice(-2).map(index)
        const tops = (column: Element) =>
            [...column.children].map((child) => child.getBoundingClientRect().top)
        // The trailing add button, wrapped under a column's last tool.
        const grid = [...dialog.querySelectorAll('.flex-wrap button')]
        const last = grid.at(-1)!.getBoundingClientRect()
        const gap = parseFloat(
            getComputedStyle(dialog.querySelector('.flex-wrap:has(> .flex-col)')!).rowGap,
        )
        const over = grid.find((button) => {
            const box = button.getBoundingClientRect()
            const centre = box.left + box.width / 2
            return (
                Math.abs(last.top - box.bottom - gap) < 0.01 &&
                centre > last.left &&
                centre < last.right
            )
        })
        const wrapped = over && [index(over), index(grid.at(-1)!)]
        for (let i = 0; i + 1 < columns.length; i++) {
            const [left, right] = [columns[i]!, columns[i + 1]!]
            const shared = tops(left).find((top) => tops(right).includes(top))
            if (shared === undefined) continue
            const at = (column: Element) =>
                [...column.children].find((child) => child.getBoundingClientRect().top === shared)!
            return { down, end, across: [index(at(left)), index(at(right))], wrapped }
        }
        throw new Error('no columns side by side')
    })

const settingsToolbarMeets = async (page: Page, wraps = true) => {
    await page.evaluate(async () => {
        const { commands } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands')
        >('/src/editor/commands/index.ts')
        await commands.settings.execute()
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByText('Toolbar', { exact: true }).scrollIntoViewIfNeeded()
    const { down, across, wrapped } = await toolbarPairs(page)
    const button = (index: number) => dialog.locator('button').nth(index)
    // A column's add button meets the tool below it, tools meet across columns,
    // and wrapped lines meet across the gap between them.
    await meet(button(down[0]!), button(down[1]!))
    await meet(button(across[0]!), button(across[1]!))
    if (!wraps) return
    expect(wrapped).toBeDefined()
    await meet(button(wrapped![0]!), button(wrapped![1]!))
}

test('the settings toolbar editor’s buttons meet', async ({ page }) => {
    await settingsToolbarMeets(page)
})

test.describe('at other root font sizes', () => {
    for (const size of [14, 18, 20])
        test(`the settings toolbar editor’s buttons meet halfway at ${size}px`, async ({
            page,
        }) => {
            await setRootFontSize(page, size)
            await page.evaluate(async () => {
                const { commands } = await window.editorTest.appImport<
                    typeof import('../../src/editor/commands')
                >('/src/editor/commands/index.ts')
                await commands.settings.execute()
            })
            const dialog = page.getByRole('dialog')
            await expect(dialog).toBeVisible()
            await dialog.getByText('Toolbar', { exact: true }).scrollIntoViewIfNeeded()
            const { end, across, wrapped } = await toolbarPairs(page)
            const button = (index: number) => dialog.locator('button').nth(index)
            const reach = size / 8
            // A column's last tool and the one above it, also beside them in the
            // gaps between columns; tools across columns; wrapped lines.
            await button(end[1]!).scrollIntoViewIfNeeded()
            await meetHalfway(button(end[0]!), button(end[1]!), reach)
            await meetHalfway(button(across[0]!), button(across[1]!))
            expect(wrapped).toBeDefined()
            await button(wrapped![1]!).scrollIntoViewIfNeeded()
            await meetHalfway(button(wrapped![0]!), button(wrapped![1]!), reach)
        })

    for (const size of [18, 20])
        test(`rail tabs and preview steppers reach each other and the track’s edges at ${size}px`, async ({
            page,
        }) => {
            await setRootFontSize(page, size)
            await expect(page.locator('.transport-step')).toHaveCount(6)
            const edges = await page.evaluate(() => {
                // Each face's box grown by its pseudo-element's insets.
                const reach = (element: Element) => {
                    const box = element.getBoundingClientRect()
                    const style = getComputedStyle(element, '::before')
                    return {
                        top: box.top + parseFloat(style.top),
                        bottom: box.bottom - parseFloat(style.bottom),
                        left: box.left + parseFloat(style.left),
                        right: box.right - parseFloat(style.right),
                    }
                }
                const tabs = [
                    ...document.querySelectorAll('[data-workspace-dock="left"] [data-panel-tab]'),
                ].map(reach)
                const steps = [...document.querySelectorAll('.transport-step')].map(reach)
                const track = document.querySelector('.transport-track')!.getBoundingClientRect()
                return {
                    tabs: tabs.slice(1).map((tab, i) => tab.top - tabs[i]!.bottom),
                    steps: steps.slice(1).map((step, i) => step.left - steps[i]!.right),
                    track: steps.flatMap((step) => [
                        step.top - track.top,
                        track.bottom - step.bottom,
                    ]),
                }
            })
            expect(edges.tabs.length).toBeGreaterThan(0)
            for (const gap of [...edges.tabs, ...edges.steps, ...edges.track])
                expect(Math.abs(gap)).toBeLessThan(0.01)
        })
})

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('top rail tabs meet', async ({ page }) => {
        const tabs = page.locator('[data-workspace-dock="top"] [data-panel-tab]')
        await expect(tabs.nth(1)).toBeVisible()
        await meet(tabs.nth(0), tabs.nth(1))
    })

    test('the settings toolbar editor’s buttons meet at touch sizes', async ({ page }) => {
        await settingsToolbarMeets(page, false)
    })
})
