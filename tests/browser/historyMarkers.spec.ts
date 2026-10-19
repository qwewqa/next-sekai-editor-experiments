import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { installEditorFixture, waitForStartup } from './editorFixture'

const shots =
    process.env.NSE_HISTORY_SHOTS_DIR ?? 'D:/sonolus/nse-next/work/validation/history-shots'
const boot = async (page: Page) => {
    await page.addInitScript(() => {
        performance.setResourceTimingBufferSize(5000)
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        localStorage.setItem('nse.test.storage', '{}')
    })
    await page.goto('/')
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
    const noticeClose = page.locator('[data-notice-close]').first()
    if (await noticeClose.isVisible()) await noticeClose.click()
}
const previewLatest = async (page: Page) => {
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const [{ flusher }, { storageWorker }, { requestPeek, keyOf }] = await Promise.all([
            appImport<typeof import('../../src/local/storing')>('/src/local/storing.ts'),
            appImport<typeof import('../../src/local/start')>('/src/local/start.ts'),
            appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
        ])
        await flusher!.flush({ strict: true })
        const sessionId = flusher!.session!.id
        const seq = flusher!.newestSeq(flusher!.session!)
        const entry = (await storageWorker!.call('readEntry', { sessionId, seq }))!
        const metadata = (
            await storageWorker!.call('readTimeline', { sessionId, before: seq + 1, limit: 1 })
        ).entries[0]!
        requestPeek({
            key: keyOf({ sessionId, seq }),
            time: new Date(2024, 8, 13, 16, 35).getTime(),
            recipe: (
                await appImport<typeof import('../../src/history/operationPresentation')>(
                    '/src/history/operationPresentation/index.ts',
                )
            ).captureOperationRecipe([{ description: metadata, time: entry.time }]),
            snapshot: entry.snapshot,
        })
    })
    await expect(page.locator('[data-peek-change]')).not.toHaveText('')
}
const seedNotes = async (page: Page) => {
    await page.evaluate(async () => {
        const { history, fixtures, appImport, view, settings } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const chart = structuredClone(fixtures.notes)
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Notes',
            ),
            createState(chart, 0),
        )
        const after = structuredClone(chart)
        after.slides = after.slides.map((slide, i) =>
            i % 4 === 0
                ? []
                : slide.map((note) => ({
                      ...note,
                      left: note.left + (i % 2 ? 1 : 0),
                      isCritical: !note.isCritical,
                  })),
        )
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Changed note shapes',
            ),
            createState(after, 0),
        )
        view.time = 3
        settings.dimUnchangedObjects = true
    })
    await previewLatest(page)
}

test('removed events preserve every native kind and group/stage visibility', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const { fixtures, history, appImport } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const before = structuredClone(fixtures.events)
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Events',
            ),
            createState(before, 0),
        )
        const after = {
            ...before,
            bpms: before.bpms.slice(0, 1),
            timeScales: [],
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
        }
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Removed events',
            ),
            createState(after, 0),
        )
    })
    await previewLatest(page)
    const result = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const [{ changeMarks }, { drawChangeMarks }, { createScopeLookup, entityScopeVisibility }] =
            await Promise.all([
                appImport<typeof import('../../src/editor/history/changes')>(
                    '/src/editor/history/changes.ts',
                ),
                appImport<typeof import('../../src/editor/canvas/changes')>(
                    '/src/editor/canvas/changes.ts',
                ),
                appImport<typeof import('../../src/editor/scopeRules')>(
                    '/src/editor/scopeRules.ts',
                ),
            ])
        const marks = changeMarks.value!
        const scope = createScopeLookup({
            isDynamicStages: true,
            stageVisibility: new Map([[1 as never, 'hidden']]),
            groupVisibility: new Map([
                [1 as never, 'hidden'],
                [2 as never, 'hidden'],
            ]),
        })
        const drawn: string[] = []
        const context = {
            state: marks.ghostState!,
            scale: 40,
            ups: 2,
            bounds: { l: -10, r: 10, t: -50, b: 50 },
            ctx: new Proxy({}, { get: () => () => {} }),
        } as Parameters<typeof drawChangeMarks>[0]
        drawChangeMarks(
            context,
            marks,
            0,
            100,
            (entity) => entityScopeVisibility(entity, scope) !== 'hidden',
            (_context, entity) => drawn.push(entity.type),
        )
        return { types: [...new Set(marks.ghosts.map(({ entity }) => entity.type))].sort(), drawn }
    })
    expect(result.types).toEqual([
        'bpm',
        'cameraEventJoint',
        'stageMaskEventJoint',
        'stagePivotEventJoint',
        'stageStyleEventJoint',
        'stageTransformEventJoint',
        'timeScale',
    ])
    expect(result.drawn.every((type) => type === 'bpm' || type === 'cameraEventJoint')).toBe(true)
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: `${shots}/removed-events.png` })
})

const cases = [
    { name: 'desktop', width: 1440, height: 900, touch: false },
    { name: 'hybrid', width: 1440, height: 900, touch: true },
    { name: 'tablet-landscape', width: 1024, height: 768, touch: true },
    { name: 'tablet-portrait', width: 820, height: 1180, touch: true },
    { name: 'phone', width: 390, height: 844, touch: true },
    { name: 'phone-small', width: 320, height: 568, touch: true },
    { name: 'phone-landscape', width: 844, height: 390, touch: true },
    { name: 'phone-short', width: 667, height: 375, touch: true },
]
for (const size of cases)
    test.describe(size.name, () => {
        test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch })
        test('bars and marker shapes stay usable across pane sizes, locales and sheets', async ({
            page,
        }) => {
            await boot(page)
            await seedNotes(page)
            await mkdir(shots, { recursive: true })
            const layouts: unknown[] = []
            for (const locale of ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht'] as const) {
                await page.evaluate((locale) => {
                    window.editorTest.settings.locale = locale
                }, locale)
                const buttons = page.locator('[data-peek-bar] button')
                await expect(buttons).toHaveCount(6)
                // The visual boxes, and the hits the buttons keep past them through ::before:
                // faces 36 px tall with 44 px hits, the change controls 24 px with 32 px hits.
                const boxes = await buttons.evaluateAll((elements) => {
                    const rects = elements.map((element) => element.getBoundingClientRect())
                    // The topmost element at a point is the button, or it is not.
                    const hits = (element: Element, x: number, y: number) =>
                        document.elementFromPoint(x, y)?.closest('button') === element
                    return elements.map((element, index) => {
                        const box = rects[index]!
                        const midX = box.x + box.width / 2
                        const midY = box.y + box.height / 2
                        // Neighbouring hits meet in the gaps, so a side is probed only where
                        // no other button on the row lies within 8 px of it.
                        const clear = (side: 'left' | 'right') =>
                            rects.every(
                                (other, otherIndex) =>
                                    otherIndex === index ||
                                    other.bottom <= box.top ||
                                    other.top >= box.bottom ||
                                    (side === 'left'
                                        ? other.right <= box.left - 8 || other.left >= box.right
                                        : other.left >= box.right + 8 || other.right <= box.left),
                            )
                        return {
                            x: box.x,
                            y: box.y,
                            w: box.width,
                            h: box.height,
                            secondary: !!element.closest('[data-peek-navigation]'),
                            name: element.getAttribute('aria-label') || element.textContent,
                            // Just inside each hit edge, and just past the vertical ones.
                            hitTop: hits(element, midX, box.top - 3),
                            hitBottom: hits(element, midX, box.bottom + 3),
                            pastTop: hits(element, midX, box.top - 5),
                            pastBottom: hits(element, midX, box.bottom + 5),
                            hitLeft: clear('left') ? hits(element, box.left - 3, midY) : true,
                            hitRight: clear('right') ? hits(element, box.right + 3, midY) : true,
                        }
                    })
                })
                for (const box of boxes) {
                    const name = String(box.name)
                    expect(box.w, name).toBeGreaterThanOrEqual(box.secondary ? 24 : 36)
                    expect(box.h, name).toBe(box.secondary ? 24 : 36)
                    // The hit reaches 4 px past the face on each side: 44 and 32 px tall.
                    expect(
                        [box.hitTop, box.hitBottom, box.hitLeft, box.hitRight],
                        `${name} hit`,
                    ).toEqual([true, true, true, true])
                    expect([box.pastTop, box.pastBottom], `${name} past the hit`).toEqual([
                        false,
                        false,
                    ])
                    expect(box.x).toBeGreaterThanOrEqual(0)
                    expect(box.x + box.w).toBeLessThanOrEqual(size.width)
                }
                const pane = await page.locator('.chart-pane').boundingBox()
                layouts.push({ locale, pane, buttons: boxes })
                if (locale === 'en' || locale === 'fr' || locale === 'ko')
                    await page.screenshot({ path: `${shots}/${size.name}-${locale}.png` })
            }
            await page.evaluate(() => {
                window.editorTest.settings.locale = 'fr'
                window.editorTest.settings.theme = 'dark'
            })
            await page.keyboard.press('Shift+H')
            await expect(page.locator('[data-tool-dialog][data-sheet]')).toBeVisible()
            const sheet = await page.locator('[data-tool-dialog][data-sheet]').boundingBox()
            const bar = await page.locator('[data-peek-bar]').boundingBox()
            expect(sheet!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height)
            await page.screenshot({ path: `${shots}/${size.name}-sheet-dark.png` })
            layouts.push({ sheet, bar })
            await writeFile(`${shots}/${size.name}-geometry.json`, JSON.stringify(layouts, null, 2))
        })
    })

test('forced colors and chart zoom retain marks with directional shape cues', async ({ page }) => {
    await boot(page)
    await seedNotes(page)
    for (const forcedColors of ['none', 'active'] as const) {
        await page.emulateMedia({ forcedColors, reducedMotion: 'reduce' })
        for (const width of [6, 24]) {
            await page.evaluate((width) => {
                window.editorTest.settings.width = width
                window.editorTest.settings.pps = width === 6 ? 400 : 80
            }, width)
            await page.locator('[data-change-arrow="up"]').focus()
            await page.screenshot({ path: `${shots}/marks-${forcedColors}-${width}.png` })
        }
    }
})

for (const width of [1440, 390])
    test.describe(`chronology-${width}`, () => {
        test.use({
            viewport: { width, height: width === 390 ? 844 : 900 },
            hasTouch: width === 390,
        })
        test('group labels and disclosure keep chronological actions visible', async ({ page }) => {
            await boot(page)
            await page.evaluate(() => {
                const { history } = window.editorTest
                const labels = [
                    'Added 1 Note',
                    'Moved 2 Notes',
                    'Changed BPM',
                    'Adjusted',
                    'Adjusted',
                    'Adjusted',
                ]
                for (const [index, label] of labels.entries())
                    history.pushState(
                        index < 3
                            ? window.editorTest.historySteps.futureInitialLife(
                                  history.state.value.initialLife,
                                  history.state.value.initialLife + 1,
                                  label,
                              )
                            : window.editorTest.historySteps.initialLife(
                                  history.state.value.initialLife,
                                  history.state.value.initialLife + 1,
                              ),
                        {
                            ...history.state.value,
                            initialLife: history.state.value.initialLife + 1,
                        },
                    )
                for (let i = 0; i < 4; i++) history.undoState()
                for (let i = 0; i < 4; i++) history.redoState()
            })
            await page.evaluate(async () => {
                await window.nseFlushTest!.flusher.flush({ strict: true })
            })
            await page.keyboard.press('Shift+H')
            const list = page.locator('[data-history-surface="dialog"] [data-history-list]')
            await expect(list.getByRole('row', { name: /^Redid 4 steps/ })).toBeVisible()
            await expect(list.getByRole('row', { name: /^Undid 4 steps/ })).toBeVisible()
            const group = list.getByRole('row', { name: /^Changed Initial Life/ })
            await (width === 390 ? group.tap() : group.click())
            await page.screenshot({ path: `${shots}/groups-${width}-collapsed.png` })
            await (width === 390
                ? group.locator('[data-history-disclosure]').tap()
                : group.locator('[data-history-disclosure]').click())
            await expect(group).toHaveAttribute('aria-selected', 'true')
            await page.screenshot({ path: `${shots}/groups-${width}-expanded.png` })
            await list
                .getByRole('row', { name: /^Undid 4 steps/ })
                .locator('[data-history-disclosure]')
                .click()
            await list.getByRole('row', { name: /^Undo · Changed BPM/ }).scrollIntoViewIfNeeded()
            await page.screenshot({ path: `${shots}/groups-${width}-undo.png` })
        })
    })

test('200 percent viewport equivalent and narrowed docks retain both bar rows', async ({
    page,
}) => {
    await boot(page)
    await seedNotes(page)
    await page
        .locator('[data-workspace-dock="right"]')
        .getByRole('tab', { name: 'History', exact: true })
        .click()
    await page.screenshot({ path: `${shots}/desktop-dock.png` })
    // A 1600px display at 200% browser zoom has an 800 CSS-pixel viewport.
    await page.setViewportSize({ width: 800, height: 450 })
    await page.evaluate(() => {
        window.editorTest.settings.locale = 'fr'
    })
    await expect(page.locator('[data-peek-main]')).toBeVisible()
    await expect(page.locator('[data-peek-navigation]')).toBeVisible()
    const boxes = await page.locator('[data-peek-bar] button').evaluateAll((buttons) =>
        buttons.map((button) => {
            const box = button.getBoundingClientRect()
            return { left: box.left, right: box.right }
        }),
    )
    for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(800)
    }
    await page.screenshot({ path: `${shots}/desktop-200-percent.png` })
})

test('same-beat event moves retain old glyphs and Show Change reaches their actual lanes', async ({
    page,
}) => {
    await boot(page)
    await page.evaluate(async () => {
        const { fixtures, history, appImport, view, settings } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const before = structuredClone(fixtures.events)
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Events',
            ),
            createState(before, 0),
        )
        const after = structuredClone(before)
        after.timeScales[0]!.editorLane = 30
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Moved event',
            ),
            createState(after, 0),
        )
        view.time = 2.25
        settings.maxScrollX = 64
    })
    await previewLatest(page)
    const ghosts = await page.evaluate(async () => {
        const { changeMarks } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        return changeMarks.value!.ghosts.map(({ entity }) => ({
            type: entity.type,
            lane: 'editorLane' in entity ? entity.editorLane : undefined,
        }))
    })
    expect(ghosts).toEqual([{ type: 'timeScale', lane: 8 }])
    await page.evaluate(async () => {
        ;(
            await window.editorTest.appImport<typeof import('../../src/editor/history/changes')>(
                '/src/editor/history/changes.ts',
            )
        ).showNearestChange()
    })
    await expect.poll(() => page.evaluate(() => window.editorTest.view.lane)).toBeGreaterThan(20)
    await page.screenshot({ path: `${shots}/event-horizontal-move.png` })
})

test('narrow French history keeps removed and damaged reasons readable', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await boot(page)
    await page.evaluate(async () => {
        const { appImport, settings } = window.editorTest
        settings.locale = 'fr'
        const { storageWorker } =
            await appImport<typeof import('../../src/local/start')>('/src/local/start.ts')
        const { damagedEntries, keyOf } = await appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        const entries = [1, 2].map((seq) => ({
            sessionId: 'evidence',
            seq,
            time: Date.now() - seq * 1000,
            kind: 'edit' as const,
            step: window.editorTest.historySteps.editStep(
                window.editorTest.historySteps.futureFixtureOperation(
                    'unavailable-localized',
                    {},
                    seq === 1
                        ? 'Déplacement de nombreuses notes sur plusieurs voies'
                        : 'Modification du tempo',
                ),
            ),
            kept: false,
            snapshot: '00',
            dirty: false,
            noteCount: 5,
        }))
        damagedEntries.value = new Set([keyOf(entries[1]!)])
        const worker = storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const call = worker.call.bind(worker)
        worker.call = async (name, ...args) => {
            const result = await call(name, ...args)
            return name === 'readTimeline' ? { ...(result as object), entries } : result
        }
    })
    await page.keyboard.press('Shift+H')
    const flags = page.locator('[data-history-surface="dialog"] [data-history-flag]')
    await expect(flags).toHaveCount(2)
    const sizes = await flags.evaluateAll((flags) =>
        flags.map((flag) => {
            const text = flag.lastElementChild!
            const row = flag.closest('[role="row"]')!.getBoundingClientRect()
            const box = text.getBoundingClientRect()
            return {
                inside: box.top >= row.top && box.bottom <= row.bottom,
                fits: text.scrollWidth <= text.clientWidth,
            }
        }),
    )
    expect(sizes).toEqual([
        { inside: true, fits: true },
        { inside: true, fits: true },
    ])
    await page.screenshot({ path: `${shots}/phone-small-fr-unavailable-rows.png` })
})

test('header-only and unavailable comparisons have explicit stable summaries', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await boot(page)
    await page.evaluate(() => {
        const { history, settings } = window.editorTest
        settings.locale = 'fr'
        history.pushState(
            window.editorTest.historySteps.futureInitialLife(
                history.state.value.initialLife,
                1200,
                'Modification de la vie initiale et des paramètres du niveau conservés dans cet historique',
            ),
            { ...history.state.value, initialLife: 1200 },
        )
    })
    await previewLatest(page)
    await page.screenshot({ path: `${shots}/phone-fr-header-only.png` })
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { peekedInfo, requestPeek } = await appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        requestPeek({
            ...peekedInfo.value!,
            previous: { key: 'missing:1', snapshot: '0'.repeat(32) },
        })
    })
    const comparison = page.locator('[data-peek-change]')
    await expect(comparison).toHaveText('Indisponible')
    await expect(comparison.locator('..')).toHaveAccessibleName('Modifications indisponibles')
    await expect(comparison.locator('..')).toHaveAttribute('title', 'Modifications indisponibles')
    await page.screenshot({ path: `${shots}/phone-fr-unavailable.png` })
})

test('composed stages outline attached ticks and zero-width placeholders', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const { fixtures, history, appImport, view, settings } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const before = structuredClone(fixtures.events)
        const base = fixtures.notes.slides[0]![0]!
        before.cameraEvents = []
        before.stageMaskEvents = []
        before.stageStyleEvents = []
        before.stageTransformEvents = []
        before.timeScales = []
        before.stagePivotEvents = before.stagePivotEvents
            .slice(0, 1)
            .map((event) => ({ ...event, beat: 0, pivotLane: 4 }))
        before.slides = [
            [
                { ...base, beat: 2, size: 4 },
                { ...base, beat: 4, size: 0, isAttached: true, noteType: 'forceTick' },
                { ...base, beat: 6, size: 4, left: -3 },
            ],
        ]
        before.slides.push([{ ...base, beat: 5, left: 3, size: 0, noteType: 'forceTick' }])
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Composed slide',
            ),
            createState(before, 0),
        )
        const after = structuredClone(before)
        after.slides[0]![1]!.isCritical = true
        after.slides[1]![0]!.isCritical = true
        after.slides[0]![0]!.connectorEase = 'inQuad'
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Changed tick and connector',
            ),
            createState(after, 0),
        )
        view.layout = 'composed'
        view.time = 3.5
        settings.width = 16
        settings.pps = 160
    })
    await previewLatest(page)
    const result = await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const { changeMarks } = await appImport<typeof import('../../src/editor/history/changes')>(
            '/src/editor/history/changes.ts',
        )
        const { getComposedLayout } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        const { changeShape } = await appImport<
            typeof import('../../src/editor/canvas/changeGeometry')
        >('/src/editor/canvas/changeGeometry.ts')
        const state = history.state.value
        const tick = changeMarks.value!.rings.find(
            ({ entity }) =>
                entity.type === 'note' && entity.noteType === 'forceTick' && entity.isAttached,
        )!.entity
        const composed = getComposedLayout(state)!
        return {
            shape: changeShape(
                { state, ups: 2, composed } as Parameters<typeof changeShape>[0],
                tick,
            ),
            storedSize: 'size' in tick ? tick.size : null,
            effective: composed.hitbox(tick)?.w,
            marks: changeMarks.value!.rings.length,
        }
    })
    expect(result.storedSize).toBe(4)
    expect(result.effective).toBeGreaterThan(0)
    expect(result.shape?.kind).toBe('diamond')
    expect(result.shape?.points).toHaveLength(4)
    expect(result.marks).toBe(3)
    await page.screenshot({ path: `${shots}/composed-attached-tick-connector.png` })
})

test('Show Change reaches a removed event outside the visible lanes', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const { fixtures, history, appImport, view, settings } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const before = structuredClone(fixtures.events)
        before.timeScales = [{ ...before.timeScales[0]!, editorLane: -30 }]
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Off-lane event',
            ),
            createState(before, 0),
        )
        history.pushState(
            window.editorTest.historySteps.nativeOperation(
                { id: 'nse.externalChange', data: {} },
                'Removed off-lane event',
            ),
            createState({ ...before, timeScales: [] }, 0),
        )
        view.time = 2.25
        view.lane = 0
        settings.maxScrollX = 64
    })
    await previewLatest(page)
    await page.evaluate(async () => {
        const { showNearestChange } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        showNearestChange()
    })
    await expect.poll(() => page.evaluate(() => window.editorTest.view.lane)).toBe(-30)
    await page.screenshot({ path: `${shots}/removed-off-lane-event.png` })
})
