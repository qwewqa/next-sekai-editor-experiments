import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, touchInput } from './editorFixture'
import { row as historyRow } from './historyJourney'

// The minimap strip's placement, input, command and setting (Part 1 §1.4.22). Its drawing is
// minimapContent.spec.ts's; the rows here read the content canvas only to tell shown from absent.

const prefix = 'sonolus-next-sekai-editor.'

/** Seeds `showMinimap` on a first load only, so a reload keeps what the page itself saved. */
const seedMinimap = async (page: Page, minimap: boolean | null) => {
    // Before the fixture's seeding (which closes the docks), to read the key a reload kept.
    await page.addInitScript(
        ({ prefix, minimap }) => {
            const key = `${prefix}showMinimap`
            const booted = sessionStorage.getItem('minimapBooted')
            sessionStorage.setItem('minimapBooted', '1')
            ;(window as unknown as { keptMinimap: string | null }).keptMinimap = booted
                ? localStorage.getItem(key)
                : minimap === null
                  ? null
                  : JSON.stringify(minimap)
        },
        { prefix, minimap },
    )
    await page.addInitScript(installCanvasCounters)
    // The fixture sets the key off in every load; the seed goes back over it.
    await page.addInitScript((key) => {
        const kept = (window as unknown as { keptMinimap: string | null }).keptMinimap
        if (kept === null) localStorage.removeItem(key)
        else localStorage.setItem(key, kept)
    }, `${prefix}showMinimap`)
}

const frames = (page: Page, count = 60) =>
    page.evaluate(
        (count) =>
            new Promise<void>((resolve) => {
                let left = count
                const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
                requestAnimationFrame(step)
            }),
        count,
    )

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

/** The interaction chart with one note at 120 s, so the strip's range is long. */
const longChart = (page: Page, time = 3) =>
    page.evaluate((time) => {
        const { fixtures, show } = window.editorTest
        const chart = structuredClone(fixtures.interaction)
        const far = structuredClone(chart.slides[3]![0]!)
        far.beat = 240
        chart.slides.push([far])
        show(chart, time)
    }, time)

type OpenOptions = {
    size?: { width: number; height: number }
    /** The saved choice: true or false, or null for none. */
    minimap?: boolean | null
    long?: boolean
}

const open = async (page: Page, { size, minimap = true, long = true }: OpenOptions = {}) => {
    if (size) await page.setViewportSize(size)
    await seedMinimap(page, minimap)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    if (long) await longChart(page)
    await settle(page)
}

const statsOf = (page: Page) =>
    page.evaluate(async () => {
        const { minimapStats } = await window.editorTest.appImport<
            typeof import('../../src/editor/minimap/pipeline')
        >('/src/editor/minimap/pipeline.ts')
        return { ...minimapStats }
    })

/** The strip, its range and the mapping between rows and times (design §4.2). */
const minimapStrip = (page: Page) => {
    const el = page.locator('[data-minimap]')
    const box = el.locator('[data-minimap-box]')
    const metrics = async () => {
        const rect = (await el.boundingBox())!
        const { end } = await statsOf(page)
        const ih = rect.height - 8
        return {
            rect,
            end,
            /** Seconds per CSS px. */
            row: end / ih,
            x: rect.x + rect.width / 2,
            yOf: (time: number) => rect.y + 4 + ih * (1 - Math.min(1, Math.max(0, time / end))),
            timeOf: (y: number) => end * (1 - (y - rect.y - 4) / ih),
        }
    }
    return { el, box, metrics }
}

const viewTime = (page: Page) => page.evaluate(() => window.editorTest.view.time)

const setViewTime = (page: Page, time: number) =>
    page.evaluate(async (time) => {
        window.editorTest.view.time = time
        await window.editorTest.nextTick()
    }, time)

const selectedCount = (page: Page) =>
    page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length)

const selectAll = (page: Page) =>
    page.evaluate(() => {
        const { history } = window.editorTest
        const notes = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: notes.slice(0, 2) })
    })

const toolbar = (page: Page) => page.locator('[data-editor-toolbar]')

const isPlaying = (page: Page) =>
    page.evaluate(async () => {
        const { isPlaying } =
            await window.editorTest.appImport<typeof import('../../src/player')>('/src/player.ts')
        return isPlaying.value
    })

const startPlayback = (page: Page) =>
    page.evaluate(async () => {
        const { startOrStopPlayer } =
            await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                '/src/editor/player.ts',
            )
        startOrStopPlayer()
    })

const bindKey = (page: Page, key: string) =>
    page.evaluate((key) => {
        const { settings } = window.editorTest
        settings.keyboardShortcuts = { ...settings.keyboardShortcuts, minimap: key }
    }, key)

test.describe('placement, command and setting', () => {
    test('shown by default at 1280 and hidden at 390, and the toolbar tool, a key and Settings toggle it alike', async ({
        page,
    }) => {
        await open(page, { size: { width: 1280, height: 800 }, minimap: null })
        const { el } = minimapStrip(page)
        await expect(el).toHaveCount(1)

        // The toolbar tool, in the navigation group's flyout.
        await toolbar(page).getByTitle('Jump to Start', { exact: true }).hover()
        await toolbar(page).getByTitle('Minimap', { exact: true }).click()
        await expect(el).toHaveCount(0)
        // It keeps the group's face, and the tool has no pressed state.
        await expect(toolbar(page).getByTitle('Jump to Start', { exact: true })).toHaveCount(1)

        // A bound key.
        await bindKey(page, 'l')
        await page.keyboard.press('l')
        await expect(el).toHaveCount(1)
        await page.keyboard.press('l')
        await expect(el).toHaveCount(0)

        // The Settings switch shows what is shown, and writes the same setting.
        await page.keyboard.press(',')
        const toggle = page.getByRole('switch', { name: 'Show Minimap' })
        await expect(toggle).toHaveAttribute('aria-checked', 'false')
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-checked', 'true')
        await expect(el).toHaveCount(1)
        await page.keyboard.press('Escape')

        // The choice survives a reload.
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect(el).toHaveCount(1)
        await page.evaluate(installEditorFixture)
        await page.evaluate(() => {
            window.editorTest.settings.showMinimap = false
        })
        await expect(el).toHaveCount(0)
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect(el).toHaveCount(0)
    })

    test('hidden by default at 390 wide, until turned on', async ({ page }) => {
        await open(page, { size: { width: 390, height: 844 }, minimap: null })
        const { el } = minimapStrip(page)
        await expect(el).toHaveCount(0)
        await page.evaluate(() => {
            window.editorTest.settings.showMinimap = true
        })
        await expect(el).toHaveCount(1)
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect(el).toHaveCount(1)
    })

    test('hidden, there is no strip and an edit paints nothing', async ({ page }) => {
        await open(page, { minimap: false })
        await expect(page.locator('[data-minimap]')).toHaveCount(0)
        const before = await statsOf(page)
        await selectAll(page)
        await page.keyboard.press('Delete')
        await settle(page)
        await frames(page, 10)
        const after = await statsOf(page)
        expect(after.paints).toBe(before.paints)
        expect(after.annotationPaints).toBe(before.annotationPaints)
    })

    test('with both docks open at 1280 the toolbar keeps one row and toggling the strip moves no panel', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 800 })
        await seedMinimap(page, true)
        // Undo the closed Preview and Properties the fixture seeds.
        await page.addInitScript((prefix) => {
            localStorage.removeItem(`${prefix}showPreview`)
            localStorage.removeItem(`${prefix}showSidebar`)
        }, prefix)
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await settle(page)

        const layout = () =>
            page.evaluate(() => {
                const height = (selector: string) =>
                    document.querySelector(selector)?.getBoundingClientRect().height
                const width = (selector: string) =>
                    document.querySelector(selector)?.getBoundingClientRect().width
                return {
                    toolbar: height('[data-editor-toolbar] > div'),
                    pane: width('.chart-pane'),
                    tabs: [...document.querySelectorAll('[data-workspace-dock] [role="tab"]')].map(
                        (tab) => `${tab.textContent}:${tab.getAttribute('aria-selected')}`,
                    ),
                }
            })
        await expect(page.locator('[data-minimap]')).toHaveCount(1)
        const on = await layout()
        await page.evaluate(() => {
            window.editorTest.settings.showMinimap = false
        })
        await expect(page.locator('[data-minimap]')).toHaveCount(0)
        await settle(page)
        const off = await layout()
        // The docks gave the strip's 40 px to the chart, so it keeps its width and its row.
        expect(on.tabs.length).toBeGreaterThan(1)
        expect(off.tabs).toEqual(on.tabs)
        expect(on.toolbar).toBe(off.toolbar)
        expect(Math.abs(on.pane! - off.pane!)).toBeLessThan(2)
        await page.evaluate(() => {
            window.editorTest.settings.showMinimap = true
        })
        await settle(page)
        expect(await layout()).toEqual(on)
    })
})

test.describe('mouse', () => {
    test.beforeEach(async ({ page }) => {
        await open(page, { size: { width: 1280, height: 800 } })
        await expect(minimapStrip(page).box).toBeVisible()
    })

    test('a click jumps to the row and a press during playback stops it', async ({ page }) => {
        const strip = minimapStrip(page)
        const m = await strip.metrics()
        await page.mouse.click(m.x, m.yOf(60))
        expect(Math.abs((await viewTime(page)) - 60)).toBeLessThanOrEqual(m.row)

        await startPlayback(page)
        await expect.poll(() => isPlaying(page)).toBe(true)
        await page.mouse.move(m.x, m.yOf(30))
        await page.mouse.down()
        expect(await isPlaying(page)).toBe(false)
        await page.mouse.up()
        expect(Math.abs((await viewTime(page)) - 30)).toBeLessThanOrEqual(m.row)
    })

    test('grabbing the box at time 0 does not jump, and a pixel moves the view by its time', async ({
        page,
    }) => {
        await setViewTime(page, 0)
        const strip = minimapStrip(page)
        const m = await strip.metrics()
        await expect.poll(async () => (await strip.box.boundingBox())!.y).toBeGreaterThan(m.rect.y)
        const box = (await strip.box.boundingBox())!
        // The box runs from the view's end down to time 0, so its middle is not the view's time.
        const y = box.y + box.height - 10
        await page.mouse.move(m.x, y)
        await page.mouse.down()
        expect(await viewTime(page)).toBe(0)
        await page.mouse.move(m.x, y - 1)
        expect(Math.abs((await viewTime(page)) - m.row)).toBeLessThan(m.row * 0.01)
        await page.mouse.move(m.x, y - 11)
        expect(Math.abs((await viewTime(page)) - 11 * m.row)).toBeLessThan(m.row * 0.01)
        await page.mouse.up()
        // The press is over: the view stays put.
        await page.mouse.move(m.x, y - 30)
        expect(Math.abs((await viewTime(page)) - 11 * m.row)).toBeLessThan(m.row * 0.01)
    })

    test('Escape mid-drag restores the view and keeps the selection', async ({ page }) => {
        await selectAll(page)
        expect(await selectedCount(page)).toBe(2)
        const strip = minimapStrip(page)
        const m = await strip.metrics()
        const box = (await strip.box.boundingBox())!
        await page.mouse.move(m.x, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(m.x, box.y + box.height / 2 - 60)
        expect(await viewTime(page)).not.toBeCloseTo(3, 1)
        await page.keyboard.press('Escape')
        expect(await viewTime(page)).toBe(3)
        expect(await selectedCount(page)).toBe(2)
        // The drag ended with Escape.
        await page.mouse.move(m.x, box.y + box.height / 2 - 100)
        expect(await viewTime(page)).toBe(3)
        await page.mouse.up()
        // A second Escape is the usual Deselect.
        await page.keyboard.press('Escape')
        expect(await selectedCount(page)).toBe(0)
    })

    test('leaving the app mid-drag ends the press', async ({ page }) => {
        await selectAll(page)
        const strip = minimapStrip(page)
        const m = await strip.metrics()
        const box = (await strip.box.boundingBox())!
        await page.mouse.move(m.x, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(m.x, box.y + box.height / 2 - 30)
        const dragged = await viewTime(page)
        expect(dragged).not.toBeCloseTo(3, 1)
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        // The release never arrives: the press is over all the same.
        await page.mouse.move(m.x, box.y + box.height / 2 - 60)
        expect(await viewTime(page)).toBe(dragged)
        await page.mouse.up()
        await page.keyboard.press('Escape')
        expect(await selectedCount(page)).toBe(0)
    })

    test('unmounting mid-drag leaves Escape to Deselect', async ({ page }) => {
        await bindKey(page, 'l')
        await selectAll(page)
        const strip = minimapStrip(page)
        const m = await strip.metrics()
        const box = (await strip.box.boundingBox())!
        await page.mouse.move(m.x, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(m.x, box.y + box.height / 2 - 30)
        await page.keyboard.press('l')
        await expect(strip.el).toHaveCount(0)
        await page.mouse.up()
        await page.keyboard.press('Escape')
        expect(await selectedCount(page)).toBe(0)
    })

    test('a wheel over the strip scrolls the main chart while the Elevation Editor holds the navigation', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1600, height: 1000 })
        await page.keyboard.press('t')
        const navigation = () =>
            page.evaluate(async () => {
                const { editorNavigation } = await window.editorTest.appImport<
                    typeof import('../../src/editor/navigation')
                >('/src/editor/navigation.ts')
                return editorNavigation.value !== undefined
            })
        // The pointer entering the Elevation pane gives it the navigation.
        await page.mouse.move(1300, 500)
        await expect.poll(navigation).toBe(true)
        const strip = minimapStrip(page)
        await expect(strip.el).toHaveCount(1)
        const m = await strip.metrics()
        const before = await viewTime(page)
        await page.mouse.move(m.x, m.yOf(60))
        await page.mouse.wheel(0, -200)
        await expect.poll(() => viewTime(page)).not.toBe(before)
        expect(await navigation()).toBe(false)
    })
})

test.describe('touch', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 1180, height: 820 } })

    test('a tap jumps, a slide off the box leaves the view, and a slide on the box scrubs', async ({
        page,
    }) => {
        await open(page)
        const strip = minimapStrip(page)
        await expect(strip.box).toBeVisible()
        const touch = await touchInput(page)
        const m = await strip.metrics()

        await touch('touchStart', [[m.x, m.yOf(80)]])
        await touch('touchEnd', [])
        await expect.poll(() => viewTime(page)).toBeGreaterThan(50)
        expect(Math.abs((await viewTime(page)) - 80)).toBeLessThanOrEqual(m.row)

        // A slide that starts off the box, as an edge swipe does, does nothing.
        const before = await viewTime(page)
        await touch('touchStart', [[m.x, m.yOf(20)]])
        for (const dy of [10, 20, 40, 80]) await touch('touchMove', [[m.x, m.yOf(20) - dy]])
        await touch('touchEnd', [])
        await frames(page, 3)
        expect(await viewTime(page)).toBe(before)

        // On the box it scrubs, by the distance moved.
        const box = (await strip.box.boundingBox())!
        const y = box.y + box.height / 2
        await touch('touchStart', [[m.x, y]])
        expect(await viewTime(page)).toBe(before)
        await touch('touchMove', [[m.x, y + 40]])
        await touch('touchMove', [[m.x, y + 40]])
        await touch('touchEnd', [])
        expect(Math.abs((await viewTime(page)) - (before - 40 * m.row))).toBeLessThan(m.row)
    })
})

test.describe('zero work', () => {
    test('scrolling, playback with Follow and a held note drag paint nothing', async ({ page }) => {
        await open(page, { size: { width: 1280, height: 800 } })
        await expect(minimapStrip(page).box).toBeVisible()
        await frames(page, 10)
        const counts = async () => {
            const { paints, annotationPaints } = await statsOf(page)
            return { paints, annotationPaints }
        }
        const start = await counts()

        // The wheel over the chart.
        await page.mouse.move(400, 400)
        for (let i = 0; i < 30; i++) {
            await page.mouse.wheel(0, 40)
            await frames(page, 2)
        }
        expect(await counts()).toEqual(start)

        // Playback with Follow.
        await page.evaluate(() => {
            window.editorTest.settings.playFollow = true
        })
        const time = await viewTime(page)
        await startPlayback(page)
        await expect.poll(() => isPlaying(page)).toBe(true)
        await frames(page, 60)
        expect(Math.abs((await viewTime(page)) - time)).toBeGreaterThan(0.05)
        await startPlayback(page)
        expect(await counts()).toEqual(start)

        // A Basic note held mid-drag; the edit lands at the release.
        await setViewTime(page, 3)
        const point = await page.evaluate(() => {
            const { history, point } = window.editorTest
            const note = [...history.state.value.store.slides.note.values()]
                .flat()
                .find((note) => note.beat === 5)!
            return point(note.left + note.size / 2, note.beat)
        })
        await page.mouse.move(point.x, point.y)
        await page.mouse.down()
        for (let i = 1; i <= 10; i++) await page.mouse.move(point.x + 3 * i, point.y - 3 * i)
        await frames(page, 60)
        expect(await counts()).toEqual(start)
        await page.mouse.up()
    })
})

// The peek rows need the stored entries of a session, as the History panel has.
test.describe('peek', () => {
    const session = (page: Page) =>
        page.evaluate(async () => {
            const { flusher } = await import('/src/local/storing.ts')
            return flusher?.session?.id
        })

    const newestSeq = (page: Page) =>
        page.evaluate(async () => {
            const { flusher } =
                await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                    '/src/local/storing.ts',
                )
            return flusher!.newestSeq(flusher!.session!)
        })

    const act = (page: Page, action: 'peekEntry' | 'leavePeek', seq = 0) =>
        page.evaluate(
            async ([action, seq]) => {
                const { appImport } = window.editorTest
                const [peek, { flusher }] = await Promise.all([
                    appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
                    appImport<typeof import('../../src/local/storing')>('/src/local/storing.ts'),
                ])
                if (action === 'leavePeek') peek.leavePeek()
                else await peek[action](peek.entryKey(flusher!.session!.id, seq))
            },
            [action, seq] as const,
        )

    const isPeeking = (page: Page) => page.evaluate(() => window.editorTest.history.isPeeking.value)

    /** A signature of the content canvas over the rows around a time. */
    const pixelsAround = (page: Page, time: number) =>
        page.evaluate(
            async ([time]) => {
                const { minimapStats } = await window.editorTest.appImport<
                    typeof import('../../src/editor/minimap/pipeline')
                >('/src/editor/minimap/pipeline.ts')
                const canvas = document.querySelector<HTMLCanvasElement>('[data-minimap] canvas')!
                const ctx = canvas.getContext('2d')!
                const cssHeight = canvas.clientHeight
                const scale = canvas.height / cssHeight
                const y = (4 + (cssHeight - 8) * (1 - time / minimapStats.end)) * scale
                const data = ctx.getImageData(
                    0,
                    Math.max(0, Math.floor(y - 4 * scale)),
                    canvas.width,
                    Math.ceil(8 * scale),
                ).data
                let sum = 0
                for (let i = 3; i < data.length; i += 4) sum += data[i]!
                return sum
            },
            [time] as const,
        )

    // A missed edit path throws in development (pushState while viewing history).
    const errors = new WeakMap<Page, string[]>()
    test.afterEach(({ page }) => {
        expect(errors.get(page)).toEqual([])
    })

    test.beforeEach(async ({ page }) => {
        const seen: string[] = []
        errors.set(page, seen)
        page.on('pageerror', (error) => seen.push(error.message))
        await open(page, { size: { width: 1280, height: 800 }, long: false })
        await expect(minimapStrip(page).box).toBeVisible()
        // The short chart's note is an edit away from a long one; storing follows the shown chart.
        await expect.poll(() => session(page)).toBeTruthy()
        await expect.poll(() => newestSeq(page)).toBeGreaterThan(0)
    })

    /** Adds a note at a time with the Note tool, as the user would. */
    const addNoteAt = async (page: Page, time: number) => {
        await setViewTime(page, time)
        await page.keyboard.press('a')
        const point = await page.evaluate((time) => window.editorTest.point(0, time * 2), time)
        await page.mouse.click(point.x, point.y)
        await page.keyboard.press('Escape')
        await settle(page)
    }

    test('the peeked step is shown: a note added after it is absent, and a click edits nothing', async ({
        page,
    }) => {
        const strip = minimapStrip(page)
        const first = await newestSeq(page)
        const m0 = await strip.metrics()
        await addNoteAt(page, 30)
        await expect.poll(() => newestSeq(page)).toBe(first + 1)
        const m1 = await strip.metrics()
        // Both the live and the peeked range hold the later note, so rows agree.
        expect(m1.end).toBeGreaterThanOrEqual(m0.end)
        await expect.poll(() => pixelsAround(page, 30)).toBeGreaterThan(0)
        const withNote = await pixelsAround(page, 30)

        await act(page, 'peekEntry', first)
        expect(await isPeeking(page)).toBe(true)
        await expect.poll(() => pixelsAround(page, 30)).not.toBe(withNote)
        const peeked = await pixelsAround(page, 30)

        // A click on the strip scrolls the peeked view and touches neither state.
        await page.evaluate(() => {
            const { history } = window.editorTest
            Object.assign(window, {
                shownBefore: history.state.value,
                liveBefore: history.liveState.value,
            })
        })
        const m = await strip.metrics()
        await page.mouse.click(m.x, m.yOf(10))
        expect(Math.abs((await viewTime(page)) - 10)).toBeLessThanOrEqual(m.row)
        expect(
            await page.evaluate(() => {
                const { history } = window.editorTest
                const w = window as unknown as { shownBefore: unknown; liveBefore: unknown }
                return [
                    history.state.value === w.shownBefore,
                    history.liveState.value === w.liveBefore,
                    history.isPeeking.value,
                ]
            }),
        ).toEqual([true, true, true])
        expect(await newestSeq(page)).toBe(first + 1)
        expect(await pixelsAround(page, 30)).toBe(peeked)

        await act(page, 'leavePeek')
        await expect.poll(() => pixelsAround(page, 30)).toBe(withNote)
    })

    // --- Change ticks (C): the peeked step's changed places, in the tick column.

    type Step =
        | { kind: 'move'; from: number; to: number }
        | { kind: 'slide'; beats: number[] }
        | { kind: 'bpm'; beat: number; bpm: number }

    /** Pushes one native step through the transaction, as the History specs do. */
    const pushStep = (page: Page, label: string, step: Step) =>
        page.evaluate(
            async ({ label, step }) => {
                const { appImport, history, historySteps } = window.editorTest
                const [{ createTransaction }, notes, bpm, { noteObjectOf }, { createSlideId }] =
                    await Promise.all([
                        appImport<typeof import('../../src/state/transaction')>(
                            '/src/state/transaction.ts',
                        ),
                        appImport<typeof import('../../src/state/mutations/slides/note')>(
                            '/src/state/mutations/slides/note.ts',
                        ),
                        appImport<typeof import('../../src/state/mutations/bpm')>(
                            '/src/state/mutations/bpm.ts',
                        ),
                        appImport<typeof import('../../src/local/records/extract')>(
                            '/src/local/records/extract.ts',
                        ),
                        appImport<typeof import('../../src/state/entities/slides')>(
                            '/src/state/entities/slides/index.ts',
                        ),
                    ])
                const state = history.state.value
                const transaction = createTransaction(state)
                let receipt: import('../../src/history/operations').NativeOperationInput
                if (step.kind === 'move') {
                    const note = [...state.store.slides.note.values()]
                        .flat()
                        .find((note) => note.beat === step.from)!
                    receipt = {
                        id: 'nse.object.move',
                        data: { subject: 'note', changed: { note: 1 } },
                    }
                    notes.replaceNote(transaction, note, { ...noteObjectOf(note), beat: step.to })
                } else if (step.kind === 'slide') {
                    receipt = { id: 'nse.note.add', data: { created: step.beats.length } }
                    const template = noteObjectOf([...state.store.slides.note.values()].flat()[0]!)
                    const slideId = createSlideId()
                    for (const beat of step.beats)
                        notes.addNote(transaction, slideId, { ...template, beat })
                } else {
                    receipt = {
                        id: 'nse.object.edit',
                        data: { subject: 'bpm', changed: { bpm: 1 } },
                    }
                    bpm.addBpm(transaction, { beat: step.beat, bpm: step.bpm, meter: 4 })
                }
                // An unknown extension keeps the change view to the plain shapes.
                const operation = {
                    ...historySteps.nativeOperation(receipt, label),
                    futureFixture: true,
                }
                history.pushState(operation, transaction.commit([]))
            },
            { label, step },
        )

    /** The ticks: runs of orange rows in the annotation canvas's tick column, in CSS px. */
    const tickRows = (page: Page) =>
        page.evaluate(() => {
            const canvas = document.querySelectorAll<HTMLCanvasElement>('[data-minimap] canvas')[1]
            if (!canvas) return []
            const scale = canvas.width / canvas.clientWidth
            const { data } = canvas.getContext('2d')!.getImageData(0, 0, 3, canvas.height)
            const runs: [number, number][] = []
            for (let y = 0; y < canvas.height; y++) {
                const i = y * 3 * 4
                // Orange, #ff9b42: red high, blue low.
                if (data[i + 3]! < 200 || data[i]! < 200 || data[i + 2]! > 120) continue
                const last = runs.at(-1)
                if (last && y / scale - last[1] <= 1.01) last[1] = y / scale
                else runs.push([y / scale, y / scale])
            }
            return runs
        })

    /** Whether anything is drawn outside the tick column. */
    const marksBeyondColumn = (page: Page) =>
        page.evaluate(() => {
            const canvas = document.querySelectorAll<HTMLCanvasElement>('[data-minimap] canvas')[1]
            if (!canvas) return false
            const scale = canvas.width / canvas.clientWidth
            const from = Math.ceil(3 * scale)
            const { data } = canvas
                .getContext('2d')!
                .getImageData(from, 0, canvas.width - from, canvas.height)
            return data.some((value, i) => i % 4 === 3 && value > 0)
        })

    /** Peeks a step by its row in the History panel, as the user does. */
    const peekRow = async (page: Page, title: string) => {
        const dock = page.locator('[data-workspace-dock="right"]')
        await dock.getByRole('tab', { name: 'History' }).click()
        await historyRow(page, title, 'panel').click()
        await expect.poll(() => isPeeking(page)).toBe(true)
    }

    const contentOpacity = (page: Page) =>
        page.evaluate(
            () => document.querySelector<HTMLCanvasElement>('[data-minimap] canvas')!.style.opacity,
        )

    /** The CSS row of a time on the strip. */
    const rowOf = async (page: Page, time: number) => {
        const { end } = await statsOf(page)
        const height = await page.locator('[data-minimap]').evaluate((el) => el.clientHeight)
        return 4 + (height - 8) * (1 - time / end)
    }

    const near = (runs: [number, number][], y: number) =>
        runs.some(([from, to]) => from - 2 <= y && y <= to + 2)

    test('a moved note is ticked at its old and new rows, and the strip dims while they show', async ({
        page,
    }) => {
        const first = await newestSeq(page)
        // Beat 5 is 2.5 s at the fixture's 120 BPM; beat 100 is 50 s.
        await pushStep(page, 'Moved 1 note', { kind: 'move', from: 5, to: 100 })
        await expect.poll(() => newestSeq(page)).toBe(first + 1)
        expect(await tickRows(page)).toEqual([])
        expect(await contentOpacity(page)).toBe('')

        await peekRow(page, 'Moved 1 note')
        await expect.poll(() => contentOpacity(page)).toBe('0.45')
        await expect.poll(async () => (await tickRows(page)).length).toBeGreaterThan(0)
        const runs = await tickRows(page)
        expect(near(runs, await rowOf(page, 2.5))).toBe(true)
        expect(near(runs, await rowOf(page, 50))).toBe(true)
        // Only those two places, and only in the tick column.
        expect(runs.length).toBe(2)
        expect(await marksBeyondColumn(page)).toBe(false)

        await act(page, 'leavePeek')
        await expect.poll(() => contentOpacity(page)).toBe('')
        await expect.poll(async () => (await tickRows(page)).length).toBe(0)
    })

    test('a note moved within its slide is ticked at its old and new rows', async ({ page }) => {
        const first = await newestSeq(page)
        // Beats 20 and 30 are 10 s and 15 s; the tail moves to beat 36 (18 s), near enough to pair.
        await pushStep(page, 'Added a slide', { kind: 'slide', beats: [20, 30] })
        await pushStep(page, 'Moved the tail', { kind: 'move', from: 30, to: 36 })
        await expect.poll(() => newestSeq(page)).toBe(first + 2)
        await peekRow(page, 'Moved the tail')
        await expect.poll(async () => (await tickRows(page)).length).toBeGreaterThan(0)
        const runs = await tickRows(page)
        expect(near(runs, await rowOf(page, 15))).toBe(true)
        expect(near(runs, await rowOf(page, 18))).toBe(true)
        await act(page, 'leavePeek')
    })

    test('with Show Edits off the strip has no ticks and is not dimmed', async ({ page }) => {
        const first = await newestSeq(page)
        await pushStep(page, 'Moved 1 note', { kind: 'move', from: 5, to: 100 })
        await expect.poll(() => newestSeq(page)).toBe(first + 1)
        await page.evaluate(() => {
            window.editorTest.settings.dimUnchangedObjects = false
        })
        await peekRow(page, 'Moved 1 note')
        // The change is known, and the chart marks none of it.
        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const { comparisonStatus, changeMarks } = await window.editorTest.appImport<
                        typeof import('../../src/editor/history/changes')
                    >('/src/editor/history/changes.ts')
                    return [comparisonStatus.value, changeMarks.value]
                }),
            )
            .toEqual(['known', undefined])
        await frames(page, 5)
        expect(await tickRows(page)).toEqual([])
        expect(await contentOpacity(page)).toBe('')
        await act(page, 'leavePeek')
    })

    test('a tempo change is ticked at its beat on the peeked tempo', async ({ page }) => {
        const first = await newestSeq(page)
        // A note far out gives the strip the range, which ends beyond the tempo changes.
        await pushStep(page, 'Moved far', { kind: 'move', from: 9, to: 60 })
        // 120 BPM to beat 10 (5 s), then 60 BPM: beat 20 is at 15 s, where a flat 120 BPM has 10 s.
        await pushStep(page, 'Slower', { kind: 'bpm', beat: 10, bpm: 60 })
        await pushStep(page, 'Faster', { kind: 'bpm', beat: 20, bpm: 90 })
        await expect.poll(() => newestSeq(page)).toBe(first + 3)
        await peekRow(page, 'Faster')
        await expect.poll(async () => (await tickRows(page)).length).toBeGreaterThan(0)
        const runs = await tickRows(page)
        expect(runs.length).toBe(1)
        const y = await rowOf(page, 15)
        expect(near(runs, y)).toBe(true)
        // The flat-tempo row is far enough away to tell.
        expect(Math.abs((await rowOf(page, 10)) - y)).toBeGreaterThan(4)
        await act(page, 'leavePeek')
    })

    test('Escape mid-drag keeps the peek', async ({ page }) => {
        const strip = minimapStrip(page)
        const first = await newestSeq(page)
        await addNoteAt(page, 30)
        await act(page, 'peekEntry', first)
        await setViewTime(page, 3)
        const m = await strip.metrics()
        const box = (await strip.box.boundingBox())!
        await page.mouse.move(m.x, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(m.x, box.y + box.height / 2 + 40)
        expect(await viewTime(page)).not.toBe(3)
        await page.keyboard.press('Escape')
        expect(await viewTime(page)).toBe(3)
        expect(await isPeeking(page)).toBe(true)
        await page.mouse.up()
        await act(page, 'leavePeek')
    })

    test('arrowing between entries with different ends keeps the range', async ({ page }) => {
        const strip = minimapStrip(page)
        const first = await newestSeq(page)
        await addNoteAt(page, 100)
        await expect.poll(() => newestSeq(page)).toBe(first + 1)
        const live = (await statsOf(page)).end
        await act(page, 'peekEntry', first)
        await expect.poll(async () => (await statsOf(page)).end).toBe(live)
        await act(page, 'peekEntry', first + 1)
        await frames(page, 5)
        expect((await statsOf(page)).end).toBe(live)
        await act(page, 'peekEntry', first)
        await frames(page, 5)
        expect((await statsOf(page)).end).toBe(live)
        expect(await strip.el.count()).toBe(1)
        await act(page, 'leavePeek')
    })
})
