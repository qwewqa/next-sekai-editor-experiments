import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { importLevelData, openEditor } from './memoryBaseline'

// Vector sections near the view are compiled at idle time (rendering.md). A later visit replays
// them, and its pixels are the ones sections compiled in the frame give.

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout} sections compiled at idle match those compiled in the frame`, async ({
        page,
    }) => {
        test.setTimeout(120_000)
        await openEditor(page)
        await importLevelData(
            page,
            'level.json',
            readFileSync('tests/fixtures/generated-large.json'),
        )
        const result = await page.evaluate(async (layout) => {
            const { appImport, settings, view, nextTick } = window.editorTest
            const { VectorRanges } = await appImport<
                typeof import('../../src/editor/canvas/vectorRanges')
            >('/src/editor/canvas/vectorRanges.ts')
            type Ranges = InstanceType<typeof VectorRanges>
            const ranges = new Set<Ranges>()
            const begin = VectorRanges.prototype.beginFrame
            VectorRanges.prototype.beginFrame = function (...args) {
                ranges.add(this)
                return begin.apply(this, args)
            }
            settings.width = 24
            settings.pps = 200
            view.layout = layout
            view.lastActive = -100
            const canvas = document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!
            const ctx = window.editorRendering.getDrawContext(canvas)
            await ctx.ready
            const frame = async () => {
                view.cursorTime = 100_000 + (view.cursorTime === 100_000 ? 1 : 0)
                await nextTick()
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                )
            }
            const stats = () =>
                [...ranges].reduce(
                    (total, range) => ({
                        captures: total.captures + range.stats.captures,
                        replays: total.replays + range.stats.replays,
                        ahead: total.ahead + range.stats.ahead,
                    }),
                    { captures: 0, replays: 0, ahead: 0 },
                )
            const pending = () =>
                [...ranges].some(
                    (range) => (range as unknown as { aheadPending: boolean }).aheadPending,
                )
            const settle = async () => {
                for (let quiet = 0; quiet < 3;) {
                    const before = stats().ahead
                    await new Promise((resolve) => requestIdleCallback(resolve))
                    quiet = !pending() && stats().ahead === before ? quiet + 1 : 0
                }
            }
            view.time = 30
            await frame()
            await settle()
            const ahead = stats().ahead
            // Most of a view span on: every section entering the view was compiled at idle.
            view.time = 30 + (0.8 * view.h) / settings.pps
            const before = stats()
            await frame()
            const visit = stats()
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            for (const range of ranges) range.clear()
            await frame()
            const fresh = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            let changed = 0
            for (let i = 0; i < pixels.length; i++) changed += +(pixels[i] !== fresh[i])
            VectorRanges.prototype.beginFrame = begin
            return {
                ahead,
                captures: visit.captures - before.captures,
                replays: visit.replays - before.replays,
                recaptured: stats().captures - visit.captures,
                changed,
            }
        }, layout)
        expect(result.ahead).toBeGreaterThan(0)
        expect(result.captures).toBe(0)
        expect(result.replays).toBeGreaterThan(0)
        expect(result.recaptured).toBeGreaterThan(0)
        expect(result.changed).toBe(0)
    })
}
