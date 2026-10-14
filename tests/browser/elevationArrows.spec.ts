import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// The rows in slide order, in the canvas's CSS pixels, and pixels beside the last piece's arrow.
const sample = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, nextTick } = window.editorTest
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        await nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
        const layout = elevationLayout.value
        const s = layout.laneScale
        const rows = [...layout.rows].sort((a, b) => a.order - b.order)
        const [, head, tail] = rows
        const sign = Math.sign(tail!.x - head!.x)
        const from = head!.x + sign * (head!.w / 2 + 0.08 * s)
        const to = tail!.x - sign * (tail!.w / 2 + 0.08 * s)
        const pixel = (x: number, y: number) => [
            ...canvas
                .getContext('2d')!
                .getImageData(
                    Math.round((x * canvas.width) / layout.width),
                    Math.round((y * canvas.height) / layout.height),
                    1,
                    1,
                ).data,
        ]
        const box = canvas.getBoundingClientRect()
        return {
            rows: rows.map((row) => ({ x: box.left + row.x, y: box.top + row.y })),
            middle: pixel((from + to) / 2, head!.y),
            // Beside the shaft near each end: only the tail's end has the arrow's head there.
            headEnd: pixel(from + sign * 0.2 * s, head!.y + 0.16 * s),
            tailEnd: pixel(to - sign * 0.2 * s, head!.y + 0.16 * s),
        }
    })

for (const direction of [-1, 1]) {
    test(`a slide's level same-beat connectors show arrows toward their tails, ${direction > 0 ? 'rightward' : 'leftward'}, while one of its notes is hovered or selected`, async ({
        page,
    }) => {
        await page.evaluate((direction) => {
            const { fixtures, show, view } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    slides: [
                        [-5, 0, 5].map((left) => ({
                            ...base,
                            beat: 6,
                            left: left * direction - 0.5,
                            size: 1,
                            elevation: 1,
                        })),
                    ],
                },
                3,
            )
            view.cursorTime = 3
        }, direction)
        await page.keyboard.press('t')
        await expect(page.locator('.elevation-canvas')).toBeVisible()
        const none = await sample(page)
        const [first] = none.rows
        const away = { x: first!.x, y: first!.y - 150 }

        // Hovering the first note shows the last piece's arrow, fainter.
        await page.mouse.move(first!.x, first!.y)
        const hovered = await sample(page)
        expect(hovered.middle).not.toEqual(none.middle)

        // Selecting it shows it in full.
        await page.mouse.down()
        await page.mouse.up()
        await page.mouse.move(away.x, away.y)
        const selected = await sample(page)
        expect(selected.middle).not.toEqual(none.middle)
        expect(selected.middle).not.toEqual(hovered.middle)
        expect(selected.middle[3]).toBeGreaterThan(hovered.middle[3]!)
        expect(selected.tailEnd).not.toEqual(none.tailEnd)
        expect(selected.headEnd).toEqual(none.headEnd)

        await page.evaluate(async () => {
            const { settings } =
                await window.editorTest.appImport<typeof import('../../src/settings')>(
                    '/src/settings.ts',
                )
            settings.elevationConnectorArrows = false
        })
        const off = await sample(page)
        expect(off.middle).toEqual(none.middle)
        expect(off.tailEnd).toEqual(none.tailEnd)
    })
}
