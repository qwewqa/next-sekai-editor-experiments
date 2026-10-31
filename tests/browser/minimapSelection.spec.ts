import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { GUTTER_MARK_WIDTH } from '../../src/editor/minimap/mapping'
import { importLevelData, openEditor } from './memoryBaseline'

// The minimap's selection marks: a white lift on each selected note and a cyan rail at the right
// edge. What paints when, the gate that keeps the marks on the image the content canvas shows,
// and pixel oracles for both marks. The History peek's case is in minimap.spec.ts.

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })

const selectionCanvas = '[data-minimap-layer="selection"]'

type Chart = 'interaction' | 'notes' | 'connectors' | 'events'

const open = async (page: Page, chart: Chart = 'notes') => {
    await openEditor(page)
    await page.evaluate(async (chart) => {
        const { settings, fixtures, show, nextTick } = window.editorTest
        settings.showMinimap = true
        show(fixtures[chart], 4)
        await nextTick()
    }, chart)
    await expect(page.locator('[data-minimap] canvas').first()).toBeVisible()
    await install(page)
    await settled(page)
}

/** Records each paint counter's increments with the frame's time, and the selection canvas's hiding. */
const install = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, history, historySteps } = window.editorTest
        const [
            { minimapStats },
            { createMapping, capScale },
            { beatToTime },
            { createTransaction },
            slideNotes,
            bpm,
        ] = await Promise.all([
            appImport<typeof import('../../src/editor/minimap/pipeline')>(
                '/src/editor/minimap/pipeline.ts',
            ),
            appImport<typeof import('../../src/editor/minimap/mapping')>(
                '/src/editor/minimap/mapping.ts',
            ),
            appImport<typeof import('../../src/state/integrals/bpms')>(
                '/src/state/integrals/bpms.ts',
            ),
            appImport<typeof import('../../src/state/transaction')>('/src/state/transaction.ts'),
            appImport<typeof import('../../src/state/mutations/slides/note')>(
                '/src/state/mutations/slides/note.ts',
            ),
            appImport<typeof import('../../src/state/mutations/bpm')>(
                '/src/state/mutations/bpm.ts',
            ),
        ])
        const log: { key: string; t: number }[] = []
        const now = () => Number(document.timeline.currentTime)
        for (const key of ['paints', 'selectionPaints', 'changePaints', 'fullJobs'] as const) {
            let value = minimapStats[key]
            Object.defineProperty(minimapStats, key, {
                configurable: true,
                enumerable: true,
                get: () => value,
                set: (next: number) => {
                    value = next
                    log.push({ key, t: now() })
                },
            })
        }
        // The selection canvas's visibility as it changes, by frame.
        let shown = 'removed'
        new MutationObserver(() => {
            const canvas = document.querySelector<HTMLCanvasElement>(
                '[data-minimap-layer="selection"]',
            )
            const hidden = canvas?.style.visibility === 'hidden'
            const key = canvas ? (hidden ? 'visibility:hidden' : 'visibility:shown') : 'removed'
            if (key !== shown) log.push({ key, t: now() })
            shown = key
        }).observe(document.querySelector('[data-minimap]')!, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['style'],
        })
        const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
        const notes = () => [...history.state.value.store.slides.note.values()].flat()
        window.mmSelection = {
            minimapStats,
            log,
            frame,
            history,
            createMapping,
            capScale,
            beatToTime,
            select: (entities) => {
                history.replaceState({ ...history.state.value, selectedEntities: [...entities] })
            },
            notes,
            commit(edit) {
                const transaction = createTransaction(history.state.value)
                let selection = history.state.value.selectedEntities
                if (edit === 'moveAll')
                    selection = notes().flatMap((note) =>
                        slideNotes.replaceNote(transaction, note, {
                            ...note,
                            beat: note.beat + 0.25,
                        }),
                    )
                else if (edit === 'moveFirst') {
                    const note = notes()[0]!
                    selection = slideNotes.replaceNote(transaction, note, {
                        ...note,
                        beat: note.beat + 0.25,
                    })
                } else if (edit === 'shiftMiddle') {
                    // A note in the middle, so the range keeps its end.
                    const all = notes().sort((a, b) => a.beat - b.beat)
                    const note = all[all.length >> 1]!
                    slideNotes.replaceNote(transaction, note, { ...note, left: note.left + 1 })
                } else if (edit === 'meter') {
                    // The chart's BPM change at beat 12, with a meter of 3.
                    const change = [...window.editorTest.store.getAllEntities()].find(
                        (entity) => entity.type === 'bpm' && entity.beat === 12,
                    ) as import('../../src/state/entities/bpm').BpmEntity
                    bpm.replaceBpm(transaction, change, { beat: 12, bpm: change.bpm, meter: 3 })
                } else bpm.addBpm(transaction, { beat: edit.tempoAt, bpm: edit.bpm, meter: 4 })
                history.pushState(historySteps.noteAdd(1), transaction.commit(selection))
            },
        }
    })

/** One Timeline step: notes moved later, a note moved sideways, a meter, or a BPM change. */
type Edit = 'moveAll' | 'moveFirst' | 'shiftMiddle' | 'meter' | { tempoAt: number; bpm: number }

const commitEdit = (page: Page, edit: Edit) =>
    page.evaluate((edit) => window.mmSelection.commit(edit), edit)

declare global {
    interface Window {
        mmSelection: {
            minimapStats: (typeof import('../../src/editor/minimap/pipeline'))['minimapStats']
            log: { key: string; t: number }[]
            frame: () => Promise<number>
            history: typeof import('../../src/history')
            createMapping: (typeof import('../../src/editor/minimap/mapping'))['createMapping']
            capScale: (typeof import('../../src/editor/minimap/mapping'))['capScale']
            beatToTime: (typeof import('../../src/state/integrals/bpms'))['beatToTime']
            select: (entities: readonly import('../../src/state/entities').Entity[]) => void
            notes: () => import('../../src/state/entities/slides/note').NoteEntity[]
            commit: (edit: Edit) => void
        }
        /** The context-loss test's canvases and steps. */
        mmLoss: {
            created: HTMLCanvasElement[]
            canvas: (name: 'front' | 'back') => HTMLCanvasElement
            lose: (name: 'front' | 'back') => void
            restore: (name: 'front' | 'back') => void
            edit: () => void
            stopped: (count: number) => Promise<{ hidden: boolean; idle: boolean }>
        }
    }
}

/**
 * Until no counter has changed for 15 frames and 250 ms: the pipeline and the layers are idle. A
 * running full redraw counts a slice each frame, and the 100 ms resize debounce is shorter.
 */
const settled = (page: Page) =>
    page.evaluate(async () => {
        const { minimapStats, frame } = window.mmSelection
        const signature = () => JSON.stringify(minimapStats)
        let last = signature()
        let quiet = 0
        let since = performance.now()
        for (let i = 0; i < 1200; i++) {
            await frame()
            const next = signature()
            if (next !== last) {
                last = next
                quiet = 0
                since = performance.now()
            } else if (++quiet >= 15 && performance.now() - since >= 250) return
        }
        throw new Error('The minimap never settled')
    })

/** Every note entity, anchors included: what selecting the whole chart gives the strip. */
const selectAll = (page: Page) =>
    page.evaluate(() => window.mmSelection.select(window.mmSelection.notes()))

const counts = (page: Page) =>
    page.evaluate(() => {
        const { paints, selectionPaints, changePaints, passes, fullJobs } =
            window.mmSelection.minimapStats
        return { paints, selectionPaints, changePaints, passes, fullJobs }
    })

/** The log from here on. */
const mark = (page: Page) => page.evaluate(() => window.mmSelection.log.length)
const logSince = (page: Page, from: number) =>
    page.evaluate((from) => window.mmSelection.log.slice(from), from)

type Entry = { key: string; t: number }

/**
 * The gate's check: every selection paint lands in a frame the content painted in, and none comes
 * before the content's first paint.
 */
const expectOnContentFrames = (entries: Entry[], label: string) => {
    const content = entries.filter((entry) => entry.key === 'paints').map((entry) => entry.t)
    const selection = entries.filter((entry) => entry.key === 'selectionPaints')
    expect(content.length, label).toBeGreaterThan(0)
    for (const { t } of selection) expect(content, label).toContain(t)
    expect(Math.min(...selection.map((entry) => entry.t)), label).toBeGreaterThanOrEqual(
        Math.min(...content),
    )
}

const selectionVisible = (page: Page) =>
    page
        .locator(selectionCanvas)
        .evaluate((canvas: HTMLCanvasElement) => canvas.style.visibility !== 'hidden')

/** Reads the strip's canvases and the mapping their pixels are drawn on. */
const readStrip = (page: Page) =>
    page.evaluate(() => {
        const { minimapStats, createMapping, capScale, beatToTime, history } = window.mmSelection
        const strip = document.querySelector<HTMLElement>('[data-minimap]')!
        const content = strip.querySelector<HTMLCanvasElement>('canvas')!
        const selection = strip.querySelector<HTMLCanvasElement>('[data-minimap-layer="selection"]')
        const width = strip.clientWidth
        const height = strip.clientHeight
        const scale = capScale(window.devicePixelRatio, height)
        const mapping = createMapping({ width, height, scale }, minimapStats.end)
        const { bpms, selectedEntities } = history.state.value
        const read = (canvas: HTMLCanvasElement) =>
            Array.from(
                canvas
                    .getContext('2d', { willReadFrequently: true })!
                    .getImageData(0, 0, canvas.width, canvas.height).data,
            )
        // Rows of the rail's marked objects, as a plain list.
        const marked = selectedEntities.filter(
            (entity) => entity.type !== 'connector' && !entity.type.endsWith('EventConnection'),
        )
        return {
            width,
            scale,
            backing: { width: content.width, height: content.height },
            rows: marked.map((entity) => mapping.timeToY(beatToTime(bpms, entity.beat))),
            content: read(content),
            selection: selection ? read(selection) : undefined,
        }
    })

/** The rail's expected device rows: a plain sort and merge, then the rects' union by row. */
const expectedRail = (rows: number[], scale: number, backingHeight: number) => {
    const sorted = [...rows].sort((a, b) => a - b)
    const runs: { lo: number; hi: number }[] = []
    for (const y of sorted) {
        const last = runs.at(-1)
        if (last && y - last.hi <= 2 / scale) last.hi = y
        else runs.push({ lo: y, hi: y })
    }
    const coverage = new Array<number>(backingHeight).fill(0)
    for (const { lo, hi } of runs) {
        const h = Math.max(hi - lo, 3)
        const top = ((lo + hi - h) / 2) * scale
        const bottom = top + h * scale
        for (let row = Math.floor(top); row < Math.ceil(bottom); row++)
            coverage[row] = Math.max(
                coverage[row] ?? 0,
                Math.min(row + 1, bottom) - Math.max(row, top),
            )
    }
    return coverage
}

const isCyan = (data: number[], i: number) =>
    (data[i + 3] ?? 0) >= 128 && (data[i] ?? 0) < 160 && (data[i + 1] ?? 0) > 180

const isWhite = (data: number[], i: number) =>
    (data[i + 3] ?? 0) >= 100 &&
    (data[i] ?? 0) >= 250 &&
    (data[i + 1] ?? 0) >= 250 &&
    (data[i + 2] ?? 0) >= 250

/** Compares the rail column with the oracle; boundary rows may go either way. */
const expectRail = async (page: Page, label: string) => {
    const strip = await readStrip(page)
    expect(strip.selection, label).toBeDefined()
    const data = strip.selection!
    const { width: backingWidth, height: backingHeight } = strip.backing
    const coverage = expectedRail(strip.rows, strip.scale, backingHeight)
    // The rail's middle column, 2.5 px in from the right edge.
    const column = Math.floor((strip.width - 2.5) * strip.scale)
    let wrong = 0
    let on = 0
    for (let row = 0; row < backingHeight; row++) {
        const cyan = isCyan(data, (row * backingWidth + column) * 4)
        const expected = coverage[row] ?? 0
        if (cyan) on++
        if (expected > 0.8 && !cyan) wrong++
        if (expected < 0.2 && cyan) wrong++
    }
    expect(wrong, label).toBe(0)
    expect(on, label).toBeGreaterThan(0)
    // The rail is flush with the strip's right edge, as the ticks are with its left.
    const outer = backingWidth - 1
    let ragged = 0
    for (let row = 0; row < backingHeight; row++)
        if (
            isCyan(data, (row * backingWidth + outer) * 4) !==
            isCyan(data, (row * backingWidth + column) * 4)
        )
            ragged++
    expect(ragged, label).toBe(0)
    return strip
}

/** Every white pixel of the lift sits on a drawn note of the content canvas. */
const expectLiftOnNotes = (strip: Awaited<ReturnType<typeof readStrip>>, label: string) => {
    const data = strip.selection!
    const railStart = Math.floor((strip.width - GUTTER_MARK_WIDTH) * strip.scale)
    let white = 0
    let offNotes = 0
    for (let i = 0; i < data.length; i += 4) {
        if ((i / 4) % strip.backing.width >= railStart || !isWhite(data, i)) continue
        white++
        const content = strip.content
        const drawn = (content[i + 3] ?? 0) > 0
        const plainWhite =
            (content[i] ?? 0) === 255 &&
            (content[i + 1] ?? 0) === 255 &&
            (content[i + 2] ?? 0) === 255
        if (!drawn || plainWhite) offNotes++
    }
    expect(offNotes, label).toBe(0)
    return white
}

test.describe('what paints', () => {
    test('a selection change paints once and nothing else; select all once; an unrelated state change and deselecting paint nothing', async ({
        page,
    }) => {
        await open(page)
        await expect(page.locator(selectionCanvas)).toHaveCount(0)
        let before = await counts(page)
        await page.evaluate(() => window.mmSelection.select(window.mmSelection.notes().slice(0, 1)))
        await settled(page)
        let after = await counts(page)
        expect(after.selectionPaints - before.selectionPaints).toBe(1)
        expect([after.paints, after.passes, after.changePaints]).toEqual([
            before.paints,
            before.passes,
            before.changePaints,
        ])
        await expect(page.locator(selectionCanvas)).toHaveCount(1)

        before = after
        await selectAll(page)
        await settled(page)
        after = await counts(page)
        expect(after.selectionPaints - before.selectionPaints).toBe(1)
        expect(after.paints).toBe(before.paints)

        // A state change beside the selection, as a BGM load makes.
        before = after
        await page.evaluate(() => {
            const { history } = window.mmSelection
            history.replaceState({ ...history.state.value, bgm: { offset: 0.5 } })
        })
        await settled(page)
        expect(await counts(page)).toEqual(before)

        // Deselect: the canvas goes, and nothing paints.
        await page.evaluate(() => window.mmSelection.select([]))
        await settled(page)
        await expect(page.locator(selectionCanvas)).toHaveCount(0)
        after = await counts(page)
        expect(after.selectionPaints).toBe(before.selectionPaints)
    })

    test('a box drag paints between once and once per frame, and no ticks', async ({ page }) => {
        await open(page)
        // From the empty space between two rows of notes, over two rows.
        const from = await page.evaluate(() => window.editorTest.point(-1, 3.2))
        const to = await page.evaluate(() => window.editorTest.point(11, 8))
        const before = await counts(page)
        const start = await page.evaluate(() => {
            const record = { frames: 0, on: true }
            const loop = () => {
                if (!record.on) return
                record.frames++
                requestAnimationFrame(loop)
            }
            requestAnimationFrame(loop)
            ;(window as unknown as { boxFrames: typeof record }).boxFrames = record
            return window.mmSelection.minimapStats.selectionPaints
        })
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= 20; i++) {
            await page.mouse.move(
                from.x + ((to.x - from.x) * i) / 20,
                from.y + ((to.y - from.y) * i) / 20,
            )
            await page.evaluate(() => window.mmSelection.frame())
        }
        await page.mouse.up()
        await settled(page)
        const frames = await page.evaluate(() => {
            const record = (window as unknown as { boxFrames: { frames: number; on: boolean } })
                .boxFrames
            record.on = false
            return record.frames
        })
        const after = await counts(page)
        expect(
            await page.evaluate(
                () => window.editorTest.history.state.value.selectedEntities.length,
            ),
        ).toBeGreaterThan(3)
        const paints = after.selectionPaints - start
        expect(paints).toBeGreaterThanOrEqual(1)
        expect(paints).toBeLessThanOrEqual(frames)
        expect(after.changePaints).toBe(before.changePaints)
        expect(after.paints).toBe(before.paints)
    })
})

test.describe('the gate', () => {
    test('an Undo of a select-all move paints the marks in the band frame, not before', async ({
        page,
    }) => {
        await open(page)
        await selectAll(page)
        await settled(page)
        // Move every note a quarter beat later in one step, then Undo it.
        await commitEdit(page, 'moveAll')
        await settled(page)
        const from = await mark(page)
        await page.evaluate(() => window.mmSelection.history.undoState())
        await settled(page)
        const entries = await logSince(page, from)
        expectOnContentFrames(entries, 'undo')
        expect(entries.filter((entry) => entry.key === 'selectionPaints')).toHaveLength(1)
        await expectRail(page, 'after the Undo')
    })

    test('a tempo change paints the marks once, at the full redraw’s swap', async ({ page }) => {
        await open(page)
        await selectAll(page)
        await settled(page)
        const from = await mark(page)
        await commitEdit(page, { tempoAt: 6, bpm: 60 })
        await settled(page)
        const entries = await logSince(page, from)
        expect(entries.some((entry) => entry.key === 'fullJobs')).toBe(true)
        expectOnContentFrames(entries, 'tempo')
        expect(entries.filter((entry) => entry.key === 'selectionPaints')).toHaveLength(1)
        await expectRail(page, 'after the tempo change')
    })

    for (const layout of ['basic', 'composed'] as const) {
        test(`a meter change in ${layout} paints once, and a selection after it once`, async ({
            page,
        }) => {
            await open(page, 'events')
            await page.evaluate(async (layout) => {
                window.editorTest.view.layout = layout
                await window.editorTest.nextTick()
            }, layout)
            await page.evaluate(() => window.mmSelection.select(window.mmSelection.notes()))
            await settled(page)
            const from = await mark(page)
            await commitEdit(page, 'meter')
            await settled(page)
            const entries = await logSince(page, from)
            expect(entries.filter((entry) => entry.key === 'selectionPaints')).toHaveLength(1)
            // Basic keeps the image: the tempo is the same. Composed redraws and paints at the swap.
            expect(entries.some((entry) => entry.key === 'fullJobs')).toBe(layout === 'composed')
            if (layout === 'composed') expectOnContentFrames(entries, 'meter')
            const next = await mark(page)
            await page.evaluate(() =>
                window.mmSelection.select(window.mmSelection.notes().slice(0, 1)),
            )
            await settled(page)
            const after = await logSince(page, next)
            expect(after.filter((entry) => entry.key === 'selectionPaints')).toHaveLength(1)
            expect(after.filter((entry) => entry.key === 'paints')).toHaveLength(0)
        })
    }

    test('Basic to Composed on a dynamic-stage chart paints the marks at the swap', async ({
        page,
    }) => {
        await open(page, 'events')
        await page.evaluate(() => window.mmSelection.select(window.mmSelection.notes()))
        await settled(page)
        const from = await mark(page)
        await page.evaluate(async () => {
            window.editorTest.view.layout = 'composed'
            await window.editorTest.nextTick()
        })
        await settled(page)
        const entries = await logSince(page, from)
        expect(entries.some((entry) => entry.key === 'fullJobs')).toBe(true)
        expectOnContentFrames(entries, 'layout')
        expect(entries.filter((entry) => entry.key === 'selectionPaints')).toHaveLength(1)
        expect(expectLiftOnNotes(await expectRail(page, 'composed'), 'composed')).toBeGreaterThan(0)
    })

    test('a resize from 160 to 24 px stretches the marks with the content, then paints once at the swap', async ({
        page,
    }) => {
        await open(page)
        await page.evaluate(() => {
            window.editorTest.settings.minimapWidth = 160
        })
        await settled(page)
        await selectAll(page)
        await settled(page)
        const before = await page
            .locator(selectionCanvas)
            .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])
        const from = await mark(page)
        // Frame by frame: the backing size and the paint count, until the content swaps.
        const frames = await page.evaluate(async () => {
            const { frame, minimapStats } = window.mmSelection
            const canvas = () =>
                document.querySelector<HTMLCanvasElement>('[data-minimap-layer="selection"]')!
            const start = minimapStats.paints
            window.editorTest.settings.minimapWidth = 24
            const seen: { width: number; selectionPaints: number; paints: number }[] = []
            for (let i = 0; i < 600 && minimapStats.paints === start; i++) {
                await frame()
                seen.push({
                    width: canvas().width,
                    selectionPaints: minimapStats.selectionPaints,
                    paints: minimapStats.paints,
                })
            }
            return seen
        })
        await settled(page)
        // Before the swap the canvas keeps its size and its marks.
        const waiting = frames.filter((frame) => frame.paints === frames[0]!.paints)
        expect(waiting.length).toBeGreaterThanOrEqual(1)
        for (const frame of waiting) {
            expect(frame.width).toBe(before[0])
            expect(frame.selectionPaints).toBe(waiting[0]!.selectionPaints)
        }
        const entries = await logSince(page, from)
        expectOnContentFrames(entries, 'resize')
        expect(entries.filter((entry) => entry.key === 'selectionPaints')).toHaveLength(1)
        expect(entries.some((entry) => entry.key === 'visibility:hidden')).toBe(false)
        await expectRail(page, 'at 24 px')
    })

    test('an Undo during a full redraw hides the marks from the stale swap until the band that catches up', async ({
        page,
    }) => {
        test.setTimeout(120_000)
        await openEditor(page)
        await page.evaluate(() => {
            window.editorTest.settings.showMinimap = true
        })
        await importLevelData(
            page,
            'generated-large.json',
            readFileSync('tests/fixtures/generated-large.json'),
        )
        await install(page)
        await settled(page)
        await selectAll(page)
        await settled(page)
        // An edit to Undo.
        await commitEdit(page, 'shiftMiddle')
        await settled(page)
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        const from = await mark(page)
        // A width change starts a full redraw; the Undo lands while it runs, so it swaps stale.
        const undone = await page.evaluate(async () => {
            const { frame, minimapStats, history } = window.mmSelection
            const jobs = minimapStats.fullJobs
            const paints = minimapStats.paints
            window.editorTest.settings.minimapWidth = 80
            for (let i = 0; i < 600 && minimapStats.fullJobs === jobs; i++) await frame()
            if (minimapStats.paints !== paints) return false
            history.undoState()
            return true
        })
        await settled(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        expect(undone).toBe(true)
        const entries = await logSince(page, from)
        const paints = entries.filter((entry) => entry.key === 'paints')
        // The stale swap, then the band.
        expect(paints.length).toBeGreaterThanOrEqual(2)
        const swap = paints[0]!.t
        const band = paints[1]!.t
        const hidden = entries.find((entry) => entry.key === 'visibility:hidden')
        expect(hidden?.t).toBe(swap)
        const shown = entries.find((entry) => entry.key === 'visibility:shown' && entry.t > swap)
        expect(shown?.t).toBe(band)
        const selection = entries.filter((entry) => entry.key === 'selectionPaints')
        expect(selection.map((entry) => entry.t)).toEqual([band])
        expect(await selectionVisible(page)).toBe(true)
    })
})

test.describe('what is marked', () => {
    test('the rail matches a plain merge of the selected rows, and the lift covers only drawn notes', async ({
        page,
    }) => {
        await open(page)
        // Every note type, fakes and anchors included.
        await selectAll(page)
        await settled(page)
        const strip = await expectRail(page, 'all notes')
        expect(expectLiftOnNotes(strip, 'all notes')).toBeGreaterThan(50)
        // One note: one rail run and its own lift.
        await page.evaluate(() => {
            const { select, notes } = window.mmSelection
            select(
                notes()
                    .filter((note) => note.noteType === 'default')
                    .slice(0, 1),
            )
        })
        await settled(page)
        const one = await expectRail(page, 'one note')
        expect(expectLiftOnNotes(one, 'one note')).toBeGreaterThan(0)
    })

    for (const kind of ['bpm', 'anchor', 'event joint'] as const) {
        test(`a lone ${kind} gives a rail run and no white`, async ({ page }) => {
            await open(page, kind === 'anchor' ? 'notes' : 'events')
            await page.evaluate((kind) => {
                const { select, notes } = window.mmSelection
                const all = [...window.editorTest.store.getAllEntities()]
                const entity =
                    kind === 'anchor'
                        ? notes().find((note) => note.noteType === 'anchor')
                        : kind === 'bpm'
                          ? all.find((entity) => entity.type === 'bpm' && entity.beat > 0)
                          : all.find((entity) => entity.type === 'stagePivotEventJoint')
                select([entity!])
            }, kind)
            await settled(page)
            const strip = await expectRail(page, kind)
            expect(expectLiftOnNotes(strip, kind)).toBe(0)
        })
    }
})

test.describe('lifetime', () => {
    test('unmounting with a frame pending paints nothing after, and frees the canvas', async ({
        page,
    }) => {
        await open(page)
        const result = await page.evaluate(async () => {
            const { select, notes, minimapStats, frame } = window.mmSelection
            const { settings, nextTick } = window.editorTest
            select(notes().slice(0, 2))
            await nextTick()
            const canvas = document.querySelector<HTMLCanvasElement>(
                '[data-minimap-layer="selection"]',
            )
            const paints = minimapStats.selectionPaints
            // The paint waits for the next frame; the strip goes first.
            settings.showMinimap = false
            await nextTick()
            select(notes().slice(0, 3))
            for (let i = 0; i < 10; i++) await frame()
            return {
                mounted: !!canvas,
                paints: minimapStats.selectionPaints - paints,
                size: canvas && [canvas.width, canvas.height],
            }
        })
        expect(result).toEqual({ mounted: true, paints: 0, size: [0, 0] })
    })

    test('while a content canvas is lost, edits draw and publish nothing and the marks stay hidden, until every lost canvas is back', async ({
        page,
    }) => {
        // Its frame waits outlast the default timeout under a full suite's load.
        test.slow()
        await open(page)
        // The strip again, with its back buffer recorded: the pipeline makes it off the page.
        await page.evaluate(async () => {
            const { settings, nextTick } = window.editorTest
            const created: HTMLCanvasElement[] = []
            const make = document.createElement.bind(document)
            document.createElement = ((tag: string, options?: ElementCreationOptions) => {
                const element = make(tag, options)
                if (element instanceof HTMLCanvasElement) created.push(element)
                return element
            }) as typeof document.createElement
            settings.showMinimap = false
            await nextTick()
            settings.showMinimap = true
            await nextTick()
            document.createElement = make
            window.mmLoss = { created } as unknown as Window['mmLoss']
        })
        await install(page)
        await settled(page)
        await selectAll(page)
        await settled(page)
        const found = await page.evaluate(() => {
            const { frame, minimapStats, commit } = window.mmSelection
            const front = document.querySelector<HTMLCanvasElement>('[data-minimap] canvas')!
            const back = window.mmLoss.created.find(
                (canvas) =>
                    !canvas.isConnected &&
                    canvas.width === front.width &&
                    canvas.height === front.height,
            )
            let beat = 6
            window.mmLoss = {
                created: window.mmLoss.created,
                canvas: (name) => (name === 'front' ? front : back!),
                lose(name) {
                    const canvas = this.canvas(name)
                    canvas.dispatchEvent(new Event('contextlost'))
                    // Its pixels are gone.
                    const { width } = canvas
                    canvas.width = 0
                    canvas.width = width
                },
                restore(name) {
                    this.canvas(name).dispatchEvent(new Event('contextrestored'))
                },
                edit() {
                    commit('moveFirst')
                    commit({ tempoAt: (beat += 0.5), bpm: 90 })
                },
                async stopped(count) {
                    const work = () =>
                        [
                            minimapStats.passes,
                            minimapStats.slices,
                            minimapStats.paints,
                            minimapStats.fullJobs,
                            minimapStats.selectionPaints,
                        ].join()
                    const start = work()
                    let hidden = true
                    for (let i = 0; i < count; i++) {
                        await frame()
                        const selection = document.querySelector<HTMLCanvasElement>(
                            '[data-minimap-layer="selection"]',
                        )
                        hidden &&= selection?.style.visibility === 'hidden'
                    }
                    return { hidden, idle: work() === start }
                },
            }
            return !!back
        })
        expect(found).toBe(true)
        /** Restores a canvas, then checks a redraw followed and the marks show again. */
        const restore = async (name: 'front' | 'back', label: string) => {
            // Read in the same task as the restore, before its redraw can start.
            const jobs = await page.evaluate((name) => {
                const { fullJobs } = window.mmSelection.minimapStats
                window.mmLoss.restore(name)
                return fullJobs
            }, name)
            await settled(page)
            expect(await selectionVisible(page), label).toBe(true)
            expect((await counts(page)).fullJobs, label).toBeGreaterThan(jobs)
            await expectRail(page, label)
        }

        // The front lost while a full redraw runs: the redraw must not go on to swap or publish.
        const running = await page.evaluate(async () => {
            const { frame, minimapStats } = window.mmSelection
            const jobs = minimapStats.fullJobs
            const paints = minimapStats.paints
            window.editorTest.settings.minimapWidth = 80
            for (let i = 0; i < 600 && minimapStats.fullJobs === jobs; i++) await frame()
            const started = minimapStats.fullJobs > jobs && minimapStats.paints === paints
            window.mmLoss.lose('front')
            return { started, ...(await window.mmLoss.stopped(30)) }
        })
        expect(running).toEqual({ started: true, hidden: true, idle: true })
        await restore('front', 'front restored after a running redraw')

        // The front lost, with a note and a tempo edit while it is.
        expect(
            await page.evaluate(() => {
                window.mmLoss.lose('front')
                window.mmLoss.edit()
                return window.mmLoss.stopped(30)
            }),
        ).toEqual({ hidden: true, idle: true })
        await restore('front', 'front restored')

        // The back buffer lost, then the front too; one restored is not enough.
        expect(
            await page.evaluate(() => {
                window.mmLoss.lose('back')
                window.mmLoss.edit()
                return window.mmLoss.stopped(20)
            }),
        ).toEqual({ hidden: true, idle: true })
        expect(
            await page.evaluate(() => {
                window.mmLoss.lose('front')
                window.mmLoss.restore('back')
                window.mmLoss.edit()
                return window.mmLoss.stopped(20)
            }),
        ).toEqual({ hidden: true, idle: true })
        await restore('front', 'both restored')
    })

    test("unmounting removes the layer canvas's context listeners, so a late restore schedules nothing", async ({
        page,
    }) => {
        await open(page)
        await selectAll(page)
        await settled(page)
        const requests = await page.evaluate(async () => {
            const { settings, nextTick } = window.editorTest
            const canvas = document.querySelector<HTMLCanvasElement>(
                '[data-minimap-layer="selection"]',
            )!
            settings.showMinimap = false
            await nextTick()
            // The listener would run inside the dispatch: count the frames it asks for there.
            let count = 0
            const request = window.requestAnimationFrame
            window.requestAnimationFrame = (callback) => {
                count++
                return request.call(window, callback)
            }
            canvas.dispatchEvent(new Event('contextrestored'))
            window.requestAnimationFrame = request
            return count
        })
        expect(requests).toBe(0)
    })

    test('a content context restore with nothing else changed shows the marks again without a paint', async ({
        page,
    }) => {
        await open(page)
        await selectAll(page)
        await settled(page)
        const before = await counts(page)
        const from = await mark(page)
        await page.evaluate(() => {
            const content = document.querySelector<HTMLCanvasElement>('[data-minimap] canvas')!
            content.dispatchEvent(new Event('contextlost'))
            content.dispatchEvent(new Event('contextrestored'))
        })
        await settled(page)
        const entries = await logSince(page, from)
        expect(entries.some((entry) => entry.key === 'visibility:hidden')).toBe(true)
        expect(await selectionVisible(page)).toBe(true)
        const after = await counts(page)
        expect(after.fullJobs).toBeGreaterThan(before.fullJobs)
        expect(after.selectionPaints).toBe(before.selectionPaints)
        await expectRail(page, 'after the restore')
    })

    test('a context restore on the selection canvas paints once at the next aligned frame', async ({
        page,
    }) => {
        await open(page)
        await selectAll(page)
        await settled(page)
        const before = await counts(page)
        await page.locator(selectionCanvas).evaluate((canvas: HTMLCanvasElement) => {
            canvas.dispatchEvent(new Event('contextlost'))
            // The lost context's pixels are gone.
            const { width } = canvas
            canvas.width = 0
            canvas.width = width
            canvas.dispatchEvent(new Event('contextrestored'))
        })
        await settled(page)
        const after = await counts(page)
        expect(after.selectionPaints - before.selectionPaints).toBe(1)
        expect(after.paints).toBe(before.paints)
        expect(await selectionVisible(page)).toBe(true)
        await expectRail(page, 'after its own restore')
    })
})
