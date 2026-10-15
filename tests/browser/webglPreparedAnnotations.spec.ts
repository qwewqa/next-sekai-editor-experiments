import { expect, test } from '@playwright/test'

for (const alignToPixels of [false, true])
    test(`prepared annotations preserve ${alignToPixels ? 'integer baselines' : 'fractional text phases'}, clipping, font changes and ease geometry`, async ({
        page,
    }) => {
        await page.route('**/__prepared-annotations', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body></body></html>',
            }),
        )
        await page.goto('/__prepared-annotations')
        const result = await page.evaluate(async (alignToPixels) => {
            const { getDrawContext } = await import('/src/rendering/context.ts')
            const { DrawPath } = await import('/src/rendering/path.ts')
            const { clearTextRasterCache } = await import('/src/rendering/textRaster.ts')
            const make = async () => {
                const canvas = document.createElement('canvas')
                canvas.width = 220
                canvas.height = 100
                document.body.append(canvas)
                const context = getDrawContext(canvas)
                await context.ready
                return context
            }
            const reference = await make(),
                prepared = await make()
            const differences: number[] = []
            const text = '1.25× שלום 漢字'
            const label = prepared.prepareEditorLabel(
                text,
                '#ffff00',
                'Arial, sans-serif',
                40,
                0.5,
                'start',
                0.35,
                alignToPixels,
            )
            const compare = () => {
                const a = reference.getImageData(0, 0, 220, 100).data
                const b = prepared.getImageData(0, 0, 220, 100).data
                differences.push(a.reduce((sum, value, index) => sum + +(value !== b[index]), 0))
            }
            try {
                for (const direction of ['ltr', 'rtl'] as const) {
                    document.documentElement.dir = direction
                    clearTextRasterCache()
                    for (const reflected of [false, true])
                        for (const phase of [0, 1 / 64, 0.25, 0.5, 1])
                            for (const x of [-3, 0, 3]) {
                                for (const ctx of [reference, prepared]) {
                                    ctx.clear()
                                    ctx.setTransform(
                                        reflected ? -40 : 40,
                                        0,
                                        0,
                                        40,
                                        110 + phase,
                                        50,
                                    )
                                    ctx.globalAlpha = 0.7
                                }
                                reference.drawEditorLabel(
                                    text,
                                    x,
                                    0,
                                    '#ffff00',
                                    'Arial, sans-serif',
                                    40,
                                    0.5,
                                    'start',
                                    0.35,
                                    alignToPixels,
                                )
                                prepared.drawPreparedEditorLabel(label, x, 0)
                                compare()
                            }
                }
                for (const ctx of [reference, prepared]) {
                    ctx.clear()
                    ctx.setTransform(0, 0, 0, 0, 110, 50)
                }
                reference.drawEditorLabel(
                    text,
                    0,
                    0,
                    '#ffff00',
                    'Arial, sans-serif',
                    40,
                    0.5,
                    'start',
                    0.35,
                    alignToPixels,
                )
                prepared.drawPreparedEditorLabel(label, 0, 0)
                compare()

                const path = new DrawPath()
                path.moveTo(0, -0.17)
                path.lineTo(0.15, 0.17)
                path.lineTo(0.3, -0.17)
                for (const ctx of [reference, prepared])
                    ctx.setTransform(63.666666666666664, 0, 0, 63.666666666666664, 100, 50)
                const glyph = prepared.prepareEaseGlyph(path, '#ff0', 0.05)
                if (!glyph) throw new Error('Visible ease geometry was not retained')
                for (const phase of [0, 0.25, 0.5, 1]) {
                    for (const ctx of [reference, prepared]) {
                        ctx.clear()
                        ctx.setTransform(
                            63.666666666666664,
                            0,
                            0,
                            63.666666666666664,
                            100 + phase,
                            50 - phase,
                        )
                        ctx.globalAlpha = 0.25
                    }
                    reference.save()
                    reference.globalAlpha *= 0.7
                    reference.strokeStyle = '#ff0'
                    reference.lineWidth = 0.05
                    reference.lineCap = reference.lineJoin = 'round'
                    reference.translate(-0.15, 0.123)
                    reference.stroke(path)
                    reference.restore()
                    if (!prepared.drawPreparedEaseGlyph(glyph, -0.15, 0.123, 0.7))
                        throw new Error('A valid prepared glyph was refused')
                    compare()
                }
                // The feature releases its geometry after the frame has flushed.
                prepared.releasePreparedEaseGlyph(glyph)
                prepared.releasePreparedEaseGlyph(glyph)
                return { differences, releasedDraw: prepared.drawPreparedEaseGlyph(glyph, 0, 0) }
            } finally {
                reference.dispose()
                prepared.dispose()
            }
        }, alignToPixels)
        expect(result.differences.every((count) => count === 0)).toBe(true)
        expect(result.releasedDraw).toBe(false)
    })
