import { expect, test } from '@playwright/test'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const installActivityProbe = async (layout: 'basic' | 'composed') => {
    const { appImport, fixtures, history, settings, show, store, view, nextTick } =
        window.editorTest
    const { VectorRanges } = await appImport<typeof import('../../src/editor/canvas/vectorRanges')>(
        '/src/editor/canvas/vectorRanges.ts',
    )
    const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
        '/src/editor/tools/index.ts',
    )
    const ranges = new Set<InstanceType<typeof VectorRanges>>()
    let context: EditorDrawContext | undefined
    const originalBegin = VectorRanges.prototype.beginFrame
    VectorRanges.prototype.beginFrame = function (...args) {
        ranges.add(this)
        context = args[0]
        return originalBegin.apply(this, args)
    }
    settings.width = 30
    settings.pps = 100
    settings.showStageName = true
    // This focused-scope fixture tests activity and 0.25/1 opacity independently
    // of the default option that deliberately hides all focused-stage names.
    settings.hideStageNameWhenFocusingStage = false
    settings.showGroupName = true
    settings.nameContrast = true
    const stages = [...fixtures.events.stages]
    const firstStage = stages[0]![0]
    const secondStage = stages[1]![0]
    const event = fixtures.events.stageTransformEvents[0]!
    show(
        {
            ...fixtures.events,
            bpms: [{ beat: 0, bpm: 120 }],
            stages: new Map(
                stages.map(([id, stage], index) => [
                    id,
                    { ...stage, name: `Activity ${index ? 'B' : 'A'}` },
                ]),
            ),
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            timeScales: [],
            slides: [],
            stageTransformEvents: [
                { ...event, stageId: firstStage, beat: 4, xTranslation: -2 },
                { ...event, stageId: firstStage, beat: 8, xTranslation: 2 },
                { ...event, stageId: secondStage, beat: 6, xTranslation: -1 },
                { ...event, stageId: secondStage, beat: 10, xTranslation: 3 },
            ],
        },
        3,
    )
    view.layout = layout
    view.stageId = firstStage
    view.cursorTime = 1000
    view.lastActive = -100
    switchToolTo('select')
    await document.fonts.ready
    const frame = async () => {
        // The cursor stays outside this viewport and only requests a chart frame.
        view.cursorTime = 1000 + (view.cursorTime === 1000 ? 1 : 0)
        await nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    }
    await frame()
    await frame()
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!
    const ctx = window.editorRendering.getDrawContext(canvas)
    await ctx.ready
    const joint = [...store.getAllEntities()].find(
        (entity) =>
            entity.type === 'stageTransformEventJoint' &&
            entity.stageId === firstStage &&
            entity.beat === 4,
    )
    if (joint?.type !== 'stageTransformEventJoint') throw new Error('Missing hover target')
    type NameDraw = { text: string; alpha: number; position: number[] }
    let draws: NameDraw[] = []
    const clear = ctx.clear
    const drawNameSprite = ctx.drawNameSprite
    ctx.clear = function () {
        draws = []
        return clear.call(this)
    }
    ctx.drawNameSprite = function (source, ...args) {
        const label = window.editorLabels.get(source)
        if (label?.text.startsWith('Activity '))
            draws.push({ text: label.text, alpha: this.globalAlpha, position: args })
        return Reflect.apply(drawNameSprite, this, [source, ...args])
    }
    const stats = () =>
        [...ranges].reduce(
            (result, range) => ({
                captures: result.captures + range.stats.captures,
                replays: result.replays + range.stats.replays,
            }),
            { captures: 0, replays: 0 },
        )
    const snapshot = () => ({
        pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        names:
            context?.names?.names
                .filter(({ owner }) => owner.type === 'stageTransformEventJoint')
                .map(({ owner, text, alpha, highlighted }) => ({
                    beat: owner.beat,
                    text,
                    alpha,
                    highlighted,
                })) ?? [],
        draws: [...draws],
        stats: stats(),
        active: context?.recentlyActive,
    })
    await frame()
    let previous = snapshot()
    const probe = {
        point: window.editorTest.point(joint.xTranslation, joint.beat),
        away: window.editorTest.point(-10, 4),
        begin() {
            previous = snapshot()
        },
        activity(active: boolean) {
            view.lastActive = active ? performance.now() / 1000 + 60 : -100
        },
        selected() {
            return history.state.value.selectedEntities.includes(joint)
        },
        hovered() {
            return view.entities.hovered.includes(joint)
        },
        async compare(label: string) {
            await frame()
            const retained = snapshot()
            for (const range of ranges) range.clear()
            await frame()
            const fresh = snapshot()
            let changedChannels = 0
            let changedFromPrevious = 0
            let maximumDelta = 0
            for (let i = 0; i < retained.pixels.length; i++) {
                changedFromPrevious += +(retained.pixels[i] !== previous.pixels[i])
                const delta = Math.abs(retained.pixels[i]! - fresh.pixels[i]!)
                changedChannels += +(delta !== 0)
                maximumDelta = Math.max(maximumDelta, delta)
            }
            return {
                label,
                captures: retained.stats.captures - previous.stats.captures,
                replays: retained.stats.replays - previous.stats.replays,
                changedChannels,
                maximumDelta,
                changedFromPrevious,
                active: retained.active,
                names: retained.names,
                freshNames: fresh.names,
                draws: retained.draws,
                freshDraws: fresh.draws,
            }
        },
        restore() {
            VectorRanges.prototype.beginFrame = originalBegin
            ctx.clear = clear
            ctx.drawNameSprite = drawNameSprite
        },
    }
    window.vectorActivityProbe = probe
    return { point: probe.point, away: probe.away }
}

declare global {
    interface Window {
        vectorActivityProbe: {
            point: { x: number; y: number }
            away: { x: number; y: number }
            begin(): void
            activity(active: boolean): void
            selected(): boolean
            hovered(): boolean
            compare(label: string): Promise<{
                label: string
                captures: number
                replays: number
                changedChannels: number
                maximumDelta: number
                changedFromPrevious: number
                active: boolean | undefined
                names: { beat: number; text: string; alpha: number; highlighted: boolean }[]
                freshNames: { beat: number; text: string; alpha: number; highlighted: boolean }[]
                draws: { text: string; alpha: number; position: number[] }[]
                freshDraws: { text: string; alpha: number; position: number[] }[]
            }>
            restore(): void
        }
    }
}

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout} activity and stage hover update names without recapturing vectors`, async ({
        page,
    }, testInfo) => {
        await page.addInitScript(installCanvasCounters)
        await page.goto('/')
        await page.locator('canvas.editor-chart').waitFor()
        await page.evaluate(installEditorFixture)
        const points = await page.evaluate(installActivityProbe, layout)
        const results: Awaited<ReturnType<Window['vectorActivityProbe']['compare']>>[] = []
        const activity = async (label: string, active: boolean) => {
            await page.evaluate((active) => {
                window.vectorActivityProbe.begin()
                window.vectorActivityProbe.activity(active)
            }, active)
            results.push(
                await page.evaluate((label) => window.vectorActivityProbe.compare(label), label),
            )
        }
        try {
            await activity('idle baseline', false)
            await activity('active', true)
            await activity('idle again', false)
            await page.evaluate(() => window.vectorActivityProbe.begin())
            await page.mouse.move(points.point.x, points.point.y)
            await expect
                .poll(() => page.evaluate(() => window.vectorActivityProbe.hovered()))
                .toBe(true)
            await page.evaluate(() => window.vectorActivityProbe.activity(false))
            results.push(await page.evaluate(() => window.vectorActivityProbe.compare('hover in')))
            await page.evaluate(() => window.vectorActivityProbe.begin())
            await page.mouse.move(points.away.x, points.away.y)
            await expect
                .poll(() => page.evaluate(() => window.vectorActivityProbe.hovered()))
                .toBe(false)
            await page.evaluate(() => window.vectorActivityProbe.activity(false))
            results.push(await page.evaluate(() => window.vectorActivityProbe.compare('hover out')))
            await page.evaluate(() => window.vectorActivityProbe.begin())
            await page.mouse.click(points.point.x, points.point.y)
            await expect
                .poll(() => page.evaluate(() => window.vectorActivityProbe.selected()))
                .toBe(true)
            await page.mouse.move(points.away.x, points.away.y)
            await page.evaluate(() => window.vectorActivityProbe.activity(false))
            results.push(
                await page.evaluate(() => window.vectorActivityProbe.compare('selected idle')),
            )
            await activity('selected active', true)
            await activity('selected idle again', false)
        } finally {
            await page.evaluate(() => window.vectorActivityProbe.restore())
        }
        await testInfo.attach('activity-transitions', {
            body: JSON.stringify(results, null, 2),
            contentType: 'application/json',
        })
        for (const result of results) {
            expect(result.changedChannels, JSON.stringify(result)).toBe(0)
            expect(result.maximumDelta, result.label).toBe(0)
            expect(result.names, result.label).toEqual(result.freshNames)
            expect(result.draws, result.label).toEqual(result.freshDraws)
            if (result.label !== 'selected idle') {
                expect(result.captures, result.label).toBe(0)
                expect(result.replays, result.label).toBeGreaterThan(0)
            }
        }
        for (const label of ['idle baseline', 'idle again', 'hover out']) {
            const result = results.find((result) => result.label === label)!
            expect(result.active, label).toBe(false)
            expect(result.names, label).toHaveLength(0)
            expect(result.draws, label).toHaveLength(0)
        }
        for (const label of ['active', 'selected active']) {
            const result = results.find((result) => result.label === label)!
            expect(result.active, label).toBe(true)
            expect(result.names, label).toHaveLength(4)
            expect(result.draws, label).toHaveLength(4)
            expect(new Set(result.draws.map(({ alpha }) => alpha)), label).toEqual(
                new Set([0.25, 1]),
            )
        }
        for (const label of ['hover in', 'selected idle', 'selected idle again']) {
            const result = results.find((result) => result.label === label)!
            expect(result.active, label).toBe(false)
            expect(result.names, label).toEqual([
                { beat: 4, text: 'Activity A', alpha: 1, highlighted: true },
            ])
            expect(result.draws, label).toHaveLength(1)
        }
        for (const label of [
            'active',
            'idle again',
            'hover in',
            'hover out',
            'selected active',
            'selected idle again',
        ])
            expect(
                results.find((result) => result.label === label)!.changedFromPrevious,
                label,
            ).toBeGreaterThan(0)
        const selectedActive = results.find(({ label }) => label === 'selected active')!
        expect(selectedActive.names.at(-1)).toMatchObject({ beat: 4, highlighted: true })
        expect(selectedActive.draws.at(-1)?.text).toBe('Activity A')
    })
}
