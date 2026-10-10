import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// A tick that stops being an interior attached tick stays where gameplay drew it.
const errors = new WeakMap<Page, string[]>()

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

type Layout = 'basic' | 'composed'

// Stage 1: pivot 0 to 4, X translation 0 to 4 and elevation 0 to 2 over beats 0 to 8.
// Stage 2: pivot 4.5, X translation -3, elevation 1. Slide S runs from stage 1 (beat 2,
// elevation 1) to stage 2 (beat 6, size 3, elevation 3), with a tick on stage 1 at beat 4
// drawn at left -1.25, size 2.5 and effective elevation 3: stored on stage 1, left -5.25
// and elevation 2. The tail is in group 2. Note N on stage 2 sits apart at beat 8.
const setup = (page: Page, layout: Layout, sameBeat = false) =>
    page.evaluate(
        async ({ layout, sameBeat }) => {
            const { fixtures, show, view, settings, appImport } = window.editorTest
            const { addToStages } =
                await appImport<typeof import('../../src/chart/stages')>('/src/chart/stages.ts')
            const { addToGroups } =
                await appImport<typeof import('../../src/chart/groups')>('/src/chart/groups.ts')
            // The fixture's ids were not minted; move both counters past them.
            while (addToStages(new Map())[0] < 2);
            while (addToGroups(new Map())[0] < 2);
            const chart = fixtures.interaction
            const base = chart.slides[0]![0]!
            const [stageA, stageB] = [...fixtures.events.stages.keys()]
            const pivot = fixtures.events.stagePivotEvents[0]!
            const transform = fixtures.events.stageTransformEvents[0]!
            const slide = sameBeat
                ? [
                      { ...base, stageId: stageA!, beat: 4, left: -4, size: 2, elevation: 0 },
                      {
                          ...base,
                          stageId: stageA!,
                          beat: 4,
                          left: 0,
                          size: 2,
                          elevation: 1,
                          isAttached: true,
                      },
                      {
                          ...base,
                          stageId: stageB!,
                          groupId: 2 as never,
                          beat: 4,
                          left: -4,
                          size: 3,
                          elevation: 4,
                      },
                  ]
                : [
                      { ...base, stageId: stageA!, beat: 2, left: -4, size: 2, elevation: 1 },
                      {
                          ...base,
                          stageId: stageA!,
                          beat: 4,
                          left: 0,
                          size: 2,
                          elevation: 0,
                          isAttached: true,
                      },
                      {
                          ...base,
                          stageId: stageB!,
                          groupId: 2 as never,
                          beat: 6,
                          left: -4,
                          size: 3,
                          elevation: 3,
                      },
                  ]
            show(
                {
                    ...fixtures.events,
                    bpms: chart.bpms,
                    cameraEvents: [],
                    stageMaskEvents: [],
                    stageStyleEvents: [],
                    timeScales: [],
                    stagePivotEvents: [
                        { ...pivot, stageId: stageA!, beat: 0, pivotLane: 0, eventEase: 'linear' },
                        { ...pivot, stageId: stageA!, beat: 8, pivotLane: 4, eventEase: 'linear' },
                        {
                            ...pivot,
                            stageId: stageB!,
                            beat: 0,
                            pivotLane: 4.5,
                            divisionParity: 'odd',
                            eventEase: 'linear',
                        },
                    ],
                    stageTransformEvents: [
                        {
                            ...transform,
                            stageId: stageA!,
                            beat: 0,
                            xTranslation: 0,
                            elevation: 0,
                            eventEase: 'linear',
                        },
                        {
                            ...transform,
                            stageId: stageA!,
                            beat: 8,
                            xTranslation: 4,
                            elevation: 2,
                            eventEase: 'linear',
                        },
                        {
                            ...transform,
                            stageId: stageB!,
                            beat: 0,
                            xTranslation: -3,
                            elevation: 1,
                            eventEase: 'linear',
                        },
                    ],
                    slides: [
                        slide,
                        [
                            {
                                ...base,
                                stageId: stageB!,
                                groupId: 2 as never,
                                beat: 8,
                                left: 0,
                                size: 2,
                            },
                        ],
                    ],
                },
                2,
            )
            view.layout = layout
            settings.mouseSecondaryTool = 'selectContextMenu'
            Object.defineProperty(navigator.clipboard, 'writeText', {
                configurable: true,
                value: async () => undefined,
            })
            Object.defineProperty(navigator.clipboard, 'readText', {
                configurable: true,
                value: async () => {
                    throw new DOMException('Clipboard denied', 'NotAllowedError')
                },
            })
        },
        { layout, sameBeat },
    )

// Where each layout draws the slide's centres at their beats.
const lanes = {
    basic: { head: -3, tick: -2.75, tail: -2.5 },
    composed: { head: -1, tick: 0, tail: -1 },
}

type Brief = {
    beat: number
    left: number
    size: number
    elevation: number
    attached: boolean
    stage: number
    drawn: { left: number; size: number }
}

/** Every note with its Composed (gameplay) lane, sorted by stage then beat. */
const notes = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const source = history.state.value
        const layout = createComposedLayout(source)
        return [...source.store.slides.note.values()]
            .flat()
            .map((note) => ({
                beat: note.beat,
                left: note.left,
                size: note.size,
                elevation: note.elevation ?? 0,
                attached: note.isAttached,
                stage: note.stageId as number,
                drawn: layout.notePosition(note),
            }))
            .sort((a, b) => a.stage - b.stage || a.beat - b.beat)
    })

// The tick's place in gameplay: drawn at -1.25, stored on stage 1 at -5.25, elevation 2.
const kept = (stage = 1) => ({
    beat: 4,
    left: -5.25,
    size: 2.5,
    elevation: 2,
    stage,
    drawn: { left: -1.25, size: 2.5 },
})

const tickOf = (all: Brief[], stage = 1) =>
    all.find((note) => note.beat === 4 && note.stage === stage)

const expectKept = (tick: Brief | undefined, stage = 1, attached?: boolean) => {
    expect(tick).toMatchObject(kept(stage))
    if (attached !== undefined) expect(tick?.attached).toBe(attached)
}

const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(([lane, beat]) => window.editorTest.point(lane!, beat!), [lane, beat])

const click = async (page: Page, lane: number, beat: number) => {
    const target = await point(page, lane, beat)
    await page.mouse.click(target.x, target.y)
}

const select = async (page: Page, lane: number, beat: number) => {
    await page.keyboard.press('f')
    await click(page, lane, beat)
    await expect
        .poll(() => page.evaluate(() => window.editorTest.snapshot().selected.length))
        .toBe(1)
}

// Undo restores the snapshot exactly and redo reapplies it.
const expectUndoRedo = async (page: Page, before: Brief[], after: Brief[]) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('z')
    await expect.poll(() => notes(page)).toEqual(before)
    await page.keyboard.press('y')
    await expect.poll(() => notes(page)).toEqual(after)
}

for (const layout of ['basic', 'composed'] as const) {
    test.describe(layout, () => {
        test('the tick is drawn and stored as the fixture says', async ({ page }) => {
            await setup(page, layout)
            const tick = tickOf(await notes(page))!
            expect(tick.drawn).toEqual({ left: -1.25, size: 2.5 })
            expect(tick.attached).toBe(true)
        })

        test('Properties Attached off keeps the tick in place', async ({ page }) => {
            await setup(page, layout)
            const before = await notes(page)
            await page.evaluate(() => {
                window.editorTest.settings.showSidebar = true
            })
            await select(page, lanes[layout].tick, 4)
            const control = page
                .locator('#workspace-panel-properties #properties-section-selection label')
                .filter({ has: page.getByText('Attached', { exact: true }) })
                .locator('input')
            await control.click()
            await expect(control).toHaveValue('Disabled')
            await expect.poll(async () => tickOf(await notes(page))?.attached).toBe(false)
            const after = await notes(page)
            expectKept(tickOf(after), 1, false)
            await expectUndoRedo(page, before, after)
        })

        test('a slide preset with Attached off keeps the tick in place', async ({ page }) => {
            await setup(page, layout)
            await page.evaluate(() => {
                const { settings } = window.editorTest
                settings.showSidebar = true
                settings.defaultSlidePropertiesPresets = settings.defaultSlidePropertiesPresets.map(
                    (preset, i) => (i === 0 ? { ...preset, isAttached: false } : preset),
                )
            })
            await select(page, lanes[layout].tick, 4)
            // A Slide tap on the selection applies its preset.
            await page.keyboard.press('s')
            await click(page, lanes[layout].tick, 4)
            await expect.poll(async () => tickOf(await notes(page))?.attached).toBe(false)
            expectKept(tickOf(await notes(page)), 1, false)
        })

        test('a Brush with Attached off keeps the tick in place', async ({ page }) => {
            await setup(page, layout)
            await page.evaluate(async () => {
                const { brushProperties } = await window.editorTest.appImport<
                    typeof import('../../src/editor/tools/brush')
                >('/src/editor/tools/brush/index.ts')
                brushProperties.value = { isAttached: false }
            })
            await page.keyboard.press('b')
            await click(page, lanes[layout].tick, 4)
            await expect.poll(async () => tickOf(await notes(page))?.attached).toBe(false)
            expectKept(tickOf(await notes(page)), 1, false)
        })

        test('a Brush that also sets Size keeps its size', async ({ page }) => {
            await setup(page, layout)
            await page.evaluate(async () => {
                const { brushProperties } = await window.editorTest.appImport<
                    typeof import('../../src/editor/tools/brush')
                >('/src/editor/tools/brush/index.ts')
                brushProperties.value = { isAttached: false, size: 1 }
            })
            await page.keyboard.press('b')
            await click(page, lanes[layout].tick, 4)
            await expect.poll(async () => tickOf(await notes(page))?.attached).toBe(false)
            expect(tickOf(await notes(page))).toMatchObject({ left: -5.25, size: 1, elevation: 2 })
        })

        test('deleting the slide head keeps the tick, now the head, in place', async ({ page }) => {
            await setup(page, layout)
            const before = await notes(page)
            await select(page, lanes[layout].head, 2)
            await page.keyboard.press('Delete')
            await expect.poll(async () => (await notes(page)).length).toBe(before.length - 1)
            const after = await notes(page)
            // The flag stays; nothing is detached implicitly.
            expectKept(tickOf(after), 1, true)
            await expectUndoRedo(page, before, after)
        })

        test('cutting the slide head keeps the tick in place', async ({ page }) => {
            await setup(page, layout)
            await select(page, lanes[layout].head, 2)
            await page.keyboard.press('x')
            await expect.poll(async () => (await notes(page)).length).toBe(3)
            expectKept(tickOf(await notes(page)), 1, true)
        })

        test('erasing the slide tail keeps the tick, now the tail, in place', async ({ page }) => {
            await setup(page, layout)
            await page.keyboard.press('g')
            await click(page, lanes[layout].tail, 6)
            await expect.poll(async () => (await notes(page)).length).toBe(3)
            expectKept(tickOf(await notes(page)), 1, true)
        })

        test('deleting the tail stage keeps the tick in place', async ({ page }) => {
            await setup(page, layout)
            const before = await notes(page)
            await page.evaluate(async () => {
                const { deleteStage } = await window.editorTest.appImport<
                    typeof import('../../src/editor/workspace/manager/stages')
                >('/src/editor/workspace/manager/stages.ts')
                deleteStage(2 as never)
            })
            await expect.poll(async () => (await notes(page)).length).toBe(2)
            const after = await notes(page)
            expectKept(tickOf(after), 1, true)
            await expectUndoRedo(page, before, after)
        })

        test('duplicating the head stage keeps the copied tick in place', async ({ page }) => {
            await setup(page, layout)
            await page.evaluate(async () => {
                const { stageFolderOps } = await window.editorTest.appImport<
                    typeof import('../../src/editor/workspace/manager/stages')
                >('/src/editor/workspace/manager/stages.ts')
                stageFolderOps.duplicate(new Set([1 as never]))
            })
            await expect.poll(async () => (await notes(page)).length).toBe(6)
            const after = await notes(page)
            // The original slide is untouched; the copy ends at the tick.
            expect(tickOf(after)).toMatchObject({ left: -4, attached: true })
            const copy = after.find((note) => note.beat === 4 && note.stage > 2)
            expect(copy).toMatchObject({ left: -5.25, size: 2.5, elevation: 2, attached: true })
            expect(copy!.drawn).toEqual({ left: -1.25, size: 2.5 })
        })

        test('duplicating the head group keeps the copied tick in place', async ({ page }) => {
            await setup(page, layout)
            await page.evaluate(async () => {
                const { groupFolderOps } = await window.editorTest.appImport<
                    typeof import('../../src/editor/workspace/manager/groups')
                >('/src/editor/workspace/manager/groups.ts')
                groupFolderOps.duplicate(new Set([1 as never]))
            })
            await expect.poll(async () => (await notes(page)).length).toBe(6)
            const ticks = (await notes(page)).filter((note) => note.beat === 4)
            expect(ticks.map(({ left, attached }) => [left, attached])).toEqual([
                [-4, true],
                [-5.25, true],
            ])
            expect(ticks[1]).toMatchObject(kept())
        })

        test('pasting a copied tick and tail keeps the tick at its elevation', async ({ page }) => {
            await setup(page, layout)
            await select(page, lanes[layout].tick, 4)
            const tail = await point(page, lanes[layout].tail, 6)
            await page.keyboard.down('Control')
            await page.mouse.click(tail.x, tail.y)
            await page.keyboard.up('Control')
            await expect
                .poll(() => page.evaluate(() => window.editorTest.snapshot().selected.length))
                .toBe(2)
            // Quarter lanes, so the paste's lattice holds the tick's place.
            await page.evaluate(() => {
                window.editorTest.view.laneDivision = 4
            })
            // Copy with the pointer on the tick, which anchors the paste.
            const tick = await point(page, lanes[layout].tick, 4)
            await page.mouse.move(tick.x, tick.y)
            await page.keyboard.press('c')
            // Paste onto the tick's own place.
            await page.mouse.click(tick.x, tick.y, { button: 'right' })
            await page.getByRole('menu').getByRole('menuitem', { name: 'Paste' }).click()
            await expect.poll(async () => (await notes(page)).length).toBe(6)
            const original = JSON.stringify(tickOf(await notes(page)))
            const pasted = (await notes(page)).filter((note) => note.beat === 4)
            expect(pasted).toHaveLength(2)
            const copy = pasted.find((note) => JSON.stringify(note) !== original)!
            // Level data keeps no Attached flag on a slide's end.
            expect(copy).toMatchObject({ size: 2.5, elevation: 2 })
            // It lands where the original was drawn in this layout.
            if (layout === 'composed') expect(copy.drawn).toEqual({ left: -1.25, size: 2.5 })
            else expect(copy.left + copy.size / 2).toBe(lanes.basic.tick)
        })

        test('a same-beat tick keeps its stored elevation when its head goes', async ({ page }) => {
            await setup(page, layout, true)
            const tick = async () => (await notes(page)).find((note) => note.elevation === 1)!
            const before = await tick()
            expect(before.attached).toBe(true)
            await page.evaluate(async () => {
                const { history, store } = window.editorTest
                history.replaceState({
                    ...history.state.value,
                    selectedEntities: [...store.getAllEntities()].filter(
                        (entity) =>
                            entity.type === 'note' &&
                            entity.stageId === (1 as never) &&
                            !entity.isAttached,
                    ),
                })
            })
            await page.keyboard.press('Delete')
            await expect.poll(async () => (await notes(page)).length).toBe(3)
            const after = await tick()
            expect(after.attached).toBe(true)
            expect(after.drawn.left).toBeCloseTo(before.drawn.left, 9)
            expect(after.drawn.size).toBeCloseTo(before.drawn.size, 9)
        })
    })
}
