import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { installEditorFixture, waitForStartup } from './editorFixture'

const shots = 'D:/sonolus/nse-next/work/validation/history-shots'
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
        requestPeek({
            key: keyOf({ sessionId, seq }),
            time: new Date(2024, 8, 13, 16, 35).getTime(),
            label: 'Marker changes',
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
        history.pushState(() => 'Notes', createState(chart, 0))
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
        history.pushState(() => 'Changed note shapes', createState(after, 0))
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
        history.pushState(() => 'Events', createState(before, 0))
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
        history.pushState(() => 'Removed events', createState(after, 0))
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
                await expect(buttons).toHaveCount(4)
                const boxes = await buttons.evaluateAll((elements) =>
                    elements.map((element) => {
                        const box = element.getBoundingClientRect()
                        return {
                            x: box.x,
                            y: box.y,
                            w: box.width,
                            h: box.height,
                            name: element.getAttribute('aria-label') || element.textContent,
                        }
                    }),
                )
                for (const box of boxes) {
                    expect(box.w).toBeGreaterThanOrEqual(44)
                    expect(box.h).toBeGreaterThanOrEqual(44)
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
