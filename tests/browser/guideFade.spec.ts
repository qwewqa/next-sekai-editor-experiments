import { expect, test, type Page } from '@playwright/test'
import type { NoteObject } from '../../src/chart/note'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

// At 150 BPM, a beat is 0.4 s.
const pointAt = (page: Page, lane: number, beat: number) =>
    page.evaluate(
        ({ lane, beat }) => {
            const { view, settings } = window.editorTest
            return {
                x: view.x + view.w * (0.5 + (lane - view.lane) / settings.width),
                y: view.y + view.h / 2 - (beat * 0.4 - view.time) * settings.pps,
            }
        },
        { lane, beat },
    )

test('separators a float step apart draw their zero-length guide segment, and a drag onto one lands exactly', async ({
    page,
}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(async () => {
        const { fixtures, show, view, nextTick } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const guide = (beat: number, extra: Partial<NoteObject> = {}): NoteObject => ({
            ...base,
            beat,
            left: -4,
            size: 2,
            noteType: 'anchor',
            connectorType: 'guide',
            connectorGuideAlpha: 1,
            ...extra,
        })
        show(
            {
                ...fixtures.interaction,
                bpms: [{ beat: 0, bpm: 150 }],
                slides: [
                    [
                        guide(0),
                        guide(22 / 3, { isConnectorSeparator: true }),
                        // 7.333333333333334: a float step after 22 / 3, as imported charts can hold.
                        guide(7 / 3 + 5, {
                            left: 2,
                            isConnectorSeparator: true,
                            connectorGuideAlpha: 0.2,
                        }),
                        guide(10),
                    ],
                    [
                        guide(0, { left: 4 }),
                        guide(7 / 3, { left: 4, isConnectorSeparator: true }),
                        guide(10, { left: 4 }),
                    ],
                ],
            },
            2,
        )
        view.snapping = 'absolute'
        view.division = 3
        await nextTick()
    })
    await settle(page)

    const beats = () =>
        page.evaluate(() => window.editorTest.snapshot().notes.map((note) => note.beat))
    const [head, tail] = (await beats()).filter((beat) => beat > 7 && beat < 8)
    expect(head).not.toBe(tail)
    expect(Math.abs(head! - tail!)).toBeLessThan(1e-9)

    // A select drag onto the other separator's beat lands on it exactly.
    const start = await pointAt(page, 5, 7 / 3)
    const end = await pointAt(page, 5, 22 / 3)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 })
    await page.mouse.up()
    await settle(page)
    expect((await beats()).filter((beat) => beat === 22 / 3)).toHaveLength(2)
    expect(errors).toEqual([])
})
