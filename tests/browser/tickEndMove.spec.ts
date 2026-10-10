import { expect, test, type Page } from '@playwright/test'
import { notes, point, setup, type Brief, type Layout } from './crossStageSlide'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// An attached tick moved past its slide's head or tail moves as the note it becomes, from where
// gameplay drew it (as detaching keeps it), and its preview shows exactly where it drops.
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

type Tool = 'select' | 'note' | 'slide'

const useTool = (page: Page, tool: Tool) =>
    page.evaluate(async (tool) => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo(tool)
    }, tool)

const stored = ({ beat, left, size, elevation, attached }: Brief) => ({
    beat,
    left,
    size,
    elevation,
    attached,
})

// Stage 1 notes at a beat, as stored.
const stageOne = async (page: Page, beat: number) =>
    (await notes(page)).filter((note) => note.stage === 1 && note.beat === beat)

/** The lane where this layout draws a note's centre. */
const centre = (layout: Layout, note: Brief) =>
    layout === 'composed' ? note.drawn.left + note.drawn.size / 2 : note.left + note.size / 2

/** The notes the canvas previews during a drag, as stored. */
const ghosts = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.view.entities.creating.flatMap((note) =>
            note.type === 'note'
                ? [
                      {
                          beat: note.beat,
                          left: note.left,
                          size: note.size,
                          elevation: note.elevation,
                          attached: note.isAttached,
                      },
                  ]
                : [],
        ),
    )

/** Drags from a note's drawn centre by lanes and beats; returns the preview just before release. */
const drag = async (page: Page, lane: number, beat: number, dLane: number, dBeat: number) => {
    const start = await point(page, lane, beat)
    const end = await point(page, lane + dLane, beat + dBeat)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 })
    const preview = await ghosts(page)
    await page.mouse.up()
    return preview
}

const click = async (page: Page, lane: number, beat: number, ctrl = false) => {
    const target = await point(page, lane, beat)
    if (ctrl) await page.keyboard.down('Control')
    await page.mouse.click(target.x, target.y)
    if (ctrl) await page.keyboard.up('Control')
}

const expectUndoRedo = async (page: Page, before: Brief[], after: Brief[]) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('z')
    await expect.poll(() => notes(page)).toEqual(before)
    await page.keyboard.press('y')
    await expect.poll(() => notes(page)).toEqual(after)
}

// The tick detached where gameplay draws it, as Properties Attached off does.
const detachInPlace = (page: Page, beats: number[]) =>
    page.evaluate(async (beats) => {
        const { history, store, appImport } = window.editorTest
        const { editSelectedEditableEntities } = await appImport<
            typeof import('../../src/editor/sidebars/default')
        >('/src/editor/sidebars/default/index.ts')
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) =>
                    entity.type === 'note' && entity.isAttached && beats.includes(entity.beat),
            ),
        })
        editSelectedEditableEntities({ isAttached: false })
    }, beats)

for (const layout of ['basic', 'composed'] as const) {
    test.describe(layout, () => {
        // Detached in place, the tick is stored at left -5.25, elevation 2 on stage 1, whose
        // Composed offset grows one lane per beat. Composed keeps it drawn at -1.25.
        const landed = (beat: number) => ({
            beat,
            left: layout === 'composed' ? -5.25 + 4 - beat : -5.25,
            size: 2.5,
            elevation: 2,
            attached: true,
        })

        for (const tool of ['select', 'note', 'slide'] as const) {
            for (const [end, beat] of [
                ['tail', 7],
                ['head', 1],
            ] as const) {
                test(`${tool}: a tick dragged past the ${end} keeps its gameplay place`, async ({
                    page,
                }) => {
                    await setup(page, layout)
                    await useTool(page, tool)
                    const before = await notes(page)
                    const [tick] = await stageOne(page, 4)
                    const preview = await drag(page, centre(layout, tick!), 4, 0, beat - 4)
                    const after = await notes(page)
                    const [moved] = await stageOne(page, beat)
                    // Nothing is detached; the flag stays.
                    expect(stored(moved!)).toEqual(landed(beat))
                    if (layout === 'composed')
                        expect(moved!.drawn).toEqual({ left: -1.25, size: 2.5 })
                    expect(preview).toEqual([stored(moved!)])
                    await expectUndoRedo(page, before, after)
                })
            }

            test(`${tool}: a tick dropped on the tail's beat stays on the path`, async ({
                page,
            }) => {
                await setup(page, layout)
                await useTool(page, tool)
                const [tick] = await stageOne(page, 4)
                const preview = await drag(page, centre(layout, tick!), 4, 0, 2)
                const [moved] = await stageOne(page, 6)
                // The tail keeps its slot after the tick, so the tick takes the path's lane there.
                expect(stored(moved!)).toEqual({
                    beat: 6,
                    left: -4,
                    size: 3,
                    elevation: 0,
                    attached: true,
                })
                expect(preview).toEqual([stored(moved!)])
            })
        }

        for (const tool of ['select', 'note'] as const) {
            for (const snapping of ['absolute', 'relative'] as const) {
                test(`${tool}: a ${snapping} sideways drag past the tail moves it as a note there`, async ({
                    page,
                }) => {
                    const run = async (detached: boolean) => {
                        await setup(page, layout)
                        await page.evaluate((snapping) => {
                            window.editorTest.view.laneSnapping = snapping
                        }, snapping)
                        if (detached) await detachInPlace(page, [4])
                        await useTool(page, tool)
                        const [tick] = await stageOne(page, 4)
                        const preview = await drag(page, centre(layout, tick!), 4, 1.3, 2.5)
                        const [moved] = await stageOne(page, 6.5)
                        return { preview, moved: stored(moved!) }
                    }
                    const attached = await run(false)
                    const detached = await run(true)
                    expect(attached.moved).toEqual({ ...detached.moved, attached: true })
                    expect(attached.preview).toEqual([attached.moved])
                })
            }
        }

        test('a selected tick carried past the tail by another note moves as a note', async ({
            page,
        }) => {
            const run = async (detached: boolean) => {
                await setup(page, layout)
                if (detached) await detachInPlace(page, [4])
                await useTool(page, 'select')
                const [tick] = await stageOne(page, 4)
                const other = (await notes(page)).find((note) => note.beat === 8)!
                await click(page, centre(layout, tick!), 4)
                await click(page, centre(layout, other), 8, true)
                await expect
                    .poll(() => page.evaluate(() => window.editorTest.snapshot().selected.length))
                    .toBe(2)
                // Grab the ordinary note; the tick follows by the same authored offset.
                const preview = await drag(page, centre(layout, other), 8, 0.6, 2.5)
                const [moved] = await stageOne(page, 6.5)
                return { preview, moved: stored(moved!) }
            }
            const attached = await run(false)
            const detached = await run(true)
            expect(attached.moved).toEqual({ ...detached.moved, attached: true })
            expect(attached.preview).toContainEqual(attached.moved)
        })

        for (const grab of ['inner', 'end'] as const) {
            test(`of two ticks dragged past the tail by the ${grab} one, only the new end leaves the path`, async ({
                page,
            }) => {
                const run = async (detached: boolean) => {
                    await setup(page, layout, false, [5])
                    if (detached) await detachInPlace(page, [5])
                    await useTool(page, 'select')
                    const [first] = await stageOne(page, 4)
                    const [second] = await stageOne(page, 5)
                    await click(page, centre(layout, first!), 4)
                    await click(page, centre(layout, second!), 5, true)
                    await expect
                        .poll(() =>
                            page.evaluate(() => window.editorTest.snapshot().selected.length),
                        )
                        .toBe(2)
                    const [lane, beat] =
                        grab === 'inner'
                            ? [centre(layout, first!), 4]
                            : [centre(layout, second!), 5]
                    const preview = await drag(page, lane, beat, 0, 2.5)
                    const [inner] = await stageOne(page, 6.5)
                    const [end] = await stageOne(page, 7.5)
                    return { preview, inner: stored(inner!), end: stored(end!) }
                }
                const attached = await run(false)
                // The inner tick stays attached on the path, at its stored elevation.
                expect(attached.inner).toMatchObject({ attached: true, elevation: 0 })
                expect(attached.end).toMatchObject({ attached: true, size: 2.75 })
                expect(attached.end.elevation).not.toBe(0)
                expect(attached.preview).toEqual([attached.inner, attached.end])
                // Grabbing the end, the drag is the same as for the note it becomes. Grabbing the
                // inner tick, it is not: detaching first moves the inner tick on the path.
                if (grab === 'inner') return
                const detached = await run(true)
                expect(attached.inner).toEqual(detached.inner)
                expect(attached.end).toEqual({ ...detached.end, attached: true })
            })
        }

        test('a same-beat tick dragged off its beat keeps its stored elevation', async ({
            page,
        }) => {
            const run = async (detached: boolean) => {
                await setup(page, layout, true)
                if (detached) await detachInPlace(page, [4])
                const tick = (await notes(page)).find((note) => note.elevation === 1)!
                await page.evaluate(() => {
                    const { history, store } = window.editorTest
                    history.replaceState({
                        ...history.state.value,
                        selectedEntities: [...store.getAllEntities()].filter(
                            (entity) => entity.type === 'note' && entity.elevation === 1,
                        ),
                    })
                })
                await useTool(page, 'select')
                const preview = await drag(page, centre(layout, tick), 4, 0, 1)
                const moved = (await notes(page)).find((note) => note.beat === 5)!
                return { tick, preview, moved }
            }
            const attached = await run(false)
            expect(stored(attached.moved)).toMatchObject({ elevation: 1, attached: true })
            if (layout === 'composed') expect(attached.moved.drawn).toEqual(attached.tick.drawn)
            expect(attached.preview).toEqual([stored(attached.moved)])
            const detached = await run(true)
            expect(stored(attached.moved)).toEqual({ ...stored(detached.moved), attached: true })
        })

        for (const tool of ['select', 'note'] as const) {
            test(`${tool}: a tick taken past the tail and back before release stays on the path`, async ({
                page,
            }) => {
                const run = async (overshoot: boolean) => {
                    await setup(page, layout)
                    await useTool(page, tool)
                    const [tick] = await stageOne(page, 4)
                    const lane = centre(layout, tick!)
                    const start = await point(page, lane, 4)
                    const past = await point(page, lane, 7)
                    const end = await point(page, lane, 5)
                    await page.mouse.move(start.x, start.y)
                    await page.mouse.down()
                    if (overshoot) {
                        await page.mouse.move(past.x, past.y, { steps: 8 })
                        // Past the tail, it previews as the end it would become.
                        expect(await ghosts(page)).toEqual([landed(7)])
                    }
                    await page.mouse.move(end.x, end.y, { steps: 8 })
                    const preview = await ghosts(page)
                    await page.mouse.up()
                    const [moved] = await stageOne(page, 5)
                    return { preview, moved: stored(moved!) }
                }
                const back = await run(true)
                expect(back.moved).toMatchObject({ attached: true, elevation: 0, size: 2.75 })
                expect(back.preview).toEqual([back.moved])
                expect(back.moved).toEqual((await run(false)).moved)
            })
        }

        test.describe('Properties Beat', () => {
            const beatField = (page: Page) =>
                page
                    .locator('#workspace-panel-properties #properties-section-selection')
                    .getByRole('spinbutton', { name: 'Beat', exact: true })

            const previewed = (page: Page) =>
                page.evaluate(async () => {
                    const { history, appImport } = window.editorTest
                    const edit =
                        await appImport<typeof import('../../src/preview/edit')>(
                            '/src/preview/edit.ts',
                        )
                    if (!edit.previewEdit.value) return
                    return [...edit.getPreviewState(history.state.value).store.slides.note.values()]
                        .flat()
                        .filter((note) => note.stageId === (1 as never) && note.beat === 7)
                        .map((note) => ({
                            beat: note.beat,
                            left: note.left,
                            size: note.size,
                            elevation: note.elevation,
                            attached: note.isAttached,
                        }))
                })

            for (const [end, beat] of [
                ['tail', 7],
                ['head', 1],
            ] as const) {
                test(`a Beat past the ${end} keeps the tick in place`, async ({ page }) => {
                    await setup(page, layout)
                    await page.evaluate(() => {
                        window.editorTest.settings.showSidebar = true
                    })
                    const before = await notes(page)
                    const [tick] = await stageOne(page, 4)
                    await page.keyboard.press('f')
                    await click(page, centre(layout, tick!), 4)
                    const field = beatField(page)
                    const shown = Number(await field.inputValue())
                    await field.fill(String(shown + beat - 4))
                    await field.press('Enter')
                    await expect.poll(async () => (await stageOne(page, beat)).length).toBe(1)
                    const after = await notes(page)
                    const [moved] = await stageOne(page, beat)
                    // A Beat edit keeps stored lanes, as for any note.
                    expect(stored(moved!)).toEqual({ ...landed(beat), left: -5.25 })
                    await expectUndoRedo(page, before, after)
                })
            }

            test('a Beat that stays inside keeps the tick on the path', async ({ page }) => {
                await setup(page, layout)
                await page.evaluate(() => {
                    window.editorTest.settings.showSidebar = true
                })
                const [tick] = await stageOne(page, 4)
                await page.keyboard.press('f')
                await click(page, centre(layout, tick!), 4)
                const field = beatField(page)
                const shown = Number(await field.inputValue())
                await field.fill(String(shown + 1))
                await field.press('Enter')
                await expect.poll(async () => (await stageOne(page, 5)).length).toBe(1)
                const [moved] = await stageOne(page, 5)
                expect(stored(moved!)).toMatchObject({ attached: true, elevation: 0 })
                // Still interpolated on the path: three quarters of the way from head to tail.
                expect(moved!.size).toBe(2.75)
            })

            test('a Mixed Beat step past the tail previews and keeps the tick in place', async ({
                page,
            }) => {
                await setup(page, layout)
                await page.evaluate(() => {
                    window.editorTest.settings.showSidebar = true
                })
                const [tick] = await stageOne(page, 4)
                const other = (await notes(page)).find((note) => note.beat === 8)!
                await page.keyboard.press('f')
                await click(page, centre(layout, tick!), 4)
                await click(page, centre(layout, other), 8, true)
                await expect
                    .poll(() => page.evaluate(() => window.editorTest.snapshot().selected.length))
                    .toBe(2)
                const field = beatField(page)
                await field.focus()
                for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp')
                const expected = { ...landed(7), left: -5.25 }
                await expect.poll(() => previewed(page)).toEqual([expected])
                await page.keyboard.press('Tab')
                await expect
                    .poll(async () => (await stageOne(page, 7)).map(stored))
                    .toEqual([expected])
            })
        })
    })
}

// Composed with dynamic stages moves a mixed selection by one solved delta; Basic snaps each.
test('basic: a camera joint moved with a tick taken past the tail shifts as the tick does', async ({
    page,
}) => {
    await setup(page, 'basic')
    await page.evaluate(async () => {
        const { history, fixtures, appImport } = window.editorTest
        const { createTransaction } = await appImport<typeof import('../../src/state/transaction')>(
            '/src/state/transaction.ts',
        )
        const { addCameraEventJoint } = await appImport<
            typeof import('../../src/state/mutations/events/camera')
        >('/src/state/mutations/events/camera.ts')
        const source = history.state.value
        const transaction = createTransaction(source)
        const [camera] = addCameraEventJoint(transaction, {
            ...fixtures.events.cameraEvents[0]!,
            beat: 4,
            cameraLeft: -6,
            cameraSize: 12,
        })
        const tick = [...source.store.slides.note.values()].flat().find((note) => note.isAttached)
        history.replaceState(transaction.commit([tick!, camera!]))
    })
    await useTool(page, 'select')
    const [tick] = await stageOne(page, 4)
    // Absolute lane snapping, 1.3 lanes sideways: the tick snaps from its gameplay place.
    await drag(page, centre('basic', tick!), 4, 1.3, 2.5)
    const [moved] = await stageOne(page, 6.5)
    const cameraLeft = await page.evaluate(
        () =>
            [...window.editorTest.history.state.value.store.grid.cameraEventJoint.values()]
                .flatMap((bucket) => [...bucket])
                .find((joint) => joint.beat === 6.5)?.cameraLeft,
    )
    // Detached in place, the tick is at -5.25.
    expect(moved!.left).not.toBe(-5.25)
    expect(cameraLeft! - -6).toBe(moved!.left - -5.25)
})
