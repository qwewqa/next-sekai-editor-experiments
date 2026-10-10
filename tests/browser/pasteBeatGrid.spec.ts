import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// A paste onto a grid beat lands exactly on it, though a + (b - a) can miss b by float noise.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        Object.defineProperty(navigator.clipboard, 'readText', {
            configurable: true,
            value: async () => '',
        })
    })
})

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

// 4/3 + (10/3 - 4/3) is 3.333333333333333, not 10/3.
const from = 4 / 3
const to = 10 / 3

const copyAtThird = async (page: Page, layout: 'basic' | 'composed') => {
    await page.evaluate(
        ({ layout, from }) => {
            const { show, fixtures, history, view, settings } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: layout === 'composed',
                    slides: [[{ ...base, beat: from, left: -1, size: 2 }]],
                },
                1,
            )
            view.layout = layout
            view.division = 3
            view.snapping = 'absolute'
            settings.elevationEditorSideBySide = 'allow'
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
            })
        },
        { layout, from },
    )
    const note = await page.evaluate((from) => window.editorTest.point(0, from), from)
    await page.mouse.move(note.x, note.y)
    await settle(page)
    await page.keyboard.press('c')
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { clipboardEntry } =
                    await window.editorTest.appImport<typeof import('../../src/clipboard')>(
                        '/src/clipboard/index.ts',
                    )
                return clipboardEntry.value?.data?.beat
            }),
        )
        .toBe(from)
    expect(from + (to - from)).not.toBe(to)
}

const pastedBeat = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.history.state.value.selectedEntities.flatMap((entity) =>
            entity.type === 'note' ? [entity.beat] : [],
        ),
    )

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: a chart paste at a third lands exactly on it, as its ghost shows`, async ({
        page,
    }) => {
        await copyAtThird(page, layout)
        await page.evaluate(async () => {
            const { switchToolTo } = await window.editorTest.appImport<
                typeof import('../../src/editor/tools')
            >('/src/editor/tools/index.ts')
            switchToolTo('paste')
        })
        const target = await page.evaluate((to) => window.editorTest.point(4, to), to)
        await page.mouse.move(target.x - 2, target.y)
        await page.mouse.move(target.x, target.y)
        await settle(page)
        expect(
            await page.evaluate(() =>
                window.editorTest.view.entities.creating.flatMap((entity) =>
                    entity.type === 'note' ? [entity.beat] : [],
                ),
            ),
        ).toEqual([to])
        await page.mouse.click(target.x, target.y)
        await expect.poll(() => pastedBeat(page)).toEqual([to])
    })

    test(`${layout}: an Elevation Editor paste at a third lands exactly on it`, async ({
        page,
    }) => {
        await copyAtThird(page, layout)
        const target = await page.evaluate(async (to) => {
            const { appImport, nextTick } = window.editorTest
            const { openElevationEditor, elevationBeat } = await appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            openElevationEditor(to)
            await nextTick()
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo('paste')
            const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
                '/src/editor/elevation/scene.ts',
            )
            const layout = scene.elevationLayout.value
            const box = document.querySelector('.elevation-canvas')!.getBoundingClientRect()
            return {
                beat: elevationBeat.value,
                x: box.x + layout.xAt(4),
                y: box.y + layout.yAt(0),
            }
        }, to)
        expect(target.beat).toBe(to)
        await page.mouse.move(target.x - 2, target.y)
        await page.mouse.move(target.x, target.y)
        await page.mouse.click(target.x, target.y)
        await expect.poll(() => pastedBeat(page)).toEqual([to])
    })
}
