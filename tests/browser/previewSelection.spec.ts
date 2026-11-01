import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { outlinePixels, resource } from './previewResourceFixture'

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
        window.editorTest.settings.showPreview = true
    })
    await expect(
        page.locator('.preview-controls').getByText('Note Speed', { exact: true }),
    ).toBeVisible()
})

test('selected notes highlight at the hit beat without seeking or adding history', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, history } = window.editorTest
        const base = fixtures.interaction.slides[0]?.[0]
        if (!base) throw new Error('Missing fixture')
        show({ ...fixtures.interaction, slides: [[{ ...base, beat: 6 }]] }, 3)
        view.cursorTime = 3
        const note = [...history.state.value.store.slides.note.values()].flat()[0]
        if (note) history.replaceState({ ...history.state.value, selectedEntities: [note] })
    })
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.editorTest.view.cursorTime)).toBe(3)
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
    const highlighting = page
        .locator('.preview-controls')
        .getByLabel('Highlight Selection', { exact: true })
    await highlighting.uncheck()
    await expect.poll(() => outlinePixels(page)).toBe(0)
    expect(
        await page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
    ).toBe(1)
    await highlighting.check()
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    await expect.poll(() => outlinePixels(page)).toBe(0)
    await expect(page.locator('.elevation-canvas')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Elevation', exact: true })).toHaveCount(0)
})

test('connectors, moving slide heads, and stage events highlight their visible objects', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, history } = window.editorTest
        const base = fixtures.interaction.slides[0]?.[0]
        const transform = fixtures.events.stageTransformEvents[0]
        const mask = fixtures.events.stageMaskEvents[0]
        const style = fixtures.events.stageStyleEvents[0]
        if (!base || !transform || !mask || !style) throw new Error('Missing fixture')
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                slides: [
                    [
                        { ...base, beat: 4 },
                        { ...base, beat: 8, elevation: 0.5 },
                    ],
                ],
                stageTransformEvents: [{ ...transform, beat: 0, xTranslation: 0, elevation: 0.5 }],
                stageMaskEvents: [{ ...mask, beat: 0, maskLeft: -6, maskSize: 12 }],
                stageStyleEvents: [{ ...style, beat: 0 }],
            },
            3,
        )
        view.cursorTime = 3
        const connector = [...history.state.value.store.slides.connector.values()].flat()[0]
        if (connector)
            history.replaceState({ ...history.state.value, selectedEntities: [connector] })
    })
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    await expect.poll(() => outlinePixels(page)).toBe(0)
    await page.evaluate(() => {
        const { history } = window.editorTest
        const head = [...history.state.value.store.slides.note.values()].flat()[0]
        if (head) history.replaceState({ ...history.state.value, selectedEntities: [head] })
    })
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    await page.evaluate(() => {
        const { history, store } = window.editorTest
        const event = [...store.getAllEntities()].find(
            (entity) => entity.type === 'stageTransformEventJoint',
        )
        if (!event) throw new Error('Missing stage event')
        history.replaceState({ ...history.state.value, selectedEntities: [event] })
    })
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.editorTest.view.cursorTime)).toBe(3)
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
})

/** The selection overlay's lit pixels, by index, once two reads a frame apart agree. */
const settledOverlay = async (page: Page) => {
    const read = () =>
        page.evaluate(async () => {
            for (let i = 0; i < 2; i++) await new Promise((done) => requestAnimationFrame(done))
            await window.nsePreviewTest?.settled()
            const alpha = await window.nsePreviewTest?.outlineAlpha()
            const lit: number[] = []
            alpha?.data.forEach((value, index) => {
                if (value) lit.push(index)
            })
            return { width: alpha?.width ?? 0, lit }
        })
    let last = await read()
    for (;;) {
        const next = await read()
        if (next.width === last.width && next.lit.join() === last.lit.join()) return next
        last = next
    }
}

const selectFirst = (page: Page, type: 'stageTransformEventJoint' | 'stageMaskEventJoint') =>
    page.evaluate((type) => {
        const { history, store } = window.editorTest
        const event = [...store.getAllEntities()].find((entity) => entity.type === type)
        if (!event) throw new Error(`Missing ${type}`)
        history.replaceState({ ...history.state.value, selectedEntities: [event] })
    }, type)

// Lane 0 on the judgment line, and the screen's center, with the default camera at 16:9 (y up,
// in half the preview's height).
for (const [rotationCenter, centerY] of [
    ['stage', -0.5824426],
    ['screen', 0],
] as const)
    test(`a selected transform event marks its stage's rotation center, ${rotationCenter}, with an X turned with the stage`, async ({
        page,
    }) => {
        await page.evaluate(() => {
            window.editorTest.settings.previewAspectRatio = 16 / 9
        })
        for (const rotation of [0, 45]) {
            await page.evaluate(
                ({ rotation, rotationCenter }) => {
                    const { fixtures, show, view } = window.editorTest
                    const transform = fixtures.events.stageTransformEvents[0]
                    const mask = fixtures.events.stageMaskEvents[0]
                    if (!transform || !mask) throw new Error('Missing fixture')
                    // The mask off lane 0, so that Mask Center is elsewhere.
                    show(
                        {
                            ...fixtures.interaction,
                            isDynamicStages: true,
                            slides: [],
                            stageTransformEvents: [
                                {
                                    ...transform,
                                    beat: 0,
                                    rotation,
                                    rotationCenter,
                                    xTranslation: 0,
                                },
                            ],
                            stageMaskEvents: [{ ...mask, beat: 0, maskLeft: -2, maskSize: 8 }],
                        },
                        3,
                    )
                    view.cursorTime = 3
                },
                { rotation, rotationCenter },
            )
            // The same stage's outline either way; only the transform event adds the X.
            await selectFirst(page, 'stageMaskEventJoint')
            const without = await settledOverlay(page)
            await selectFirst(page, 'stageTransformEventJoint')
            await expect
                .poll(async () => (await settledOverlay(page)).lit.join() !== without.lit.join())
                .toBe(true)
            const marked = await settledOverlay(page)
            const box = (await page.locator('canvas.preview-selection').last().boundingBox())!
            expect(box.width / box.height).toBeCloseTo(16 / 9, 1)
            // Without a context yet, nothing was drawn.
            if (without.width) expect(marked.width).toBe(without.width)
            const scale = marked.width / box.width
            const center = {
                x: box.width / 2,
                y: box.height / 2 - (centerY * box.height) / 2,
            }
            const before = new Set(without.lit)
            const added = marked.lit
                .filter((index) => !before.has(index))
                .map((index) => ({
                    x: ((index % marked.width) + 0.5) / scale - center.x,
                    y: (Math.floor(index / marked.width) + 0.5) / scale - center.y,
                }))
            // The arms, +/-6 px on both axes before turning: diagonals at 0 degrees, upright at 45 degrees.
            const turn = (rotation * Math.PI) / 180
            const ends = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4].map(
                (angle) => ({
                    x: 6 * Math.SQRT2 * Math.cos(angle + turn),
                    y: 6 * Math.SQRT2 * Math.sin(angle + turn),
                }),
            )
            const toArm = (p: { x: number; y: number }, end: { x: number; y: number }) => {
                const t = Math.max(0, Math.min(1, (p.x * end.x + p.y * end.y) / 72))
                return Math.hypot(p.x - t * end.x, p.y - t * end.y)
            }
            // Within half the dark stroke, 1 px of antialiasing and half a pixel's diagonal.
            const reach = 2.5 + 1 + Math.SQRT1_2 / scale
            const stray = added.filter((p) => Math.min(...ends.map((end) => toArm(p, end))) > reach)
            expect(stray, `${rotationCenter} at ${rotation}`).toEqual([])
            // Each of the four half arms is drawn out to near its end.
            for (const end of ends)
                expect(
                    added.some((p) => Math.hypot(p.x, p.y) >= 5 && toArm(p, end) <= 1.5),
                    `${rotationCenter} at ${rotation}: arm to (${end.x}, ${end.y})`,
                ).toBe(true)
        }
        // Highlight Selection off: no outline and no X.
        await page
            .locator('.preview-controls')
            .getByLabel('Highlight Selection', { exact: true })
            .uncheck()
        await expect.poll(() => outlinePixels(page)).toBe(0)
    })

test('the outline follows playback frames', async ({ page }) => {
    await page.evaluate(() => {
        const { fixtures, show, view, history } = window.editorTest
        const base = fixtures.interaction.slides[0]?.[0]
        if (!base) throw new Error('Missing fixture')
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [
                        { ...base, beat: 4 },
                        { ...base, beat: 8 },
                    ],
                ],
            },
            3,
        )
        view.cursorTime = 3
        const { note, connector } = history.state.value.store.slides
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...note.values(), ...connector.values()].flat(),
        })
    })
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    for (const time of [3.05, 3.1, 3.15, 3.2]) {
        await page.evaluate(async (time) => {
            window.editorTest.view.cursorTime = time
            for (let i = 0; i < 4; i++) await new Promise((done) => requestAnimationFrame(done))
        }, time)
        expect(await outlinePixels(page)).toBeGreaterThan(0)
    }
})

test('selected invisible anchors show a preview line that respects the highlight toggle', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, history } = window.editorTest
        const base = fixtures.interaction.slides[0]?.[0]
        if (!base) throw new Error('Missing fixture')
        show(
            {
                ...fixtures.interaction,
                slides: [[{ ...base, beat: 6, elevation: 2, noteType: 'anchor' }]],
            },
            3,
        )
        view.cursorTime = 3
        const anchor = [...history.state.value.store.slides.note.values()].flat()[0]
        if (!anchor) throw new Error('Missing anchor')
        history.replaceState({ ...history.state.value, selectedEntities: [anchor] })
    })
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    const highlighting = page
        .locator('.preview-controls')
        .getByLabel('Highlight Selection', { exact: true })
    await highlighting.uncheck()
    await expect.poll(() => outlinePixels(page)).toBe(0)
    await highlighting.check()
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    await page.evaluate(() => {
        window.editorTest.view.cursorTime = 3.1
    })
    await expect.poll(() => outlinePixels(page)).toBe(0)
    expect(
        await page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
    ).toBe(1)
})

test('deselecting clears the outline across later presented frames', async ({ page }) => {
    // Read pixels only at the end: a readback flushes Chromium's deferred Canvas and hides the bug.
    const present = async () => {
        await page.evaluate(
            () =>
                new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
        )
        await page.waitForTimeout(650)
    }
    const box = (await page.locator('canvas.editor-chart').boundingBox())!
    const click = async (x: number, y: number) => {
        await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
        await present()
    }
    await present()
    await page.keyboard.press('a')
    await click(0.5, 0.45)
    await page.keyboard.press('f')
    await present()
    await click(0.3, 0.6)
    for (const y of [0.3, 0.7, 0.2, 0.8, 0.5]) await click(0.3, y)
    expect(
        await page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
    ).toBe(0)
    expect(await outlinePixels(page)).toBe(0)
})
