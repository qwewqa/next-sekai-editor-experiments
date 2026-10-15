import { expect, test } from '@playwright/test'
import type { NamePlacement } from '../../src/editor/canvas/nameLayout'
import type { Entity } from '../../src/state/entities'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        nameDeclutterProbe: {
            frame?: { names: readonly NamePlacement[]; visible: ReadonlySet<NamePlacement> }
            target?: Entity
            targetText?: string
            submitted: string[]
            trustedPointerEvents: number
        }
    }
}

test('a trusted pointer hover reveals an overlapping name without changing its note hit area', async ({
    page,
}) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await page.locator('canvas.editor-chart').waitFor()
    await page.evaluate(installEditorFixture)
    const before = await page.evaluate(async () => {
        const { appImport, fixtures, show, settings, view, nextTick, point } = window.editorTest
        const { NameLayout } = await appImport<typeof import('../../src/editor/canvas/nameLayout')>(
            '/src/editor/canvas/nameLayout.ts',
        )
        const { WebGLDrawContext } = window.editorRendering
        const probe: Window['nameDeclutterProbe'] = {
            submitted: [],
            trustedPointerEvents: 0,
        }
        window.nameDeclutterProbe = probe
        const place = NameLayout.prototype.place
        NameLayout.prototype.place = function (names) {
            const visible = place.call(this, names)
            probe.frame = { names, visible }
            return visible
        }
        const draw = WebGLDrawContext.prototype.drawNameSprite
        WebGLDrawContext.prototype.drawNameSprite = function (...args) {
            const label = window.editorLabels.get(args[0])
            if (label) probe.submitted.push(label.text)
            return draw.apply(this, args)
        }
        const chart = { ...fixtures.interaction, isDynamicStages: true }
        chart.stages = new Map(
            [...chart.stages].map(([id, stage], index) => [
                id,
                {
                    ...stage,
                    name: `${index ? 'Second' : 'First'} stage with a deliberately long label`,
                },
            ]),
        )
        const stageIds = [...chart.stages.keys()]
        const note = chart.slides[0]![0]!
        chart.slides = [
            [{ ...note, beat: 4, left: -2, size: 1, stageId: stageIds[0]! }],
            [{ ...note, beat: 4, left: 1, size: 1, stageId: stageIds[1]! }],
        ]
        settings.width = 12
        settings.pps = 200
        settings.showGroupName = false
        settings.showStageName = true
        settings.nameContrast = true
        show(chart, 2)
        view.layout = 'basic'
        view.lane = 0
        // Keep ordinary names visible until the actual pointer event updates activity.
        view.lastActive = Infinity
        await document.fonts.ready
        await nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        const { names, visible } = probe.frame!
        const suppressed = names.filter((name) => !visible.has(name))
        const target = suppressed[0]?.owner as Entity | undefined
        if (!target || target.type !== 'note') throw new Error('Expected one suppressed note name')
        probe.target = target
        probe.targetText = chart.stages.get(target.stageId)!.name
        probe.submitted = []
        document.addEventListener('pointermove', (event) => {
            if (event.isTrusted) probe.trustedPointerEvents++
        })
        return {
            requested: names.length,
            shown: visible.size,
            suppressed: suppressed.length,
            point: point(target.left + target.size / 2, target.beat),
            text: probe.targetText,
        }
    })
    expect(before.requested).toBe(2)
    expect(before.shown).toBe(1)
    expect(before.suppressed).toBe(1)
    await page.mouse.move(before.point.x, before.point.y)
    await expect
        .poll(() =>
            page.evaluate(() => {
                const probe = window.nameDeclutterProbe
                return (
                    !!probe.target &&
                    window.editorTest.view.entities.hovered.includes(probe.target) &&
                    [...(probe.frame?.visible ?? [])].some(
                        (name) => name.owner === probe.target && name.highlighted,
                    )
                )
            }),
        )
        .toBe(true)
    const after = await page.evaluate(() => {
        const probe = window.nameDeclutterProbe
        return {
            trusted: probe.trustedPointerEvents,
            submitted: probe.submitted,
            highlightedVisible: [...(probe.frame?.visible ?? [])]
                .filter((name) => name.highlighted)
                .map((name) => name.owner === probe.target),
        }
    })
    expect(after.trusted).toBeGreaterThan(0)
    expect(after.highlightedVisible).toEqual([true])
    expect(after.submitted).toContain(before.text)
})
