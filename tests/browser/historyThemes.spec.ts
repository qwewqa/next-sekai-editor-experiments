import { expect, test, type Locator, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { touchInput } from './editorFixture'
import {
    errorsFail,
    liveOf,
    load,
    noErrors,
    openHistory,
    placeTap,
    timeline,
} from './historyJourney'

test.afterEach(({ page }) => noErrors(page))

// --- Helpers

/** Pushes `count` separate rows (future extensions are never grouped), titled "Life 1" and on. */
const synthesise = (page: Page, count: number) =>
    page.evaluate((count) => {
        const { history, historySteps } = window.editorTest
        for (let i = 0; i < count; i++)
            history.pushState(
                historySteps.futureInitialLife(
                    history.state.value.initialLife,
                    history.state.value.initialLife + 1,
                    `Life ${i + 1}`,
                ),
                { ...history.state.value, initialLife: history.state.value.initialLife + 1 },
            )
    }, count)

/** Adds an older stored entry that was removed to save space: an unavailable row. */
const seedRemoved = (page: Page) =>
    page.evaluate(async () => {
        const start =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const worker = start.storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const call = worker.call.bind(worker)
        const { historySteps } = window.editorTest
        const removed = {
            sessionId: 'seeded',
            seq: 900,
            time: Date.now() - 3_600_000,
            kind: 'edit',
            step: historySteps.editStep(
                historySteps.futureFixtureOperation('seed-removed', {}, 'Removed notes'),
            ),
            snapshot: '00',
            noteCount: 1,
            dirty: false,
            kept: false,
        }
        worker.call = async (name, ...args) => {
            const result = await call(name, ...args)
            if (name !== 'readTimeline') return result
            const page = result as { entries: unknown[] }
            return { ...page, entries: [...page.entries, removed] }
        }
    })

/** Starts every page of the test with a root font size of 20 px. */
const rootAt20 = (page: Page) =>
    page.addInitScript(() => {
        const apply = () => {
            document.documentElement.style.fontSize = '20px'
        }
        if (document.documentElement) apply()
        else {
            const observer = new MutationObserver(() => {
                if (!document.documentElement) return
                observer.disconnect()
                apply()
            })
            observer.observe(document, { childList: true })
        }
    })

const setRoot = (page: Page, px: number) =>
    page.evaluate((px) => {
        document.documentElement.style.fontSize = `${px}px`
    }, px)

const twoFrames = (page: Page) =>
    page.evaluate(
        () =>
            new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
            ),
    )

/** The rows the Timeline renders, with the box each occupies in the list. */
const boxes = (page: Page) =>
    timeline(page)
        .locator('[data-history-row]')
        .evaluateAll((rows) =>
            rows.map((row) => {
                const rect = row.getBoundingClientRect()
                const text = row.matches('.timeline-now')
                    ? row.querySelector('.timeline-entry-text')
                    : row.querySelector('[data-history-group-action]')
                return {
                    title: (text?.textContent ?? '').replace(/\s+/g, ' ').trim(),
                    top: rect.top,
                    bottom: rect.bottom,
                    height: rect.height,
                    left: rect.left,
                    width: rect.width,
                    header: row.getAttribute('role') === 'presentation',
                }
            }),
        )

/** The height of a rendered entry row's slot. */
const slotOf = async (page: Page) =>
    (await boxes(page)).find((box) => /^Life \d+$/.test(box.title))?.height

const listBox = (page: Page) =>
    timeline(page).evaluate((list) => {
        const rect = list.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    })

const scrollListTo = async (page: Page, top: number) => {
    await timeline(page).evaluate((list, top) => {
        list.scrollTop = top
    }, top)
    // The window of rendered rows follows the scroll.
    await expect.poll(() => timeline(page).evaluate((list) => list.scrollTop)).toBeCloseTo(top, 0)
    await twoFrames(page)
}

/**
 * A click at the visual centre of the entry row at `index` of those rendered peeks that row. The
 * rows' titles are unique ("Life n"), so the peeked row is told by its title.
 */
const clickCentreOfRow = async (page: Page, title: string) => {
    const row = timeline(page)
        .locator('[data-history-row]')
        .filter({
            has: page.locator('[data-history-group-action]').filter({
                hasText: new RegExp(`^\\s*${title}\\s*$`),
            }),
        })
    await expect(row).toHaveCount(1)
    const box = await row.boundingBox()
    if (!box) throw new Error(`${title} has no box`)
    // The title is the row's main hit; the centre of the row's box is on it or its padding.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(
        timeline(page)
            .locator('[data-history-row][aria-selected="true"]')
            .filter({
                has: page.locator('[data-history-group-action]').filter({
                    hasText: new RegExp(`^\\s*${title}\\s*$`),
                }),
            }),
    ).toHaveCount(1)
}

const backToNowByKey = async (page: Page) => {
    await page.locator('[data-peek-back]').click()
    await expect(page.locator('[data-peek-bar]')).toHaveCount(0)
}

const entryTitles = async (page: Page) =>
    (await boxes(page)).filter((box) => /^Life \d+$/.test(box.title)).map((box) => box.title)

/** Checks the list's slots against the scale: entry rows 44 * k, headers 28 * k. */
const expectSlots = async (page: Page, k: number) => {
    const rows = await boxes(page)
    expect(rows.length).toBeGreaterThan(3)
    for (const box of rows) {
        const expected =
            box.title === 'Now' || /^Life \d+$/.test(box.title)
                ? 44 * k
                : box.title.startsWith('Removed')
                  ? 80 * k
                  : undefined
        if (expected !== undefined)
            expect(box.height, `${box.title} is ${box.height} px tall`).toBeCloseTo(expected, 0)
    }
}

// --- RM1 and RM2: the root font size

test.describe('a larger root font size', () => {
    test('RM1: slots, End and clicks scale with a 20 px root', async ({ page }) => {
        test.slow()
        errorsFail(page)
        await rootAt20(page)
        await load(page)
        await synthesise(page, 300)
        await seedRemoved(page)
        await openHistory(page, { focused: false })
        const k = 20 / 16
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
            '20px',
        )
        // Row slots are 55 px.
        await expect
            .poll(() => entryTitles(page).then((titles) => titles.length))
            .toBeGreaterThan(5)
        await expectSlots(page, k)
        // A click at the visual centre of a row peeks that row, down a 300-row list.
        for (const [index, scroll] of [
            [5, 0],
            [40, 40 * 55 - 100],
            [120, 120 * 55 - 100],
            [200, 200 * 55 - 100],
        ] as const) {
            await scrollListTo(page, scroll)
            // The rows are newest first: "Life 300" is at the top.
            const title = `Life ${300 - index}`
            await clickCentreOfRow(page, title)
            await backToNowByKey(page)
        }
        // End shows the last row whole.
        await timeline(page).locator('[data-history-row]').first().focus()
        await page.keyboard.press('End')
        const list = timeline(page)
        await expect
            .poll(() =>
                list.evaluate(
                    (element) =>
                        element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
                ),
            )
            .toBe(true)
        const rows = await boxes(page)
        const last = rows.at(-1)!
        const area = await listBox(page)
        expect(last.top).toBeGreaterThanOrEqual(area.top - 0.5)
        expect(last.bottom).toBeLessThanOrEqual(area.bottom + 0.5)
        // The unavailable row is 100 px.
        const removed = rows.find((box) => box.title.startsWith('Removed'))
        expect(removed, 'the removed row is shown').toBeTruthy()
        expect(removed!.height).toBeCloseTo(80 * k, 0)
    })

    test('RM1: the one-line threshold and the stack scale with a 20 px root', async ({ page }) => {
        errorsFail(page)
        await rootAt20(page)
        await load(page)
        await synthesise(page, 10)
        await openHistory(page, { focused: false })
        // 18rem is 360 px at a 20 px root: 352 px takes two lines and 360 px one.
        const list = timeline(page)
        for (const [width, oneLine] of [
            [352, false],
            [360, true],
            [352, false],
        ] as const) {
            await list.evaluate((element, width) => {
                element.style.width = `${width}px`
            }, width)
            await expect(list).toHaveClass(oneLine ? /timeline-one-line/ : /timeline-two-line/)
        }
        // The stack of the strip and the capsule is 105 px, 84 px at a 16 px root.
        await list.evaluate((element) => {
            element.style.width = ''
        })
        await list.locator('[data-history-group-action]').first().click()
        await expect(page.locator('[data-peek-bar]')).toBeVisible()
        const stack = await page.locator('[data-peek-bar]').evaluate((bar) => {
            const [main, capsule] = [...bar.children]
            const first = main!.getBoundingClientRect()
            const last = capsule!.getBoundingClientRect()
            return last.bottom - first.top
        })
        expect(stack).toBeCloseTo(105, 0)
    })

    test('RM2: a root size change with History open and peeking rescales the rows and the strip', async ({
        page,
        browser,
    }) => {
        test.slow()
        errorsFail(page)
        await load(page)
        await synthesise(page, 300)
        await openHistory(page, { focused: false })
        const strip = () =>
            page.locator('[data-peek-main]').evaluate((main) => main.getBoundingClientRect().width)
        await clickCentreOfRow(page, 'Life 295')
        const at16 = await strip()
        await expectSlots(page, 1)

        // The browser's text size changes while the sheet is open.
        await setRoot(page, 20)
        await twoFrames(page)
        await expect.poll(() => slotOf(page)).toBeCloseTo(55, 0)
        await expectSlots(page, 20 / 16)
        // A click at the visual centre of a row peeks that row, at the new scale.
        for (const [index, scroll] of [
            [5, 0],
            [60, 60 * 55 - 100],
            [150, 150 * 55 - 100],
        ] as const) {
            await scrollListTo(page, scroll)
            await clickCentreOfRow(page, `Life ${300 - index}`)
        }
        // The strip refits: its width is what a fresh load at 20 px gives.
        await expect.poll(strip).not.toBeCloseTo(at16, 0)
        await scrollListTo(page, 0)
        await clickCentreOfRow(page, 'Life 295')
        const at20 = await strip()

        const fresh = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
        try {
            const other = await fresh.newPage()
            errorsFail(other)
            await rootAt20(other)
            await load(other)
            await synthesise(other, 300)
            await openHistory(other, { focused: false })
            await clickCentreOfRow(other, 'Life 295')
            const expected = await other
                .locator('[data-peek-main]')
                .evaluate((main) => main.getBoundingClientRect().width)
            expect(at20).toBeCloseTo(expected, 0)
            await noErrors(other)
        } finally {
            await fresh.close()
        }

        // And back again.
        await setRoot(page, 16)
        await twoFrames(page)
        await expect.poll(() => slotOf(page)).toBeCloseTo(44, 0)
        await expect.poll(strip).toBeCloseTo(at16, 0)
    })
})

// --- Themes: principles, not pixels

type Rgba = { r: number; g: number; b: number; a: number }
type Ring = {
    width: number
    style: string
    color: Rgba
    offset: number
    /** What lies behind the ring, composited to an opaque colour. */
    surface: Rgba
    /** The product of the opacities from the ring's element up. */
    opacity: number
    focusVisible: boolean
}

/** WCAG relative luminance of an opaque sRGB colour. */
const luminance = ({ r, g, b }: Rgba) => {
    const channel = (value: number) => {
        const s = value / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** `fill` composited over an opaque `surface`. */
const flatten = (fill: Rgba, surface: Rgba): Rgba => ({
    r: fill.r * fill.a + surface.r * (1 - fill.a),
    g: fill.g * fill.a + surface.g * (1 - fill.a),
    b: fill.b * fill.a + surface.b * (1 - fill.a),
    a: 1,
})

/** The WCAG contrast ratio of two opaque colours. */
const contrast = (a: Rgba, b: Rgba) => {
    const [x, y] = [luminance(a), luminance(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * Reads, in the page, what an element draws: its outline, the fill and shadow of a pseudo-element,
 * the surface behind it, and the opacities above it. `ring` names the descendant that draws the
 * ring, `pseudo` the pseudo-element (the Timeline's rows draw on `::before`).
 */
const paintOf = (target: Locator, opts: { ring?: string; pseudo?: '::before' } = {}) =>
    target.evaluate((element, opts) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        const resolve = (css: string) => {
            context.clearRect(0, 0, 1, 1)
            context.fillStyle = '#000'
            context.fillStyle = css
            context.fillRect(0, 0, 1, 1)
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
            return { r: r!, g: g!, b: b!, a: a! / 255 }
        }
        const drawn = (opts.ring ? element.querySelector<HTMLElement>(opts.ring) : null) ?? element
        const style = getComputedStyle(drawn, opts.pseudo)
        const offset = parseFloat(style.outlineOffset)
        // The fills behind the ring: a ring drawn inside starts at its own element's.
        const layers = [] as ReturnType<typeof resolve>[]
        for (
            let node: Element | null = offset < 0 || opts.pseudo ? drawn : drawn.parentElement;
            node;
            node = node.parentElement
        )
            layers.push(resolve(getComputedStyle(node).backgroundColor))
        let surface = { r: 255, g: 255, b: 255, a: 1 }
        for (const layer of layers.reverse())
            surface = {
                r: layer.r * layer.a + surface.r * (1 - layer.a),
                g: layer.g * layer.a + surface.g * (1 - layer.a),
                b: layer.b * layer.a + surface.b * (1 - layer.a),
                a: 1,
            }
        let opacity = 1
        for (let at: Element | null = drawn; at; at = at.parentElement)
            opacity *= parseFloat(getComputedStyle(at).opacity)
        return {
            width: parseFloat(style.outlineWidth),
            style: style.outlineStyle,
            color: resolve(style.outlineColor),
            offset,
            surface,
            opacity,
            fill: resolve(style.backgroundColor),
            shadow: style.boxShadow,
            focusVisible: element.matches(':focus-visible'),
        }
    }, opts) as Promise<
        Ring & {
            fill: Rgba
            shadow: string
        }
    >

type Scheme = 'light' | 'dark'
const schemes: Scheme[] = ['light', 'dark']

const rowOf = (page: Page, title: string) =>
    timeline(page)
        .locator('[data-history-row]')
        .filter({
            has: page.locator('[data-history-group-action]').filter({
                hasText: new RegExp(`^\\s*${title}\\s*$`),
            }),
        })

/** A group of three real taps, then four separate rows above it, and History open. */
const themed = async (page: Page, scheme: Scheme) => {
    errorsFail(page)
    await page.emulateMedia({ colorScheme: scheme })
    await load(page)
    await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(scheme)
    for (const beat of [1, 2, 3]) await placeTap(page, { lane: 0, beat })
    await synthesise(page, 4)
    await openHistory(page)
}

/** A key press is what makes a programmatic focus show its ring (`:focus-visible`). */
const focusByKeyboard = async (page: Page, target: Locator) => {
    await page.keyboard.press('Shift')
    await target.focus()
    await expect(target).toBeFocused()
}

for (const scheme of schemes) {
    test.describe(`${scheme} theme`, () => {
        test(`TH1 (${scheme}): the current row differs from a hovered row by an edge or shadow`, async ({
            page,
        }) => {
            await themed(page, scheme)
            await rowOf(page, 'Life 3').locator('[data-history-group-action]').click()
            await expect(page.locator('[data-peek-bar]')).toBeVisible()
            const current = rowOf(page, 'Life 3')
            await expect(current).toHaveAttribute('aria-selected', 'true')
            const hovered = rowOf(page, 'Life 1')
            const box = (await hovered.boundingBox())!
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            // The hover fill shows once the pointer is over the row.
            await expect
                .poll(async () => (await paintOf(hovered, { pseudo: '::before' })).fill.a)
                .toBeGreaterThan(0)
            const selected = await paintOf(current, { pseudo: '::before' })
            const hover = await paintOf(hovered, { pseudo: '::before' })
            const rest = await paintOf(rowOf(page, 'Life 2'), { pseudo: '::before' })
            // An edge or a shadow that the hover lacks.
            expect(selected.shadow, 'the current row has a shadow or an edge').not.toBe('none')
            expect(hover.shadow, 'the hovered row has none').toBe('none')
            // Their fills are told apart, and a hovered row from one at rest.
            const fills = {
                selected: flatten(selected.fill, selected.surface),
                hover: flatten(hover.fill, hover.surface),
                rest: rest.surface,
            }
            const ratios = {
                selectedAgainstHover: contrast(fills.selected, fills.hover),
                hoverAgainstRest: contrast(fills.hover, fills.rest),
            }
            test.info().annotations.push({ type: 'contrast', description: JSON.stringify(ratios) })
            expect(ratios.selectedAgainstHover).toBeGreaterThanOrEqual(1.05)
            expect(ratios.hoverAgainstRest).toBeGreaterThan(1)
        })
    })
}

/** The 1 px inset edge in a computed `box-shadow`: its colour, or undefined when there is none. */
const insetEdge = (shadow: string) => /(rgba?\([^)]*\)) 0px 0px 0px 1px inset/.exec(shadow)?.[1]

for (const scheme of schemes) {
    test(`X-11 (${scheme}): the current row carries a 1 px inset edge, under the focus outline, and moves nothing`, async ({
        page,
    }) => {
        await themed(page, scheme)
        const current = rowOf(page, 'Life 3')
        const title = current.locator('.timeline-entry-text')
        const before = await title.boundingBox()
        await current.locator('[data-history-group-action]').click()
        await expect(current).toHaveAttribute('aria-selected', 'true')
        expect(await title.boundingBox(), 'the title does not move').toEqual(before)
        const hovered = rowOf(page, 'Life 1')
        const box = (await hovered.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await expect
            .poll(async () => (await paintOf(hovered, { pseudo: '::before' })).fill.a)
            .toBeGreaterThan(0)
        const selected = await paintOf(current, { pseudo: '::before' })
        const hover = await paintOf(hovered, { pseudo: '::before' })
        const edge = insetEdge(selected.shadow)
        expect(edge, `the current row's edge (${selected.shadow})`).toBeDefined()
        expect(insetEdge(hover.shadow), 'a hovered row has none').toBeUndefined()
        // A contour, about 1.5:1 against the current fill and against a hovered one.
        const edgeColor = await page.evaluate((css) => {
            const context = document.createElement('canvas').getContext('2d')!
            context.fillStyle = css
            context.fillRect(0, 0, 1, 1)
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
            return { r: r!, g: g!, b: b!, a: a! / 255 }
        }, edge!)
        const fill = flatten(selected.fill, selected.surface)
        const ratios = {
            againstCurrent: contrast(flatten(edgeColor, fill), fill),
            againstHover: contrast(flatten(edgeColor, fill), flatten(hover.fill, hover.surface)),
        }
        test.info().annotations.push({ type: 'edge', description: JSON.stringify(ratios) })
        expect(ratios.againstCurrent).toBeGreaterThanOrEqual(1.3)
        expect(ratios.againstHover).toBeGreaterThanOrEqual(1.3)
        // Keyboard focus is the 2 px full-fg outline drawn over it, apart from the edge.
        await page.mouse.move(0, 0)
        await focusByKeyboard(page, current)
        const focused = await paintOf(current, { pseudo: '::before' })
        expect(focused.width).toBe(2)
        expect(focused.color.a).toBe(1)
        expect(insetEdge(focused.shadow)).toBe(edge)
        expect(contrast(flatten(focused.color, fill), fill)).toBeGreaterThan(
            2 * ratios.againstCurrent,
        )
        expect(await title.boundingBox(), 'nor on focus').toEqual(before)
    })
}

/** The ring floors (plan TH2): 3:1 against the surface behind it, 2 px wide (1 px outside), drawn. */
const expectRing = (name: string, ring: Awaited<ReturnType<typeof paintOf>>, outside = false) => {
    expect(ring.focusVisible, `${name} shows focus-visible`).toBe(true)
    expect(ring.style, `${name} ring is drawn`).not.toBe('none')
    expect(ring.color.a, `${name} ring is not transparent`).toBeGreaterThan(0)
    expect(ring.width, `${name} ring width`).toBeGreaterThanOrEqual(outside ? 1 : 2)
    const ratio = contrast(flatten(ring.color, ring.surface), ring.surface)
    test.info().annotations.push({ type: 'ring', description: `${name}: ${ratio.toFixed(2)}` })
    expect(ratio, `${name} ring contrast`).toBeGreaterThanOrEqual(3)
}

for (const scheme of schemes) {
    test.describe(`${scheme} theme, focus`, () => {
        test(`TH2 (${scheme}): focus rings show on rows, cells and the strip`, async ({ page }) => {
            test.slow()
            await themed(page, scheme)
            // Row focus: Down peeks and focuses the row below Now.
            await page.keyboard.press('ArrowDown')
            const first = rowOf(page, 'Life 4')
            await expect(first).toBeFocused()
            expectRing('row', await paintOf(first, { pseudo: '::before' }))

            // A text-pill cell: the group of taps, opened, then to its main cell.
            const group = timeline(page)
                .locator('[data-history-row]')
                .filter({
                    has: page
                        .locator('[data-history-group-action]')
                        .filter({ hasText: /^\s*Added 3 notes/ }),
                })
            await focusByKeyboard(page, group)
            await page.keyboard.press('ArrowRight')
            await page.keyboard.press('ArrowRight')
            await page.keyboard.press('ArrowRight')
            const cell = page.locator('[data-history-part="main"]:focus')
            await expect(cell).toHaveCount(1)
            expectRing('cell', await paintOf(cell, { ring: '.timeline-entry-text' }))

            // The strip and the capsule, each focused by keyboard.
            const strip = [
                ['date', '[data-peek-details]', undefined, false],
                ['Back to Now', '[data-peek-back]', undefined, false],
                ['Restore', '[data-peek-restore]', undefined, false],
                ['Show Edits', '[data-show-edits]', undefined, true],
                ['arrow', '[data-change-arrow="up"]', '.change-face', true],
            ] as const
            for (const [name, selector, ring, outside] of strip) {
                const control = page.locator(selector)
                await focusByKeyboard(page, control)
                expectRing(name, await paintOf(control, ring ? { ring } : {}), outside)
            }
        })

        test(`TH3 (${scheme}): a focused disabled arrow keeps a full ring`, async ({ page }) => {
            await themed(page, scheme)
            // A header-only change leaves nothing to find: both arrows are disabled.
            await page.keyboard.press('ArrowDown')
            await expect(page.locator('[data-peek-bar]')).toBeVisible()
            const down = page.locator('[data-change-arrow="down"]')
            await expect(down).toHaveAttribute('aria-disabled', 'true')
            await focusByKeyboard(page, down)
            const face = await paintOf(down, { ring: '.change-face' })
            expectRing('disabled arrow', face, true)
            // The face and its ring are whole; only the glyph and the count are faded.
            expect(face.opacity).toBe(1)
            expect(face.color.a).toBe(1)
            const glyph = await down
                .locator('.change-face > svg')
                .evaluate((svg) => getComputedStyle(svg).opacity)
            const count = await down
                .locator('.change-count')
                .evaluate((span) => getComputedStyle(span).opacity)
            expect(Number(glyph)).toBeLessThan(1)
            expect(Number(count)).toBeLessThan(1)
        })

        test(`TH4 (${scheme}): state is not shown by colour alone`, async ({ page }) => {
            await themed(page, scheme)
            await page.keyboard.press('ArrowDown')
            const current = rowOf(page, 'Life 4')
            // The current row carries its state; Now does not.
            await expect(current).toHaveAttribute('aria-selected', 'true')
            await expect(timeline(page).getByRole('row', { name: /^Now/ })).toHaveAttribute(
                'aria-selected',
                'false',
            )
            // Show Edits says whether it is on.
            const eye = page.locator('[data-show-edits]')
            await expect(eye).toHaveAttribute('aria-pressed', /^(true|false)$/)
            const before = await eye.getAttribute('aria-pressed')
            await eye.click()
            await expect(eye).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true')
            // The peeking pane shows the strip as well as its ring.
            await expect(page.locator('[data-peek-bar]')).toBeVisible()
            await expect(
                page.locator('[data-peek-bar]').locator('xpath=..').locator('.ring-accent'),
            ).toHaveCount(1)
            // A filter shows its banner text, not only a dot on a button.
            await page.locator('[data-history-focus="goto"]').click()
            await page.locator('[data-goto-filter="saves"]').click()
            await expect(page.locator('[data-history-filter-banner]')).toContainText(
                en.history.filterSaves,
            )
            await expect(page.locator('[data-history-filter-banner]')).toContainText(
                en.history.showAll,
            )
        })
    })
}

// --- Forced colours: basic function only (the owner's rule for niche accessibility)

test('TH5: with forced colours the current and the focused rows keep an edge, and Restore works', async ({
    page,
}) => {
    errorsFail(page)
    await page.emulateMedia({ forcedColors: 'active' })
    await load(page)
    await expect
        .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
        .toBe(true)
    await synthesise(page, 4)
    await openHistory(page)
    const live = await liveOf(page)
    // A pointer press makes Life 3 the current row, with no focus ring.
    await rowOf(page, 'Life 3').locator('[data-history-group-action]').click()
    await expect(page.locator('[data-peek-bar]')).toBeVisible()
    const current = rowOf(page, 'Life 3')
    await expect(current).toHaveAttribute('aria-selected', 'true')
    const edge = async (row: Locator) => {
        const paint = await paintOf(row, { pseudo: '::before' })
        const border = await row.evaluate(
            (element) => getComputedStyle(element, '::before').borderStyle,
        )
        return { paint, border }
    }
    {
        const { paint, border } = await edge(current)
        test.info().annotations.push({
            type: 'current',
            description: JSON.stringify({ ...paint, border }),
        })
        expect(paint.style !== 'none' || border !== 'none').toBe(true)
        expect(paint.color.a).toBeGreaterThan(0)
    }
    // A key moves the focus to the next row: it keeps a drawn outline as well.
    await page.keyboard.press('ArrowDown')
    const focused = rowOf(page, 'Life 2')
    await expect(focused).toBeFocused()
    {
        const { paint, border } = await edge(focused)
        test.info().annotations.push({
            type: 'focused',
            description: JSON.stringify({ ...paint, border }),
        })
        expect(paint.focusVisible).toBe(true)
        expect(paint.style !== 'none' || border !== 'none').toBe(true)
        expect(paint.color.a).toBeGreaterThan(0)
    }
    // Restore stays operable.
    await page.locator('[data-peek-restore]').click()
    await expect(page.locator('[data-peek-bar]')).toHaveCount(0)
    const restored = await liveOf(page)
    expect(restored.initialLife).not.toBe(live.initialLife)
})

// --- CH1: the chart's own chrome while peeking (INV 8)

test.describe('on a phone', () => {
    test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

    test('CH1: the quick-scroll zone scrolls and the status bar stays one line while peeking', async ({
        page,
    }) => {
        test.slow()
        errorsFail(page)
        await load(page)
        await synthesise(page, 4)
        // On a phone History is a sheet over the chart's lower half: peek a row in it.
        await openHistory(page, { focused: false })
        await rowOf(page, 'Life 3').locator('[data-history-group-action]').click()
        await expect(page.locator('[data-peek-bar]')).toBeVisible()

        const view = () =>
            page.evaluate(() => {
                const { x, y, w, h, time } = window.editorTest.view
                return { x, y, w, h, time }
            })
        const bar = page.locator('[data-status-bar]')
        const lineOf = () =>
            bar.evaluate((element) => {
                const rowHeight = parseFloat(
                    getComputedStyle(element).getPropertyValue('--status-row-height'),
                )
                return {
                    height: element.getBoundingClientRect().height,
                    rowHeight,
                    overflows: element.scrollHeight > element.clientHeight,
                    tallest: Math.max(
                        0,
                        ...[...element.children].map(
                            (child) => child.getBoundingClientRect().height,
                        ),
                    ),
                }
            })

        for (const size of [
            { width: 390, height: 844 },
            { width: 320, height: 568 },
        ]) {
            await page.setViewportSize(size)
            // A small screen shows History as the compact dialog, which View Chart closes while
            // the peek goes on; a larger one keeps the sheet over the chart's lower half.
            const dialog = page.locator('[data-history-presentation]')
            if (
                (await dialog.count()) &&
                (await dialog.getAttribute('data-history-presentation')) === 'compact'
            ) {
                await page.locator('[data-history-view-chart]').click()
                await expect(timeline(page)).toHaveCount(0)
            }
            await expect(page.locator('[data-peek-bar]')).toBeVisible()
            // The bar is one line: its height is its row's, and nothing in it wraps or spills.
            await expect
                .poll(async () => {
                    const line = await lineOf()
                    return (
                        line.height === line.rowHeight &&
                        !line.overflows &&
                        line.tallest <= line.rowHeight
                    )
                })
                .toBe(true)
            // A real drag in the zone, at the pane's right edge, moves the view.
            await expect(page.locator('.editor-quick-scroll-zone')).toHaveCount(1)
            const pane = await view()
            const touch = await touchInput(page)
            const from = { x: pane.x + pane.w - 16, y: pane.y + pane.h * 0.3 }
            const before = pane.time
            await touch('touchStart', [[from.x, from.y]])
            for (let step = 1; step <= 6; step++)
                await touch('touchMove', [[from.x, from.y - (step * 60) / 6]])
            await touch('touchEnd', [])
            await expect.poll(async () => (await view()).time).not.toBe(before)
            // Still peeking: the drag did not end it.
            await expect(page.locator('[data-peek-bar]')).toBeVisible()
        }
    })
})
